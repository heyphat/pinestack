import { expect, test } from 'bun:test';
import {
  MarketDataError,
  ReplayProvider,
  StaticProvider,
  TigerProvider,
  assertProviderConfig,
  assertLiveSymbolMatchesConfig,
  createMarketDataProvider,
  isMarketDataProvider,
  InstrumentRouter,
  type Bar,
  type TigerBarsRequest,
  type TigerBarsResult,
  type TigerMarketDataTransport,
} from '../src/index.js';

const bars: Bar[] = [
  { time: 300, open: 3, high: 4, low: 2, close: 3, volume: 1 },
  { time: 100, open: 1, high: 2, low: 0, close: 1, volume: 1 },
  { time: 200, open: 2, high: 3, low: 1, close: 2, volume: 1 },
  { time: 200, open: 2, high: 3, low: 1, close: 2.5, volume: 1 },
  { time: 500, open: 5, high: 6, low: 4, close: 5, volume: 1 },
];

function replay() {
  const source = new StaticProvider({ X: bars }).setInstrument('X', { minQty: 1, mintick: 0.25 });
  return new ReplayProvider(source, {
    cutoverTime: 300,
    clock: () => 550,
    instrument: { minOrderQty: 1 },
  });
}

test('ReplayProvider has explicit cutover, recent warmup, exclusive after, closed/ascending/unique output', async () => {
  const provider = replay();
  expect(isMarketDataProvider(provider)).toBe(true);
  const resolved = await provider.resolve('X', { strict: true });
  expect(resolved).toEqual(
    expect.objectContaining({ strategySymbol: 'X', venueSymbol: 'X', mintick: 0.25, qtyStep: 1 }),
  );
  expect(
    (await provider.historyResolved(resolved, '1m', { limit: 1 })).map((bar) => bar.time),
  ).toEqual([200]);
  const streamed: Bar[] = [];
  const controller = new AbortController();
  for await (const bar of provider.closedBars(resolved, '1m', {
    after: 200,
    signal: controller.signal,
  })) {
    streamed.push(bar);
    controller.abort();
  }
  expect(streamed.map((bar) => bar.time)).toEqual([300]);
});

test('ReplayProvider cancellation and ownership checks fail safely', async () => {
  const provider = replay();
  const resolved = await provider.resolve('X');
  const controller = new AbortController();
  controller.abort();
  await expect(
    provider.historyResolved(resolved, '1m', {}, controller.signal),
  ).rejects.toBeInstanceOf(MarketDataError);
  await expect(
    provider.historyResolved({ ...resolved, providerHandle: 'other:X' }, '1m'),
  ).rejects.toMatchObject({ code: 'invalid-symbol' });
});

test('strict live config rejects mismatched addresses and historical-only providers', () => {
  expect(() =>
    assertLiveSymbolMatchesConfig('BI:FU:X', {
      provider: 'tiger',
      assetClass: 'futures',
      transport: new FixtureTigerTransport(),
    }),
  ).toThrow('does not match');
  expect(() => createMarketDataProvider({ provider: 'binance' })).toThrow('historical-only');
  expect(() => createMarketDataProvider({ provider: 'tiger', assetClass: 'futures' })).toThrow(
    'transport',
  );
});

class FixtureTigerTransport implements TigerMarketDataTransport {
  calls: Array<{ contract: string; from?: number; cursor?: string }> = [];
  batches: Array<TigerBarsResult | Error> = [];
  resolveCalls = 0;
  async resolveFuture(root: string) {
    this.resolveCalls++;
    return {
      root,
      contract: 'MGCZ24',
      mintick: 0.1,
      qtyStep: 1,
      minOrderQty: 1,
      pointValue: 10,
      exchange: 'COMEX',
      expiry: '2024-12-27',
    };
  }
  async bars(
    contract: string,
    _timeframe: string,
    range: TigerBarsRequest,
  ): Promise<TigerBarsResult> {
    this.calls.push({ contract, from: range.from, cursor: range.cursor });
    const next = this.batches.shift();
    if (next instanceof Error) throw next;
    return next ?? { bars: [], serverTime: 10_000 };
  }
}

const tigerBar = (time: number): Bar => ({
  time,
  open: time,
  high: time + 1,
  low: time - 1,
  close: time,
  volume: 1,
});

test('TigerProvider freezes exact contract and normalizes closed historical bars', async () => {
  const transport = new FixtureTigerTransport();
  transport.batches.push({
    bars: [tigerBar(120), tigerBar(60), tigerBar(120), tigerBar(180)],
    finality: [true, true, true, false],
  });
  const provider = new TigerProvider({ transport, pollIntervalMs: 0 });
  const first = await provider.resolve('MGC');
  const second = await provider.resolve('MGC');
  const alias = await provider.resolve('TG:FU:MGC');
  expect(first).toBe(second);
  expect(alias).not.toBe(first);
  expect(alias.strategySymbol).toBe('TG:FU:MGC');
  expect(alias.venueSymbol).toBe(first.venueSymbol);
  expect(first.venueSymbol).toBe('MGCZ24');
  expect(transport.resolveCalls).toBe(1);
  const history = await provider.historyResolved(first, '1m', { limit: 2 });
  expect(history.map((bar) => bar.time)).toEqual([60, 120]);
  expect(transport.calls[0]?.contract).toBe('MGCZ24');
});

test('TigerProvider live polling overlaps, suppresses duplicates, backfills gaps, retries, and cancels', async () => {
  const transport = new FixtureTigerTransport();
  const provider = new TigerProvider({
    transport,
    pollIntervalMs: 0,
    retryDelayMs: 0,
    maxRetries: 2,
    sleep: async () => {},
  });
  const resolved = await provider.resolve('MGC');
  transport.batches.push(
    { bars: [tigerBar(100), tigerBar(200)], serverTime: 1_000 },
    new Error('temporary connectivity'),
    { bars: [tigerBar(200), tigerBar(300), tigerBar(500)], serverTime: 1_000 },
  );
  const controller = new AbortController();
  const times: number[] = [];
  for await (const bar of provider.closedBars(resolved, '1m', {
    after: 100,
    signal: controller.signal,
  })) {
    times.push(bar.time);
    if (times.length === 3) controller.abort();
  }
  expect(times).toEqual([200, 300, 500]);
  expect(transport.calls.map((call) => call.from)).toEqual([100, 200, 200]);
});

test('TigerProvider classifies terminal entitlement and finality errors without leaking causes', async () => {
  const transport = new FixtureTigerTransport();
  const provider = new TigerProvider({ transport });
  const resolved = await provider.resolve('MGC');
  transport.batches.push(new Error('permission entitlement denied secret=abc'));
  await expect(provider.historyResolved(resolved, '1m')).rejects.toMatchObject({
    code: 'entitlement',
    retryable: false,
  });
  transport.batches.push({ bars: [tigerBar(100)] });
  await expect(provider.historyResolved(resolved, '1m')).rejects.toMatchObject({
    code: 'malformed-data',
  });
});

test('resolved objects cannot be forged and Tiger errors retain no secret-bearing cause', async () => {
  const provider = replay();
  const resolved = await provider.resolve('X');
  await expect(provider.historyResolved({ ...resolved }, '1m')).rejects.toMatchObject({
    code: 'invalid-symbol',
  });

  const transport = new FixtureTigerTransport();
  const tiger = new TigerProvider({ transport });
  const exact = await tiger.resolve('MGC');
  transport.batches.push(new Error('auth credential=secret'));
  const error = await tiger.historyResolved(exact, '1m').catch((value) => value as MarketDataError);
  expect(error.code).toBe('auth');
  expect(error.message).not.toContain('secret');
  expect(error.cause).toBeUndefined();
});

test('live router rejects capability-erasing overrides and config validates branch fields', () => {
  expect(
    () =>
      new InstrumentRouter({
        providers: {
          tiger: createMarketDataProvider({
            provider: 'tiger',
            assetClass: 'futures',
            transport: new FixtureTigerTransport(),
          }),
        },
      }),
  ).toThrow('pass the MarketDataProvider directly');
  expect(() =>
    createMarketDataProvider({
      provider: 'tiger',
      assetClass: 'futures',
      transport: new FixtureTigerTransport(),
      maxRetries: -1,
    }),
  ).toThrow('maxRetries');
  expect(() =>
    createMarketDataProvider({
      provider: 'csv',
      dataDir: 'x',
      cutoverTime: 1,
      paceMs: -1,
    } as never),
  ).toThrow('paceMs');
});

test('ReplayProvider waits for each virtual-clock close and cancellation stops a pending wait', async () => {
  const source = new StaticProvider({ X: [tigerBar(300), tigerBar(500)] }).setInstrument('X', {
    minQty: 1,
    mintick: 0.25,
  });
  let now = 350;
  let sleeps = 0;
  const provider = new ReplayProvider(source, {
    cutoverTime: 300,
    clock: () => now,
    clockPollIntervalMs: 0,
    sleep: async () => {
      sleeps++;
      now += 100;
    },
  });
  const resolved = await provider.resolve('X');
  const emitted: number[] = [];
  for await (const bar of provider.closedBars(resolved, '1m')) emitted.push(bar.time);
  expect(emitted).toEqual([300, 500]);
  expect(sleeps).toBe(3);

  let waiting!: () => void;
  const waitingStarted = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const controller = new AbortController();
  const cancelled = new ReplayProvider(source, {
    cutoverTime: 300,
    clock: () => 0,
    sleep: async (_milliseconds, signal) => {
      waiting();
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  });
  const cancelledResolved = await cancelled.resolve('X');
  const next = cancelled
    .closedBars(cancelledResolved, '1m', { signal: controller.signal })
    [Symbol.asyncIterator]()
    .next();
  await waitingStarted;
  controller.abort();
  await expect(next).resolves.toMatchObject({ done: true });
});

test('TigerProvider pages past an unclosed history tail to satisfy the closed-bar limit', async () => {
  const transport = new FixtureTigerTransport();
  const provider = new TigerProvider({ transport });
  const resolved = await provider.resolve('MGC');
  transport.batches.push(
    {
      bars: [tigerBar(180), tigerBar(120)],
      finality: [false, true],
      nextCursor: 'older',
    },
    { bars: [tigerBar(60)], finality: [true] },
  );
  const history = await provider.historyResolved(resolved, '1m', { limit: 2 });
  expect(history.map((bar) => bar.time)).toEqual([60, 120]);
  expect(transport.calls.map((call) => call.cursor)).toEqual([undefined, 'older']);
});

test('TigerProvider completes live pagination and observes cancellation between buffered yields', async () => {
  const transport = new FixtureTigerTransport();
  const provider = new TigerProvider({ transport, pollIntervalMs: 0, sleep: async () => {} });
  const resolved = await provider.resolve('MGC');
  transport.batches.push(
    {
      bars: [tigerBar(300), tigerBar(400)],
      finality: [true, true],
      nextCursor: 'older-gap',
    },
    { bars: [tigerBar(200)], finality: [true] },
  );
  const controller = new AbortController();
  const emitted: number[] = [];
  for await (const bar of provider.closedBars(resolved, '1m', {
    after: 100,
    signal: controller.signal,
  })) {
    emitted.push(bar.time);
    controller.abort();
  }
  expect(emitted).toEqual([200]);
  expect(transport.calls.map((call) => call.cursor)).toEqual([undefined, 'older-gap']);
});

test('provider config rejects unknown, inapplicable, and incomplete Tiger fields', () => {
  expect(() =>
    assertProviderConfig({ provider: 'kraken', assetClass: 'crypto', maxBars: 10 }),
  ).toThrow('does not allow');
  expect(() =>
    assertProviderConfig({ provider: 'csv', dataDir: 'x', cutoverTime: 1, baseUrl: 'x' }),
  ).toThrow('does not allow');
  expect(() =>
    assertProviderConfig({
      provider: 'tiger',
      assetClass: 'futures',
      transport: { bars: async () => ({ bars: [], serverTime: 1 }) },
    }),
  ).toThrow('resolveFuture');
  expect(() =>
    assertProviderConfig({
      provider: 'tiger',
      assetClass: 'futures',
      transport: {
        resolveFuture: async () => ({
          root: 'MGC',
          contract: 'MGCZ24',
          mintick: 0.1,
          qtyStep: 1,
          minOrderQty: 1,
        }),
        bars: async () => ({ bars: [], serverTime: 1 }),
        connect: true,
      },
    }),
  ).toThrow('connect');
});

test('TigerProvider does not start contract resolution after cancellation during connect', async () => {
  const transport = new FixtureTigerTransport();
  let releaseConnect!: () => void;
  let connectStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    connectStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseConnect = resolve;
  });
  transport.connect = async () => {
    connectStarted();
    await blocked;
  };
  const provider = new TigerProvider({ transport });
  const controller = new AbortController();
  const resolving = provider.resolve('MGC', { signal: controller.signal });
  await started;
  controller.abort();
  releaseConnect();
  await expect(resolving).rejects.toBeInstanceOf(MarketDataError);
  expect(transport.resolveCalls).toBe(0);
});
