/*
 * Provider factory — turns a (provider, assetClass) pair into a configured
 * `HistoryProvider`, hiding each adapter's own vocabulary for the same idea.
 */
import type {
  Bar,
  HistoryProvider,
  HistoryRange,
  InstrumentInfo,
  ResolvedHistorySource,
} from './provider.js';
import { resolveHistorySource as resolveProviderHistorySource } from './acquisition.js';
import {
  coerceAssetClass,
  defaultAssetClassForProvider,
  parseInstrumentAddress,
  supportsPair,
  type AssetClass,
  type DataProvider,
} from './asset-class.js';
import { BinanceProvider } from './adapters/binance.js';
import { OkxProvider } from './adapters/okx.js';
import { KrakenProvider } from './adapters/kraken.js';
import { AlpacaProvider } from './adapters/alpaca.js';
import { MassiveProvider } from './adapters/massive.js';

/** Superset of per-adapter options; each adapter picks what it understands. */
export interface CreateProviderOptions {
  /** API key (Massive) / key id (Alpaca). Falls back to the adapter's env vars. */
  apiKey?: string;
  /** API secret (Alpaca). Falls back to the adapter's env vars. */
  apiSecret?: string;
  /** Alpaca data feed: 'iex' (free) or 'sip' (paid). */
  feed?: 'iex' | 'sip';
  /** Alpaca corporate-action adjustment. */
  adjustment?: 'raw' | 'split' | 'dividend' | 'all';
  /** Massive split adjustment. */
  adjusted?: boolean;
  /** Override the REST base (proxy, regional endpoint). */
  baseUrl?: string;
  /** Safety/acquisition cap forwarded to every adapter that supports one. */
  maxBars?: number;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

/**
 * Create a `HistoryProvider` for a (provider, assetClass) pair. Omitting
 * `assetClass` uses the provider's default (crypto for the exchanges, equities
 * for Alpaca/Massive). Throws for a pair the provider does not serve.
 */
export function createProvider(
  provider: DataProvider,
  assetClass?: AssetClass,
  opts: CreateProviderOptions = {},
): HistoryProvider {
  const cls = assetClass ?? defaultAssetClassForProvider(provider);
  if (!supportsPair(provider, cls)) {
    throw new Error(`pinery: provider "${provider}" does not serve asset class "${cls}"`);
  }
  const { apiKey, apiSecret, feed, adjustment, adjusted, baseUrl, maxBars, fetchImpl } = opts;
  switch (provider) {
    case 'binance':
      return new BinanceProvider({
        market: cls === 'futures' ? 'futures' : 'spot',
        baseUrl,
        maxBars,
        fetchImpl,
      });
    case 'okx':
      return new OkxProvider({
        market: cls === 'futures' ? 'swap' : 'spot',
        baseUrl,
        maxBars,
        fetchImpl,
      });
    case 'kraken':
      return new KrakenProvider({ baseUrl, fetchImpl });
    case 'alpaca':
      return new AlpacaProvider({
        keyId: apiKey,
        secretKey: apiSecret,
        feed,
        adjustment,
        maxBars,
        baseUrl,
        fetchImpl,
      });
    case 'massive':
      return new MassiveProvider({ apiKey, adjusted, maxBars, baseUrl, fetchImpl });
    case 'csv':
      // The CSV adapter reads the filesystem, so it lives behind the Node-only
      // entry and can't be constructed from this browser-safe module. Build it
      // yourself and hand it to the router.
      throw new Error(
        'pinery: the "csv" provider is Node-only — construct a CsvProvider from ' +
          '"@heyphat/pinery/node" and pass it via InstrumentRouterOptions.providers',
      );
  }
}

export interface InstrumentRouterOptions extends CreateProviderOptions {
  /** Provider used for bare tickers with no address prefix. Default 'binance'. */
  fallbackProvider?: DataProvider;
  /** Asset class for bare tickers. Default: the fallback provider's default. */
  fallbackAssetClass?: AssetClass;
  /**
   * Wrap each created pair provider exactly once (e.g. with the node disk
   * cache). Caching at the leaf keeps cache keys on the real provider ids.
   */
  wrap?: (provider: HistoryProvider) => HistoryProvider;
  /**
   * Pre-built provider instances, keyed by provider name. A named provider is
   * used as-is for every asset class — neither created via `createProvider`
   * nor passed through `wrap`.
   */
  providers?: Partial<Record<DataProvider, HistoryProvider>>;
}

/** Routes instrument addresses to lazily-created, reusable leaf providers. */
export class InstrumentRouter implements HistoryProvider {
  readonly id = 'instrument-router';
  private readonly fallbackProvider: DataProvider;
  private readonly fallbackAssetClass: AssetClass;
  private readonly providerOpts: CreateProviderOptions;
  private readonly wrap: (provider: HistoryProvider) => HistoryProvider;
  private readonly overrides: Partial<Record<DataProvider, HistoryProvider>>;
  private readonly pairs = new Map<string, HistoryProvider>();

  constructor(opts: InstrumentRouterOptions = {}) {
    const { fallbackProvider, fallbackAssetClass, wrap, providers, ...providerOpts } = opts;
    this.fallbackProvider = fallbackProvider ?? 'binance';
    this.fallbackAssetClass = coerceAssetClass(fallbackAssetClass, this.fallbackProvider);
    this.providerOpts = providerOpts;
    this.wrap = wrap ?? ((provider) => provider);
    this.overrides = providers ?? {};
  }

  history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const route = this.route(symbol);
    return route.provider.history(route.ticker, timeframe, range);
  }

  /** Resolve exact history through the same route as history(), preserving the
   * leaf/wrapper provider, its cache identity, and its adapter-normalized ticker. */
  async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
    const route = this.route(symbol);
    return resolveProviderHistorySource(route.provider, route.ticker);
  }

  /** Route instrument metadata exactly like history(); undefined when the
   * target adapter has no instrument() of its own. */
  async instrument(symbol: string): Promise<InstrumentInfo | undefined> {
    const route = this.route(symbol);
    return route.provider.instrument ? route.provider.instrument(route.ticker) : undefined;
  }

  private route(symbol: string): { provider: HistoryProvider; ticker: string } {
    const parsed = parseInstrumentAddress(symbol);
    const providerName = parsed.provider ?? this.fallbackProvider;
    const assetClass = parsed.provider
      ? coerceAssetClass(parsed.assetClass, providerName)
      : this.fallbackAssetClass;
    return {
      provider: this.providerFor(providerName, assetClass),
      ticker: parsed.ticker,
    };
  }

  private providerFor(provider: DataProvider, assetClass: AssetClass): HistoryProvider {
    const override = this.overrides[provider];
    if (override) return override;
    const key = `${provider}|${assetClass}`;
    let instance = this.pairs.get(key);
    if (!instance) {
      instance = this.wrap(createProvider(provider, assetClass, this.providerOpts));
      this.pairs.set(key, instance);
    }
    return instance;
  }
}

export interface ResolvedInstrument {
  /** Provider ready to serve the instrument's history. */
  provider: HistoryProvider;
  /** The ticker with any address prefix stripped (adapter-normalized on fetch). */
  ticker: string;
  assetClass: AssetClass;
}

/** Resolve a full instrument address into a configured provider + stripped ticker. */
export function resolveInstrument(
  input: string,
  fallbackProvider: DataProvider = 'binance',
  opts: CreateProviderOptions = {},
): ResolvedInstrument {
  const parsed = parseInstrumentAddress(input);
  const provider = parsed.provider ?? fallbackProvider;
  const assetClass = coerceAssetClass(parsed.assetClass, provider);
  return {
    provider: createProvider(provider, assetClass, opts),
    ticker: parsed.ticker,
    assetClass,
  };
}
