import { test, expect } from 'bun:test';
import {
  BinanceProvider,
  OkxProvider,
  KrakenProvider,
  AlpacaProvider,
  MassiveProvider,
  normalizeOkxSpot,
  normalizeOkxSwap,
  normalizeKrakenSpot,
  parseTimeframe,
  dropUnclosedBars,
} from '../src/index.js';

/** A fake fetch that records URLs/headers and returns queued JSON bodies. */
function mockFetch(bodies: unknown[]) {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  let i = 0;
  const fn = (async (url: string | URL, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), headers: init?.headers });
    const body = i < bodies.length ? bodies[i++] : null;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('BinanceProvider spot: URL, interval, ms→sec parsing', async () => {
  const { fn, calls } = mockFetch([[[1700000000000, '10', '12', '9', '11', '100']]]);
  const p = new BinanceProvider({ market: 'spot', fetchImpl: fn });
  const bars = await p.history('btc/usdt', '1h', { limit: 1 });
  expect(p.id).toBe('binance');
  expect(calls[0]!.url).toContain('/api/v3/klines');
  expect(calls[0]!.url).toContain('symbol=BTCUSDT');
  expect(calls[0]!.url).toContain('interval=1h');
  expect(bars).toEqual([{ time: 1700000000, open: 10, high: 12, low: 9, close: 11, volume: 100 }]);
});

test('BinanceProvider futures: fapi host + path + id', async () => {
  const { fn, calls } = mockFetch([[]]);
  const p = new BinanceProvider({ market: 'futures', fetchImpl: fn });
  await p.history('ETHUSDT', '4h', { limit: 1 });
  expect(p.id).toBe('binance-futures');
  expect(calls[0]!.url).toContain('fapi.binance.com');
  expect(calls[0]!.url).toContain('/fapi/v1/klines');
});

test('OkxProvider spot: instId, bar mapping, envelope parse', async () => {
  const { fn, calls } = mockFetch([
    { code: '0', data: [['1700003600000', '2', '3', '1', '2.5', '50']] },
    { code: '0', data: [] },
  ]);
  const p = new OkxProvider({ market: 'spot', fetchImpl: fn });
  const bars = await p.history('BTCUSDT', '1h', { limit: 1 });
  expect(calls[0]!.url).toContain('/api/v5/market/candles');
  expect(calls[0]!.url).toContain('instId=BTC-USDT');
  expect(calls[0]!.url).toContain('bar=1H');
  expect(bars).toEqual([{ time: 1700003600, open: 2, high: 3, low: 1, close: 2.5, volume: 50 }]);
});

test('OkxProvider swap: -SWAP instId and 1d→1Dutc', async () => {
  const { fn, calls } = mockFetch([
    { code: '0', data: [['1700000000000', '2', '3', '1', '2.5', '50']] },
    { code: '0', data: [] },
  ]);
  const p = new OkxProvider({ market: 'swap', fetchImpl: fn });
  await p.history('ETH/USDT', '1d', { limit: 1 });
  expect(p.id).toBe('okx-swap');
  expect(calls[0]!.url).toContain('instId=ETH-USDT-SWAP');
  expect(calls[0]!.url).toContain('bar=1Dutc');
});

test('OkxProvider surfaces a non-zero code as an error', async () => {
  const { fn } = mockFetch([{ code: '51001', msg: 'bad instId' }]);
  const p = new OkxProvider({ fetchImpl: fn });
  await expect(p.history('BTCUSDT', '1h', { limit: 1 })).rejects.toThrow(/51001/);
});

test('KrakenProvider: pair form, minute interval, result parse', async () => {
  const { fn, calls } = mockFetch([
    {
      error: [],
      result: { XBTUSD: [[1700000000, '2', '3', '1', '2.5', '2.4', '10', 5]], last: 1700000000 },
    },
  ]);
  const p = new KrakenProvider({ fetchImpl: fn });
  const bars = await p.history('XBTUSD', '1h');
  expect(calls[0]!.url).toContain('/0/public/OHLC');
  expect(calls[0]!.url).toContain('pair=BTC%2FUSD');
  expect(calls[0]!.url).toContain('interval=60');
  expect(bars).toEqual([{ time: 1700000000, open: 2, high: 3, low: 1, close: 2.5, volume: 10 }]);
});

test('KrakenProvider rejects unsupported timeframes', async () => {
  const { fn } = mockFetch([]);
  const p = new KrakenProvider({ fetchImpl: fn });
  await expect(p.history('BTC/USD', '3m')).rejects.toThrow(/unsupported/);
});

test('AlpacaProvider: auth headers, timeframe, pagination, parse', async () => {
  const { fn, calls } = mockFetch([
    {
      bars: [{ t: '2023-11-14T12:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 9 }],
      next_page_token: 'p2',
    },
    {
      bars: [{ t: '2023-11-14T13:00:00Z', o: 1.5, h: 2, l: 1, c: 1.8, v: 7 }],
      next_page_token: null,
    },
  ]);
  const p = new AlpacaProvider({ keyId: 'k', secretKey: 's', fetchImpl: fn });
  const bars = await p.history('aapl', '1h', { from: 1699900000, to: 1700100000 });
  expect(calls[0]!.url).toContain('/v2/stocks/AAPL/bars');
  expect(calls[0]!.url).toContain('timeframe=1Hour');
  expect(calls[0]!.headers?.['APCA-API-KEY-ID']).toBe('k');
  expect(calls[1]!.url).toContain('page_token=p2');
  expect(bars).toHaveLength(2);
  expect(bars[0]).toEqual({ time: 1699963200, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 });
});

test('AlpacaProvider requires credentials', async () => {
  const p = new AlpacaProvider({ fetchImpl: mockFetch([]).fn });
  await expect(p.history('AAPL', '1h')).rejects.toThrow(/credentials/);
});

test('MassiveProvider: aggs path, Bearer auth, parse', async () => {
  const { fn, calls } = mockFetch([
    { results: [{ t: 1700000000000, o: 1, h: 2, l: 0.5, c: 1.5, v: 9 }] },
  ]);
  const p = new MassiveProvider({ apiKey: 'mk', fetchImpl: fn });
  const bars = await p.history('AAPL', '1h', { from: 1699000000, to: 1700100000 });
  expect(calls[0]!.url).toContain('/v2/aggs/ticker/AAPL/range/1/hour/');
  expect(calls[0]!.headers?.Authorization).toBe('Bearer mk');
  expect(bars).toEqual([{ time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 }]);
});

test('MassiveProvider requires an API key', async () => {
  const p = new MassiveProvider({ fetchImpl: mockFetch([]).fn });
  await expect(p.history('AAPL', '1h')).rejects.toThrow(/API key/);
});

test('symbol normalizers', () => {
  expect(normalizeOkxSpot('BTCUSDT')).toBe('BTC-USDT');
  expect(normalizeOkxSpot('eth/usdt')).toBe('ETH-USDT');
  expect(normalizeOkxSwap('BTCUSDT')).toBe('BTC-USDT-SWAP');
  expect(normalizeOkxSwap('BTC-USDT-SWAP')).toBe('BTC-USDT-SWAP');
  expect(normalizeKrakenSpot('XBTUSD')).toBe('BTC/USD');
  expect(normalizeKrakenSpot('btc/usd')).toBe('BTC/USD');
  expect(normalizeKrakenSpot('ETHUSDT')).toBe('ETH/USDT');
});

test('parseTimeframe', () => {
  expect(parseTimeframe('15m')).toEqual({ n: 15, unit: 'm' });
  expect(parseTimeframe('4h')).toEqual({ n: 4, unit: 'h' });
  expect(parseTimeframe('1d')).toEqual({ n: 1, unit: 'd' });
});

// ── audit-fix regressions ───────────────────────────────────

test('BinanceProvider pages backwards when limit exceeds the 1000-per-request cap', async () => {
  const stepMs = 3_600_000;
  const newestOpen = 1_700_000_000_000; // Nov 2023 — every bar long closed
  const kline = (openMs: number) => [openMs, '1', '2', '0.5', '1.5', '9'];
  // Binance returns klines oldest→newest per page; page 1 is the newest 1000.
  const page1 = Array.from({ length: 1000 }, (_, i) => kline(newestOpen - (999 - i) * stepMs));
  const page2 = Array.from({ length: 500 }, (_, i) => kline(newestOpen - (1499 - i) * stepMs));
  const { fn, calls } = mockFetch([page1, page2]);
  const p = new BinanceProvider({ fetchImpl: fn });

  const bars = await p.history('BTCUSDT', '1h', { limit: 1500 });
  expect(calls).toHaveLength(2);
  expect(calls[0]!.url).toContain('limit=1000');
  expect(calls[0]!.url).not.toContain('endTime');
  // Second page ends just before the first page's oldest open.
  expect(calls[1]!.url).toContain(`endTime=${newestOpen - 999 * stepMs - 1}`);
  expect(calls[1]!.url).toContain('limit=500');
  expect(bars).toHaveLength(1500);
  expect(bars[0]!.time).toBe((newestOpen - 1499 * stepMs) / 1000);
  expect(bars[1499]!.time).toBe(newestOpen / 1000);
  // Strictly ascending, no duplicates.
  for (let i = 1; i < bars.length; i++) expect(bars[i]!.time).toBeGreaterThan(bars[i - 1]!.time);
});

test('BinanceProvider drops the in-progress candle', async () => {
  const stepMs = 3_600_000;
  const openNow = Math.floor(Date.now() / stepMs) * stepMs; // current hour — still forming
  const { fn } = mockFetch([
    [
      [openNow - 2 * stepMs, '1', '2', '0.5', '1.5', '9'],
      [openNow - stepMs, '1', '2', '0.5', '1.5', '9'],
      [openNow, '1', '2', '0.5', '1.5', '9'],
    ],
  ]);
  const p = new BinanceProvider({ fetchImpl: fn });
  const bars = await p.history('BTCUSDT', '1h', { limit: 3 });
  expect(bars.map((b) => b.time)).toEqual([
    (openNow - 2 * stepMs) / 1000,
    (openNow - stepMs) / 1000,
  ]);
});

test('OkxProvider drops unconfirmed (in-progress) candles', async () => {
  const { fn } = mockFetch([
    {
      code: '0',
      data: [
        ['1700007200000', '3', '4', '2', '3.5', '60', '0', '0', '0'], // confirm=0 → forming
        ['1700003600000', '2', '3', '1', '2.5', '50', '0', '0', '1'],
      ],
    },
    { code: '0', data: [] },
  ]);
  const p = new OkxProvider({ fetchImpl: fn });
  const bars = await p.history('BTCUSDT', '1h', { limit: 5 });
  expect(bars).toEqual([{ time: 1700003600, open: 2, high: 3, low: 1, close: 2.5, volume: 50 }]);
});

test('dropUnclosedBars trims only the still-forming tail', () => {
  const nowSec = 1_700_010_000;
  const bars = [
    { time: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    { time: 1_700_003_600, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
    { time: 1_700_007_200, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 }, // closes 1_700_010_800 > now
  ];
  expect(dropUnclosedBars(bars, '1h', nowSec)).toHaveLength(2);
  expect(dropUnclosedBars(bars, '1h', 1_700_010_800)).toHaveLength(3); // exactly closed → kept
  expect(dropUnclosedBars([], '1h', nowSec)).toEqual([]);
});

// ── instrument() — per-symbol exchange trading rules ──────────────────────────

test('BinanceProvider spot instrument: LOT_SIZE/PRICE_FILTER parsing + memoization', async () => {
  const body = {
    symbols: [
      {
        symbol: 'BTCUSDT',
        filters: [
          { filterType: 'LOT_SIZE', stepSize: '0.00001000' },
          { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
        ],
      },
    ],
  };
  const { fn, calls } = mockFetch([body]);
  const p = new BinanceProvider({ market: 'spot', fetchImpl: fn });
  expect(await p.instrument('btc/usdt')).toEqual({ minQty: 0.00001, mintick: 0.01 });
  expect(calls[0]!.url).toContain('/api/v3/exchangeInfo');
  // Second lookup answers from the per-instance memo — no extra fetch.
  await p.instrument('BTCUSDT');
  expect(calls.length).toBe(1);
  // Unknown symbol → undefined, still no extra fetch.
  expect(await p.instrument('NOPEUSDT')).toBeUndefined();
  expect(calls.length).toBe(1);
});

test('BinanceProvider futures instrument: fapi endpoint, whole-contract steps', async () => {
  const body = {
    symbols: [
      {
        symbol: 'DOGEUSDT',
        filters: [
          { filterType: 'LOT_SIZE', stepSize: '1' },
          { filterType: 'PRICE_FILTER', tickSize: '0.00001' },
        ],
      },
    ],
  };
  const { fn, calls } = mockFetch([body]);
  const p = new BinanceProvider({ market: 'futures', fetchImpl: fn });
  expect(await p.instrument('DOGEUSDT')).toEqual({ minQty: 1, mintick: 0.00001 });
  expect(calls[0]!.url).toContain('/fapi/v1/exchangeInfo');
});

test('OkxProvider spot instrument: lotSz/tickSz straight through', async () => {
  const { fn, calls } = mockFetch([{ code: '0', data: [{ lotSz: '0.00000001', tickSz: '0.1' }] }]);
  const p = new OkxProvider({ fetchImpl: fn });
  expect(await p.instrument('BTC/USDT')).toEqual({ minQty: 0.00000001, mintick: 0.1 });
  expect(calls[0]!.url).toContain('/api/v5/public/instruments');
  expect(calls[0]!.url).toContain('instType=SPOT');
  expect(calls[0]!.url).toContain('instId=BTC-USDT');
});

test('OkxProvider swap instrument: contract lots convert to base units via ctVal', async () => {
  const { fn, calls } = mockFetch([
    { code: '0', data: [{ lotSz: '1', tickSz: '0.1', ctVal: '0.0001' }] },
  ]);
  const p = new OkxProvider({ market: 'swap', fetchImpl: fn });
  // 1 contract × 0.0001 BTC/contract = 0.0001 base units per lot step
  expect(await p.instrument('BTCUSDT')).toEqual({ minQty: 0.0001, mintick: 0.1 });
  expect(calls[0]!.url).toContain('instType=SWAP');
});

test('KrakenProvider instrument: lot_decimals → 10^-n, tick_size passthrough', async () => {
  const { fn, calls } = mockFetch([
    { error: [], result: { XXBTZUSD: { lot_decimals: 8, tick_size: '0.1' } } },
  ]);
  const p = new KrakenProvider({ fetchImpl: fn });
  expect(await p.instrument('BTC/USD')).toEqual({ minQty: 1e-8, mintick: 0.1 });
  expect(calls[0]!.url).toContain('/0/public/AssetPairs');
});

test('equities providers instrument: whole-share lots, one-cent tick, no HTTP', async () => {
  const { fn, calls } = mockFetch([]);
  const alpaca = new AlpacaProvider({ fetchImpl: fn });
  const massive = new MassiveProvider({ fetchImpl: fn });
  expect(await alpaca.instrument('TSLA')).toEqual({ minQty: 1, mintick: 0.01 });
  expect(await massive.instrument('AAPL')).toEqual({ minQty: 1, mintick: 0.01 });
  expect(calls.length).toBe(0); // static exchange rules — no credentials needed
});
