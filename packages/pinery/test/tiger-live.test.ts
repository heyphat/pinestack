import { describe, expect, test } from 'bun:test';
import {
  TigerProvider,
  createMarketDataProvider,
  supportsLiveBars,
  type Bar,
  type BarUpdate,
  type TigerBarsRequest,
  type TigerBarsResult,
  type TigerKlineUpdate,
  type TigerMarketDataTransport,
} from '../src/index.js';

const T0 = 1_704_067_200;
const CONTRACT = 'MGCZ26';

function bar(time: number, price = time): Bar {
  return {
    time,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price + 0.5,
    volume: 1,
  };
}

function kline(time: number, price = time, eventOffsetMs = 1_000): TigerKlineUpdate {
  return {
    symbol: CONTRACT,
    time: time * 1_000,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price + 0.5,
    volume: 1,
    eventTime: time * 1_000 + eventOffsetMs,
  };
}

class PushTigerTransport implements TigerMarketDataTransport {
  readonly calls: Array<{ contract: string; range: TigerBarsRequest }> = [];
  readonly subscriptions: string[] = [];
  streamBatches: Array<readonly TigerKlineUpdate[] | Error> = [];
  barBatches: Array<TigerBarsResult | Error> = [];
  closedStreams = 0;

  async resolveFuture(root: string) {
    return {
      root,
      contract: CONTRACT,
      mintick: 0.1,
      qtyStep: 1,
      minOrderQty: 1,
    };
  }

  async bars(
    contract: string,
    _timeframe: string,
    range: TigerBarsRequest,
  ): Promise<TigerBarsResult> {
    this.calls.push({ contract, range });
    const batch = this.barBatches.shift();
    if (batch instanceof Error) throw batch;
    return batch ?? { bars: [], finality: [] };
  }

  openKlineStream(contract: string): AsyncIterable<TigerKlineUpdate> {
    this.subscriptions.push(contract);
    const batch = this.streamBatches.shift() ?? [];
    const fixture = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          if (batch instanceof Error) throw batch;
          for (const update of batch) yield update;
        } finally {
          fixture.closedStreams++;
        }
      },
    };
  }
}

class HistoricalTigerTransport implements TigerMarketDataTransport {
  async resolveFuture(root: string) {
    return {
      root,
      contract: CONTRACT,
      mintick: 0.1,
      qtyStep: 1,
      minOrderQty: 1,
    };
  }

  async bars(): Promise<TigerBarsResult> {
    return { bars: [], finality: [] };
  }
}

async function collect(
  source: AsyncIterable<BarUpdate>,
  limit: number,
  controller?: AbortController,
): Promise<BarUpdate[]> {
  const updates: BarUpdate[] = [];
  for await (const update of source) {
    updates.push(update);
    if (updates.length >= limit) {
      controller?.abort();
      break;
    }
  }
  return updates;
}

async function provider(transport: TigerMarketDataTransport) {
  const instance = new TigerProvider({
    transport,
    sleep: async () => {},
  });
  const instrument = await instance.resolve('MGC');
  return { instance, instrument };
}

describe('TigerProvider official push capability', () => {
  test('is exposed only when the transport supplies a K-line stream', async () => {
    const historical = await provider(new HistoricalTigerTransport());
    const pushed = await provider(new PushTigerTransport());
    expect(supportsLiveBars(historical.instance)).toBe(false);
    expect(supportsLiveBars(pushed.instance)).toBe(true);
    expect(
      supportsLiveBars(
        createMarketDataProvider({
          provider: 'tiger',
          assetClass: 'futures',
          transport: new PushTigerTransport(),
        }),
      ),
    ).toBe(true);
  });

  test('emits increasing forming revisions and infers one final on minute rollover', async () => {
    const transport = new PushTigerTransport();
    transport.streamBatches.push([
      kline(T0, 100, 1_000),
      kline(T0, 101, 20_000),
      kline(T0 + 60, 102, 1_000),
    ]);
    const { instance, instrument } = await provider(transport);
    const controller = new AbortController();
    const updates = await collect(
      instance.liveBars!(instrument, '1m', {
        source: { kind: 'native' },
        throttleMs: 0,
        signal: controller.signal,
      }),
      4,
      controller,
    );

    expect(updates.map((update) => [update.bar.time, update.isClose, update.revision])).toEqual([
      [T0, false, 1],
      [T0, false, 2],
      [T0, true, 3],
      [T0 + 60, false, 1],
    ]);
    expect(updates[2]?.bar.close).toBe(101.5);
    expect(updates[2]?.provenance).toEqual({ authority: 'tiger-kline-rollover' });
    expect(transport.subscriptions.length).toBeGreaterThanOrEqual(1);
    expect(transport.subscriptions.every((contract) => contract === CONTRACT)).toBe(true);
    expect(transport.closedStreams).toBe(transport.subscriptions.length);
  });

  test('rejects larger native bars and lower-bars without Tiger session buckets', async () => {
    const { instance, instrument } = await provider(new PushTigerTransport());
    expect(() => instance.liveBars!(instrument, '5m', { source: { kind: 'native' } })).toThrow(
      /native push supports only 1m/,
    );
    for (const timeframe of ['1m', '2m']) {
      expect(() =>
        instance.liveBars!(instrument, '5m', {
          source: { kind: 'lower-bars', timeframe },
        }),
      ).toThrow(/authoritative session buckets/);
    }
  });

  test('accepts a later minute after a legal session or no-trade gap', async () => {
    const transport = new PushTigerTransport();
    transport.streamBatches.push([kline(T0, 100), kline(T0 + 3_600, 101)]);
    const { instance, instrument } = await provider(transport);
    const controller = new AbortController();
    const updates = await collect(
      instance.liveBars!(instrument, '1m', {
        source: { kind: 'native' },
        throttleMs: 0,
        signal: controller.signal,
      }),
      3,
      controller,
    );
    expect(updates.map((update) => [update.bar.time, update.isClose])).toEqual([
      [T0, false],
      [T0, true],
      [T0 + 3_600, false],
    ]);
  });
});

describe('TigerProvider push reconnect recovery', () => {
  test('publishes authoritative REST finals across a session gap before post-reconnect push', async () => {
    const transport = new PushTigerTransport();
    transport.streamBatches.push([kline(T0, 100)], [kline(T0 + 3_660, 102)]);
    transport.barBatches.push({
      bars: [bar(T0, 100), bar(T0 + 3_600, 101)],
      finality: [true, true],
    });
    const { instance, instrument } = await provider(transport);
    const controller = new AbortController();
    const updates = await collect(
      instance.liveBars!(instrument, '1m', {
        source: { kind: 'native' },
        throttleMs: 0,
        signal: controller.signal,
      }),
      4,
      controller,
    );

    expect(updates.map((update) => [update.bar.time, update.isClose, update.recovered])).toEqual([
      [T0, false, undefined],
      [T0, true, true],
      [T0 + 3_600, true, true],
      [T0 + 3_660, false, undefined],
    ]);
    expect(transport.calls[0]).toMatchObject({
      contract: CONTRACT,
      range: { from: T0, limit: 1_002 },
    });
  });

  test('rejects REST recovery that omits the active pushed bar', async () => {
    const transport = new PushTigerTransport();
    transport.streamBatches.push([kline(T0, 100)], [kline(T0 + 120, 102)]);
    transport.barBatches.push({ bars: [bar(T0 + 60, 101)], finality: [true] });
    const { instance, instrument } = await provider(transport);

    let caught: unknown;
    try {
      await collect(
        instance.liveBars!(instrument, '1m', {
          source: { kind: 'native' },
          reconnectDelayMs: 0,
        }),
        4,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: 'MarketDataError',
      code: 'live-discontinuity',
      retryable: false,
    });
  });

  test('rejects a newer push after empty recovery until the active bar is refreshed', async () => {
    const transport = new PushTigerTransport();
    transport.streamBatches.push([kline(T0, 100)], [kline(T0 + 120, 102)]);
    const { instance, instrument } = await provider(transport);
    await expect(
      collect(
        instance.liveBars!(instrument, '1m', {
          source: { kind: 'native' },
          reconnectDelayMs: 0,
        }),
        3,
      ),
    ).rejects.toMatchObject({ code: 'live-discontinuity', retryable: false });
  });

  test('accepts a same-open refresh after empty recovery before rollover', async () => {
    const transport = new PushTigerTransport();
    transport.streamBatches.push([kline(T0, 100)], [kline(T0, 101, 30_000), kline(T0 + 60, 102)]);
    const { instance, instrument } = await provider(transport);
    const controller = new AbortController();
    const updates = await collect(
      instance.liveBars!(instrument, '1m', {
        source: { kind: 'native' },
        reconnectDelayMs: 0,
        throttleMs: 0,
        signal: controller.signal,
      }),
      4,
      controller,
    );
    expect(updates.map((update) => [update.bar.time, update.isClose, update.bar.close])).toEqual([
      [T0, false, 100.5],
      [T0, false, 101.5],
      [T0, true, 101.5],
      [T0 + 60, false, 102.5],
    ]);
  });

  test('does not treat a duplicate same-open frame as a refresh after empty recovery', async () => {
    const transport = new PushTigerTransport();
    transport.streamBatches.push(
      [kline(T0, 100, 20_000)],
      [kline(T0, 100, 20_000), kline(T0 + 60, 102)],
    );
    const { instance, instrument } = await provider(transport);
    const updates: BarUpdate[] = [];
    let caught: unknown;
    try {
      for await (const update of instance.liveBars!(instrument, '1m', {
        source: { kind: 'native' },
        reconnectDelayMs: 0,
        throttleMs: 0,
      })) {
        updates.push(update);
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'live-discontinuity', retryable: false });
    expect(updates.map((update) => [update.bar.time, update.isClose, update.revision])).toEqual([
      [T0, false, 1],
    ]);
  });

  test('stale push rows do not reset the bounded reconnect budget', async () => {
    const transport = new PushTigerTransport();
    transport.streamBatches.push([kline(T0)], [kline(T0)]);
    const { instance, instrument } = await provider(transport);
    await expect(
      collect(
        instance.liveBars!(instrument, '1m', {
          source: { kind: 'native' },
          after: T0,
          reconnectAttempts: 1,
          reconnectDelayMs: 0,
        }),
        1,
      ),
    ).rejects.toMatchObject({ code: 'connectivity' });
    expect(transport.subscriptions).toHaveLength(2);
  });

  test('zero-delay retries yield so timer-driven cancellation is observed', async () => {
    const transport = new PushTigerTransport();
    const { instance, instrument } = await provider(transport);
    const controller = new AbortController();
    const iterator = instance.liveBars!(instrument, '1m', {
      source: { kind: 'native' },
      reconnectAttempts: 1_000_000,
      reconnectDelayMs: 0,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    setTimeout(() => controller.abort(), 0);
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  test('bounds reconnect attempts and classifies malformed push payloads', async () => {
    const exhausted = new PushTigerTransport();
    exhausted.streamBatches.push([], []);
    const first = await provider(exhausted);
    await expect(
      collect(
        first.instance.liveBars!(first.instrument, '1m', {
          source: { kind: 'native' },
          reconnectAttempts: 1,
          reconnectDelayMs: 0,
        }),
        1,
      ),
    ).rejects.toMatchObject({ code: 'connectivity' });

    const malformed = new PushTigerTransport();
    malformed.streamBatches.push([{ ...kline(T0), symbol: 'OTHER' }]);
    const second = await provider(malformed);
    await expect(
      collect(
        second.instance.liveBars!(second.instrument, '1m', {
          source: { kind: 'native' },
        }),
        1,
      ),
    ).rejects.toMatchObject({ code: 'malformed-data', retryable: false });
  });
});

test('Tiger liveBars does not retain lifecycle state before iteration starts', async () => {
  const { instance, instrument } = await provider(new PushTigerTransport());
  let listenersAdded = 0;
  const signal = {
    aborted: false,
    addEventListener: () => {
      listenersAdded++;
    },
    removeEventListener: () => {},
  } as unknown as AbortSignal;

  instance.liveBars!(instrument, '1m', {
    source: { kind: 'native' },
    signal,
  });

  expect(listenersAdded).toBe(0);
  await instance.disconnect();
});

test('Tiger push cancellation closes the active transport iterator', async () => {
  const transport = new PushTigerTransport();
  transport.streamBatches.push([kline(T0)]);
  const { instance, instrument } = await provider(transport);
  const controller = new AbortController();
  await collect(
    instance.liveBars!(instrument, '1m', {
      source: { kind: 'native' },
      signal: controller.signal,
    }),
    1,
    controller,
  );
  expect(transport.closedStreams).toBe(1);
});

test('return aborts a stalled reconnect recovery without waiting for REST', async () => {
  const transport = new PushTigerTransport();
  transport.streamBatches.push([kline(T0)]);
  let recoveryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    recoveryStarted = resolve;
  });
  transport.bars = async () => {
    recoveryStarted();
    return await new Promise<TigerBarsResult>(() => {});
  };
  const { instance, instrument } = await provider(transport);
  const iterator = instance.liveBars!(instrument, '1m', {
    source: { kind: 'native' },
    reconnectDelayMs: 0,
  })[Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toMatchObject({ done: false });
  const pending = iterator.next();
  await started;
  await expect(iterator.return?.()).resolves.toMatchObject({ done: true });
  await expect(pending).resolves.toMatchObject({ done: true });
});

test('provider disconnect aborts a stalled reconnect recovery', async () => {
  const transport = new PushTigerTransport();
  transport.streamBatches.push([kline(T0)]);
  let recoveryStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    recoveryStarted = resolve;
  });
  transport.bars = async () => {
    recoveryStarted();
    return await new Promise<TigerBarsResult>(() => {});
  };
  const { instance, instrument } = await provider(transport);
  const iterator = instance.liveBars!(instrument, '1m', {
    source: { kind: 'native' },
    reconnectDelayMs: 0,
  })[Symbol.asyncIterator]();
  await iterator.next();
  const pending = iterator.next();
  await started;
  await instance.disconnect();
  await expect(pending).resolves.toMatchObject({ done: true });
});

test('Tiger reconnect option validation is synchronous', async () => {
  const { instance, instrument } = await provider(new PushTigerTransport());
  expect(() =>
    instance.liveBars!(instrument, '1m', {
      source: { kind: 'native' },
      reconnectAttempts: -1,
    }),
  ).toThrow(RangeError);
});

test('Tiger reconnect recovery fails closed when more than 1,000 bars were missed', async () => {
  const transport = new PushTigerTransport();
  transport.streamBatches.push([kline(T0)], []);
  transport.barBatches.push({
    bars: Array.from({ length: 1_001 }, (_, index) => bar(T0 + index * 60, 100 + index)),
    finality: Array.from({ length: 1_001 }, () => true),
  });
  const { instance, instrument } = await provider(transport);
  let caught: unknown;
  try {
    await collect(
      instance.liveBars!(instrument, '1m', {
        source: { kind: 'native' },
        reconnectDelayMs: 0,
      }),
      2,
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    name: 'MarketDataError',
    code: 'live-discontinuity',
    retryable: false,
  });
});
