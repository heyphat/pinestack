/**
 * pinerun — programmable, parallel execution surface for the piner engine.
 *
 * Browser-safe core: the job model, the pure run primitive, an in-process runner,
 * the ranker, and the `scan` fan-out. The Node worker-thread pool lives behind the
 * separate `@heyphat/pinerun/node` entry.
 */
export type { Job, Bar, JobMetricsOptions } from './job.js';
export { jobId } from './job.js';
export type {
  RunResult,
  PlotResult,
  AlertResult,
  StrategySummary,
  StrategyTrade,
  StrategyMetrics,
} from './result.js';
export { jobHash } from './hash.js';
export { executeJob } from './execute.js';
export type { Runner, RunAllOptions } from './runner.js';
export { LocalRunner, fanOut } from './runner.js';
export type { Aggregate, RankSpec, RankedResult, RankOptions } from './rank.js';
export { parseRankSpec, evalRank, rankResults, sortRanked, selectPlot } from './rank.js';
export type { ScanOptions, ScanReport } from './scan.js';
export { scan } from './scan.js';
export type { PortfolioOptions, PortfolioReport, SleeveContribution } from './portfolio.js';
export { portfolio } from './portfolio.js';
export type { Sleeve } from './align.js';
export { unionTimes, alignEquity, combineEquity, returnCorrelation } from './align.js';
export type { BacktestOptions, BacktestReport } from './backtest.js';
export { backtest } from './backtest.js';
export type {
  WalkforwardOptions,
  WalkforwardReport,
  WalkforwardWindow,
  WalkforwardAggregate,
  WindowPlan,
} from './walkforward.js';
export { walkforward, planWindows } from './walkforward.js';
export {
  tradesToCsv,
  equityToCsv,
  equityPlotHtml,
  sweepPointsToCsv,
  sweepHeatmap,
} from './export.js';
export type { SweepHeatmapOptions } from './export.js';
export type {
  EquityChartOptions,
  PriceChartOptions,
  PriceChartTrade,
  OverlayChartOptions,
} from './chart.js';
export {
  equityChartAscii,
  priceChartAscii,
  overlayChartAscii,
  drawdownChartAscii,
  sparkline,
} from './chart.js';
export type {
  MonthlyReturnsOptions,
  TopDrawdownsOptions,
  ProfitHistogramOptions,
  DrawdownEpisode,
} from './tearsheet.js';
export {
  monthlyReturnsAscii,
  topDrawdownsAscii,
  drawdownEpisodes,
  profitHistogramAscii,
  correlationMatrixAscii,
} from './tearsheet.js';
export type { StarterTemplate, ScaffoldOptions } from './scaffold.js';
export {
  starterStrategy,
  isStarterTemplate,
  STARTER_TEMPLATES,
  STARTER_DESCRIPTIONS,
  SUGGESTED_FILE,
} from './scaffold.js';
export type { Axis, ComboBudgetOptions } from './params.js';
export {
  parseAxis,
  parseAxes,
  parseSpec,
  coerceToken,
  expandRange,
  cartesian,
  comboAt,
  sampleCombos,
  comboId,
  countCombos,
  assertComboBudget,
  DEFAULT_MAX_COMBOS,
  DEFAULT_SAMPLE_SEED,
} from './params.js';
export type { SweepOptions, SweepReport, SweepPoint } from './sweep.js';
export { sweep, validateAxes } from './sweep.js';
export {
  resolveSecurity,
  discoverSecurityRequests,
  classifyRequests,
  planFromStatic,
  resolveLowerFetchTf,
  resolveSameSymbolFetchTf,
  PROBE_SYMBOL,
} from './security.js';
export type { ClassifiedRequests, DiscoverOptions, ResolveSecurityOptions } from './security.js';
