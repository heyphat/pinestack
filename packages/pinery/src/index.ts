/**
 * pinery — the browser-safe data layer for the piner engine.
 *
 * Provides the `HistoryProvider` contract, canonical timeframe helpers, and
 * keyless / authenticated market-data adapters (Binance, OKX, Kraken, Alpaca,
 * Massive). The Node-only on-disk cache lives behind the separate
 * `@heyphat/pinery/node` entry so it is never bundled into a browser.
 */
export type { Bar, HistoryProvider, HistoryRange } from './provider.js';
export { toDataFeed, applyRange, dropUnclosedBars } from './provider.js';
export type { Timeframe } from './timeframe.js';
export {
  timeframeSeconds,
  toPinerTimeframe,
  parseTimeframe,
  pinerTimeframeToCanonical,
} from './timeframe.js';
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
export { StaticProvider, barsFromCsv } from './adapters/static.js';
