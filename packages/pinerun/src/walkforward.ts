/**
 * walkforward — out-of-sample validation, the anti-overfitting counterpart to
 * `sweep`.
 *
 * A sweep picks the best parameter combo on historical data; that combo is
 * usually fit to noise. Walk-forward asks the only question that matters: does
 * the edge survive on data the optimizer never saw?
 *
 * The timeline is split into N windows. In each window the input grid is swept
 * on the in-sample (IS) segment, the winning combo is picked by the rank spec,
 * and that winner is evaluated on the following out-of-sample (OOS) segment.
 * OOS segments tile the tail of history back to back, so every OOS bar is
 * traded by a combo optimized strictly on earlier bars. `windows: 1` is the
 * plain IS/OOS split.
 *
 * **OOS attribution.** The winner runs over the FULL window (IS + OOS): the IS
 * stretch doubles as indicator warmup, and — because a piner run is
 * deterministic bar by bar — its IS prefix is identical to the sweep run that
 * selected it. OOS performance is then the equity-curve difference across the
 * boundary, and OOS trades are those that EXIT in the OOS segment (a position
 * opened in-sample and carried across the boundary counts, as it would live).
 * Both are plain arithmetic on piner's outputs — pinerun still performs no
 * strategy calculations of its own.
 */
import type { Bar, HistoryProvider, HistoryRange } from '@heyphat/pinery';
import { toPinerTimeframe } from '@heyphat/pinery';
import { compile } from '@heyphat/piner';
import type { Job, JobMetricsOptions } from './job.js';
import type { RunResult } from './result.js';
import { LocalRunner, type Runner } from './runner.js';
import { sweep } from './sweep.js';
import { resolveSecurity } from './security.js';
import { comboId, type Axis } from './params.js';

export interface WalkforwardOptions {
  source: string;
  /** Single symbol to validate on. */
  symbol: string;
  /** Canonical pinery timeframe (e.g. "1h", "1d"); mapped to the piner label internally. */
  timeframe: string;
  provider: HistoryProvider;
  range?: HistoryRange;
  /** The input grid swept per window (see params.ts). */
  axes: Axis[];
  /** Fixed inputs applied to every combo (merged under each combo's swept values). */
  baseInputs?: Record<string, unknown>;
  /** Rank spec that picks each window's winner. Default "strategy.netProfit". */
  rank?: string;
  /** Number of walk-forward windows. Default 5; 1 = plain IS/OOS split. */
  windows?: number;
  /** OOS share of each window, 0 < f < 1. Default 0.25. */
  oosFraction?: number;
  /** Anchored (expanding) in-sample: every window's IS starts at bar 0.
   *  Default false (rolling: fixed-length IS that slides forward). */
  anchored?: boolean;
  concurrency?: number;
  backend?: 'js' | 'interp';
  mintick?: number;
  /** Host conventions for the derived risk-adjusted metrics. */
  metrics?: JobMetricsOptions;
  /** Resolve request.security dependencies per window. Default true. */
  resolveSecurity?: boolean;
  /** Cap on combos per window sweep (sweep's default 5000). */
  maxCombos?: number;
  runner?: Runner;
  onWindow?: (done: number, total: number) => void;
  onFetch?: (symbol: string, bars: number) => void;
}

/** One window's bar-index plan (half-open ranges over the fetched series). */
export interface WindowPlan {
  isFrom: number;
  isTo: number; // == oosFrom
  oosFrom: number;
  oosTo: number;
}

export interface WalkforwardWindow extends WindowPlan {
  index: number;
  /** Unix-seconds times of the window edges (from the bars), when available. */
  isFromTime?: number;
  oosFromTime?: number;
  oosToTime?: number;
  /** The winning combo's swept inputs and its readable id (params.comboId). */
  winner?: Record<string, unknown>;
  winnerId?: string;
  /** The IS rank value that selected the winner. */
  winnerValue?: number;
  /** Winner's IS net profit as % of initial capital (equity at the OOS boundary). */
  isProfitPercent?: number;
  /** OOS-segment net profit as % of initial capital (equity difference across the boundary). */
  oosProfitPercent?: number;
  /** Trades that exited in the OOS segment. */
  oosTrades?: number;
  /** Per-bar profit ratio OOS/IS (NaN when IS profit ≤ 0). */
  efficiency?: number;
  /** The full-window winner run (ledger + equity attached). */
  result?: RunResult;
  /** Set when the window could not produce a verdict (empty sweep / failed run). */
  error?: string;
}

export interface WalkforwardAggregate {
  windows: number;
  failed: number;
  /** Windows whose OOS segment was profitable. */
  oosPositive: number;
  meanIsProfitPercent: number;
  meanOosProfitPercent: number;
  /** Walk-forward efficiency: per-bar OOS profit ÷ per-bar IS profit across all
   *  successful windows (NaN when total IS profit ≤ 0). ~1 means the edge holds
   *  out of sample; « 1 means the sweep was fitting noise. */
  walkForwardEfficiency: number;
}

export interface WalkforwardReport {
  symbol: string;
  /** The effective rank spec string. */
  rank: string;
  anchored: boolean;
  totalBars: number;
  /** Per-window segment lengths from the plan (IS length is the FIRST window's —
   *  anchored windows grow from there). */
  isBars: number;
  oosBars: number;
  windows: WalkforwardWindow[];
  aggregate: WalkforwardAggregate;
  warnings: string[];
  fetchError?: string;
}

/**
 * Tile `windows` OOS segments across the tail of `totalBars`, each preceded by
 * its in-sample stretch. Rolling: IS is a fixed-length slide; anchored: IS
 * always starts at 0. Solves `I + N·O = B` with `O = W·f`, remainder to IS.
 */
export function planWindows(
  totalBars: number,
  windows: number,
  oosFraction: number,
  anchored: boolean,
): WindowPlan[] {
  if (!Number.isInteger(windows) || windows < 1) {
    throw new Error(`walkforward: windows must be a positive integer (got ${windows})`);
  }
  if (!(oosFraction > 0 && oosFraction < 1)) {
    throw new Error(`walkforward: oos fraction must be in (0, 1) (got ${oosFraction})`);
  }
  const oosLen = Math.floor((totalBars * oosFraction) / (1 - oosFraction + windows * oosFraction));
  const isLen = totalBars - windows * oosLen;
  if (oosLen < 1 || isLen < 2) {
    throw new Error(
      `walkforward: ${totalBars} bars is too few for ${windows} window(s) at ` +
        `${oosFraction} OOS (IS ${isLen} / OOS ${oosLen} bars) — fetch more history`,
    );
  }
  const plans: WindowPlan[] = [];
  for (let k = 0; k < windows; k++) {
    const oosFrom = isLen + k * oosLen;
    plans.push({
      isFrom: anchored ? 0 : k * oosLen,
      isTo: oosFrom,
      oosFrom,
      oosTo: oosFrom + oosLen,
    });
  }
  return plans;
}

export async function walkforward(opts: WalkforwardOptions): Promise<WalkforwardReport> {
  const rank = opts.rank ?? 'strategy.netProfit';
  const anchored = opts.anchored ?? false;
  const runner = opts.runner ?? new LocalRunner();
  const pinerTf = toPinerTimeframe(opts.timeframe);
  const warnings: string[] = [];

  // Walk-forward judges out-of-sample PROFIT, so it needs a strategy. Reject
  // indicators up front (a compile error is left to the runs to surface).
  try {
    if (!compile(opts.source).metadata.isStrategy) {
      throw new Error('walkforward: the script is an indicator — walk-forward needs a strategy()');
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('walkforward:')) throw err;
  }

  const empty = (fetchError?: string): WalkforwardReport => ({
    symbol: opts.symbol,
    rank,
    anchored,
    totalBars: 0,
    isBars: 0,
    oosBars: 0,
    windows: [],
    aggregate: aggregate([]),
    warnings,
    fetchError,
  });

  let bars: Bar[];
  try {
    bars = await opts.provider.history(opts.symbol, opts.timeframe, opts.range);
    opts.onFetch?.(opts.symbol, bars.length);
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }

  const plans = planWindows(bars.length, opts.windows ?? 5, opts.oosFraction ?? 0.25, anchored);
  const windows: WalkforwardWindow[] = [];

  for (const [index, plan] of plans.entries()) {
    const w: WalkforwardWindow = {
      index,
      ...plan,
      isFromTime: bars[plan.isFrom]?.time,
      oosFromTime: bars[plan.oosFrom]?.time,
      oosToTime: bars[plan.oosTo - 1]?.time,
    };
    windows.push(w);

    // 1) Sweep the grid on the IS slice; the rank spec picks the winner.
    const isSlice = bars.slice(plan.isFrom, plan.isTo);
    const isRange: HistoryRange = { from: isSlice[0]!.time, to: isSlice[isSlice.length - 1]!.time };
    const swept = await sweep({
      source: opts.source,
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      provider: opts.provider,
      bars: isSlice,
      range: isRange,
      axes: opts.axes,
      baseInputs: opts.baseInputs,
      rank,
      top: 1,
      concurrency: opts.concurrency,
      backend: opts.backend,
      mintick: opts.mintick,
      metrics: opts.metrics,
      resolveSecurity: opts.resolveSecurity,
      maxCombos: opts.maxCombos,
      runner,
    });
    for (const warning of swept.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    const best = swept.ranked[0];
    if (!best) {
      w.error =
        swept.errors[0]?.error != null
          ? `in-sample sweep produced no ranked combo (first error: ${swept.errors[0].error})`
          : 'in-sample sweep produced no ranked combo';
      opts.onWindow?.(index + 1, plans.length);
      continue;
    }
    w.winner = best.inputs;
    w.winnerId = comboId(best.inputs);
    w.winnerValue = best.value;

    // 2) Run the winner over the full window (IS prefix = warmup, identical to
    //    the sweep run by determinism), then difference equity at the boundary.
    const job: Job = {
      id: `w${index}:${w.winnerId}`,
      source: opts.source,
      symbol: opts.symbol,
      timeframe: pinerTf,
      bars: bars.slice(plan.isFrom, plan.oosTo),
      inputs: { ...opts.baseInputs, ...best.inputs },
      mintick: opts.mintick,
      backend: opts.backend,
      metrics: opts.metrics,
      includeTrades: true,
    };
    if (opts.resolveSecurity !== false) {
      await resolveSecurity(opts.source, [job], opts.timeframe, pinerTf, opts.provider, {
        range: { from: job.bars[0]!.time, to: job.bars[job.bars.length - 1]!.time },
        inputs: job.inputs,
        backend: opts.backend,
        mintick: opts.mintick,
        concurrency: Math.max(1, opts.concurrency ?? 4),
      });
    }
    const result = await runner.run(job);
    w.result = result;
    if (!result.ok || !result.strategy) {
      w.error = `winner run failed: ${result.error ?? 'no strategy summary'}`;
      opts.onWindow?.(index + 1, plans.length);
      continue;
    }

    const boundary = plan.oosFrom - plan.isFrom; // OOS start, slice-relative
    const initial = result.strategy.initialCapital;
    const eqBoundary = equityAt(result.equityCurve!, boundary - 1) ?? initial;
    const eqEnd = equityAt(result.equityCurve!, result.equityCurve!.length - 1) ?? initial;
    w.isProfitPercent = ((eqBoundary - initial) / initial) * 100;
    w.oosProfitPercent = ((eqEnd - eqBoundary) / initial) * 100;
    w.oosTrades = result.trades!.filter((t) => t.exitBar >= boundary).length;
    const isBars = plan.isTo - plan.isFrom;
    const oosBars = plan.oosTo - plan.oosFrom;
    w.efficiency =
      w.isProfitPercent > 0 ? w.oosProfitPercent / oosBars / (w.isProfitPercent / isBars) : NaN;
    opts.onWindow?.(index + 1, plans.length);
  }

  return {
    symbol: opts.symbol,
    rank,
    anchored,
    totalBars: bars.length,
    isBars: plans[0]!.isTo - plans[0]!.isFrom,
    oosBars: plans[0]!.oosTo - plans[0]!.oosFrom,
    windows,
    aggregate: aggregate(windows),
    warnings,
  };
}

/** Last defined equity value at or before `bar` (piner's curve is sparse before
 *  the strategy activates). Undefined when nothing is defined that early. */
function equityAt(curve: number[], bar: number): number | undefined {
  for (let i = Math.min(bar, curve.length - 1); i >= 0; i--) {
    const v = curve[i];
    if (v != null && Number.isFinite(v)) return v;
  }
  return undefined;
}

function aggregate(windows: WalkforwardWindow[]): WalkforwardAggregate {
  const ok = windows.filter((w) => w.error == null);
  const mean = (vals: number[]): number =>
    vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;

  // Per-bar normalized profit ratio across all successful windows.
  let isProfit = 0;
  let oosProfit = 0;
  let isBars = 0;
  let oosBars = 0;
  for (const w of ok) {
    isProfit += w.isProfitPercent!;
    oosProfit += w.oosProfitPercent!;
    isBars += w.isTo - w.isFrom;
    oosBars += w.oosTo - w.oosFrom;
  }
  const wfe =
    ok.length && isProfit > 0 && oosBars > 0 ? oosProfit / oosBars / (isProfit / isBars) : NaN;

  return {
    windows: windows.length,
    failed: windows.length - ok.length,
    oosPositive: ok.filter((w) => w.oosProfitPercent! > 0).length,
    meanIsProfitPercent: mean(ok.map((w) => w.isProfitPercent!)),
    meanOosProfitPercent: mean(ok.map((w) => w.oosProfitPercent!)),
    walkForwardEfficiency: wfe,
  };
}
