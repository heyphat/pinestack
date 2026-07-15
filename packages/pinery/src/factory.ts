/**
 * Provider factory — turns a (provider, assetClass) pair into a configured
 * `HistoryProvider`, hiding each adapter's own vocabulary for the same idea
 * (Binance calls futures a `market: 'futures'`, OKX calls it `market: 'swap'`).
 * Unsupported pairs throw with a message naming the offending pair.
 */
import type { Bar, HistoryProvider, HistoryRange, InstrumentInfo } from './provider.js';
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
  /** Override the REST base (proxy, regional endpoint). */
  baseUrl?: string;
  /** Safety cap on total bars fetched when paging a range (Binance, OKX). */
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
  const { apiKey, apiSecret, feed, baseUrl, maxBars, fetchImpl } = opts;
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
      return new AlpacaProvider({ keyId: apiKey, secretKey: apiSecret, feed, baseUrl, fetchImpl });
    case 'massive':
      return new MassiveProvider({ apiKey, baseUrl, fetchImpl });
  }
}

export interface InstrumentRouterOptions extends CreateProviderOptions {
  /** Provider used for bare tickers with no address prefix. Default 'binance'. */
  fallbackProvider?: DataProvider;
  /** Asset class for bare tickers. Default: the fallback provider's default. */
  fallbackAssetClass?: AssetClass;
  /**
   * Wrap each created pair provider exactly once (e.g. with the node disk
   * cache). Caching at the leaf keeps cache keys on the real provider ids
   * ("binance-futures"), not the router's.
   */
  wrap?: (provider: HistoryProvider) => HistoryProvider;
}

/**
 * A `HistoryProvider` that resolves each symbol as an instrument address and
 * routes it to the right (provider, assetClass) adapter with the prefix
 * stripped — so one provider instance can serve a mixed universe like
 * `BI:FU:BTCUSDT, KR:BTC/USD, AAPL`. Bare tickers go to the fallback pair;
 * pair providers are created lazily and reused across calls.
 */
export class InstrumentRouter implements HistoryProvider {
  readonly id = 'instrument-router';
  private readonly fallbackProvider: DataProvider;
  private readonly fallbackAssetClass: AssetClass;
  private readonly providerOpts: CreateProviderOptions;
  private readonly wrap: (provider: HistoryProvider) => HistoryProvider;
  private readonly pairs = new Map<string, HistoryProvider>();

  constructor(opts: InstrumentRouterOptions = {}) {
    const { fallbackProvider, fallbackAssetClass, wrap, ...providerOpts } = opts;
    this.fallbackProvider = fallbackProvider ?? 'binance';
    this.fallbackAssetClass = coerceAssetClass(fallbackAssetClass, this.fallbackProvider);
    this.providerOpts = providerOpts;
    this.wrap = wrap ?? ((provider) => provider);
  }

  history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const parsed = parseInstrumentAddress(symbol);
    const provider = parsed.provider ?? this.fallbackProvider;
    const assetClass = parsed.provider
      ? coerceAssetClass(parsed.assetClass, provider)
      : this.fallbackAssetClass;
    return this.providerFor(provider, assetClass).history(parsed.ticker, timeframe, range);
  }

  /** Route instrument metadata exactly like history(); undefined when the
   *  target adapter has no instrument() of its own. */
  async instrument(symbol: string): Promise<InstrumentInfo | undefined> {
    const parsed = parseInstrumentAddress(symbol);
    const provider = parsed.provider ?? this.fallbackProvider;
    const assetClass = parsed.provider
      ? coerceAssetClass(parsed.assetClass, provider)
      : this.fallbackAssetClass;
    const target = this.providerFor(provider, assetClass);
    return target.instrument ? target.instrument(parsed.ticker) : undefined;
  }

  private providerFor(provider: DataProvider, assetClass: AssetClass): HistoryProvider {
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

/**
 * Resolve a full instrument address (`BI:FU:BTCUSDT`, `AL:AAPL`, or a bare
 * `BTCUSDT`) into a configured provider + ticker. A bare ticker uses
 * `fallbackProvider`; an unserved or missing class falls back to the provider's
 * default rather than throwing, so untrusted input degrades gracefully.
 */
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
