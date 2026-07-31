/**
 * View models: `pinerun --json` payload → renderable shapes.
 *
 * §4.6 — `run.report` is the parsed `--json` payload, and view models derive
 * from it. Nothing in this file computes a metric; it narrows, selects, and
 * formats. Where a number is missing it stays missing (`undefined` → `—` on
 * screen) rather than being defaulted to zero, because a zero Sharpe and an
 * absent Sharpe are different facts about a run.
 *
 * The shapes mirror the emission sites in `pinerun/src/cli.ts`:
 *  backtest    → RunResult & { elapsedMs }
 *  sweep       → { symbol, rank, total, combos, gridTotal, axes, ranked[], errors[], … }
 *  walkforward → { symbol, rank, anchored, isBars, oosBars, windows[], aggregate, … }
 *  scan        → { rank, direction, ranked[], errors[], fetchErrors, elapsedMs }
 *  portfolio   → PortfolioReport (mode, summary, metrics, sleeves[], trades[], …)
 *  compare     → { symbol, timeframe, a: {label, result}, b: {label, result} }
 */

import type { StrategyMetrics, StrategySummary, StrategyTrade } from '@heyphat/pinerun';

export interface BacktestJson {
  id?: string;
  symbol?: string;
  timeframe?: string;
  ok?: boolean;
  bars?: number;
  strategy?: StrategySummary;
  trades?: StrategyTrade[];
  equityCurve?: number[];
  barTimes?: number[];
  closes?: number[];
  diagnostics?: string[];
  error?: string;
  elapsedMs?: number;
}

export interface SweepAxisJson {
  name: string;
  values: unknown[];
}

export interface SweepRankedJson {
  symbol?: string;
  inputs?: Record<string, unknown>;
  value?: number;
  bars?: number;
  strategy?: StrategySummary;
  trades?: StrategyTrade[];
  equityCurve?: number[];
  barTimes?: number[];
}

export interface SweepJson {
  symbol?: string;
  symbols?: string[];
  rank?: string;
  direction?: string;
  total?: number;
  combos?: number;
  gridTotal?: number;
  sample?: number;
  seed?: number;
  axes?: SweepAxisJson[];
  warnings?: string[];
  ranked?: SweepRankedJson[];
  errors?: { symbol?: string; id?: string; error?: string }[];
  fetchErrors?: { symbol: string; error: string }[];
  elapsedMs?: number;
}

export interface WalkforwardWindowJson {
  index?: number;
  isFrom?: number;
  isTo?: number;
  oosFrom?: number;
  oosTo?: number;
  isFromTime?: number;
  oosFromTime?: number;
  oosToTime?: number;
  winner?: Record<string, unknown>;
  winnerId?: string;
  winnerValue?: number;
  isProfitPercent?: number;
  oosProfitPercent?: number;
  oosTrades?: number;
  efficiency?: number;
  error?: string;
}

export interface WalkforwardAggregateJson {
  windows?: number;
  failed?: number;
  oosPositive?: number;
  meanIsProfitPercent?: number;
  meanOosProfitPercent?: number;
  walkForwardEfficiency?: number;
}

export interface WalkforwardJson {
  symbol?: string;
  rank?: string;
  anchored?: boolean;
  totalBars?: number;
  isBars?: number;
  oosBars?: number;
  windows?: WalkforwardWindowJson[];
  aggregate?: WalkforwardAggregateJson;
  warnings?: string[];
  elapsedMs?: number;
}

export interface ScanRankedJson {
  symbol?: string;
  value?: number;
  bars?: number;
  strategy?: StrategySummary;
  trades?: StrategyTrade[];
  equityCurve?: number[];
  barTimes?: number[];
}

export interface ScanJson {
  rank?: string;
  direction?: string;
  ranked?: ScanRankedJson[];
  errors?: { symbol?: string; error?: string }[];
  fetchErrors?: { symbol: string; error: string }[];
  elapsedMs?: number;
}

export interface SleeveJson {
  symbol?: string;
  barsProcessed?: number;
  funding?: number;
  netProfit?: number;
  closedTrades?: number;
  marginCalls?: number;
  contributionPercent?: number;
  returnCorrelation?: number;
  equityCurve?: number[];
  barTimes?: number[];
  trades?: StrategyTrade[];
}

export interface PortfolioJson {
  mode?: 'isolated' | 'shared';
  symbols?: string[];
  times?: number[];
  equityCurve?: number[];
  initialCapital?: number;
  summary?: StrategySummary;
  metrics?: StrategyMetrics;
  trades?: StrategyTrade[];
  sleeves?: SleeveJson[];
  fetchErrors?: { symbol: string; error: string }[];
  elapsedMs?: number;
}

export interface CompareSideJson {
  label?: string;
  result?: BacktestJson;
}

export interface CompareJson {
  symbol?: string;
  timeframe?: string;
  a?: CompareSideJson;
  b?: CompareSideJson;
}

/**
 * One tearsheet row: the CLI's `label · money · percent` shape, where either
 * value column may be blank (`buy & hold` has only a percent, `sharpe` only a
 * number).
 */
export interface MetricRow {
  label: string;
  /** The money / ratio column. */
  value: string;
  /** The percent column, or a parenthetical like `(7W 0L 0E)`. */
  percent?: string;
  /** -1 loss, 0 neutral, 1 gain — the pane maps this to a style. */
  sign: number;
}

export function metricRow(label: string, value: string, sign = 0): MetricRow {
  return { label, value, sign };
}

/**
 * The CLI's own formatters, so a value reads identically in both surfaces.
 * `printTearsheet` uses exactly these three (cli.ts fmtNum / fmtPct / fmtPf).
 */
export function fmtNum(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'na';
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e9)) return v.toExponential(4);
  return v.toFixed(abs >= 100 ? 2 : 4);
}

export function fmtPct(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'na';
  return `${v.toFixed(2)}%`;
}

/** Ratios: `inf` is a real answer here, not a missing one. */
export function fmtPf(v: number | undefined): string {
  if (v === Infinity) return 'inf';
  if (v == null || !Number.isFinite(v)) return 'na';
  return v.toFixed(2);
}

/** One labelled section of the tearsheet. */
export interface MetricSection {
  title: string;
  rows: MetricRow[];
}

function row(label: string, value: string, percent?: string, sign = 0): MetricRow {
  return { label, value, percent, sign };
}

/**
 * The tearsheet, as `pinerun backtest` prints it: three sections — RETURNS,
 * RISK, TRADES — in the CLI's order, with the CLI's labels, fields and
 * formatters. `printTearsheet` in cli.ts is the reference; this is a
 * transcription of it, not a selection from it, so a reader can hold the two
 * side by side and check them off.
 *
 * The CLI lays each row out as `label · money · percent`, either of the last two
 * blank. That shape is preserved rather than collapsed, because which column a
 * number lands in is how you know whether you are reading currency or a rate.
 */
export function tearsheetSections(strategy: StrategySummary | undefined): MetricSection[] {
  if (strategy == null) return [];
  const s = strategy;
  const m = s.metrics;

  return [
    {
      title: 'RETURNS',
      rows: [
        row('net profit', fmtNum(s.netProfit), fmtPct(s.netProfitPercent), Math.sign(s.netProfit)),
        row('gross profit', fmtNum(s.grossProfit), fmtPct(s.grossProfitPercent), 1),
        row('gross loss', fmtNum(s.grossLoss), fmtPct(s.grossLossPercent), -1),
        row(
          'buy & hold',
          '',
          fmtPct(m?.buyHoldReturnPercent),
          Math.sign(m?.buyHoldReturnPercent ?? 0),
        ),
        row('outperformance', fmtNum(m?.outperformance), '', Math.sign(m?.outperformance ?? 0)),
        row('CAGR', '', fmtPct(m?.cagrPercent), Math.sign(m?.cagrPercent ?? 0)),
      ],
    },
    {
      title: 'RISK',
      rows: [
        // The report carries drawdown/runup as positive magnitudes; the sign
        // column is what marks one a loss, exactly as the CLI's colouring does.
        row('max drawdown', fmtNum(s.maxDrawdown), fmtPct(s.maxDrawdownPercent), -1),
        row('max runup', fmtNum(s.maxRunup), fmtPct(s.maxRunupPercent), 1),
        row('volatility (annual)', '', fmtPct(m?.volatilityPercent)),
        row('sharpe', fmtPf(m?.sharpe), '', Math.sign(m?.sharpe ?? 0)),
        row('sortino', fmtPf(m?.sortino), '', Math.sign(m?.sortino ?? 0)),
        row('calmar', fmtPf(m?.calmar), '', Math.sign(m?.calmar ?? 0)),
        row('exposure', '', fmtPct(m?.exposurePercent)),
      ],
    },
    {
      title: 'TRADES',
      rows: [
        row('closed trades', String(s.closedTrades), `(${s.wins}W ${s.losses}L ${s.evens}E)`),
        row('win rate', '', fmtPct(s.winRate * 100)),
        row('profit factor', profitFactor(s), '', profitFactorSign(s)),
        row('expectancy', fmtNum(m?.expectancy), '', Math.sign(m?.expectancy ?? 0)),
        row('avg win / loss', `${fmtNum(s.avgWinningTrade)} / ${fmtNum(s.avgLosingTrade)}`),
        row('largest win / loss', `${fmtNum(m?.largestWin)} / ${fmtNum(m?.largestLoss)}`),
        row(
          'max consecutive',
          `${m?.maxConsecutiveWins ?? 'na'} win / ${m?.maxConsecutiveLosses ?? 'na'} loss`,
        ),
        row('avg bars in trade', fmtPf(m?.avgBarsInTrade)),
        row('commission paid', fmtNum(s.totalCommission), '', -1),
        row('max contracts held', fmtNum(s.maxContractsHeld)),
      ],
    },
  ];
}

/**
 * The rail's footer: the CLI's closing line, compacted to fit a ~38-column rail.
 * `annualized at 8760.00 periods/yr` becomes `8760/yr` — the same fact, and the
 * only part of it that ever varies is the number.
 */
export function tearsheetFooter(strategy: StrategySummary | undefined): string[] {
  if (strategy == null) return [];
  const out = [`initial capital ${fmtNum(strategy.initialCapital)}`];
  const periods = strategy.metrics?.periodsPerYear;
  if (periods != null && Number.isFinite(periods)) {
    out.push(`${Number.isInteger(periods) ? periods : periods.toFixed(2)}/yr`);
  }
  return out;
}

/**
 * The fill model, which the CLI prints directly under the tearsheet header.
 * It belongs in the pane legend rather than the footer: it is a statement about
 * how every number below was produced, not a summary of them.
 */
export function fillModelNote(strategy: StrategySummary | undefined): string | undefined {
  if (strategy == null) return undefined;
  const parts: string[] = [];
  if (strategy.barMagnifier) parts.push(`magnifier ${strategy.barMagnifier.coverage}`);
  if (strategy.calcOnOrderFills) parts.push('calc-on-order-fills');
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * `profitFactor` is `grossProfit / |grossLoss|`, so a run with no losing trade
 * is Infinity — and `JSON.stringify` writes Infinity as `null`. The CLI prints
 * ∞ because it never crosses the wire; over `--json` the value arrives absent.
 *
 * Rather than show `—` for a perfectly well-defined result, the sibling fields
 * that *did* survive are read: gross loss of zero against a positive gross
 * profit is exactly the Infinity case. A genuinely missing value still shows —.
 */
export function profitFactor(strategy: StrategySummary): string {
  const value = strategy.profitFactor;
  if (value === Infinity) return '∞';
  if (value == null || !Number.isFinite(value)) {
    if (strategy.grossLoss === 0 && strategy.grossProfit > 0) return '∞';
    return '—';
  }
  return value.toFixed(2);
}

function profitFactorSign(strategy: StrategySummary): number {
  const value = strategy.profitFactor;
  if (value == null || !Number.isFinite(value)) {
    return strategy.grossLoss === 0 && strategy.grossProfit > 0 ? 1 : 0;
  }
  return value >= 1 ? 1 : -1;
}

/** `pinerun`'s own footer values, for the breadcrumb's right side (§8). */
export function runFooter(report: BacktestJson | undefined): string {
  if (report == null) return '';
  const parts: string[] = [];
  if (report.bars != null) parts.push(`bars ${report.bars.toLocaleString('en-US')}`);
  if (report.timeframe) parts.push(report.timeframe);
  const magnifier = report.strategy?.barMagnifier;
  if (magnifier) parts.push(`magnifier ${magnifier.coverage}`);
  if (report.strategy?.calcOnOrderFills) parts.push('calc-on-order-fills');
  return parts.join(' · ');
}
