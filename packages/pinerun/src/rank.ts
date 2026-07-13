/**
 * Extractor + ranker. Reduces each `RunResult` to a single scalar via a small,
 * safe spec grammar (no eval) and sorts. Spec forms:
 *
 *   last(rsi)        aggregate `last` over the plot titled "rsi"
 *   max(#0)          aggregate `max` over plot index 0 (id-sorted)
 *   mean(close)      aggregate `mean` over plot titled "close"
 *   last             `last` over the first plot (bare aggregate)
 *   strategy.netProfit    a strategy summary field (broker-verbatim)
 *   strategy.sharpe       a derived risk-adjusted metric (strategy.metrics.*)
 *
 * Aggregates: last first min max mean sum count (count = non-NaN samples).
 */
import type { RunResult } from './result.js';

export type Aggregate = 'last' | 'first' | 'min' | 'max' | 'mean' | 'sum' | 'count';

const AGGREGATES = new Set<Aggregate>(['last', 'first', 'min', 'max', 'mean', 'sum', 'count']);
const STRATEGY_FIELDS = new Set([
  'initialCapital',
  'netProfit',
  'netProfitPercent',
  'grossProfit',
  'grossProfitPercent',
  'grossLoss',
  'grossLossPercent',
  'profitFactor',
  'wins',
  'losses',
  'closedTrades',
  'winRate',
  'avgTrade',
  'avgTradePercent',
  'avgWinningTrade',
  'avgLosingTrade',
  'maxDrawdown',
  'maxDrawdownPercent',
  'maxRunup',
  'maxRunupPercent',
  'maxContractsHeld',
  'evens',
  'totalCommission',
  'barsProcessed',
  'barsInMarket',
]);

/** Derived risk-adjusted metrics — live under `strategy.metrics` on the summary but
 *  rank with the same flat `strategy.<field>` grammar (no field-name overlap). */
const METRICS_FIELDS = new Set([
  'sharpe',
  'sortino',
  'volatilityPercent',
  'cagrPercent',
  'calmar',
  'exposurePercent',
  'expectancy',
  'maxConsecutiveWins',
  'maxConsecutiveLosses',
  'largestWin',
  'largestLoss',
  'avgBarsInTrade',
  'buyHoldReturnPercent',
  'outperformance',
]);

export interface RankSpec {
  kind: 'plot' | 'strategy';
  aggregate: Aggregate;
  /** For plot: a title, or `#<index>`, or null (first plot). For strategy: the field. */
  selector: string | null;
}

export interface RankedResult {
  result: RunResult;
  value: number;
}

export function parseRankSpec(spec: string): RankSpec {
  const s = spec.trim();

  const strat = /^strategy\.(\w+)$/.exec(s);
  if (strat) {
    const field = strat[1]!;
    if (!STRATEGY_FIELDS.has(field) && !METRICS_FIELDS.has(field)) {
      throw new Error(
        `rank: unknown strategy field "${field}" ` +
          `(${[...STRATEGY_FIELDS, ...METRICS_FIELDS].join(', ')})`,
      );
    }
    return { kind: 'strategy', aggregate: 'last', selector: field };
  }

  const call = /^(\w+)\s*\(\s*(.*?)\s*\)$/.exec(s);
  if (call) {
    const agg = call[1]! as Aggregate;
    if (!AGGREGATES.has(agg)) throw new Error(`rank: unknown aggregate "${agg}"`);
    const arg = call[2]!;
    return { kind: 'plot', aggregate: agg, selector: arg.length ? arg : null };
  }

  // Bare aggregate → over the first plot.
  if (AGGREGATES.has(s as Aggregate)) {
    return { kind: 'plot', aggregate: s as Aggregate, selector: null };
  }

  throw new Error(
    `rank: could not parse "${spec}" (try e.g. last(rsi), max(#0), strategy.netProfit)`,
  );
}

export function evalRank(result: RunResult, spec: RankSpec): number {
  if (!result.ok) return NaN;

  if (spec.kind === 'strategy') {
    const field = spec.selector!;
    const val = METRICS_FIELDS.has(field)
      ? result.strategy?.metrics?.[field as keyof NonNullable<RunResult['strategy']>['metrics']]
      : result.strategy?.[field as keyof NonNullable<RunResult['strategy']>];
    return typeof val === 'number' ? val : NaN;
  }

  const plot = selectPlot(result, spec.selector);
  if (!plot) return NaN;
  return aggregate(plot.data, spec.aggregate);
}

/** Resolve a plot rank selector: null → first plot, `#N` → by index, else by title. */
export function selectPlot(result: RunResult, selector: string | null) {
  if (result.plots.length === 0) return undefined;
  if (selector == null) return result.plots[0];
  const idx = /^#(\d+)$/.exec(selector);
  if (idx) return result.plots[Number(idx[1])];
  return result.plots.find((p) => p.title === selector) ?? undefined;
}

function aggregate(data: number[], agg: Aggregate): number {
  const finite = data.filter((v) => Number.isFinite(v));
  switch (agg) {
    case 'count':
      return finite.length;
    case 'first':
      return finite.length ? finite[0]! : NaN;
    case 'last':
      return finite.length ? finite[finite.length - 1]! : NaN;
    // reduce, not Math.min(...finite): spreading a long series (50k+ bars)
    // overflows the engine's argument limit.
    case 'min':
      return finite.length ? finite.reduce((a, b) => (b < a ? b : a)) : NaN;
    case 'max':
      return finite.length ? finite.reduce((a, b) => (b > a ? b : a)) : NaN;
    case 'sum':
      return finite.reduce((a, b) => a + b, 0);
    case 'mean':
      return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN;
    default:
      return NaN;
  }
}

export interface RankOptions {
  /** Sort direction. Default 'desc' (highest value first). */
  direction?: 'asc' | 'desc';
  /** Keep only the top N after sorting. */
  top?: number;
  /** Drop results whose value is NaN (failed/empty). Default true. Note ±Infinity
   *  is a legitimate value (e.g. profitFactor with zero losses) and is KEPT. */
  dropNaN?: boolean;
}

/**
 * The one sort/filter/slice pipeline, shared by scan (`rankResults`) and sweep —
 * any row shape carrying a ranked `value` works. Does not mutate `rows`.
 */
export function sortRanked<T extends { value: number }>(rows: T[], opts: RankOptions = {}): T[] {
  if (opts.top != null && !Number.isFinite(opts.top)) {
    throw new Error(`rank: top must be a finite number (got ${opts.top})`);
  }
  const dropNaN = opts.dropNaN ?? true;
  let ranked = dropNaN ? rows.filter((r) => !Number.isNaN(r.value)) : [...rows];
  const dir = opts.direction ?? 'desc';
  // Explicit comparison (not subtraction): Infinity - Infinity is NaN, which
  // would make ties among infinite values an invalid comparator result.
  const cmp = (x: number, y: number): number => (x < y ? -1 : x > y ? 1 : 0);
  ranked.sort((a, b) => (dir === 'desc' ? cmp(b.value, a.value) : cmp(a.value, b.value)));
  if (opts.top != null) ranked = ranked.slice(0, opts.top);
  return ranked;
}

export function rankResults(
  results: RunResult[],
  spec: RankSpec,
  opts: RankOptions = {},
): RankedResult[] {
  return sortRanked(
    results.map((result) => ({ result, value: evalRank(result, spec) })),
    opts,
  );
}
