/**
 * pinerun — programmable, parallel execution surface for the piner engine.
 *
 * Browser-safe core: the job model, the pure run primitive, an in-process runner,
 * the ranker, and the `scan` fan-out. The Node worker-thread pool lives behind the
 * separate `@heyphat/pinerun/node` entry.
 */
export type {
  Job,
  Bar,
  JobMetricsOptions,
  ResolvedMagnifierCoverage,
  ResolvedMagnifierAlignmentEvidence,
  ResolvedMagnifierDataset,
  ResolvedSecurityAlignmentEvidence,
  ResolvedSecurityDependencyIdentity,
  ResolvedSecurityDatasetProof,
  ResolvedSecurityRequestKind,
} from './job.js';
export { jobId } from './job.js';
export type {
  RunResult,
  PlotResult,
  AlertResult,
  StrategySummary,
  StrategyTrade,
  StrategyMetrics,
  BarMagnifierSummary,
  RunFailure,
} from './result.js';
export type { FillModelPresentation } from './fill-model.js';
export { formatFillModel } from './fill-model.js';
export { jobHash } from './hash.js';
export {
  executeJob,
  preparePinerEngineForRun,
  assertResolvedMagnifierDatasetForJob,
  toPinerBarMagnifierData,
  projectAuthoritativeBarMagnifierReport,
} from './execute.js';
export type {
  PinerBarMagnifierDataLike,
  PreparedMagnifierSourceIdentity,
  PreparedMagnifierBinding,
  PinerEnginePreparation,
  PreparePinerEngineForRunOptions,
} from './execute.js';
export type { Runner, RunAllOptions } from './runner.js';
export { LocalRunner, fanOut } from './runner.js';
export type { Aggregate, RankSpec, RankedResult, RankOptions } from './rank.js';
export { parseRankSpec, evalRank, rankResults, sortRanked, selectPlot } from './rank.js';
export type { ScanOptions, ScanReport } from './scan.js';
export { scan } from './scan.js';
export type {
  PortfolioOptions,
  PortfolioReport,
  SleeveContribution,
  PortfolioBarMagnifierSummary,
} from './portfolio.js';
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
  WalkforwardMagnifierCapObservation,
} from './walkforward.js';
export {
  walkforward,
  planWindows,
  inspectWalkforwardMagnifierCap,
  assertWalkforwardMagnifierCap,
  WALKFORWARD_MAGNIFIER_TARGET_BAR_LIMIT,
} from './walkforward.js';
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
  RollingSharpeChartOptions,
} from './chart.js';
export {
  equityChartAscii,
  priceChartAscii,
  overlayChartAscii,
  drawdownChartAscii,
  adaptiveRollingSharpeWindow,
  rollingSharpeAscii,
  sparkline,
} from './chart.js';
export type {
  MonthlyReturnsOptions,
  MonthlyTradesOptions,
  TopDrawdownsOptions,
  ProfitHistogramOptions,
  TradeOutcomeSequenceOptions,
  TradeDiagnosticOptions,
  DrawdownEpisode,
} from './tearsheet.js';
export {
  monthlyReturnsAscii,
  monthlyTradesAscii,
  topDrawdownsAscii,
  drawdownEpisodes,
  profitHistogramAscii,
  tradeOutcomeSequenceAscii,
  durationReturnAscii,
  maeMfeAscii,
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
  assertStaticSecurityForBarMagnifier,
  assertResolvedSecurityForBarMagnifier,
  deriveResolverIssuedSecurityPrefix,
  securityRangeForBarMagnifier,
  securityDatasetAcquisitionKey,
  PROBE_SYMBOL,
} from './security.js';
export type {
  ClassifiedRequests,
  DiscoverOptions,
  ResolveSecurityOptions,
  ResolverIssuedSecurityPrefix,
  SecurityDatasetAcquisitionKeyInput,
} from './security.js';

export type { BarMagnifierFailure, BarMagnifierFailureKind } from './failure.js';
export { BarMagnifierError, isBarMagnifierFailure } from './failure.js';
export type { PinerCapabilityAdapter } from './piner-capabilities.js';
export {
  SUPPORTED_BAR_MAGNIFIER_CONTRACT_VERSION,
  createPinerCapabilityAdapter,
  pinerCapabilities,
} from './piner-capabilities.js';
export type {
  MagnifierPreflight,
  MagnifierResolution,
  ResolveBarMagnifierOptions,
  MagnifierAcquisitionKeyInput,
  MagnifierDatasetAcquisitionKeyInput,
  MagnifierResolutionScope,
  BarMagnifierBudgetOptions,
} from './magnifier.js';
export {
  createMagnifierResolutionScope,
  assertBarMagnifierBudgets,
  magnifierMetadataKey,
  magnifierAcquisitionKey,
  magnifierDatasetAcquisitionKey,
  preflightBarMagnifier,
  preflightCompiledBarMagnifier,
  resolveBarMagnifier,
} from './magnifier.js';

// Self-update, shared by every binary this repo publishes: `pinetop upgrade`
// runs the same download → sha256-verify → atomic-swap path as `pinerun upgrade`
// rather than a second copy of it.
export type { UpgradableBinary, UpgradeOptions } from './upgrade.js';
export {
  checksumFor,
  compareVersions,
  runUpgrade,
  tagFromLatestLocation,
  upgradeAssetName,
} from './upgrade.js';
