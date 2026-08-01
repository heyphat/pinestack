import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BarUpdateValidator,
  ExactChildBarAggregator,
  LiveBarUpdateBuffer,
  MarketDataError,
  ReplayProvider,
  StaticProvider,
  bufferLiveBarUpdates,
  conformLiveBarUpdates,
  supportsLiveBars,
  type Bar,
  type BarUpdate,
  type LiveSourcePolicy,
} from '../src/index.js';
import { cached } from '../src/node.js';

const native = Object.freeze({ kind: 'native' as const });
const lower1m = Object.freeze({ kind: 'lower-bars' as const, timeframe: '1m' });

function bar(time: number, values: Partial<Omit<Bar, 'time'>> = {}): Bar {
  return {
    time,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 1,
    ...values,
  };
}

function update(
  time: number,
  revision: number,
  isClose: boolean,
  eventTime: number,
  values: Partial<Omit<Bar, 'time'>> = {},
  source: LiveSourcePolicy = native,
  metadata: Pick<BarUpdate, 'provenance' | 'recovered'> = {},
): BarUpdate {
  return {
    bar: bar(time, values),
    revision,
    isClose,
    eventTime,
    source,
    ...metadata,
  };
}

function replaySource(history: readonly Bar[], timeframe = '1m') {
  return new StaticProvider(
    { [`X|${timeframe}`]: [...history] },
    {
      alignment: 'utc-24x7',
      timeframes: [timeframe],
      cacheIdentity: 'live-fixture-v1',
    },
  ).setInstrument('X', { minQty: 1, mintick: 0.25 });
}

function completeLower1mTrace(open: number, firstEventTime = 1_000): BarUpdate[] {
  return [0, 60, 120, 180, 240].map((offset, index) =>
    update(open + offset, 1, true, firstEventTime + index, {}, lower1m),
  );
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

test('BarUpdateValidator freezes accepted updates and enforces revision/finality protocol', () => {
  const validator = new BarUpdateValidator({ timeframe: '1m', source: native });
  const first = validator.accept(update(0, 1, false, 1_000));
  const revised = validator.accept(update(0, 2, false, 1_001, { close: 11.5 }));
  const final = validator.accept(update(0, 3, true, 1_002, { close: 11.5 }));

  expect(first).toBeDefined();
  expect(revised?.revision).toBe(2);
  expect(final?.isClose).toBe(true);
  expect(Object.isFrozen(final)).toBe(true);
  expect(Object.isFrozen(final?.bar)).toBe(true);
  expect(Object.isFrozen(final?.source)).toBe(true);

  // Equivalent duplicate finals are idempotent even when transport metadata differs.
  expect(validator.accept(update(0, 3, true, 1_003, { close: 11.5 }))).toBeUndefined();
  expect(() => validator.accept(update(0, 4, true, 1_004, { close: 11.75 }))).toThrow(
    'conflicting authoritative finals',
  );
  expect(() => validator.accept(update(0, 5, false, 1_005, { close: 11.5 }))).toThrow(
    'after finalization',
  );
});

test('BarUpdate validation rejects malformed opens, OHLCV, revisions, clocks, sources, and gaps', () => {
  expect(() =>
    new BarUpdateValidator({ timeframe: '1m', source: native }).accept(update(1, 1, false, 1_000)),
  ).toThrow('not aligned');
  expect(() =>
    new BarUpdateValidator({ timeframe: '1m', source: native }).accept(update(0, 0, false, 1_000)),
  ).toThrow('positive safe integer');
  expect(() =>
    new BarUpdateValidator({ timeframe: '1m', source: native }).accept(
      update(0, 1, false, Number.NaN),
    ),
  ).toThrow('eventTime');
  expect(() =>
    new BarUpdateValidator({ timeframe: '1m', source: native }).accept(
      update(0, 1, false, 1_000, { high: 9 }),
    ),
  ).toThrow('inconsistent OHLC');
  expect(() =>
    new BarUpdateValidator({ timeframe: '1m', source: native }).accept(
      update(0, 1, false, 1_000, { volume: -1 }),
    ),
  ).toThrow('negative volume');
  expect(() =>
    new BarUpdateValidator({ timeframe: '1m', source: native }).accept(
      update(0, 1, false, 1_000, {}, lower1m),
    ),
  ).toThrow('does not match');
  expect(() =>
    new BarUpdateValidator({ timeframe: '1m', source: lower1m }).accept(
      update(0, 1, false, 1_000, {}, lower1m),
    ),
  ).toThrow('not an exact child timeframe');

  const revisions = new BarUpdateValidator({ timeframe: '1m', source: native });
  revisions.accept(update(0, 2, false, 1_000));
  expect(() => revisions.accept(update(0, 2, true, 1_001))).toThrow('strictly increase');

  const clocks = new BarUpdateValidator({ timeframe: '1m', source: native });
  clocks.accept(update(0, 1, false, 1_000));
  expect(() => clocks.accept(update(0, 2, true, 999))).toThrow('eventTime decreased');

  const gap = new BarUpdateValidator({ timeframe: '1m', source: native });
  gap.accept(update(0, 1, false, 1_000));
  expect(() => gap.accept(update(60, 1, true, 1_001))).toThrow('before the active bar');
});

test('exact child aggregation replaces revised slots and requires an authoritative matching final', () => {
  const aggregator = new ExactChildBarAggregator({
    sourceTimeframe: '1m',
    targetTimeframe: '5m',
  });
  const outputs: BarUpdate[] = [];
  const accept = (value: BarUpdate) => {
    const output = aggregator.accept(value);
    if (output) outputs.push(output);
  };

  accept(update(0, 1, false, 1_000, { open: 10, high: 11, low: 9, close: 10, volume: 1 }, lower1m));
  accept(update(0, 2, false, 1_001, { open: 10, high: 12, low: 9, close: 11, volume: 3 }, lower1m));
  accept(update(0, 3, true, 1_002, { open: 10, high: 12, low: 9, close: 11, volume: 3 }, lower1m));
  accept(
    update(60, 1, true, 1_003, { open: 11, high: 13, low: 10, close: 12, volume: 2 }, lower1m),
  );
  accept(
    update(120, 1, true, 1_004, { open: 12, high: 14, low: 11, close: 13, volume: 2 }, lower1m),
  );
  accept(
    update(180, 1, true, 1_005, { open: 13, high: 15, low: 12, close: 14, volume: 2 }, lower1m),
  );
  accept(
    update(240, 1, true, 1_006, { open: 14, high: 15, low: 13, close: 14, volume: 2 }, lower1m),
  );

  expect(outputs[1]?.bar.volume).toBe(3);
  expect(outputs.at(-1)).toMatchObject({
    isClose: false,
    bar: { time: 0, open: 10, high: 15, low: 9, close: 14, volume: 11 },
  });

  const final = aggregator.finalize(
    update(0, 99, true, 1_007, { open: 10, high: 15, low: 9, close: 14, volume: 11 }, lower1m),
  );
  expect(final).toMatchObject({ isClose: true, revision: 8, bar: { volume: 11 } });
  expect(aggregator.formingCount).toBe(0);
});

test('exact child aggregation honors provider slot evidence and rejects final mismatch', () => {
  const aggregator = new ExactChildBarAggregator({
    sourceTimeframe: '1m',
    targetTimeframe: '5m',
    anchorTime: 30,
    bucketFor: () => ({ open: 30, slots: [30, 90, 150, 210, 270] }),
  });
  for (const [index, time] of [30, 90, 150, 210, 270].entries()) {
    aggregator.accept(
      update(
        time,
        1,
        true,
        2_000 + index,
        { open: 10 + index, high: 12 + index, low: 9 + index, close: 11 + index, volume: 1 },
        lower1m,
      ),
    );
  }
  expect(() =>
    aggregator.finalize(
      update(30, 1, true, 2_010, { open: 10, high: 16, low: 9, close: 15, volume: 99 }, lower1m),
    ),
  ).toThrow('conflicts with exact child aggregation');
});

test('stream conformance throttles only forming updates and never coalesces away a final', async () => {
  const trace = [
    update(0, 1, false, 1_000),
    update(0, 2, false, 1_050, { close: 11.1 }),
    update(0, 3, false, 1_090, { close: 11.2 }),
    update(0, 4, false, 1_200, { close: 11.3 }),
    update(0, 5, true, 1_250, { close: 11.3 }),
  ];
  const values = await collect(
    conformLiveBarUpdates(trace, {
      timeframe: '1m',
      source: native,
      throttleMs: 100,
      maxPendingFinals: 2,
    }),
  );
  expect(values.map((value) => [value.revision, value.isClose, value.coalescedCount ?? 0])).toEqual(
    [
      [1, false, 0],
      [4, false, 2],
      [5, true, 0],
    ],
  );
});

test('recovery buffer keeps one forming snapshot, preserves finals, and fails on final overflow', () => {
  const buffer = new LiveBarUpdateBuffer(1);
  buffer.push(update(0, 1, false, 1_000));
  buffer.push(update(0, 2, false, 1_001, { close: 11.5 }));
  buffer.push(update(0, 3, true, 1_002, { close: 11.5 }));
  expect(buffer.formingCount).toBe(0);
  expect(buffer.finalCount).toBe(1);
  expect(buffer.shift()).toMatchObject({ isClose: true, revision: 3, coalescedCount: 2 });

  buffer.push(update(60, 1, true, 1_003));
  expect(() => buffer.push(update(120, 1, true, 1_004))).toThrow('final queue overflow');
  expect(buffer.shift()?.bar.time).toBe(60);
});

test('ReplayProvider emits only explicit immutable traces and verifies authoritative finals', async () => {
  const final300 = bar(300, { open: 20, high: 23, low: 19, close: 22, volume: 8 });
  const final360 = bar(360, { open: 22, high: 24, low: 21, close: 23, volume: 4 });
  const source = replaySource([bar(240), final300, final360]);
  const provider = new ReplayProvider(source, {
    cutoverTime: 300,
    updates: {
      'X|1m': [
        update(300, 1, false, 300_010, { open: 20, high: 21, low: 19, close: 20, volume: 1 }),
        update(300, 2, false, 300_020, { open: 20, high: 23, low: 19, close: 22, volume: 8 }),
        update(
          300,
          3,
          true,
          300_030,
          { open: 20, high: 23, low: 19, close: 22, volume: 8 },
          native,
          {
            provenance: { fixture: 'explicit' },
          },
        ),
      ],
    },
  });
  expect(supportsLiveBars(provider)).toBe(true);
  const resolved = await provider.resolve('X');
  const values = await collect(provider.liveBars(resolved, '1m', { source: native }));
  expect(values).toHaveLength(3);
  expect(values.at(-1)?.bar).toEqual(final300);
  expect(Object.isFrozen(values[0])).toBe(true);
  expect(Object.isFrozen(values[0]?.bar)).toBe(true);
  expect(Object.isFrozen(values[0]?.source)).toBe(true);
  expect(Object.isFrozen(values.at(-1)?.provenance)).toBe(true);

  const exact = await provider.resolveHistorySource!('X');
  expect(exact.provider).toBe(source);
  expect(exact.normalizedSymbol).toBe('X');

  const noTrace = new ReplayProvider(source, { cutoverTime: 300 });
  const noTraceResolved = await noTrace.resolve('X');
  expect(await collect(noTrace.liveBars(noTraceResolved, '1m', { source: native }))).toEqual([]);
});

test('ReplayProvider lower-bars consumes child keys, replaces revisions, and leaves native mode unchanged', async () => {
  const chartFinal = bar(300, { volume: 7 });
  const childTrace = [
    update(300, 1, false, 1_000, { volume: 1 }, lower1m),
    update(300, 2, true, 1_001, { volume: 3 }, lower1m),
    ...[60, 120, 180, 240].map((offset, index) =>
      update(300 + offset, 1, true, 1_002 + index, { volume: 1 }, lower1m),
    ),
  ];
  const provider = new ReplayProvider(replaySource([chartFinal], '5m'), {
    cutoverTime: 300,
    paceMs: 1,
    lowerBars: { anchorTime: 0 },
    updates: {
      'X|1m': childTrace,
      'X|5m': [update(300, 1, true, 2_000, { volume: 7 })],
    },
  });
  const resolved = await provider.resolve('X');

  const lowerValues = await collect(provider.liveBars(resolved, '5m', { source: lower1m }));
  expect(lowerValues.map((value) => value.bar.time)).toEqual(Array(7).fill(300));
  expect(lowerValues.map((value) => value.bar.volume)).toEqual([1, 3, 4, 5, 6, 7, 7]);
  expect(lowerValues.map((value) => value.revision)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(lowerValues.slice(0, -1).every((value) => !value.isClose)).toBe(true);
  expect(lowerValues.at(-1)).toMatchObject({
    isClose: true,
    bar: chartFinal,
    source: lower1m,
  });

  const nativeValues = await collect(provider.liveBars(resolved, '5m', { source: native }));
  expect(nativeValues).toHaveLength(1);
  expect(nativeValues[0]).toMatchObject({ isClose: true, bar: chartFinal, source: native });
});

test('ReplayProvider lower-bars honors exact provider bucket evidence', async () => {
  const contexts = new Set<string>();
  const provider = new ReplayProvider(replaySource([bar(30, { volume: 5 })], '5m'), {
    cutoverTime: 30,
    paceMs: 1,
    lowerBars: {
      anchorTime: 30,
      bucketFor: (childOpen, context) => {
        contexts.add(`${context.symbol}|${context.sourceTimeframe}|${context.targetTimeframe}`);
        const open = 30 + Math.floor((childOpen - 30) / 300) * 300;
        return { open, slots: [0, 60, 120, 180, 240].map((offset) => open + offset) };
      },
    },
    updates: { 'X|1m': completeLower1mTrace(30, 2_000) },
  });
  const resolved = await provider.resolve('X');
  const values = await collect(provider.liveBars(resolved, '5m', { source: lower1m }));

  expect(contexts).toEqual(new Set(['X|1m|5m']));
  expect(values.every((value) => value.bar.time === 30)).toBe(true);
  expect(values.at(-1)).toMatchObject({ isClose: true, bar: { time: 30, volume: 5 } });
});

test('ReplayProvider lower-bars rejects an authoritative chart mismatch', async () => {
  const provider = new ReplayProvider(replaySource([bar(300, { volume: 99 })], '5m'), {
    cutoverTime: 300,
    lowerBars: { anchorTime: 0 },
    updates: { 'X|1m': completeLower1mTrace(300, 3_000) },
  });
  const resolved = await provider.resolve('X');
  await expect(
    collect(provider.liveBars(resolved, '5m', { source: lower1m })),
  ).rejects.toMatchObject({
    code: 'malformed-data',
    message: expect.stringContaining('conflicts with exact child aggregation'),
  });
});

test('ReplayProvider lower-bars applies chart-bucket cutover and recovers only proven gaps', async () => {
  const provider = new ReplayProvider(
    replaySource([bar(300, { volume: 5 }), bar(600), bar(900, { volume: 5 })], '5m'),
    {
      cutoverTime: 300,
      paceMs: 1,
      lowerBars: { anchorTime: 0 },
      updates: {
        'X|1m': [update(360, 0, true, 3_999, {}, lower1m), ...completeLower1mTrace(900, 4_000)],
      },
    },
  );
  const resolved = await provider.resolve('X');
  const values = await collect(provider.liveBars(resolved, '5m', { source: lower1m, after: 300 }));

  expect(values[0]).toMatchObject({
    bar: { time: 600 },
    isClose: true,
    recovered: true,
    source: lower1m,
  });
  expect(values.slice(1).every((value) => value.bar.time === 900)).toBe(true);
  expect(values.at(-1)).toMatchObject({ isClose: true });
  expect(values.at(-1)?.recovered).toBeUndefined();
  expect(values.some((value) => [360, 960, 1_020, 1_080, 1_140].includes(value.bar.time))).toBe(
    false,
  );
});

test('ReplayProvider lower-bars never treats a chart-shaped trace as a child path', async () => {
  const provider = new ReplayProvider(replaySource([bar(300)], '5m'), {
    cutoverTime: 300,
    lowerBars: { anchorTime: 0 },
    updates: { 'X|5m': [update(300, 1, true, 5_000, {}, lower1m)] },
  });
  const resolved = await provider.resolve('X');
  expect(await collect(provider.liveBars(resolved, '5m', { source: lower1m }))).toEqual([]);
});

test('ReplayProvider cutover/after recovery is exclusive and never evaluates consumed bars', async () => {
  const source = replaySource([bar(240), bar(300), bar(360)]);
  const provider = new ReplayProvider(source, {
    cutoverTime: 300,
    liveUpdates: {
      'X|1m': [
        update(240, 1, true, 240_001, {}, native, { recovered: true }),
        update(300, 1, false, 299_999, { close: 10.5 }),
        update(300, 2, true, 300_001),
        update(360, 1, true, 360_001, {}, native, { recovered: true }),
      ],
    },
  });
  const resolved = await provider.resolve('X');
  const values = await collect(provider.liveBars(resolved, '1m', { source: native, after: 300 }));
  expect(values.map((value) => value.bar.time)).toEqual([360]);
  expect(values[0]?.recovered).toBe(true);
});

test('ReplayProvider aborts a pending event-clock wait without yielding', async () => {
  const source = replaySource([bar(300)]);
  let waiting!: () => void;
  const started = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const provider = new ReplayProvider(source, {
    cutoverTime: 300,
    eventClock: () => 0,
    updates: { 'X|1m': [update(300, 1, false, 1_000)] },
    sleep: async (_milliseconds, signal) => {
      waiting();
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
    },
  });
  const resolved = await provider.resolve('X');
  const controller = new AbortController();
  const next = provider
    .liveBars(resolved, '1m', { source: native, signal: controller.signal })
    [Symbol.asyncIterator]()
    .next();
  await started;
  controller.abort();
  await expect(next).resolves.toMatchObject({ done: true });
});

test('ReplayProvider recovers a missing active final and still rejects malformed/conflicting data', async () => {
  const source = replaySource([bar(300), bar(360)]);
  const recovering = new ReplayProvider(source, {
    cutoverTime: 300,
    updates: {
      'X|1m': [update(300, 1, false, 1_000), update(360, 1, true, 1_001)],
    },
  });
  const recoveringResolved = await recovering.resolve('X');
  const recovered = await collect(
    recovering.liveBars(recoveringResolved, '1m', { source: native }),
  );
  expect(
    recovered.map((value) => [value.bar.time, value.isClose, value.recovered ?? false]),
  ).toEqual([
    [300, false, false],
    [300, true, true],
    [360, true, false],
  ]);

  const malformed = new ReplayProvider(source, {
    cutoverTime: 300,
    updates: {
      'X|1m': [update(300, 2, false, 1_000), update(300, 2, true, 1_001)],
    },
  });
  const malformedResolved = await malformed.resolve('X');
  await expect(
    collect(malformed.liveBars(malformedResolved, '1m', { source: native })),
  ).rejects.toMatchObject({ code: 'malformed-data' });

  const conflict = new ReplayProvider(source, {
    cutoverTime: 300,
    updates: {
      'X|1m': [update(300, 1, true, 1_000, { close: 11.5 })],
    },
  });
  const conflictResolved = await conflict.resolve('X');
  await expect(
    collect(conflict.liveBars(conflictResolved, '1m', { source: native })),
  ).rejects.toBeInstanceOf(MarketDataError);
});

test('ReplayProvider EOF recovers a separately authoritative active final', async () => {
  const provider = new ReplayProvider(replaySource([bar(300)]), {
    cutoverTime: 300,
    paceMs: 1,
    updates: { 'X|1m': [update(300, 1, false, 1_000, { close: 10.5 })] },
  });
  const resolved = await provider.resolve('X');
  const values = await collect(provider.liveBars(resolved, '1m', { source: native }));

  expect(values).toHaveLength(2);
  expect(values[0]).toMatchObject({ isClose: false, revision: 1 });
  expect(values[1]).toMatchObject({
    bar: bar(300),
    isClose: true,
    revision: 2,
    recovered: true,
    provenance: { recovery: 'authoritative-history-eof' },
  });
});

test('ReplayProvider EOF without an authoritative final throws an identified discontinuity', async () => {
  const provider = new ReplayProvider(replaySource([]), {
    cutoverTime: 300,
    updates: { 'X|1m': [update(300, 1, false, 1_000)] },
  });
  const resolved = await provider.resolve('X');
  await expect(
    collect(provider.liveBars(resolved, '1m', { source: native })),
  ).rejects.toMatchObject({
    code: 'live-discontinuity',
    retryable: false,
    details: { activeBarTime: 300, timeframe: '1m', source: 'native' },
  });
});

test('stream conformance rejects active EOF without flushing a throttled orphan snapshot', async () => {
  const iterator = conformLiveBarUpdates(
    [update(0, 1, false, 1_000), update(0, 2, false, 1_001, { close: 11.5 })],
    { timeframe: '1m', source: native, throttleMs: 100 },
  )[Symbol.asyncIterator]();

  expect((await iterator.next()).value).toMatchObject({ revision: 1 });
  await expect(iterator.next()).rejects.toMatchObject({
    code: 'live-discontinuity',
    details: { activeBarTime: 0, timeframe: '1m' },
  });
});

test('cached MarketDataProvider forwards liveBars without writing update cache entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pinery-live-cache-'));
  try {
    const source = replaySource([bar(300)]);
    const replay = new ReplayProvider(source, {
      cutoverTime: 300,
      updates: { 'X|1m': [update(300, 1, true, 1_000)] },
    });
    const provider = cached(replay, { dir });
    expect(supportsLiveBars(provider)).toBe(true);
    const resolved = await provider.resolve('X');
    expect(
      (await collect(provider.liveBars!(resolved, '1m', { source: native }))).map(
        (value) => value.bar.time,
      ),
    ).toEqual([300]);
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('aggregate output rejects provider bucket misalignment and event-time regression', () => {
  const unaligned = new ExactChildBarAggregator({
    sourceTimeframe: '1m',
    targetTimeframe: '5m',
    bucketFor: () => ({ open: 1, slots: [0, 60, 120, 180, 240] }),
  });
  expect(() => unaligned.accept(update(0, 1, true, 3_000, {}, lower1m))).toThrow(
    'invalid live child',
  );

  const clocked = new ExactChildBarAggregator({
    sourceTimeframe: '1m',
    targetTimeframe: '5m',
  });
  for (const [index, time] of [0, 60, 120, 180, 240].entries()) {
    clocked.accept(update(time, 1, true, 3_000 + index, {}, lower1m));
  }
  expect(() => clocked.finalize(update(0, 1, true, 3_003, { volume: 5 }, lower1m))).toThrow(
    'eventTime decreased',
  );
});

test('ReplayProvider recovers every authoritative final in a multi-bar gap', async () => {
  const source = replaySource([bar(300), bar(360), bar(420)]);
  const provider = new ReplayProvider(source, {
    cutoverTime: 300,
    updates: {
      'X|1m': [update(300, 1, true, 1_000), update(420, 1, true, 1_001)],
    },
  });
  const resolved = await provider.resolve('X');
  const values = await collect(provider.liveBars(resolved, '1m', { source: native }));
  expect(values.map((value) => [value.bar.time, value.recovered ?? false])).toEqual([
    [300, false],
    [360, true],
    [420, false],
  ]);
});

test('ReplayProvider retries authoritative recovery with injected backoff', async () => {
  let historyCalls = 0;
  let sleeps = 0;
  const source = {
    id: 'flaky-replay-source',
    async history() {
      historyCalls++;
      if (historyCalls === 1) throw new Error('temporary fixture disconnect');
      return [bar(300)];
    },
    async instrument() {
      return { minQty: 1, mintick: 0.25 };
    },
  };
  const provider = new ReplayProvider(source, {
    cutoverTime: 300,
    updates: { 'X|1m': [update(300, 1, true, 1_000)] },
    sleep: async () => {
      sleeps++;
    },
  });
  const resolved = await provider.resolve('X');
  expect(
    await collect(
      provider.liveBars(resolved, '1m', {
        source: native,
        reconnectAttempts: 1,
        reconnectDelayMs: 0,
        reconnectMaxDelayMs: 0,
      }),
    ),
  ).toHaveLength(1);
  expect(historyCalls).toBe(2);
  expect(sleeps).toBe(1);
});

test('ReplayProvider live delivery enforces the non-droppable final queue bound', async () => {
  const source = replaySource([bar(300), bar(360), bar(420)]);
  const provider = new ReplayProvider(source, {
    cutoverTime: 300,
    updates: {
      'X|1m': [
        update(300, 1, true, 1_000),
        update(360, 1, true, 1_001),
        update(420, 1, true, 1_002),
      ],
    },
  });
  const resolved = await provider.resolve('X');
  const iterator = provider
    .liveBars(resolved, '1m', { source: native, maxPendingFinals: 1 })
    [Symbol.asyncIterator]();
  expect((await iterator.next()).value?.bar.time).toBe(300);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await iterator.next()).value?.bar.time).toBe(360);
  await expect(iterator.next()).rejects.toThrow('final queue overflow');
});

test('Replay traces are timeframe-exact and preserve legacy fractional pacing options', () => {
  const source = replaySource([bar(300)]);
  expect(
    () =>
      new ReplayProvider(source, {
        cutoverTime: 300,
        paceMs: 0.5,
        clockPollIntervalMs: 0.5,
      }),
  ).not.toThrow();
  expect(
    () =>
      new ReplayProvider(source, {
        cutoverTime: 300,
        updates: { X: [update(300, 1, true, 1_000)] },
      }),
  ).toThrow('exact symbol|timeframe key');
});

test('BarUpdateValidator bounds duplicate-final retention while rejecting stale updates', () => {
  const validator = new BarUpdateValidator({
    timeframe: '1m',
    source: native,
    maxFinalizedBars: 2,
  });
  validator.accept(update(0, 1, true, 1_000));
  validator.accept(update(60, 1, true, 1_001));
  validator.accept(update(120, 1, true, 1_002));
  expect(validator.finalizedCount).toBe(2);
  expect(validator.accept(update(60, 1, true, 1_003))).toBeUndefined();
  expect(() => validator.accept(update(0, 1, false, 1_004))).toThrow('did not strictly increase');
});

test('buffered stream return closes an upstream iterator blocked in next', async () => {
  let releaseNext: ((result: IteratorResult<BarUpdate>) => void) | undefined;
  let returnCalls = 0;
  const source: AsyncIterable<BarUpdate> = {
    [Symbol.asyncIterator]() {
      let first = true;
      return {
        async next(): Promise<IteratorResult<BarUpdate>> {
          if (first) {
            first = false;
            return { done: false, value: update(0, 1, false, 1_000) };
          }
          return new Promise<IteratorResult<BarUpdate>>((resolve) => {
            releaseNext = resolve;
          });
        },
        async return(): Promise<IteratorResult<BarUpdate>> {
          returnCalls++;
          releaseNext?.({ done: true, value: undefined });
          return { done: true, value: undefined };
        },
      };
    },
  };
  const iterator = bufferLiveBarUpdates(source)[Symbol.asyncIterator]();
  expect((await iterator.next()).value?.revision).toBe(1);
  await expect(iterator.return!()).resolves.toMatchObject({ done: true });
  expect(returnCalls).toBe(1);
});

test('buffered stream abort closes a source that produced but was not exhausted', async () => {
  const controller = new AbortController();
  let returnCalls = 0;
  const source: AsyncIterable<BarUpdate> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<BarUpdate>> {
          controller.abort();
          return { done: false, value: update(0, 1, false, 1_000) };
        },
        async return(): Promise<IteratorResult<BarUpdate>> {
          returnCalls++;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const iterator = bufferLiveBarUpdates(source, {
    signal: controller.signal,
  })[Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toMatchObject({ done: true });
  expect(returnCalls).toBe(1);
});

test('buffered stream bounds noncooperative next, return, and producer teardown', async () => {
  let nextCalls = 0;
  let markBlocked!: () => void;
  const blocked = new Promise<void>((resolve) => {
    markBlocked = resolve;
  });
  const source: AsyncIterable<BarUpdate> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<BarUpdate>> {
          nextCalls++;
          if (nextCalls === 1) {
            return { done: false, value: update(0, 1, false, 1_000) };
          }
          markBlocked();
          return new Promise<IteratorResult<BarUpdate>>(() => {});
        },
        async return(): Promise<IteratorResult<BarUpdate>> {
          return new Promise<IteratorResult<BarUpdate>>(() => {});
        },
      };
    },
  };
  const iterator = bufferLiveBarUpdates(source, {
    teardownTimeoutMs: 10,
  })[Symbol.asyncIterator]();

  expect((await iterator.next()).value?.revision).toBe(1);
  await blocked;
  await expect(iterator.return!()).rejects.toMatchObject({
    code: 'live-cleanup',
    retryable: false,
    details: {
      teardownTimeoutMs: 10,
      pendingNextOrProducer: true,
      pendingReturn: true,
    },
  });
});

test('buffered return immediately cancels a pending consumer read before teardown', async () => {
  let markNextStarted!: () => void;
  const nextStarted = new Promise<void>((resolve) => {
    markNextStarted = resolve;
  });
  let returnCalls = 0;
  const source: AsyncIterable<BarUpdate> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<BarUpdate>> {
          markNextStarted();
          return new Promise<IteratorResult<BarUpdate>>(() => {});
        },
        async return(): Promise<IteratorResult<BarUpdate>> {
          returnCalls++;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const iterator = bufferLiveBarUpdates(source, {
    teardownTimeoutMs: 10,
  })[Symbol.asyncIterator]();
  const pendingRead = iterator.next();
  await nextStarted;

  await expect(iterator.return!()).rejects.toMatchObject({
    code: 'live-cleanup',
    details: {
      teardownTimeoutMs: 10,
      pendingNextOrProducer: true,
      pendingReturn: false,
    },
  });
  await expect(pendingRead).resolves.toMatchObject({ done: true });
  expect(returnCalls).toBe(1);
});

test('ReplayProvider return bounds a pending public liveBars read', async () => {
  let markSleepStarted!: () => void;
  const sleepStarted = new Promise<void>((resolve) => {
    markSleepStarted = resolve;
  });
  const provider = new ReplayProvider(replaySource([bar(300)]), {
    cutoverTime: 300,
    eventClock: () => 0,
    updates: { 'X|1m': [update(300, 1, false, 1_000)] },
    sleep: async () => {
      markSleepStarted();
      return new Promise<void>(() => {});
    },
  });
  const resolved = await provider.resolve('X');
  const iterator = provider
    .liveBars(resolved, '1m', { source: native, teardownTimeoutMs: 10 })
    [Symbol.asyncIterator]();
  const pendingRead = iterator.next();
  await sleepStarted;

  await expect(iterator.return!()).rejects.toMatchObject({
    code: 'live-cleanup',
    details: {
      teardownTimeoutMs: 10,
      pendingNextOrProducer: true,
      pendingReturn: true,
    },
  });
  await expect(pendingRead).resolves.toMatchObject({ done: true });
});

test('BarUpdateValidator applies volume tolerance directly to duplicate finals', () => {
  const summedVolume = [0.1, 0.2, 0.1, 0.2, 0.1].reduce((sum, value) => sum + value, 0);
  expect(summedVolume).not.toBe(0.7);

  const tolerant = new BarUpdateValidator({ timeframe: '1m', source: native });
  tolerant.accept(update(0, 1, true, 1_000, { volume: summedVolume }));
  expect(tolerant.accept(update(0, 1, true, 1_001, { volume: 0.7 }))).toBeUndefined();
  expect(() => tolerant.accept(update(0, 2, true, 1_002, { volume: 0.8 }))).toThrow(
    'conflicting authoritative finals',
  );

  const nearZero = new BarUpdateValidator({ timeframe: '1m', source: native });
  nearZero.accept(update(0, 1, true, 2_000, { volume: 1e-12 }));
  expect(nearZero.accept(update(0, 1, true, 2_001, { volume: 1e-12 + 1e-21 }))).toBeUndefined();

  const zero = new BarUpdateValidator({ timeframe: '1m', source: native });
  zero.accept(update(0, 1, true, 3_000, { volume: 0 }));
  expect(zero.accept(update(0, 1, true, 3_001, { volume: 0 }))).toBeUndefined();
  expect(() => zero.accept(update(0, 2, true, 3_002, { volume: Number.MIN_VALUE }))).toThrow(
    'conflicting authoritative finals',
  );
});
