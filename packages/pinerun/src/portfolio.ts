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
  CompileError,
  PortfolioEngine,
  type PortfolioSleeveSpec,
  type StrategyMetrics,
} from '@heyphat/piner';
import type { Job, JobMetricsOptions, Bar } from './job.js';
import type { BarMagnifierSummary, StrategySummary, StrategyTrade } from './result.js';
import {
  assertResolvedMagnifierDatasetForJob,
  projectAuthoritativeBarMagnifierReport,
  toPinerBarMagnifierData,
} from './execute.js';
import {
  createMagnifierResolutionScope,
  preflightBarMagnifier,
  resolveBarMagnifier,
} from './magnifier.js';
import { compilePinerSource } from './piner-capabilities.js';
import { BarMagnifierError } from './failure.js';
import { assertResolvedSecurityForBarMagnifier, resolveSecurity } from './security.js';
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
  /** A request.security dependency failed to fetch; its series degrades to na/[]. */
  onSecurityError?: (label: string, error: string) => void;
}

export interface SleeveContribution {
  symbol: string;
  /** Chart bars processed by this sleeve (portfolio magnifier denominator input). */
  barsProcessed: number;
  /** Piner's authoritative optional per-sleeve block, never inferred from data. */
  barMagnifier?: BarMagnifierSummary;
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

export interface PortfolioBarMagnifierSummary extends BarMagnifierSummary {
  /** Sum of sleeve processed chart bars; never the master-clock union length. */
  processedBars: number;
  /** magnifiedBars / processedBars, validated to remain within 0..100. */
  coveragePercent: number;
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
  /** Piner aggregate block plus its sleeve-sum denominator. Omitted when no
   *  sleeve requested magnification. */
  barMagnifier?: PortfolioBarMagnifierSummary;
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

  // Compile/preflight first — bad scripts and exact-mode capability errors must
  // fail before any provider I/O or partial sleeve selection.
  let compiled;
  try {
    compiled = compilePinerSource(opts.source);
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
  const magnifierPreflight = preflightBarMagnifier(opts.source, pinerTf, undefined);
  const magnifierRequested = magnifierPreflight.requested;

  // Fetch every sleeve's history (bounded concurrency, slots keep basket order).
  const slots = new Array<Job | undefined>(opts.symbols.length);
  const fetchErrors: { symbol: string; error: string }[] = [];
  const fetchCauses = new Array<unknown>(opts.symbols.length);
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
      fetchCauses[i] = err;
      fetchErrors.push({ symbol, error });
      opts.onFetchError?.(symbol, error);
    }
  });
  if (magnifierRequested && fetchErrors.length > 0) {
    const index = fetchCauses.findIndex((cause) => cause !== undefined);
    const symbol = opts.symbols[index] ?? 'unknown';
    const cause = fetchCauses[index];
    throw cause instanceof Error
      ? new Error(
          `portfolio: magnified sleeve ${symbol} failed before atomic run: ${cause.message}`,
          {
            cause,
          },
        )
      : new Error(
          `portfolio: magnified sleeve ${symbol} failed before atomic run: ${String(cause)}`,
        );
  }
  const jobs = slots.filter((j): j is Job => j != null);
  if (jobs.length === 0) throw new Error('portfolio: no symbols with history to run');

  if (magnifierRequested) {
    // Resolve every sleeve's full symbol/window/provider-specific exact dataset
    // before constructing a PortfolioSleeveSpec. Any rejection aborts the whole
    // basket; no magnified sleeve is ever dropped.
    const magnifierScope = createMagnifierResolutionScope();
    await mapLimit(jobs, fetchConcurrency, async (job) => {
      await resolveBarMagnifier(job, opts.timeframe, opts.provider, {
        securityConcurrency: fetchConcurrency,
        onSecurityFetch: opts.onFetch ? (label, n) => opts.onFetch!(label, n) : undefined,
        onSecurityError: opts.onSecurityError,
        scope: magnifierScope,
      });
    });
    // Portfolio bypasses executeJob and calls piner's multi-sleeve engine
    // directly, so apply the same serialized Job/data boundary before creating
    // any sleeve spec. This keeps local, worker, and portfolio execution equally
    // fail-closed against stale or tampered envelopes/security proofs.
    for (const job of jobs) {
      assertResolvedMagnifierDatasetForJob(job, magnifierPreflight);
      assertResolvedSecurityForBarMagnifier(
        job.source,
        magnifierPreflight.securityDependencies,
        job,
      );
    }
  } else if (opts.resolveSecurity !== false) {
    // Legacy request.security host protocol, per sleeve — exactly scan's path.
    await resolveSecurity(opts.source, jobs, opts.timeframe, pinerTf, opts.provider, {
      range: opts.range,
      inputs: opts.inputs,
      backend: opts.backend,
      mintick: opts.mintick,
      concurrency: fetchConcurrency,
      onFetch: opts.onFetch ? (label, n) => opts.onFetch!(label, n) : undefined,
      onError: opts.onSecurityError,
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
    magnifierData: j.magnifier ? toPinerBarMagnifierData(j.magnifier) : undefined,
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
    const barMagnifier = projectAuthoritativeBarMagnifierReport(
      s.report as unknown,
      magnifierRequested,
    );
    return {
      symbol: s.symbol,
      barsProcessed: s.report.barsProcessed,
      ...(barMagnifier ? { barMagnifier } : {}),
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

  const aggregateBarMagnifier = projectAuthoritativeBarMagnifierReport(
    r as unknown,
    magnifierRequested,
  );
  let portfolioBarMagnifier: PortfolioBarMagnifierSummary | undefined;
  if (aggregateBarMagnifier) {
    const processedBars = res.sleeves.reduce((sum, sleeve) => sum + sleeve.report.barsProcessed, 0);
    const blocks = sleeveContribs.flatMap((sleeve) =>
      sleeve.barMagnifier ? [sleeve.barMagnifier] : [],
    );
    const sum = (
      field: keyof Pick<
        BarMagnifierSummary,
        'magnifiedBars' | 'fallbackBars' | 'capFallbackBars' | 'dataFallbackBars' | 'intrabarsUsed'
      >,
    ): number => blocks.reduce((total, block) => total + block[field], 0);
    const mismatches = [
      'magnifiedBars',
      'fallbackBars',
      'capFallbackBars',
      'dataFallbackBars',
      'intrabarsUsed',
    ].filter(
      (field) =>
        aggregateBarMagnifier[field as keyof BarMagnifierSummary] !==
        sum(field as Parameters<typeof sum>[0]),
    );
    const active = blocks.some((block) => block.active);
    const coverage = blocks.some((block) => block.coverage === 'mixed-data-fallback')
      ? 'mixed-data-fallback'
      : blocks.some((block) => block.coverage === 'tv-cap-fallback')
        ? 'tv-cap-fallback'
        : active
          ? 'complete'
          : 'no-data';
    if (aggregateBarMagnifier.active !== active) mismatches.push('active');
    if (aggregateBarMagnifier.coverage !== coverage) mismatches.push('coverage');
    if (blocks.some((block) => block.targetTimeframe !== aggregateBarMagnifier.targetTimeframe)) {
      mismatches.push('targetTimeframe');
    }
    const classified = aggregateBarMagnifier.magnifiedBars + aggregateBarMagnifier.fallbackBars;
    if (
      blocks.length !== res.sleeves.length ||
      mismatches.length > 0 ||
      classified !== processedBars
    ) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'malformed-piner-portfolio-bar-magnifier-report',
        message:
          'Piner portfolio Bar Magnifier state/counters must match per-sleeve reports and the processed-bar denominator',
        details: {
          sleeves: res.sleeves.length,
          blocks: blocks.length,
          mismatches,
          classified,
          processedBars,
          expectedActive: active,
          expectedCoverage: coverage,
        },
      });
    }
    const coveragePercent =
      processedBars > 0 ? (aggregateBarMagnifier.magnifiedBars / processedBars) * 100 : 0;
    if (!(coveragePercent >= 0 && coveragePercent <= 100)) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'piner-portfolio-bar-magnifier-coverage-out-of-range',
        message: 'Piner portfolio Bar Magnifier coverage must be between 0% and 100%',
        details: {
          coveragePercent,
          processedBars,
          magnifiedBars: aggregateBarMagnifier.magnifiedBars,
        },
      });
    }
    portfolioBarMagnifier = {
      ...aggregateBarMagnifier,
      processedBars,
      coveragePercent,
    };
  }

  const summary: StrategySummary = {
    ...(aggregateBarMagnifier ? { barMagnifier: aggregateBarMagnifier } : {}),
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
    ...(portfolioBarMagnifier ? { barMagnifier: portfolioBarMagnifier } : {}),
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
