import { test, expect } from 'bun:test';
import {
  InstrumentRouter,
  type HistoryProvider,
  ASSET_CLASSES,
  ASSET_CLASS_REGISTRY,
  DATA_PROVIDERS,
  assetClassesForProvider,
  canonicalizeInstrumentAddress,
  coerceAssetClass,
  createProvider,
  defaultAssetClassForProvider,
  encodeInstrumentAddress,
  isAssetClass,
  isDataProvider,
  parseInstrumentAddress,
  resolveInstrument,
  supportsPair,
  BinanceProvider,
  OkxProvider,
  KrakenProvider,
  AlpacaProvider,
  MassiveProvider,
  StaticProvider,
} from '../src/index.js';

// ── registry ────────────────────────────────────────────────

test('declares the closed asset-class universe', () => {
  expect(ASSET_CLASSES).toEqual(['equities', 'crypto', 'futures', 'forex']);
  expect(new Set(ASSET_CLASSES).size).toBe(ASSET_CLASSES.length);
});

test('every provider serves its default asset class, listed first', () => {
  for (const provider of DATA_PROVIDERS) {
    const { defaultAssetClass, assetClasses } = ASSET_CLASS_REGISTRY[provider];
    expect(assetClasses[0]).toBe(defaultAssetClass);
    expect(supportsPair(provider, defaultAssetClass)).toBe(true);
  }
});

test('registry matches the adapters that exist', () => {
  expect(assetClassesForProvider('binance')).toEqual(['crypto', 'futures']);
  expect(assetClassesForProvider('okx')).toEqual(['crypto', 'futures']);
  expect(assetClassesForProvider('kraken')).toEqual(['crypto']);
  expect(assetClassesForProvider('alpaca')).toEqual(['equities']);
  expect(assetClassesForProvider('massive')).toEqual(['equities']);
});

test('type guards accept members and reject everything else', () => {
  expect(isAssetClass('futures')).toBe(true);
  expect(isAssetClass('FUTURES')).toBe(false);
  expect(isAssetClass('bonds')).toBe(false);
  expect(isDataProvider('okx')).toBe(true);
  expect(isDataProvider('coinbase')).toBe(false);
});

test('coerceAssetClass keeps served classes and substitutes the default otherwise', () => {
  expect(coerceAssetClass('futures', 'binance')).toBe('futures');
  expect(coerceAssetClass('futures', 'kraken')).toBe('crypto'); // unserved pair
  expect(coerceAssetClass('equities', 'binance')).toBe('crypto'); // unserved pair
  expect(coerceAssetClass('garbage', 'alpaca')).toBe('equities');
  expect(coerceAssetClass(null, 'okx')).toBe('crypto');
  expect(coerceAssetClass(undefined, 'massive')).toBe('equities');
});

// ── instrument addressing ───────────────────────────────────

test('parses the three address forms', () => {
  expect(parseInstrumentAddress('btcusdt')).toEqual({
    ticker: 'BTCUSDT',
    provider: null,
    assetClass: null,
    explicitProvider: false,
  });
  expect(parseInstrumentAddress('bi:btcusdt')).toEqual({
    ticker: 'BTCUSDT',
    provider: 'binance',
    assetClass: null,
    explicitProvider: true,
  });
  expect(parseInstrumentAddress('BI:FU:BTCUSDT')).toEqual({
    ticker: 'BTCUSDT',
    provider: 'binance',
    assetClass: 'futures',
    explicitProvider: true,
  });
});

test('3-part form only activates when both prefix and code are known', () => {
  // Unknown class code: falls back to the 2-part parse (BI + "XX:BTCUSDT").
  expect(parseInstrumentAddress('BI:XX:BTCUSDT')).toEqual({
    ticker: 'XX:BTCUSDT',
    provider: 'binance',
    assetClass: null,
    explicitProvider: true,
  });
  // Unknown prefix with a valid-looking code: no provider claimed.
  const parsed = parseInstrumentAddress('ZZ:FU:BTCUSDT');
  expect(parsed.provider).toBeNull();
  expect(parsed.explicitProvider).toBe(false);
});

test('kraken slashed pairs survive addressing', () => {
  expect(parseInstrumentAddress('KR:BTC/USD')).toEqual({
    ticker: 'BTC/USD',
    provider: 'kraken',
    assetClass: null,
    explicitProvider: true,
  });
});

test('encode omits the class code when it equals the provider default', () => {
  expect(encodeInstrumentAddress('binance', 'crypto', 'btcusdt')).toBe('BI:BTCUSDT');
  expect(encodeInstrumentAddress('binance', 'futures', 'btcusdt')).toBe('BI:FU:BTCUSDT');
  expect(encodeInstrumentAddress('okx', 'futures', 'BTC-USDT')).toBe('OK:FU:BTC-USDT');
  expect(encodeInstrumentAddress('massive', 'equities', 'aapl')).toBe('MA:AAPL');
});

test('canonicalize is idempotent and collapses explicit default classes', () => {
  const inputs = ['bi:fu:btcusdt', 'BI:CR:BTCUSDT', 'ok:btc-usdt', 'ethusdt', 'AL:EQ:AAPL'];
  for (const input of inputs) {
    const once = canonicalizeInstrumentAddress(input);
    expect(canonicalizeInstrumentAddress(once)).toBe(once);
  }
  expect(canonicalizeInstrumentAddress('BI:CR:BTCUSDT')).toBe('BI:BTCUSDT');
  expect(canonicalizeInstrumentAddress('bi:fu:btcusdt')).toBe('BI:FU:BTCUSDT');
  expect(canonicalizeInstrumentAddress('ethusdt')).toBe('BI:ETHUSDT'); // binance fallback
  expect(canonicalizeInstrumentAddress('aapl', 'massive')).toBe('MA:AAPL');
});

// ── factory ─────────────────────────────────────────────────

test('createProvider maps pairs onto the right adapter configuration', () => {
  expect(createProvider('binance').id).toBe('binance');
  expect(createProvider('binance', 'futures').id).toBe('binance-futures');
  expect(createProvider('okx', 'crypto').id).toBe('okx');
  expect(createProvider('okx', 'futures').id).toBe('okx-swap');
  expect(createProvider('kraken').id).toBe('kraken');
  expect(createProvider('alpaca').id).toBe('alpaca');
  expect(createProvider('massive').id).toBe('massive');
});

test('createProvider tags instances with their asset class', () => {
  expect(createProvider('binance').assetClass).toBe('crypto');
  expect(createProvider('binance', 'futures').assetClass).toBe('futures');
  expect(createProvider('okx', 'futures').assetClass).toBe('futures');
  expect(createProvider('alpaca').assetClass).toBe('equities');
});

test('createProvider throws for unserved pairs, naming the pair', () => {
  expect(() => createProvider('kraken', 'futures')).toThrow(
    'provider "kraken" does not serve asset class "futures"',
  );
  expect(() => createProvider('massive', 'crypto')).toThrow(
    'provider "massive" does not serve asset class "crypto"',
  );
});

test('resolveInstrument turns an address into provider + ticker', () => {
  const futures = resolveInstrument('BI:FU:BTCUSDT');
  expect(futures.provider.id).toBe('binance-futures');
  expect(futures.assetClass).toBe('futures');
  expect(futures.ticker).toBe('BTCUSDT');

  const bare = resolveInstrument('ETHUSDT', 'okx');
  expect(bare.provider.id).toBe('okx');
  expect(bare.assetClass).toBe('crypto');
  expect(bare.ticker).toBe('ETHUSDT');

  // Unserved class degrades to the provider default instead of throwing.
  const degraded = resolveInstrument('KR:FU:BTC/USD');
  expect(degraded.provider.id).toBe('kraken');
  expect(degraded.assetClass).toBe('crypto');
});

// ── instrument router ───────────────────────────────────────

/** Records URLs; answers every request with an empty-but-valid provider body. */
function routerMockFetch() {
  const urls: string[] = [];
  const fn = (async (url: string | URL) => {
    const s = String(url);
    urls.push(s);
    const body = s.includes('okx.com')
      ? { code: '0', data: [] }
      : s.includes('kraken.com')
        ? { error: [], result: {} }
        : []; // binance klines
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, urls };
}

test('router sends addressed symbols to the right provider, prefix stripped', async () => {
  const { fn, urls } = routerMockFetch();
  const router = new InstrumentRouter({ fetchImpl: fn });
  await router.history('BI:FU:BTCUSDT', '1h', { limit: 10 });
  expect(urls[0]).toContain('fapi.binance.com');
  expect(urls[0]).toContain('symbol=BTCUSDT');
  await router.history('KR:BTC/USD', '1h', { limit: 10 });
  expect(urls.at(-1)).toContain('api.kraken.com');
});

test('router sends bare tickers to the fallback pair', async () => {
  const { fn, urls } = routerMockFetch();
  const router = new InstrumentRouter({
    fallbackProvider: 'okx',
    fallbackAssetClass: 'futures',
    fetchImpl: fn,
  });
  await router.history('BTC-USDT', '1h', { limit: 10 });
  expect(urls[0]).toContain('okx.com');
  expect(urls[0]).toContain('instId=BTC-USDT-SWAP');
});

test('router degrades an unserved addressed class to the provider default', async () => {
  const { fn, urls } = routerMockFetch();
  const router = new InstrumentRouter({ fetchImpl: fn });
  await router.history('KR:FU:BTC/USD', '1h', { limit: 10 }); // kraken serves crypto only
  expect(urls[0]).toContain('api.kraken.com');
});

test('router creates + wraps each pair provider exactly once', async () => {
  const { fn } = routerMockFetch();
  const wrapped: string[] = [];
  const router = new InstrumentRouter({
    fetchImpl: fn,
    wrap: (p: HistoryProvider) => {
      wrapped.push(p.id);
      return p;
    },
  });
  await router.history('BI:FU:BTCUSDT', '1h', { limit: 10 });
  await router.history('BI:FU:ETHUSDT', '1h', { limit: 10 });
  await router.history('BTCUSDT', '1h', { limit: 10 });
  expect(wrapped).toEqual(['binance-futures', 'binance']);
});

// ── adapter tags ────────────────────────────────────────────

test('adapters expose their asset class directly', () => {
  expect(new BinanceProvider().assetClass).toBe('crypto');
  expect(new BinanceProvider({ market: 'futures' }).assetClass).toBe('futures');
  expect(new OkxProvider().assetClass).toBe('crypto');
  expect(new OkxProvider({ market: 'swap' }).assetClass).toBe('futures');
  expect(new KrakenProvider().assetClass).toBe('crypto');
  expect(new AlpacaProvider().assetClass).toBe('equities');
  expect(new MassiveProvider().assetClass).toBe('equities');
  expect(new StaticProvider().assetClass).toBeUndefined();
});

test('router forwards instrument() to the addressed adapter, prefix stripped', async () => {
  const urls: string[] = [];
  const fn = (async (url: string | URL) => {
    const s = String(url);
    urls.push(s);
    const body = {
      symbols: [
        {
          symbol: 'SOLUSDT',
          filters: [
            { filterType: 'LOT_SIZE', stepSize: '0.01' },
            { filterType: 'PRICE_FILTER', tickSize: '0.0100' },
          ],
        },
      ],
    };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const router = new InstrumentRouter({ fetchImpl: fn });
  // Addressed: BI:FU: routes to binance futures, ticker stripped for the lookup.
  expect(await router.instrument('BI:FU:SOLUSDT')).toEqual({ minQty: 0.01, mintick: 0.01 });
  expect(urls[0]).toContain('fapi.binance.com');
  expect(urls[0]).toContain('/fapi/v1/exchangeInfo');
  // Equities adapters answer statically (no fetch, no credentials).
  expect(await router.instrument('AL:AAPL')).toEqual({ minQty: 1, mintick: 0.01 });
  expect(urls.length).toBe(1);
});
