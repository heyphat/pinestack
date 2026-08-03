import { describe, expect, test } from 'bun:test';
import { BinanceLiveProvider, decodeKlineMessage, type Bar, type BarUpdate } from '../src/index.js';

const SYMBOL = 'BTCUSDT';
/** 2024-01-01T00:00:00Z — a UTC-aligned 5m/1m boundary. */
const T0 = 1_704_067_200;

interface KlineInput {
  readonly open: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
  readonly closed: boolean;
  readonly interval: string;
  readonly eventOffsetMs?: number;
}

function kline(input: KlineInput): unknown {
  return {
    e: 'kline',
    E: input.open * 1_000 + (input.eventOffsetMs ?? 500),
    s: SYMBOL,
    k: {
      t: input.open * 1_000,
      T: input.open * 1_000 + 59_999,
      i: input.interval,
      o: String(input.o),
      h: String(input.h),
      l: String(input.l),
      c: String(input.c),
      v: String(input.v),
      x: input.closed,
    },
  };
}

/** One closed 1m child. */
function child(slot: number, price: number, high = price, low = price): unknown {
  return kline({
    open: T0 + slot * 60,
    o: price,
    h: high,
    l: low,
    c: price,
    v: 1,
    closed: true,
    interval: '1m',
    eventOffsetMs: 60_000,
  });
}

const EXCHANGE_INFO = {
  symbols: [
    {
      symbol: SYMBOL,
      filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.00001' },
        { filterType: 'PRICE_FILTER', tickSize: '0.01' },
      ],
    },
  ],
};

/** Stub REST: exchangeInfo plus a klines endpoint driven by supplied bars. */
function restStub(klinesByInterval: Readonly<Record<string, readonly Bar[]>> = {}): {
  fetchImpl: typeof fetch;
  klineCalls: string[];
} {
  const klineCalls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/exchangeInfo')) {
      return new Response(JSON.stringify(EXCHANGE_INFO), { status: 200 });
    }
    if (url.pathname.endsWith('/klines')) {
      klineCalls.push(url.search);
      const interval = url.searchParams.get('interval') ?? '';
      const bars = klinesByInterval[interval] ?? [];
      const rows = bars.map((bar) => [
        bar.time * 1_000,
        String(bar.open),
        String(bar.high),
        String(bar.low),
        String(bar.close),
        String(bar.volume),
        bar.time * 1_000 + 1,
      ]);
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  }) as unknown as typeof fetch;
  return { fetchImpl, klineCalls };
}

/** A transport that replays scripted message batches, one batch per connection. */
function scriptedStream(batches: readonly (readonly unknown[])[]): {
  openStream: (url: string, signal?: AbortSignal) => AsyncIterable<unknown>;
  urls: string[];
  connections: () => number;
} {
  const urls: string[] = [];
  let connection = 0;
  const openStream = (url: string): AsyncIterable<unknown> => {
    urls.push(url);
    const batch = batches[Math.min(connection, batches.length - 1)] ?? [];
    connection++;
    return {
      async *[Symbol.asyncIterator]() {
        for (const message of batch) yield message;
      },
    };
  };
  return { openStream, urls, connections: () => connection };
}

async function collect(
  updates: AsyncIterable<BarUpdate>,
  limit: number,
  controller?: AbortController,
): Promise<BarUpdate[]> {
  const out: BarUpdate[] = [];
  for await (const update of updates) {
    out.push(update);
    if (out.length >= limit) {
      controller?.abort();
      break;
    }
  }
  return out;
}

describe('decodeKlineMessage', () => {
  test('accepts a well-formed payload and rejects malformed ones', () => {
    const decoded = decodeKlineMessage(
      kline({ open: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 10, closed: true, interval: '1m' }),
    );
    expect(decoded).toMatchObject({ openTime: T0, open: 1, high: 2, closed: true, interval: '1m' });

    for (const bad of [
      undefined,
      null,
      42,
      {},
      { e: 'depthUpdate', k: {} },
      { e: 'kline' },
      // Non-boolean close flag must never be coerced.
      {
        e: 'kline',
        E: 1,
        k: { t: T0 * 1_000, i: '1m', o: '1', h: '1', l: '1', c: '1', v: '1', x: 'true' },
      },
      // Non-numeric price.
      {
        e: 'kline',
        E: 1,
        k: { t: T0 * 1_000, i: '1m', o: 'abc', h: '1', l: '1', c: '1', v: '1', x: true },
      },
      // Sub-second open time is not a canonical bar open.
      {
        e: 'kline',
        E: 1,
        k: { t: T0 * 1_000 + 1, i: '1m', o: '1', h: '1', l: '1', c: '1', v: '1', x: true },
      },
    ]) {
      expect(decodeKlineMessage(bad)).toBeUndefined();
    }
  });
});

describe('BinanceLiveProvider liveBars — native source', () => {
  test('emits increasing forming revisions then one authoritative final', async () => {
    const { fetchImpl } = restStub();
    const { openStream, urls } = scriptedStream([
      [
        kline({ open: T0, o: 100, h: 101, l: 99, c: 100.5, v: 1, closed: false, interval: '5m' }),
        kline({ open: T0, o: 100, h: 102, l: 99, c: 101.5, v: 2, closed: false, interval: '5m' }),
        kline({ open: T0, o: 100, h: 102, l: 98, c: 101, v: 3, closed: true, interval: '5m' }),
      ],
    ]);
    const provider = new BinanceLiveProvider({ fetchImpl, openStream });
    const instrument = await provider.resolve(SYMBOL);
    const controller = new AbortController();

    const updates = await collect(
      provider.liveBars(instrument, '5m', {
        source: { kind: 'native' },
        throttleMs: 0,
        signal: controller.signal,
      }),
      3,
      controller,
    );

    expect(updates.map((update) => update.isClose)).toEqual([false, false, true]);
    expect(updates.map((update) => update.revision)).toEqual([1, 2, 3]);
    expect(updates.every((update) => update.source.kind === 'native')).toBe(true);
    expect(updates.at(-1)!.bar).toMatchObject({
      time: T0,
      open: 100,
      high: 102,
      low: 98,
      close: 101,
    });
    expect(urls[0]).toBe('wss://stream.binance.com:9443/ws/btcusdt@kline_5m');
  });

  test('rejects a lower-bars policy that is not an exact child', async () => {
    const { fetchImpl } = restStub();
    const { openStream } = scriptedStream([[]]);
    const provider = new BinanceLiveProvider({ fetchImpl, openStream });
    const instrument = await provider.resolve(SYMBOL);
    expect(() =>
      provider.liveBars(instrument, '5m', { source: { kind: 'lower-bars', timeframe: '2m' } }),
    ).toThrow(/not an exact child/);
  });

  test('refuses an instrument it did not issue', async () => {
    const { fetchImpl } = restStub();
    const { openStream } = scriptedStream([[]]);
    const provider = new BinanceLiveProvider({ fetchImpl, openStream });
    const foreign = Object.freeze({
      strategySymbol: SYMBOL,
      providerHandle: 'elsewhere:BTCUSDT',
      venueSymbol: SYMBOL,
      mintick: 0.01,
      qtyStep: 0.001,
      minOrderQty: 0.001,
    });
    expect(() => provider.liveBars(foreign, '5m', { source: { kind: 'native' } })).toThrow(
      /was not issued by this provider/,
    );
  });
});

describe('BinanceLiveProvider liveBars — lower-bars source', () => {
  test('folds five 1m children into forming 5m bars and one exact final', async () => {
    const { fetchImpl } = restStub();
    const { openStream, urls } = scriptedStream([
      [
        child(0, 100, 101, 99),
        child(1, 102, 103, 100),
        child(2, 101, 104, 98),
        child(3, 103, 103, 100),
        child(4, 105, 106, 102),
      ],
    ]);
    const provider = new BinanceLiveProvider({ fetchImpl, openStream });
    const instrument = await provider.resolve(SYMBOL);
    const controller = new AbortController();

    const updates = await collect(
      provider.liveBars(instrument, '5m', {
        source: { kind: 'lower-bars', timeframe: '1m' },
        throttleMs: 0,
        signal: controller.signal,
      }),
      5,
      controller,
    );

    // One forming snapshot per completed child except the last, whose aggregate is
    // published as the authoritative final instead.
    expect(updates.filter((update) => !update.isClose)).toHaveLength(4);
    expect(updates.filter((update) => update.isClose)).toHaveLength(1);
    const final = updates.at(-1)!;
    expect(final.isClose).toBe(true);
    // Exact aggregation: open=first, high=max, low=min, close=last, volume=sum.
    expect(final.bar).toMatchObject({
      time: T0,
      open: 100,
      high: 106,
      low: 98,
      close: 105,
      volume: 5,
    });
    expect(final.source).toEqual({ kind: 'lower-bars', timeframe: '1m' });
    // Every update is stamped on the CHART grid, not the child grid.
    expect(new Set(updates.map((update) => update.bar.time))).toEqual(new Set([T0]));
    expect(urls[0]).toBe('wss://stream.binance.com:9443/ws/btcusdt@kline_1m');
  });

  test('drops children until one opens a bucket so no chart bar is built from a partial set', async () => {
    const { fetchImpl } = restStub();
    // Starts mid-bucket at slot 2; the first complete bucket is the NEXT one.
    const { openStream } = scriptedStream([
      [
        child(2, 100),
        child(3, 101),
        child(4, 102),
        ...[5, 6, 7, 8, 9].map((slot) => child(slot, 200 + slot)),
      ],
    ]);
    const provider = new BinanceLiveProvider({ fetchImpl, openStream });
    const instrument = await provider.resolve(SYMBOL);
    const controller = new AbortController();

    const updates = await collect(
      provider.liveBars(instrument, '5m', {
        source: { kind: 'lower-bars', timeframe: '1m' },
        throttleMs: 0,
        signal: controller.signal,
      }),
      // One complete bucket now yields four forming snapshots plus the final.
      5,
      controller,
    );

    // Nothing for the partial first bucket; everything belongs to the second.
    expect(new Set(updates.map((update) => update.bar.time))).toEqual(new Set([T0 + 300]));
    expect(updates.filter((update) => update.isClose)).toHaveLength(1);
    expect(updates.at(-1)!.isClose).toBe(true);
    expect(updates.at(-1)!.bar.close).toBe(209);
  });

  test('ignores forming children so the child timeframe defines the cadence', async () => {
    const { fetchImpl } = restStub();
    // Binance interleaves many forming child klines between closes (~30/min
    // observed). Exactly one chart re-evaluation per COMPLETED child must survive.
    const messages: unknown[] = [];
    for (let slot = 0; slot < 5; slot++) {
      for (let tick = 0; tick < 6; tick++) {
        messages.push(
          kline({
            open: T0 + slot * 60,
            o: 100 + slot,
            h: 100 + slot,
            l: 100 + slot,
            c: 100 + slot,
            v: 1,
            closed: false,
            interval: '1m',
            eventOffsetMs: 1_000 + tick * 8_000,
          }),
        );
      }
      messages.push(child(slot, 100 + slot));
    }
    const { openStream } = scriptedStream([messages]);
    const provider = new BinanceLiveProvider({ fetchImpl, openStream });
    const instrument = await provider.resolve(SYMBOL);
    const controller = new AbortController();

    const updates = await collect(
      provider.liveBars(instrument, '5m', {
        source: { kind: 'lower-bars', timeframe: '1m' },
        throttleMs: 0,
        signal: controller.signal,
      }),
      5,
      controller,
    );

    // 30 forming children were interleaved; none of them produced an update.
    expect(updates).toHaveLength(5);
    expect(updates.filter((update) => !update.isClose)).toHaveLength(4);
    expect(updates.filter((update) => update.isClose)).toHaveLength(1);
    // Each surviving snapshot advanced the aggregate by exactly one child.
    expect(updates.map((update) => update.bar.close)).toEqual([100, 101, 102, 103, 104]);
    expect(updates.at(-1)!.bar).toMatchObject({ time: T0, open: 100, close: 104, volume: 5 });
  });
});

test('seeds a mid-bucket start from REST so the current bucket is not discarded', async () => {
  // Elapsed children of the current bucket, available from REST.
  const seeded: Bar[] = [
    { time: T0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { time: T0 + 60, open: 100, high: 102, low: 100, close: 101, volume: 1 },
  ];
  const { fetchImpl } = restStub({ '1m': seeded });
  // The socket joins mid-bucket at slot 2.
  const { openStream } = scriptedStream([[child(2, 102), child(3, 103), child(4, 104)]]);
  const provider = new BinanceLiveProvider({ fetchImpl, openStream });
  const instrument = await provider.resolve(SYMBOL);
  const controller = new AbortController();

  const updates = await collect(
    provider.liveBars(instrument, '5m', {
      source: { kind: 'lower-bars', timeframe: '1m' },
      throttleMs: 0,
      signal: controller.signal,
    }),
    5,
    controller,
  );

  // The bucket the socket joined late is still completed, not skipped.
  expect(new Set(updates.map((update) => update.bar.time))).toEqual(new Set([T0]));
  expect(updates.filter((update) => update.isClose)).toHaveLength(1);
  const final = updates.at(-1)!;
  // open comes from the SEEDED slot 0, close from the live slot 4.
  expect(final.bar).toMatchObject({ time: T0, open: 100, close: 104, volume: 5 });
});

describe('BinanceLiveProvider reconnect recovery', () => {
  test('republishes a bar that closed while the socket was down', async () => {
    const missed: Bar = {
      time: T0 + 300,
      open: 110,
      high: 115,
      low: 109,
      close: 114,
      volume: 7,
    };
    const { fetchImpl, klineCalls } = restStub({ '5m': [missed] });
    const { openStream, connections } = scriptedStream([
      // First connection delivers one closed bar, then the socket ends.
      [kline({ open: T0, o: 100, h: 102, l: 98, c: 101, v: 3, closed: true, interval: '5m' })],
      // Second connection delivers the bar after the recovered one.
      [
        kline({
          open: T0 + 600,
          o: 114,
          h: 118,
          l: 113,
          c: 117,
          v: 4,
          closed: true,
          interval: '5m',
        }),
      ],
    ]);
    const provider = new BinanceLiveProvider({
      fetchImpl,
      openStream,
      sleep: async () => undefined,
    });
    const instrument = await provider.resolve(SYMBOL);
    const controller = new AbortController();

    const updates = await collect(
      provider.liveBars(instrument, '5m', {
        source: { kind: 'native' },
        throttleMs: 0,
        signal: controller.signal,
      }),
      3,
      controller,
    );

    expect(connections()).toBeGreaterThanOrEqual(2);
    expect(updates.map((update) => update.bar.time)).toEqual([T0, T0 + 300, T0 + 600]);
    const recovered = updates[1]!;
    expect(recovered.recovered).toBe(true);
    expect(recovered.isClose).toBe(true);
    expect(recovered.bar).toMatchObject(missed);
    // Catch-up asked REST for bars strictly after the last delivered close.
    expect(klineCalls.some((search) => search.includes('interval=5m'))).toBe(true);
  });

  test('surfaces exhausted reconnects as a classified connectivity error', async () => {
    const { fetchImpl } = restStub({ '5m': [] });
    const { openStream } = scriptedStream([[]]);
    const provider = new BinanceLiveProvider({
      fetchImpl,
      openStream,
      sleep: async () => undefined,
    });
    const instrument = await provider.resolve(SYMBOL);

    await expect(
      collect(
        provider.liveBars(instrument, '5m', { source: { kind: 'native' }, reconnectAttempts: 2 }),
        1,
      ),
    ).rejects.toThrow(/reconnect attempts/);
  });
});

describe('BinanceLiveProvider closedBars', () => {
  test('yields only closed chart bars', async () => {
    const { fetchImpl } = restStub();
    const { openStream } = scriptedStream([
      [
        kline({ open: T0, o: 100, h: 101, l: 99, c: 100.5, v: 1, closed: false, interval: '5m' }),
        kline({ open: T0, o: 100, h: 102, l: 98, c: 101, v: 3, closed: true, interval: '5m' }),
        kline({
          open: T0 + 300,
          o: 101,
          h: 103,
          l: 100,
          c: 102,
          v: 2,
          closed: false,
          interval: '5m',
        }),
        kline({
          open: T0 + 300,
          o: 101,
          h: 104,
          l: 100,
          c: 103,
          v: 5,
          closed: true,
          interval: '5m',
        }),
      ],
    ]);
    const provider = new BinanceLiveProvider({ fetchImpl, openStream });
    const instrument = await provider.resolve(SYMBOL);
    const controller = new AbortController();

    const bars: Bar[] = [];
    for await (const bar of provider.closedBars(instrument, '5m', { signal: controller.signal })) {
      bars.push(bar);
      if (bars.length >= 2) {
        controller.abort();
        break;
      }
    }
    expect(bars.map((bar) => bar.time)).toEqual([T0, T0 + 300]);
    expect(bars[1]).toMatchObject({ close: 103, high: 104 });
  });
});
