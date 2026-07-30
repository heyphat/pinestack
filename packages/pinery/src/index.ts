/**
 * pinery — the browser-safe data layer for the piner engine.
 *
 * Provides the `HistoryProvider` contract, canonical timeframe helpers, and
 * keyless / authenticated market-data adapters (Binance, OKX, Kraken, Alpaca,
 * Massive). The Node-only on-disk cache lives behind the separate
 * `@heyphat/pinery/node` entry so it is never bundled into a browser.
 */
export type {
  Bar,
  HistoryProvider,
  HistoryRange,
  InstrumentInfo,
  UnixSecond,
  UnixMillisecond,
  InclusiveRangeSec,
  HalfOpenIntervalSec,
  HalfOpenIntervalMs,
  CoverageGapReason,
  CoverageGapSec,
  CoverageGapMs,
  HistoryTruncation,
  HistorySessionCalendar,
  HistoryAlignment,
  HistoryCoverageSemantics,
  RecordCoverageEvidence,
  HistoryCapabilities,
  HistoryRequest,
  AcquisitionProvenance,
  HistoryAcquisition,
  ResolvedHistorySource,
  ExactHistoryFailureKind,
  ExactHistoryFailure,
  ResolvedDataInstrument,
  ResolveDataInstrumentOptions,
  ClosedBarsOptions,
  MarketDataProvider,
  MarketDataErrorCode,
} from './provider.js';
export {
  ExactHistoryError,
  unixSecond,
  unixMillisecond,
  halfOpenIntervalSec,
  halfOpenIntervalMs,
  inclusiveRangeSec,
  inclusiveRangeSecToHalfOpen,
  inclusiveRangeSecToHalfOpenMs,
  halfOpenMsToInclusiveRangeSec,
  halfOpenMsToHalfOpenSecExact,
  halfOpenSecToHistoryRange,
  historyRequestRange,
  boundedHistoryRangeToHalfOpenMs,
  toDataFeed,
  applyRange,
  applyExactQueryRange,
  dropUnclosedBars,
  barCloseTime,
  normalizeBars,
  normalizeExpiryDate,
  assertResolvedDataInstrument,
  MarketDataError,
  isMarketDataProvider,
} from './provider.js';
export type {
  Timeframe,
  ExactTimeframeFailureKind,
  ExactTimeframeResult,
  FixedCanonicalTimeframe,
  CalendarCanonicalTimeframe,
  ParsedCanonicalTimeframe,
  ExactDivisorSelection,
} from './timeframe.js';
export {
  timeframeSeconds,
  toPinerTimeframe,
  parseTimeframe,
  pinerTimeframeToCanonical,
  parseCanonicalTimeframeExact,
  pineTimeframeToCanonicalExact,
  canonicalTimeframeToPineExact,
  canonicalTimeframeSecondsExact,
  selectLargestExactDivisor,
  resolveLowerFetchTf,
  resolveSameSymbolFetchTf,
} from './timeframe.js';
export type {
  HistoryAcquisitionPlan,
  HistoryAcquisitionPlanResult,
  ExactHistoryRequest,
} from './acquisition.js';
export {
  resolveHistorySource,
  planHistoryAcquisition,
  acquireExactHistory,
} from './acquisition.js';
export type { AggregateAlignment, AggregateSpec } from './aggregate.js';
export { HISTORY_AGGREGATION_VERSION, aggregateBars } from './aggregate.js';
export type {
  CalendarSessionPeriod,
  HistoryAcquisitionFromBarsOptions,
  RecordSpanFromBarsOptions,
} from './coverage.js';
export {
  assertCalendarPeriodCoverage,
  calendarPeriodIntersects,
  calendarSessionPeriods,
  createHistoryCacheIdentity,
  isCalendarSessionTimeframe,
  nonSecretBaseUrl,
  snapshotHistoryCapabilities,
  snapshotHistorySessionCalendar,
  snapshotHistoryTimeframes,
  snapshotResolvedHistorySource,
  historyAcquisitionFromBars,
  historyCapabilityRecordSpan,
  historyRecordSpanFromBars,
  isUtcWeekTimeframe,
  utcTimeframeAnchor,
  utcTimeframesNest,
  validateBarsExact,
  validateHistoryAcquisition,
} from './coverage.js';
export { fetchJson, type FetchJsonOptions } from './http.js';
export type {
  AssetClass,
  DataProvider,
  ProviderAssetClassDeclaration,
  ParsedInstrumentAddress,
} from './asset-class.js';
export {
  ASSET_CLASSES,
  DATA_PROVIDERS,
  ASSET_CLASS_REGISTRY,
  isAssetClass,
  isDataProvider,
  assetClassesForProvider,
  defaultAssetClassForProvider,
  supportsPair,
  coerceAssetClass,
  providerPrefix,
  assetClassCode,
  parseInstrumentAddress,
  encodeInstrumentAddress,
  canonicalizeInstrumentAddress,
} from './asset-class.js';
export {
  createProvider,
  resolveInstrument,
  InstrumentRouter,
  type CreateProviderOptions,
  type InstrumentRouterOptions,
  type ResolvedInstrument,
  type ProviderConfig,
  assertProviderConfig,
  createMarketDataProvider,
  assertLiveSymbolMatchesConfig,
} from './factory.js';
export {
  normalizeOkxSpot,
  normalizeOkxSwap,
  normalizeKrakenSpot,
  splitConcatenatedPair,
} from './symbols.js';

// Adapters
export {
  BinanceProvider,
  type BinanceProviderOptions,
  type BinanceMarket,
} from './adapters/binance.js';
export { OkxProvider, type OkxProviderOptions, type OkxMarket } from './adapters/okx.js';
export { KrakenProvider, type KrakenProviderOptions } from './adapters/kraken.js';
export { AlpacaProvider, type AlpacaProviderOptions } from './adapters/alpaca.js';
export { MassiveProvider, type MassiveProviderOptions } from './adapters/massive.js';
export {
  StaticProvider,
  barsFromCsv,
  type StaticProviderSeed,
  type StaticProviderOptions,
} from './adapters/static.js';

export { ReplayProvider, type ReplayProviderOptions } from './adapters/replay.js';
export {
  TigerProvider,
  type TigerProviderOptions,
  type TigerMarketDataTransport,
  type TigerFutureContract,
  type TigerBarsRequest,
  type TigerBarsResult,
} from './adapters/tiger.js';
