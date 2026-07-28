/*
 * Provider factory — turns a (provider, assetClass) pair into a configured
 * `HistoryProvider`, hiding each adapter's own vocabulary for the same idea.
 */
import type {
  Bar,
  HistoryProvider,
  HistoryRange,
  InstrumentInfo,
  MarketDataProvider,
  ResolvedHistorySource,
} from './provider.js';
import { isMarketDataProvider } from './provider.js';
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
import { TigerProvider, type TigerMarketDataTransport } from './adapters/tiger.js';

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
    case 'tiger':
      throw new Error(
        'pinery: Tiger live data requires a transport; use createMarketDataProvider with an injected transport or the Node transport registry',
      );
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
    for (const provider of Object.values(this.overrides)) {
      if (provider && isMarketDataProvider(provider))
        throw new Error(
          'pinery: InstrumentRouter does not support live provider overrides; pass the MarketDataProvider directly',
        );
    }
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

/** Serializable provider configuration. Runtime-only transport injection is optional. */
export type ProviderConfig =
  | {
      provider: 'tiger';
      assetClass: 'futures';
      profile?: string;
      baseUrl?: string;
      transport?: TigerMarketDataTransport;
      pollIntervalMs?: number;
      retryDelayMs?: number;
      maxRetries?: number;
    }
  | {
      provider: 'csv';
      assetClass?: AssetClass;
      dataDir: string;
      cutoverTime: number;
      paceMs?: number;
      mintick?: number;
      qtyStep?: number;
      minOrderQty?: number;
      pointValue?: number;
      exchange?: string;
      expiry?: string;
    }
  | {
      provider: 'binance' | 'okx';
      assetClass?: 'crypto' | 'futures';
      baseUrl?: string;
      maxBars?: number;
    }
  | { provider: 'kraken'; assetClass?: 'crypto'; baseUrl?: string }
  | {
      provider: 'alpaca';
      assetClass?: 'equities';
      apiKey?: string;
      apiSecret?: string;
      feed?: 'iex' | 'sip';
      baseUrl?: string;
    }
  | { provider: 'massive'; assetClass?: 'equities'; apiKey?: string; baseUrl?: string };

export function assertProviderConfig(value: unknown): ProviderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('pinery: provider config must be an object');
  const config = value as Record<string, unknown>;
  if (
    typeof config.provider !== 'string' ||
    !['binance', 'okx', 'kraken', 'alpaca', 'massive', 'csv', 'tiger'].includes(config.provider)
  )
    throw new Error('pinery: provider config has an unknown provider');
  const provider = config.provider as DataProvider;
  if (
    config.assetClass != null &&
    (typeof config.assetClass !== 'string' ||
      !supportsPair(provider, config.assetClass as AssetClass))
  )
    throw new Error(
      `pinery: provider "${provider}" does not serve asset class "${String(config.assetClass)}"`,
    );

  if (provider === 'tiger') {
    assertAllowedKeys(config, [
      'provider',
      'assetClass',
      'profile',
      'baseUrl',
      'transport',
      'pollIntervalMs',
      'retryDelayMs',
      'maxRetries',
    ]);
    if (config.assetClass !== 'futures')
      throw new Error('pinery: Tiger live config requires assetClass "futures"');
    optionalString(config, 'profile');
    optionalString(config, 'baseUrl');
    optionalNumber(config, 'pollIntervalMs', { minimum: 0 });
    optionalNumber(config, 'retryDelayMs', { minimum: 0 });
    optionalNumber(config, 'maxRetries', { minimum: 0, integer: true });
    if (config.transport != null) assertTigerTransport(config.transport);
  } else if (provider === 'csv') {
    assertAllowedKeys(config, [
      'provider',
      'assetClass',
      'dataDir',
      'cutoverTime',
      'paceMs',
      'mintick',
      'qtyStep',
      'minOrderQty',
      'pointValue',
      'exchange',
      'expiry',
    ]);
    if (typeof config.dataDir !== 'string' || !config.dataDir)
      throw new Error('pinery: CSV live config requires dataDir');
    optionalNumber(config, 'cutoverTime', { minimum: 0, required: true });
    optionalNumber(config, 'paceMs', { minimum: 0 });
    for (const key of ['mintick', 'qtyStep', 'minOrderQty', 'pointValue'])
      optionalNumber(config, key, { minimum: Number.MIN_VALUE });
    optionalString(config, 'exchange');
    optionalString(config, 'expiry');
  } else if (provider === 'binance' || provider === 'okx') {
    assertAllowedKeys(config, ['provider', 'assetClass', 'baseUrl', 'maxBars']);
    optionalString(config, 'baseUrl');
    optionalNumber(config, 'maxBars', { minimum: 1, integer: true });
  } else if (provider === 'kraken') {
    assertAllowedKeys(config, ['provider', 'assetClass', 'baseUrl']);
    optionalString(config, 'baseUrl');
  } else if (provider === 'alpaca') {
    assertAllowedKeys(config, ['provider', 'assetClass', 'apiKey', 'apiSecret', 'feed', 'baseUrl']);
    optionalString(config, 'apiKey');
    optionalString(config, 'apiSecret');
    optionalString(config, 'baseUrl');
    if (config.feed != null && config.feed !== 'iex' && config.feed !== 'sip')
      throw new Error('pinery: feed must be "iex" or "sip"');
  } else {
    assertAllowedKeys(config, ['provider', 'assetClass', 'apiKey', 'baseUrl']);
    optionalString(config, 'apiKey');
    optionalString(config, 'baseUrl');
  }
  return value as ProviderConfig;
}

function assertAllowedKeys(config: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(config).find((key) => !allowed.includes(key));
  if (unknown)
    throw new Error(`pinery: ${String(config.provider)} config does not allow "${unknown}"`);
}

function assertTigerTransport(value: unknown): void {
  if (!value || (typeof value !== 'object' && typeof value !== 'function'))
    throw new Error('pinery: Tiger transport must be an object');
  const transport = value as Record<string, unknown>;
  if (typeof transport.resolveFuture !== 'function' || typeof transport.bars !== 'function')
    throw new Error('pinery: Tiger transport must implement resolveFuture() and bars()');
  for (const lifecycle of ['connect', 'disconnect'] as const) {
    if (transport[lifecycle] != null && typeof transport[lifecycle] !== 'function')
      throw new Error(`pinery: Tiger transport ${lifecycle} must be a function`);
  }
}

function optionalString(config: Record<string, unknown>, key: string): void {
  if (config[key] != null && typeof config[key] !== 'string')
    throw new Error(`pinery: ${key} must be a string`);
}

function optionalNumber(
  config: Record<string, unknown>,
  key: string,
  options: { minimum: number; integer?: boolean; required?: boolean },
): void {
  const value = config[key];
  if (value == null) {
    if (options.required) throw new Error(`pinery: ${key} is required`);
    return;
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < options.minimum ||
    (options.integer && !Number.isInteger(value))
  )
    throw new Error(`pinery: ${key} has an invalid value`);
}

/** Browser-safe live factory. Historical-only adapters fail rather than being polled by consumers. */
export function createMarketDataProvider(configInput: ProviderConfig): MarketDataProvider {
  const config = assertProviderConfig(configInput);
  if (config.provider === 'tiger') {
    if (!config.transport)
      throw new Error(
        'pinery: Tiger production transport is not bundled; inject a TigerMarketDataTransport',
      );
    return new TigerProvider({
      transport: config.transport,
      pollIntervalMs: config.pollIntervalMs,
      retryDelayMs: config.retryDelayMs,
      maxRetries: config.maxRetries,
    });
  }
  if (config.provider === 'csv')
    throw new Error(
      'pinery: CSV live provider is Node-only; use createNodeMarketDataProvider from @heyphat/pinery/node',
    );
  throw new Error(
    `pinery: provider "${config.provider}" is historical-only and cannot be selected for a live run`,
  );
}

/** Reject explicit provider/class addresses that disagree with live configuration. */
export function assertLiveSymbolMatchesConfig(symbol: string, configInput: ProviderConfig): string {
  const config = assertProviderConfig(configInput);
  const parsed = parseInstrumentAddress(symbol);
  if (parsed.explicitProvider && parsed.provider !== config.provider)
    throw new Error(
      `pinery: symbol provider "${parsed.provider}" does not match configured provider "${config.provider}"`,
    );
  const configuredClass = config.assetClass ?? defaultAssetClassForProvider(config.provider);
  if (parsed.assetClass && parsed.assetClass !== configuredClass)
    throw new Error(
      `pinery: symbol asset class "${parsed.assetClass}" does not match configured asset class "${configuredClass}"`,
    );
  return parsed.ticker;
}
