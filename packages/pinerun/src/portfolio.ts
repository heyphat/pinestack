/**
 * portfolio — one Pine strategy over N symbols as ONE backtest with a real
 * capital model, driven by piner's PortfolioEngine (portfolio plan §7–§8;
 * semantics: piner docs/portfolio-semantics.md).
 *
 * pinerun keeps its host role: fetch every sleeve's bars through the provider
 * (bounded concurrency, exactly like scan), resolve request.security
 * dependencies per sleeve, then hand piner the injected bars and read back the
 * portfolio report. All strategy math happens in piner — the one derived thing
 * computed here is the contribution table (plain arithmetic on aligned curves).
 *
 * Modes (spec S1): `isolated` (default) — N private sub-accounts funded wᵢ·P;
 * equals the classic per-symbol runs summed (piner gate V3 proves bit-for-bit).
 * `shared` — one pot: sizing, funds checks, margin, and risk rules read
 * portfolio equity; trades can differ from any per-symbol run.
 */
import type { HistoryProvider, HistoryRange } from '@heyphat/pinery';
import { toPinerTimeframe } from '@heyphat/pinery';
import {
  compile,
  CompileError,
  PortfolioEngine,
  type PortfolioSleeveSpec,
  type StrategyMetrics,
} from '@heyphat/piner';
import type { Job, JobMetricsOptions, Bar } from './job.js';
import type { StrategySummary, StrategyTrade } from './result.js';
import { resolveSecurity } from './security.js';
import { resolveInstrument } from './instrument.js';
import { alignEquity, returnCorrelation, type Sleeve } from './align.js';

export interface PortfolioOptions {
  source: string;
  /** Basket, in priority order — at equal timestamps earlier symbols fill first (spec S4). */
  symbols: string[];
  /** Canonical pinery timeframe (e.g. "1h"); one timeframe per basket. */
  timeframe: string;
  provider: HistoryProvider;
  range?: HistoryRange;
  /** Capital model. Default 'isolated'. */
  mode?: 'isolated' | 'shared';
  /** Total pot P. Default N × the script's initial_capital (spec S1). */
  capital?: number;
  /** Per-symbol funding fractions (isolated mode; normalized). Default equal. */
  weights?: Record<string, number>;
  inputs?: Record<string, unknown>;
  backend?: 'js' | 'interp';
  mintick?: number;
  /** Lot-step override; unset → provider instrument metadata → piner default. */
  minQty?: number;
  /** Fetch concurrency (default 4), as scan. */
  concurrency?: number;
  /** Host conventions for the portfolio metrics (periodsPerYear / riskFreeRate). */
  metrics?: JobMetricsOptions;
  /** Resolve request.security dependencies per sleeve. Default true. */
  resolveSecurity?: boolean;
  onFetch?: (symbol: string, bars: number) => void;
  onFetchError?: (symbol: string, error: string) => void;
}

export interface SleeveContribution {
  symbol: string;
  /** wᵢ·P (isolated); 0 under shared — the pot is not pre-split. */
  funding: number;
  netProfit: number;
  closedTrades: number;
  marginCalls: number;
  /** netProfitᵢ / portfolio netProfit (NaN when the portfolio netted 0). */
  contributionPercent: number;
  /** Correlation of this sleeve's per-bar equity deltas vs the portfolio's.
   *  NaN under shared mode — sleeve curves sample POT equity there (spec S2),
   *  so the correlation would be identically 1 and say nothing. */
  returnCorrelation: number;
  /** The sleeve's own equity curve and bar times (ms) — broker-verbatim. */
  equityCurve: number[];
  barTimes: number[];
  trades: StrategyTrade[];
}

export interface PortfolioReport {
  mode: 'isolated' | 'shared';
  symbols: string[];
  /** Master clock (union of sleeve bar times), ms. */
  times: number[];
  /** Portfolio equity per master bar. */
  equityCurve: number[];
  initialCapital: number;
  /** Broker-verbatim-shaped portfolio stats (percent fields relative to the pot;
   *  fields with no portfolio meaning — avgTradePercent, maxContractsHeld — are NaN). */
  summary: StrategySummary;
  /** piner's computeStrategyMetrics over the portfolio curve on the master clock. */
  metrics: StrategyMetrics;
  /** Merged ledger: symbol-tagged, exit-time sorted, cumProfit portfolio-wide. */
  trades: StrategyTrade[];
  sleeves: SleeveContribution[];
  /** Symbols dropped before the run (fetch failure / empty history). Under shared
   *  mode a smaller basket is a DIFFERENT backtest — callers should surface these. */
  fetchErrors: { symbol: string; error: string }[];
  elapsedMs: number;
}

export async function portfolio(opts: PortfolioOptions): Promise<PortfolioReport> {
  const started = Date.now();
  const mode = opts.mode ?? 'isolated';
  const pinerTf = toPinerTimeframe(opts.timeframe);
  const fetchConcurrency = Math.max(1, opts.concurrency ?? 4);

  // Compile first — a bad script should fail before any network I/O.
  let compiled;
  try {
    compiled = compile(opts.source);
  } catch (err) {
    throw new Error(`portfolio: ${err instanceof CompileError ? err.message : String(err)}`);
  }
  const diagErrors = compiled.diagnostics.filter((d) => d.severity === 'error');
  if (diagErrors.length > 0)
    throw new Error(`portfolio: compile: ${diagErrors.map((d) => d.message).join('; ')}`);
  if (!compiled.metadata.isStrategy)
    throw new Error(
      'portfolio: the script is an indicator (no strategy() call) — portfolio needs a strategy',
    );

  // Fetch every sleeve's history (bounded concurrency, slots keep basket order).
  const slots = new Array<Job | undefined>(opts.symbols.length);
  const fetchErrors: { symbol: string; error: string }[] = [];
  await mapLimit(opts.symbols, fetchConcurrency, async (symbol, i) => {
    try {
      const bars = await opts.provider.history(symbol, opts.timeframe, opts.range);
      if (bars.length === 0) throw new Error('no bars in range');
      opts.onFetch?.(symbol, bars.length);
      const inst = await resolveInstrument(opts.provider, symbol, opts);
      slots[i] = {
        source: opts.source,
        symbol,
        timeframe: pinerTf,
        bars,
        inputs: opts.inputs,
        mintick: inst.mintick,
        minQty: inst.minQty,
        backend: opts.backend,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      fetchErrors.push({ symbol, error });
      opts.onFetchError?.(symbol, error);
    }
  });
  const jobs = slots.filter((j): j is Job => j != null);
  if (jobs.length === 0) throw new Error('portfolio: no symbols with history to run');

  // request.security host protocol, per sleeve — exactly scan's path.
  if (opts.resolveSecurity !== false) {
    await resolveSecurity(opts.source, jobs, opts.timeframe, pinerTf, opts.provider, {
      range: opts.range,
      inputs: opts.inputs,
      backend: opts.backend,
      mintick: opts.mintick,
      concurrency: fetchConcurrency,
      onFetch: opts.onFetch ? (label, n) => opts.onFetch!(label, n) : undefined,
    });
  }

  // Weights: by-symbol record → basket-order array over the sleeves that survived.
  let weights: number[] | undefined;
  if (opts.weights && mode === 'isolated') {
    const missing = jobs.filter((j) => opts.weights![j.symbol] == null).map((j) => j.symbol);
    if (missing.length > 0)
      throw new Error(`portfolio: --weights missing symbols: ${missing.join(', ')}`);
    weights = jobs.map((j) => opts.weights![j.symbol]!);
  }

  // One engine run over the injected bars (piner Bars are ms-timed).
  const sleeves: PortfolioSleeveSpec[] = jobs.map((j) => ({
    symbol: j.symbol,
    timeframe: j.timeframe,
    mintick: j.mintick,
    minQty: j.minQty,
    bars: toPinerBars(j.bars),
    securityBars: j.securityBars
      ? Object.fromEntries(Object.entries(j.securityBars).map(([k, v]) => [k, toPinerBars(v)]))
      : undefined,
  }));
  const engine = new PortfolioEngine(compiled, {
    mode,
    capital: opts.capital,
    weights,
    backend: opts.backend,
    inputs: opts.inputs,
  });
  const res = engine.run(sleeves);
  const metrics = engine.metrics(opts.metrics);
  const r = res.report;

  // Contribution table — the one derived block pinerun computes (plain arithmetic).
  const sleeveContribs: SleeveContribution[] = res.sleeves.map((s) => {
    // Return correlation only makes sense in isolated mode: under shared mode
    // every sleeve's curve samples POT equity (spec S2), so it would be
    // identically 1. Forward-fill the sleeve onto the master clock first.
    const aligned: Sleeve = {
      symbol: s.symbol,
      barTimes: s.barTimes,
      equityCurve: s.report.equityCurve,
      initialCapital: s.funding,
    };
    return {
      symbol: s.symbol,
      funding: s.funding,
      netProfit: s.report.netProfit,
      closedTrades: s.report.closedTrades.length,
      marginCalls: s.report.marginCalls,
      contributionPercent: r.netProfit !== 0 ? (s.report.netProfit / r.netProfit) * 100 : NaN,
      returnCorrelation:
        mode === 'isolated'
          ? returnCorrelation(alignEquity(aligned, res.times), r.equityCurve)
          : NaN,
      equityCurve: s.report.equityCurve,
      barTimes: s.barTimes,
      trades: s.report.closedTrades.map((t) => ({ ...t })),
    };
  });

  const summary: StrategySummary = {
    initialCapital: r.initialCapital,
    netProfit: r.netProfit,
    netProfitPercent: pct(r.netProfit, r.initialCapital),
    grossProfit: r.grossProfit,
    grossProfitPercent: pct(r.grossProfit, r.initialCapital),
    grossLoss: r.grossLoss,
    grossLossPercent: pct(r.grossLoss, r.initialCapital),
    profitFactor: r.grossLoss !== 0 ? r.grossProfit / Math.abs(r.grossLoss) : Infinity,
    wins: r.wins,
    losses: r.losses,
    evens: r.evens,
    closedTrades: r.closedTrades.length,
    winRate: r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : 0,
    avgTrade: r.closedTrades.length > 0 ? r.netProfit / r.closedTrades.length : 0,
    avgTradePercent: NaN, // per-trade entry values live in the sleeves; no portfolio meaning
    avgWinningTrade: r.wins > 0 ? r.grossProfit / r.wins : 0,
    avgLosingTrade: r.losses > 0 ? r.grossLoss / r.losses : 0,
    maxDrawdown: r.maxDrawdown,
    maxDrawdownPercent: r.maxDrawdownPercent, // close-to-close on the portfolio curve (plan §7)
    maxRunup: r.maxRunup,
    maxRunupPercent: r.maxRunupPercent,
    maxContractsHeld: NaN, // contracts of different symbols don't add
    totalCommission: r.totalCommission,
    barsProcessed: r.barsProcessed,
    barsInMarket: r.barsInMarket,
    metrics,
  };

  return {
    mode,
    symbols: res.symbols,
    times: res.times,
    equityCurve: r.equityCurve,
    initialCapital: r.initialCapital,
    summary,
    metrics,
    trades: r.closedTrades.map((t) => ({ ...t })),
    sleeves: sleeveContribs,
    fetchErrors,
    elapsedMs: Date.now() - started,
  };
}

function pct(v: number, base: number): number {
  return base !== 0 ? (v / base) * 100 : 0;
}

/** pinery bars carry unix seconds; piner wants ms. Ms-native feeds pass through. */
function toPinerBars(bars: Bar[]): Bar[] {
  return bars.map((b) => (b.time >= 1e12 ? b : { ...b, time: b.time * 1000 }));
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}
