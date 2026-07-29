import { expect, test } from 'bun:test';
import {
  AlpacaProvider,
  BinanceProvider,
  KrakenProvider,
  MassiveProvider,
  OkxProvider,
  ExactHistoryError,
  InstrumentRouter,
  StaticProvider,
  acquireExactHistory,
  aggregateBars,
  canonicalTimeframeToPineExact,
  halfOpenIntervalMs,
  halfOpenIntervalSec,
  halfOpenMsToHalfOpenSecExact,
  halfOpenMsToInclusiveRangeSec,
  halfOpenSecToHistoryRange,
  boundedHistoryRangeToHalfOpenMs,
  historyAcquisitionFromBars,
  inclusiveRangeSec,
  inclusiveRangeSecToHalfOpen,
  inclusiveRangeSecToHalfOpenMs,
  pineTimeframeToCanonicalExact,
  pinerTimeframeToCanonical,
  planHistoryAcquisition,
  resolveHistorySource,
  selectLargestExactDivisor,
  unixSecond,
  nonSecretBaseUrl,
  validateHistoryAcquisition,
  type Bar,
  type HistoryAcquisition,
  type HistoryProvider,
  type HistoryRequest,
  type ResolvedHistorySource,
} from '../src/index.js';

function bar(time: number, value: number, volume = 1): Bar {
  return {
    time,
    open: value,
    high: value + 2,
    low: value - 1,
    close: value + 1,
    volume,
  };
}

function minuteBars(count: number, start = 0): Bar[] {
  return Array.from({ length: count }, (_, index) =>
    bar(start + index * 60, index + 10, index + 1),
  );
}

function expectDeepFrozenSource(source: ResolvedHistorySource): void {
  expect(Object.isFrozen(source)).toBe(true);
  expect(Object.isFrozen(source.capabilities)).toBe(true);
  if (source.capabilities.timeframes !== 'arbitrary') {
    expect(Object.isFrozen(source.capabilities.timeframes)).toBe(true);
  }
  const calendar = source.capabilities.calendar;
  if (calendar) {
    expect(Object.isFrozen(calendar)).toBe(true);
    expect(Object.isFrozen(calendar.coverage)).toBe(true);
    expect(Object.isFrozen(calendar.sessions)).toBe(true);
    for (const session of calendar.sessions) expect(Object.isFrozen(session)).toBe(true);
    if (calendar.periods) {
      expect(Object.isFrozen(calendar.periods)).toBe(true);
      for (const boundaries of Object.values(calendar.periods)) {
        expect(Object.isFrozen(boundaries)).toBe(true);
        for (const boundary of boundaries) expect(Object.isFrozen(boundary)).toBe(true);
      }
    }
  }
}

function expectTimeframeMutationRejected(source: ResolvedHistorySource): void {
  if (source.capabilities.timeframes === 'arbitrary') return;
  expect(() => (source.capabilities.timeframes as unknown as string[]).push('99m')).toThrow();
}

function mockFetch(bodies: unknown[]) {
  const calls: string[] = [];
  let index = 0;
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    const body = bodies[index++] ?? [];
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    } as unknown as Response;
  }) as typeof fetch;
  return { fn, calls };
}

// ── strict timeframe vocabulary ─────────────────────────────────────────────

test('strict Pine/canonical conversion preserves seconds and leaves legacy clamping unchanged', () => {
  expect(pineTimeframeToCanonicalExact('1S')).toEqual({ kind: 'ok', value: '1s' });
  expect(pineTimeframeToCanonicalExact('30S')).toEqual({ kind: 'ok', value: '30s' });
  expect(pineTimeframeToCanonicalExact('60')).toEqual({ kind: 'ok', value: '60m' });
  expect(pineTimeframeToCanonicalExact('2D')).toEqual({ kind: 'ok', value: '2d' });
  expect(canonicalTimeframeToPineExact('5s')).toEqual({ kind: 'ok', value: '5S' });
  expect(canonicalTimeframeToPineExact('2h')).toEqual({ kind: 'ok', value: '120' });

  const ticks = pineTimeframeToCanonicalExact('100T');
  expect(ticks.kind).toBe('unsupported');
  if (ticks.kind !== 'ok') expect(ticks.code).toBe('tick-timeframe');
  expect(pineTimeframeToCanonicalExact('0S').kind).toBe('malformed');
  expect(pineTimeframeToCanonicalExact('1h').kind).toBe('malformed');

  // The existing generic converter remains compatible for non-magnifier callers.
  expect(pinerTimeframeToCanonical('1S')).toBe('1m');
});

test('largest exact divisor selection never chooses a nearest or non-divisor timeframe', () => {
  expect(selectLargestExactDivisor('10m', ['1m', '3m', '5m'])).toEqual({
    kind: 'ok',
    value: { timeframe: '5m', durationSeconds: 300 },
  });
  expect(selectLargestExactDivisor('2m', ['1m', '3m'])).toEqual({
    kind: 'ok',
    value: { timeframe: '1m', durationSeconds: 60 },
  });
  expect(selectLargestExactDivisor('10s', ['1m', '5m']).kind).toBe('unsupported');
  expect(selectLargestExactDivisor('10m', ['bogus']).kind).toBe('malformed');
});

// ── range arithmetic ─────────────────────────────────────────────────────────

test('inclusive provider ranges and logical half-open ranges use explicit exact arithmetic', () => {
  const inclusive = inclusiveRangeSec(10, 19);
  expect(inclusiveRangeSecToHalfOpen(inclusive)).toEqual({ from: 10, to: 20 });
  expect(inclusiveRangeSecToHalfOpenMs(inclusive)).toEqual({ from: 10_000, to: 20_000 });
  expect(boundedHistoryRangeToHalfOpenMs({ from: 10, to: 19 })).toEqual({
    from: 10_000,
    to: 20_000,
  });
  expect(halfOpenSecToHistoryRange(halfOpenIntervalSec(10, 20))).toEqual({ from: 10, to: 19 });

  // Coarse provider query conversion rounds outward by contract, not as coverage proof.
  expect(halfOpenMsToInclusiveRangeSec(halfOpenIntervalMs(10_001, 19_999))).toEqual({
    from: 10,
    toInclusive: 19,
  });
});

test('semantic subsecond boundaries fail with a typed unsupported outcome', () => {
  expect(() => halfOpenMsToHalfOpenSecExact(halfOpenIntervalMs(10_001, 20_000))).toThrow(
    ExactHistoryError,
  );
  try {
    halfOpenMsToHalfOpenSecExact(halfOpenIntervalMs(10_001, 20_000));
  } catch (error) {
    expect(error).toBeInstanceOf(ExactHistoryError);
    expect((error as ExactHistoryError).kind).toBe('unsupported');
    expect((error as ExactHistoryError).code).toBe('subsecond-boundary');
  }
  expect(halfOpenMsToHalfOpenSecExact(halfOpenIntervalMs(10_000, 20_000))).toEqual({
    from: 10,
    to: 20,
  });
});

// ── source routing, identities, and planning ─────────────────────────────────

test('router resolves the addressed actual leaf provider and normalized leaf symbol', async () => {
  const leaf = new StaticProvider(
    { 'BTCUSDT|1m': minuteBars(2) },
    { alignment: 'utc-24x7', timeframes: ['1m'], cacheIdentity: 'router-leaf' },
  );
  const router = new InstrumentRouter({ providers: { binance: leaf } });
  const source = await router.resolveHistorySource('BI:BTCUSDT');

  expect(source.provider).toBe(leaf);
  expect(source.normalizedSymbol).toBe('BTCUSDT');
  expect(source.cacheIdentity).toContain('router-leaf');
  expect(source.capabilities.alignment).toBe('utc-24x7');
  expectDeepFrozenSource(source);
  const identity = source.cacheIdentity;
  expectTimeframeMutationRejected(source);
  expect(source.cacheIdentity).toBe(identity);
  expect(planHistoryAcquisition(source.capabilities, '1m')).toMatchObject({
    kind: 'native',
    sourceTimeframe: '1m',
  });
});

test('provider identities include data-affecting options and exclude credentials', async () => {
  const common = {
    keyId: 'first-key',
    secretKey: 'first-secret',
    feed: 'iex' as const,
    adjustment: 'split' as const,
    baseUrl: 'https://example.test/data?region=us&api_key=secret',
    maxBars: 123,
  };
  const a = await new AlpacaProvider(common).resolveHistorySource('aapl');
  const sameData = await new AlpacaProvider({
    ...common,
    keyId: 'different-key',
    secretKey: 'different-secret',
  }).resolveHistorySource('AAPL');
  const differentFeed = await new AlpacaProvider({ ...common, feed: 'sip' }).resolveHistorySource(
    'AAPL',
  );
  const differentAdjustment = await new AlpacaProvider({
    ...common,
    adjustment: 'raw',
  }).resolveHistorySource('AAPL');
  const differentMax = await new AlpacaProvider({ ...common, maxBars: 124 }).resolveHistorySource(
    'AAPL',
  );

  expect(a.cacheIdentity).toBe(sameData.cacheIdentity);
  expect(a.cacheIdentity).not.toContain('first-key');
  expect(a.cacheIdentity).not.toContain('first-secret');
  expect(a.cacheIdentity).not.toContain('api_key');
  expect(a.cacheIdentity).not.toContain('secret');
  expect(differentFeed.cacheIdentity).not.toBe(a.cacheIdentity);
  expect(differentAdjustment.cacheIdentity).not.toBe(a.cacheIdentity);
  expect(differentMax.cacheIdentity).not.toBe(a.cacheIdentity);
});

test('network adapter direct sources deeply freeze capabilities and identity them', async () => {
  const providers: HistoryProvider[] = [
    new AlpacaProvider(),
    new BinanceProvider(),
    new KrakenProvider(),
    new MassiveProvider(),
    new OkxProvider(),
  ];
  const sources = await Promise.all([
    providers[0]!.resolveHistorySource!('AAPL'),
    providers[1]!.resolveHistorySource!('BTCUSDT'),
    providers[2]!.resolveHistorySource!('BTC/USD'),
    providers[3]!.resolveHistorySource!('AAPL'),
    providers[4]!.resolveHistorySource!('BTCUSDT'),
  ]);

  for (const [index, source] of sources.entries()) {
    expect(source.provider).toBe(providers[index]);
    expect(source.cacheIdentity).toContain('"capabilities":');
    expectDeepFrozenSource(source);
    const identity = source.cacheIdentity;
    const before = planHistoryAcquisition(source.capabilities, '1h');
    expectTimeframeMutationRejected(source);
    expect(source.cacheIdentity).toBe(identity);
    expect(planHistoryAcquisition(source.capabilities, '1h')).toEqual(before);
  }
});

test('planning prefers native target, otherwise the largest exact divisor', () => {
  const capabilities = {
    timeframes: ['1m', '2m', '5m', '30m'],
    alignment: 'utc-24x7' as const,
  };
  expect(planHistoryAcquisition(capabilities, '30m')).toMatchObject({
    kind: 'native',
    sourceTimeframe: '30m',
    targetTimeframe: '30m',
  });
  expect(planHistoryAcquisition(capabilities, '10m')).toMatchObject({
    kind: 'aggregate',
    sourceTimeframe: '5m',
    targetTimeframe: '10m',
  });
  expect(planHistoryAcquisition(capabilities, '1s').kind).toBe('unsupported');
  expect(planHistoryAcquisition(capabilities, '1T').kind).toBe('unsupported');
  expect(planHistoryAcquisition({ ...capabilities, alignment: 'unknown' }, '30m').kind).toBe(
    'unsupported',
  );
});

test('calendar planning requires exact session tiling and never aliases 24h to native 1d', () => {
  const day = 86_400;
  const calendar = {
    calendarId: 'FULL-DAY',
    version: 'v1',
    coverage: halfOpenIntervalSec(0, day),
    sessions: [halfOpenIntervalSec(0, day)],
  };
  const base = { alignment: 'exchange-calendar' as const, calendar };

  expect(planHistoryAcquisition({ ...base, timeframes: ['24h', '1d'] }, '1d')).toMatchObject({
    kind: 'native',
    sourceTimeframe: '1d',
  });
  expect(planHistoryAcquisition({ ...base, timeframes: ['24h'] }, '1d')).toMatchObject({
    kind: 'aggregate',
    sourceTimeframe: '24h',
  });

  const shortened = {
    ...calendar,
    calendarId: 'SHORT-DAY',
    coverage: halfOpenIntervalSec(0, day),
    sessions: [halfOpenIntervalSec(0, 6 * 3_600)],
  };
  expect(
    planHistoryAcquisition(
      { alignment: 'exchange-calendar', calendar: shortened, timeframes: ['24h', '1h'] },
      '1d',
    ),
  ).toMatchObject({ kind: 'aggregate', sourceTimeframe: '1h' });
  expect(
    planHistoryAcquisition(
      { alignment: 'exchange-calendar', calendar: shortened, timeframes: ['4h'] },
      '1d',
    ),
  ).toMatchObject({ kind: 'unsupported', code: 'no-exact-calendar-tiler' });
});

test('legacy providers resolve to a typed fail-closed source without breaking history callers', async () => {
  let historyCalls = 0;
  const legacy = {
    id: 'legacy',
    async history() {
      historyCalls++;
      return minuteBars(1);
    },
  };
  expect(await legacy.history()).toHaveLength(1);
  const source = await resolveHistorySource(legacy, 'BTC');
  expect(source.provider).toBe(legacy);
  expect(source.capabilities.alignment).toBe('unknown');
  expectDeepFrozenSource(source);
  expectTimeframeMutationRejected(source);
  await expect(
    acquireExactHistory(source, {
      targetTimeframe: '1m',
      requested: halfOpenIntervalSec(0, 60),
    }),
  ).rejects.toMatchObject({ kind: 'unsupported', code: 'unknown-alignment' });
  expect(historyCalls).toBe(1); // exact planning failed before invoking legacy history
});

// ── native/aggregate acquisition and coverage ────────────────────────────────

test('exact acquisition uses native target bars when available', async () => {
  const provider = new StaticProvider(
    { 'BTC|2m': [bar(0, 10, 2), bar(120, 20, 3)] },
    { alignment: 'utc-24x7', timeframes: ['2m'], cacheIdentity: 'native' },
  );
  const source = await provider.resolveHistorySource('BTC');
  const acquisition = await acquireExactHistory(source, {
    targetTimeframe: '2m',
    requested: halfOpenIntervalSec(0, 240),
  });

  expect(acquisition.complete).toBe(true);
  expect(acquisition.bars.map((value) => value.time)).toEqual([0, 120]);
  expect(acquisition.provenance.sourceTimeframe).toBe('2m');
  expect(acquisition.provenance.targetTimeframe).toBe('2m');
  expect(acquisition.provenance.aggregationVersion).toBe(0);
});

test('exact acquisition aggregates the selected divisor with UTC OHLCV semantics', async () => {
  const provider = new StaticProvider(
    { 'BTC|1m': minuteBars(4) },
    { alignment: 'utc-24x7', timeframes: ['1m'], cacheIdentity: 'aggregate' },
  );
  const acquisition = await acquireExactHistory(await provider.resolveHistorySource('BTC'), {
    targetTimeframe: '2m',
    requested: halfOpenIntervalSec(0, 240),
  });

  expect(acquisition.complete).toBe(true);
  expect(acquisition.bars).toEqual([
    { time: 0, open: 10, high: 13, low: 9, close: 12, volume: 3 },
    { time: 120, open: 12, high: 15, low: 11, close: 14, volume: 7 },
  ]);
  expect(acquisition.covered).toEqual([{ from: 0, to: 240 }]);
  expect(acquisition.gaps).toEqual([]);
  expect(acquisition.provenance.sourceTimeframe).toBe('1m');
  expect(acquisition.provenance.targetTimeframe).toBe('2m');
  expect(acquisition.provenance.aggregationVersion).toBe(4);
});

test('query padding can prove logical edge coverage but never extends reported coverage', async () => {
  const provider = new StaticProvider(
    { 'BTC|1m': minuteBars(4) },
    { alignment: 'utc-24x7', timeframes: ['1m'], cacheIdentity: 'padding' },
  );
  const acquisition = await acquireExactHistory(await provider.resolveHistorySource('BTC'), {
    targetTimeframe: '2m',
    requested: halfOpenIntervalSec(30, 150),
  });

  expect(acquisition.complete).toBe(true);
  expect(acquisition.bars.map((value) => value.time)).toEqual([0, 120]);
  expect(acquisition.requested).toEqual({ from: 30, to: 150 });
  expect(acquisition.covered).toEqual([{ from: 30, to: 150 }]);
});

test('partial aggregate edges remain explicit incomplete coverage', () => {
  const requested = halfOpenIntervalSec(30, 150);
  const raw = historyAcquisitionFromBars({
    bars: [bar(60, 11), bar(120, 12)],
    request: { timeframe: '1m', requested, query: halfOpenIntervalSec(0, 240) },
    cacheIdentity: 'partial',
    normalizedSymbol: 'BTC',
    alignment: 'utc-24x7',
  });
  const acquisition = aggregateBars(raw, {
    sourceTimeframe: '1m',
    targetTimeframe: '2m',
    alignment: { kind: 'utc' },
  });

  expect(acquisition.bars).toEqual([]);
  expect(acquisition.complete).toBe(false);
  expect(acquisition.covered).toEqual([]);
  expect(acquisition.gaps).toEqual([{ from: 30, to: 150, reason: 'partial-aggregate' }]);
});

test('internal missing source bars remain provider-missing rather than fabricated coverage', () => {
  const requested = halfOpenIntervalSec(0, 240);
  const raw = historyAcquisitionFromBars({
    bars: [bar(0, 10), bar(60, 11), bar(180, 13)],
    request: { timeframe: '1m', requested },
    cacheIdentity: 'hole',
    normalizedSymbol: 'BTC',
    alignment: 'utc-24x7',
  });
  const acquisition = aggregateBars(raw, {
    sourceTimeframe: '1m',
    targetTimeframe: '2m',
    alignment: { kind: 'utc' },
  });

  expect(acquisition.bars.map((value) => value.time)).toEqual([0]);
  expect(acquisition.covered).toEqual([{ from: 0, to: 120 }]);
  expect(acquisition.gaps).toEqual([{ from: 120, to: 240, reason: 'provider-missing' }]);
  expect(acquisition.complete).toBe(false);
});

test('session alignment anchors buckets at session opens and proves only declared closures', () => {
  const requested = halfOpenIntervalSec(0, 600);
  const calendar = {
    calendarId: 'TEST',
    version: 'v1',
    coverage: requested,
    sessions: [halfOpenIntervalSec(0, 180), halfOpenIntervalSec(300, 480)],
  };
  const raw = historyAcquisitionFromBars({
    bars: [...minuteBars(3, 0), ...minuteBars(3, 300)],
    request: { timeframe: '1m', requested },
    cacheIdentity: 'session',
    normalizedSymbol: 'XYZ',
    alignment: 'exchange-calendar',
    calendar,
  });
  const acquisition = aggregateBars(raw, {
    sourceTimeframe: '1m',
    targetTimeframe: '3m',
    alignment: { kind: 'session', ...calendar },
  });

  expect(acquisition.complete).toBe(true);
  expect(acquisition.bars.map((value) => value.time)).toEqual([0, 300]);
  expect(acquisition.covered).toEqual([{ from: 0, to: 600 }]);
  expect(acquisition.provenance.alignment).toBe('exchange-calendar:TEST@v1');
});

test('native shortened 1d bars use the declared session close and calendar complement', async () => {
  const day = 86_400;
  const open = 10 * day + 9 * 3_600;
  const close = open + 6 * 3_600;
  const calendar = {
    calendarId: 'SHORT-NATIVE-DAY',
    version: 'v1',
    coverage: halfOpenIntervalSec(open, open + day),
    sessions: [halfOpenIntervalSec(open, close)],
  };
  const provider = new StaticProvider(
    { 'XYZ|1d': [bar(open, 100, 7)] },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes: ['1d'],
      cacheIdentity: 'short-native-day',
    },
  );

  const acquisition = await acquireExactHistory(await provider.resolveHistorySource('XYZ'), {
    targetTimeframe: '1d',
    requested: halfOpenIntervalSec(open, open + day),
  });

  expect(acquisition.complete).toBe(true);
  expect(acquisition.bars.map((value) => value.time)).toEqual([open]);
  expect(acquisition.covered).toEqual([{ from: open, to: open + day }]);
  expect(acquisition.provenance).toMatchObject({
    sourceTimeframe: '1d',
    targetTimeframe: '1d',
    aggregationVersion: 0,
  });

  const noBarEvidence = historyAcquisitionFromBars({
    bars: [],
    request: { timeframe: '1d', requested: halfOpenIntervalSec(open, open + day) },
    cacheIdentity: 'short-native-day-empty',
    normalizedSymbol: 'XYZ',
    alignment: 'exchange-calendar',
    calendar,
  });
  expect(noBarEvidence.covered).toEqual([{ from: close, to: open + day }]);
  expect(noBarEvidence.gaps).toEqual([{ from: open, to: close, reason: 'provider-missing' }]);
});

test('intraday aggregation pads and consumes the whole shortened 1d session', async () => {
  const day = 86_400;
  const open = 20 * day + 9 * 3_600;
  const close = open + 180;
  const calendar = {
    calendarId: 'SHORT-AGGREGATE-DAY',
    version: 'v1',
    coverage: halfOpenIntervalSec(open, open + day),
    sessions: [halfOpenIntervalSec(open, close)],
  };
  const provider = new StaticProvider(
    { 'XYZ|1m': minuteBars(3, open) },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes: ['1m'],
      cacheIdentity: 'short-aggregate-day',
    },
  );
  const resolved = await provider.resolveHistorySource('XYZ');
  let seenRequest: HistoryRequest | undefined;
  const source = {
    ...resolved,
    history: async (request: HistoryRequest) => {
      seenRequest = request;
      return resolved.history(request);
    },
  };

  const acquisition = await acquireExactHistory(source, {
    targetTimeframe: '1d',
    requested: halfOpenIntervalSec(open + 60, open + 120),
  });

  expect(seenRequest?.query).toEqual({ from: open, to: close });
  expect(acquisition.complete).toBe(true);
  expect(acquisition.bars).toEqual([
    { time: open, open: 10, high: 14, low: 9, close: 13, volume: 6 },
  ]);
  expect(acquisition.covered).toEqual([{ from: open + 60, to: open + 120 }]);
  expect(acquisition.provenance.aggregationVersion).toBe(4);
});

test('weekly aggregation uses one 1d member per selected session across holidays', async () => {
  const day = 86_400;
  const open = 30 * day + 9 * 3_600;
  const sessions = [
    halfOpenIntervalSec(open, open + 2 * 3_600),
    halfOpenIntervalSec(open + day, open + day + 2 * 3_600),
    // day 2 is a declared holiday through the complete calendar complement.
    halfOpenIntervalSec(open + 3 * day, open + 3 * day + 2 * 3_600),
    halfOpenIntervalSec(open + 4 * day, open + 4 * day + 3_600),
  ];
  const calendar = {
    calendarId: 'HOLIDAY-WEEK',
    version: 'v1',
    coverage: halfOpenIntervalSec(open, open + 7 * day),
    sessions,
    periods: { '1w': [halfOpenIntervalSec(open, open + 7 * day)] },
  };
  const provider = new StaticProvider(
    { 'XYZ|1d': sessions.map((session, index) => bar(session.from, 10 + index * 10)) },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes: ['1d'],
      cacheIdentity: 'holiday-week',
    },
  );

  const acquisition = await acquireExactHistory(await provider.resolveHistorySource('XYZ'), {
    targetTimeframe: '1w',
    requested: halfOpenIntervalSec(open, sessions.at(-1)!.to),
  });

  expect(acquisition.complete).toBe(true);
  expect(acquisition.bars).toEqual([
    { time: open, open: 10, high: 42, low: 9, close: 41, volume: 4 },
  ]);
  expect(acquisition.covered).toEqual([{ from: open, to: sessions.at(-1)!.to }]);
  expect(acquisition.provenance).toMatchObject({
    sourceTimeframe: '1d',
    targetTimeframe: '1w',
    aggregationVersion: 4,
  });
});

test('missing members and partial session tilers fail instead of fabricating daily coverage', async () => {
  const day = 86_400;
  const open = 40 * day + 9 * 3_600;
  const close = open + 90 * 60;
  const calendar = {
    calendarId: 'MISSING-SESSION-MEMBER',
    version: 'v1',
    coverage: halfOpenIntervalSec(open, open + day),
    sessions: [halfOpenIntervalSec(open, close)],
  };

  expect(
    planHistoryAcquisition({ alignment: 'exchange-calendar', calendar, timeframes: ['1h'] }, '1d'),
  ).toMatchObject({ kind: 'unsupported', code: 'no-exact-calendar-tiler' });

  const provider = new StaticProvider(
    { 'XYZ|30m': [bar(open, 10), bar(open + 30 * 60, 20)] },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes: ['30m'],
      cacheIdentity: 'missing-session-member',
    },
  );
  await expect(
    acquireExactHistory(await provider.resolveHistorySource('XYZ'), {
      targetTimeframe: '1d',
      requested: halfOpenIntervalSec(open, close),
    }),
  ).rejects.toMatchObject({
    kind: 'provider-limited',
    code: 'incomplete-required-coverage',
    gaps: [{ from: open, to: close, reason: 'provider-missing' }],
  });
});

test('incomplete nominal calendar-period coverage fails before provider history', async () => {
  const day = 86_400;
  const open = 50 * day + 9 * 3_600;
  const close = open + 6 * 3_600;
  const calendar = {
    calendarId: 'INCOMPLETE-DAY',
    version: 'v1',
    coverage: halfOpenIntervalSec(open, close),
    sessions: [halfOpenIntervalSec(open, close)],
  };
  const provider = new StaticProvider(
    { 'XYZ|1d': [bar(open, 10)] },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes: ['1d'],
      cacheIdentity: 'incomplete-day',
    },
  );
  const resolved = await provider.resolveHistorySource('XYZ');
  let historyCalls = 0;
  const source = {
    ...resolved,
    history: async (request: HistoryRequest) => {
      historyCalls++;
      return resolved.history(request);
    },
  };

  await expect(
    acquireExactHistory(source, {
      targetTimeframe: '1d',
      requested: halfOpenIntervalSec(open, close),
    }),
  ).rejects.toMatchObject({
    kind: 'unsupported',
    code: 'calendar-period-coverage-missing',
  });
  expect(historyCalls).toBe(0);

  expect(
    planHistoryAcquisition(
      {
        alignment: 'exchange-calendar',
        timeframes: ['1d'],
        calendar: {
          ...calendar,
          coverage: halfOpenIntervalSec(open, close - 1),
        },
      },
      '1d',
    ),
  ).toMatchObject({ kind: 'unsupported', code: 'calendar-metadata-invalid' });
});

test('aggregation rejects duplicate or unsorted source bars instead of repairing them', () => {
  const requested = halfOpenIntervalSec(0, 120);
  const malformed: HistoryAcquisition = {
    bars: [bar(60, 11), bar(0, 10)],
    requested,
    covered: [{ from: 0, to: 120 }],
    gaps: [],
    complete: true,
    provenance: {
      cacheIdentity: 'bad',
      normalizedSymbol: 'BTC',
      sourceTimeframe: '1m',
      targetTimeframe: '1m',
      alignment: 'utc-24x7',
      aggregationVersion: 0,
    },
  };
  expect(() =>
    aggregateBars(malformed, {
      sourceTimeframe: '1m',
      targetTimeframe: '2m',
      alignment: { kind: 'utc' },
    }),
  ).toThrow(ExactHistoryError);
});

test('incomplete newest required coverage throws serializable provider-limited details', async () => {
  const provider = new StaticProvider(
    { 'BTC|1m': [bar(0, 10), bar(120, 12)] },
    { alignment: 'utc-24x7', timeframes: ['1m'], cacheIdentity: 'incomplete' },
  );
  try {
    await acquireExactHistory(await provider.resolveHistorySource('BTC'), {
      targetTimeframe: '1m',
      requested: halfOpenIntervalSec(0, 180),
    });
    throw new Error('expected exact acquisition to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ExactHistoryError);
    const exact = error as ExactHistoryError;
    expect(exact.kind).toBe('provider-limited');
    expect(exact.code).toBe('incomplete-required-coverage');
    expect(exact.gaps).toEqual([{ from: 60, to: 120, reason: 'provider-missing' }]);

    const wire = JSON.parse(JSON.stringify(exact));
    expect(wire).toMatchObject({
      type: 'exact-history-error',
      kind: 'provider-limited',
      permanent: true,
    });
    expect(ExactHistoryError.fromJSON(wire).toJSON()).toEqual(wire);
  }
});

// ── newest pagination and provider truncation ────────────────────────────────

test('Binance exact ranged acquisition requests newest coverage and exposes safety-cap truncation', async () => {
  const kline = (openSec: number) => [openSec * 1000, '1', '2', '0.5', '1.5', '9'];
  const { fn, calls } = mockFetch([[kline(600), kline(660)]]);
  const provider = new BinanceProvider({ market: 'futures', maxBars: 2, fetchImpl: fn });
  const source = await provider.resolveHistorySource('btc/usdt');
  const request: HistoryRequest = {
    timeframe: '1m',
    requested: halfOpenIntervalSec(0, 720),
  };
  const acquisition = await source.history(request);

  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain('endTime=719999');
  expect(calls[0]).not.toContain('startTime');
  expect(acquisition.bars.map((value) => value.time)).toEqual([600, 660]);
  expect(acquisition.truncated).toEqual({
    side: 'before',
    reason: 'binance-max-bars',
    limit: 2,
  });
  expect(acquisition.gaps[0]).toEqual({
    from: 0,
    to: 600,
    reason: 'provider-truncated',
  });
  expect(source.capabilities.maxBarsPerRequest).toBe(1000);
  expect(source.capabilities.maxBarsPerAcquisition).toBe(2);
});

test('coverage validation rejects complete claims that are not bound to returned bars', () => {
  const forged: HistoryAcquisition = {
    bars: [],
    requested: halfOpenIntervalSec(0, 60),
    covered: [halfOpenIntervalSec(0, 60)],
    gaps: [],
    complete: true,
    provenance: {
      cacheIdentity: 'forged',
      normalizedSymbol: 'BTC',
      sourceTimeframe: '1m',
      targetTimeframe: '1m',
      alignment: 'utc-24x7',
      aggregationVersion: 0,
    },
  };
  expect(() => validateHistoryAcquisition(forged, { alignment: 'utc-24x7' })).toThrow(
    ExactHistoryError,
  );
});

test('aggregation cannot erase explicit source gaps merely because bars are present', () => {
  const inconsistent: HistoryAcquisition = {
    bars: [bar(0, 10), bar(60, 11)],
    requested: halfOpenIntervalSec(0, 120),
    covered: [],
    gaps: [{ from: 0, to: 120, reason: 'provider-missing' }],
    complete: false,
    provenance: {
      cacheIdentity: 'inconsistent',
      normalizedSymbol: 'BTC',
      sourceTimeframe: '1m',
      targetTimeframe: '1m',
      alignment: 'utc-24x7',
      aggregationVersion: 0,
    },
  };
  expect(() =>
    aggregateBars(inconsistent, {
      sourceTimeframe: '1m',
      targetTimeframe: '2m',
      alignment: { kind: 'utc' },
    }),
  ).toThrow(ExactHistoryError);
});

test('duration-equivalent provider tokens are native, not ratio-one aggregation', async () => {
  expect(
    planHistoryAcquisition({ timeframes: ['1h', '4h'], alignment: 'utc-24x7' }, '60m'),
  ).toMatchObject({ kind: 'native', sourceTimeframe: '1h', targetTimeframe: '60m' });

  const provider = new StaticProvider(
    { 'BTC|1h': [bar(0, 10), bar(3600, 11)] },
    { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'native-alias' },
  );
  const acquisition = await acquireExactHistory(await provider.resolveHistorySource('BTC'), {
    targetTimeframe: '60m',
    requested: halfOpenIntervalSec(0, 7200),
  });
  expect(acquisition.provenance.sourceTimeframe).toBe('1h');
  expect(acquisition.provenance.targetTimeframe).toBe('60m');
  expect(acquisition.provenance.aggregationVersion).toBe(0);
});

test('exact network ingestion retains the full final coarse second and rejects subsecond opens', async () => {
  const { fn, calls } = mockFetch([[[60_500, '1', '2', '0.5', '1.5', '9']]]);
  const source = await new BinanceProvider({
    market: 'futures',
    fetchImpl: fn,
  }).resolveHistorySource('BTCUSDT');
  await expect(
    source.history({
      timeframe: '1m',
      requested: halfOpenIntervalSec(60, 61),
    }),
  ).rejects.toMatchObject({
    type: 'exact-history-error',
    kind: 'unsupported',
    code: 'subsecond-bar-boundary',
  });
  expect(calls[0]).toContain('endTime=60999');
});

test('base URL identity never retains credentials, paths, or arbitrary query values', () => {
  expect(
    nonSecretBaseUrl('https://user:pass@example.test/proxy?credential=top-secret&region=us#token'),
  ).toBe('https://example.test');
  expect(nonSecretBaseUrl('https://proxy.example/token/super-secret')).toBe(
    'https://proxy.example',
  );
  expect(nonSecretBaseUrl('not a url?secret=top-secret')).toBe('invalid-url');
});

test('static source identities do not alias the known 32-bit fixture collision', async () => {
  const options = {
    alignment: 'utc-24x7' as const,
    timeframes: ['1m'],
    cacheIdentity: 'collision-regression',
  };
  const first = new StaticProvider(
    {
      'X|1m': [bar(0, 10, 631858), bar(60, 11, 522793)],
    },
    options,
  );
  const second = new StaticProvider(
    {
      'X|1m': [bar(0, 10, 350914), bar(60, 11, 78969)],
    },
    options,
  );

  const [firstSource, secondSource] = await Promise.all([
    first.resolveHistorySource('X'),
    second.resolveHistorySource('X'),
  ]);
  expect(firstSource.cacheIdentity).not.toBe(secondSource.cacheIdentity);
  expect(firstSource.cacheIdentity).toContain('sha256-');
  expect(secondSource.cacheIdentity).toContain('sha256-');
});

test('static providers snapshot constructor capabilities across direct, generic, and router sources', async () => {
  const timeframes = ['1m'];
  const calendar = {
    calendarId: 'TEST',
    version: 'v1',
    coverage: halfOpenIntervalSec(0, 120),
    sessions: [halfOpenIntervalSec(0, 60)],
  };
  const provider = new StaticProvider(
    { 'XYZ|1m': [bar(0, 10)] },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes,
      cacheIdentity: 'calendar-snapshot',
    },
  );

  // Constructor-owned declarations cannot change a later resolution.
  timeframes.splice(0, 1, '5m');
  calendar.version = 'v2';
  calendar.sessions.splice(0, 1, halfOpenIntervalSec(0, 120));

  const direct = await provider.resolveHistorySource('XYZ');
  const generic = await resolveHistorySource(provider, 'XYZ');
  const routed = await new InstrumentRouter({
    providers: { binance: provider },
  }).resolveHistorySource('BI:XYZ');

  for (const source of [direct, generic, routed]) {
    expect(source.provider).toBe(provider);
    expect(source.cacheIdentity).toBe(direct.cacheIdentity);
    expect(source.capabilities.timeframes).toEqual(['1m']);
    expect(source.capabilities.calendar?.version).toBe('v1');
    expect(source.capabilities.calendar?.sessions).toEqual([halfOpenIntervalSec(0, 60)]);
    expectDeepFrozenSource(source);
    expectTimeframeMutationRejected(source);
  }
  expect(direct.cacheIdentity).toContain('"capabilities":');
  expect(direct.cacheIdentity).toContain('"version":"v1"');
  expect(direct.cacheIdentity).not.toContain('"version":"v2"');

  const plan = planHistoryAcquisition(direct.capabilities, '1m');
  expect(() => {
    (direct.capabilities.calendar as unknown as { version: string }).version = 'exposed-mutation';
  }).toThrow();
  expect(planHistoryAcquisition(direct.capabilities, '1m')).toEqual(plan);

  const acquisition = await acquireExactHistory(direct, {
    targetTimeframe: '1m',
    requested: halfOpenIntervalSec(0, 120),
  });
  expect(acquisition.complete).toBe(true);
  expect(acquisition.provenance.alignment).toBe('exchange-calendar:TEST@v1');
});

test('blank exchange-calendar identifiers fail closed in planning and coverage', () => {
  const calendar = {
    calendarId: '   ',
    version: '',
    coverage: halfOpenIntervalSec(0, 60),
    sessions: [],
  };
  expect(
    planHistoryAcquisition({ timeframes: ['1m'], alignment: 'exchange-calendar', calendar }, '1m'),
  ).toMatchObject({ kind: 'unsupported', code: 'calendar-metadata-invalid' });

  expect(() =>
    historyAcquisitionFromBars({
      bars: [],
      request: { timeframe: '1m', requested: halfOpenIntervalSec(0, 60) },
      cacheIdentity: 'blank-calendar',
      normalizedSymbol: 'XYZ',
      alignment: 'exchange-calendar',
      calendar,
    }),
  ).toThrow(ExactHistoryError);
  try {
    historyAcquisitionFromBars({
      bars: [],
      request: { timeframe: '1m', requested: halfOpenIntervalSec(0, 60) },
      cacheIdentity: 'blank-calendar',
      normalizedSymbol: 'XYZ',
      alignment: 'exchange-calendar',
      calendar,
    });
  } catch (error) {
    expect(error).toMatchObject({
      type: 'exact-history-error',
      kind: 'malformed',
      code: 'calendar-metadata-invalid',
    });
    expect(JSON.stringify(error)).not.toContain('exchange-calendar:@');
  }
});

test('static exact capabilities are resolved per symbol and unavailable datasets fail typed', async () => {
  const provider = new StaticProvider(
    {
      'BTC|1m': minuteBars(2),
      'ETH|5m': [bar(0, 20), bar(300, 21)],
    },
    { alignment: 'utc-24x7', timeframes: ['1m', '5m'] },
  );
  const btc = await provider.resolveHistorySource('BTC');
  const eth = await provider.resolveHistorySource('ETH');
  const missing = await provider.resolveHistorySource('DOGE');

  expect(btc.capabilities.timeframes).toEqual(['1m']);
  expect(eth.capabilities.timeframes).toEqual(['5m']);
  expect(missing.capabilities.timeframes).toEqual([]);
  await expect(
    btc.history({ timeframe: '5m', requested: halfOpenIntervalSec(0, 300) }),
  ).rejects.toMatchObject({
    type: 'exact-history-error',
    kind: 'unsupported',
    code: 'static-timeframe-unavailable',
  });
});

test('semantic capability changes cannot alias static source identities', async () => {
  const seed = { X: [bar(0, 10)] };
  const oneMinute = await new StaticProvider(seed, {
    alignment: 'utc-24x7',
    timeframes: ['1m'],
    cacheIdentity: 'same-dataset',
  }).resolveHistorySource('X');
  const multiple = await new StaticProvider(seed, {
    alignment: 'utc-24x7',
    timeframes: ['1m', '5m'],
    cacheIdentity: 'same-dataset',
  }).resolveHistorySource('X');

  expect(oneMinute.cacheIdentity).toContain('"capabilities":');
  expect(multiple.cacheIdentity).toContain('"capabilities":');
  expect(oneMinute.cacheIdentity).not.toBe(multiple.cacheIdentity);
});

test('malformed live acquisitions with missing provenance fail as serializable exact errors', () => {
  const acquisition = {
    bars: [],
    requested: halfOpenIntervalSec(0, 60),
    covered: [],
    gaps: [{ from: 0, to: 60, reason: 'provider-missing' }],
    complete: false,
  } as unknown as HistoryAcquisition;

  expect(() =>
    validateHistoryAcquisition(acquisition, {
      cacheIdentity: 'expected',
      normalizedSymbol: 'BTC',
      sourceTimeframe: '1m',
    }),
  ).toThrow(ExactHistoryError);
  try {
    validateHistoryAcquisition(acquisition, { cacheIdentity: 'expected' });
  } catch (error) {
    expect(error).toMatchObject({
      type: 'exact-history-error',
      kind: 'malformed',
      code: 'provenance',
    });
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      type: 'exact-history-error',
      permanent: true,
    });
  }
});

test('aggregation preserves adjacent partial, missing, and truncated gap causes', () => {
  const requested = halfOpenIntervalSec(30, 360);
  const raw = historyAcquisitionFromBars({
    bars: [bar(60, 11), bar(240, 14)],
    request: { timeframe: '1m', requested, query: halfOpenIntervalSec(0, 360) },
    cacheIdentity: 'mixed-gaps',
    normalizedSymbol: 'BTC',
    alignment: 'utc-24x7',
    truncated: { side: 'after', reason: 'fixture-cap', limit: 2 },
  });
  const acquisition = aggregateBars(raw, {
    sourceTimeframe: '1m',
    targetTimeframe: '2m',
    alignment: { kind: 'utc' },
  });

  expect(acquisition.gaps).toEqual([
    { from: 30, to: 120, reason: 'partial-aggregate' },
    { from: 120, to: 240, reason: 'provider-missing' },
    { from: 240, to: 360, reason: 'provider-truncated' },
  ]);
});

test('capped equity adapters retain newest coverage and report leading truncation', async () => {
  const alpacaFetch = mockFetch([
    {
      bars: [
        { t: new Date(120_000).toISOString(), o: 3, h: 4, l: 2, c: 3.5, v: 12 },
        { t: new Date(60_000).toISOString(), o: 2, h: 3, l: 1, c: 2.5, v: 11 },
      ],
      next_page_token: 'older',
    },
  ]);
  const alpaca = await new AlpacaProvider({
    keyId: 'key',
    secretKey: 'secret',
    maxBars: 2,
    fetchImpl: alpacaFetch.fn,
  }).resolveHistorySource('AAPL');
  const alpacaAcquisition = await alpaca.history({
    timeframe: '1m',
    requested: halfOpenIntervalSec(0, 180),
  });
  expect(alpacaFetch.calls[0]).toContain('sort=desc');
  expect(alpacaAcquisition.bars.map((value) => value.time)).toEqual([60, 120]);
  expect(alpacaAcquisition.truncated).toEqual({
    side: 'before',
    reason: 'alpaca-max-bars',
    limit: 2,
  });
  expect(alpacaAcquisition.gaps[0]).toEqual({
    from: 0,
    to: 60,
    reason: 'provider-truncated',
  });

  const massiveFetch = mockFetch([
    {
      results: [
        { t: 120_000, o: 3, h: 4, l: 2, c: 3.5, v: 12 },
        { t: 60_000, o: 2, h: 3, l: 1, c: 2.5, v: 11 },
      ],
      resultsCount: 3,
    },
  ]);
  const massive = await new MassiveProvider({
    apiKey: 'key',
    maxBars: 2,
    fetchImpl: massiveFetch.fn,
  }).resolveHistorySource('AAPL');
  const massiveAcquisition = await massive.history({
    timeframe: '1m',
    requested: halfOpenIntervalSec(0, 180),
  });
  expect(massiveFetch.calls[0]).toContain('sort=desc');
  expect(massiveAcquisition.bars.map((value) => value.time)).toEqual([60, 120]);
  expect(massiveAcquisition.truncated).toEqual({
    side: 'before',
    reason: 'massive-max-bars',
    limit: 2,
  });
});

test('OKX advertises the effective hard pagination ceiling and identities the configured policy', async () => {
  const source = await new OkxProvider({ maxBars: 100_000 }).resolveHistorySource('BTCUSDT');
  expect(source.capabilities.maxBarsPerAcquisition).toBe(60_000);
  expect(source.cacheIdentity).toContain('"configured":100000');
  expect(source.cacheIdentity).toContain('"effective":60000');
  expect(source.cacheIdentity).toContain('"pageCapacity":60000');
});

test('unaggregated provenance cannot widen source-bar coverage with a forged target timeframe', () => {
  const forged: HistoryAcquisition = {
    bars: [bar(0, 10)],
    requested: halfOpenIntervalSec(0, 120),
    covered: [halfOpenIntervalSec(0, 120)],
    gaps: [],
    complete: true,
    provenance: {
      cacheIdentity: 'forged-target',
      normalizedSymbol: 'BTC',
      sourceTimeframe: '1m',
      targetTimeframe: '2m',
      alignment: 'utc-24x7',
      aggregationVersion: 0,
    },
  };
  expect(() => validateHistoryAcquisition(forged, { alignment: 'utc-24x7' })).toThrow(
    ExactHistoryError,
  );
  try {
    validateHistoryAcquisition(forged, { alignment: 'utc-24x7' });
  } catch (error) {
    expect(error).toMatchObject({ kind: 'malformed', code: 'native-target-duration' });
  }
});

test('resolved static sources bind an immutable content snapshot to their identity', async () => {
  const provider = new StaticProvider(
    { 'BTC|1m': [bar(0, 10)] },
    { alignment: 'utc-24x7', timeframes: ['1m'], cacheIdentity: 'mutable-fixture' },
  );
  const before = await provider.resolveHistorySource('BTC');
  provider.set('BTC|1m', [bar(0, 20)]);

  const oldAcquisition = await before.history({
    timeframe: '1m',
    requested: halfOpenIntervalSec(0, 60),
  });
  const after = await provider.resolveHistorySource('BTC');
  const newAcquisition = await after.history({
    timeframe: '1m',
    requested: halfOpenIntervalSec(0, 60),
  });

  expect(oldAcquisition.bars[0]!.close).toBe(11);
  expect(newAcquisition.bars[0]!.close).toBe(21);
  expect(after.cacheIdentity).not.toBe(before.cacheIdentity);
});

test('ExactHistoryError wire parsing rejects incomplete or malformed discriminants', () => {
  const invalid = [
    { type: 'exact-history-error', permanent: true },
    {
      type: 'exact-history-error',
      permanent: true,
      kind: 'other',
      code: 'bad',
      message: 'bad',
    },
    {
      type: 'exact-history-error',
      permanent: true,
      kind: 'unsupported',
      code: '',
      message: 'bad',
    },
    {
      type: 'exact-history-error',
      permanent: true,
      kind: 'provider-limited',
      code: 'bad-gap',
      message: 'bad gap',
      gaps: [{ from: 0, to: 60, reason: 'unknown' }],
    },
  ];
  for (const value of invalid) {
    expect(() => ExactHistoryError.fromJSON(value)).toThrow(TypeError);
  }
});

test('authoritative calendar periods group split sessions into one native and aggregate day', async () => {
  const day = 86_400;
  const open = 60 * day + 9 * 3_600;
  const first = halfOpenIntervalSec(open, open + 2 * 3_600);
  const second = halfOpenIntervalSec(open + 3 * 3_600, open + 5 * 3_600);
  const boundary = halfOpenIntervalSec(open, open + day);
  const calendar = {
    calendarId: 'SPLIT-SESSION-DAY',
    version: 'v1',
    coverage: halfOpenIntervalSec(open, open + day),
    sessions: [first, second],
    periods: { '1d': [boundary] },
  };
  const nativeProvider = new StaticProvider(
    { 'XYZ|1d': [bar(open, 100, 7)] },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes: ['1d'],
      cacheIdentity: 'split-native-day',
    },
  );
  const aggregateProvider = new StaticProvider(
    {
      'XYZ|1h': [
        bar(open, 10),
        bar(open + 3_600, 11),
        bar(second.from, 20),
        bar(second.from + 3_600, 21),
      ],
    },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes: ['1h'],
      cacheIdentity: 'split-aggregate-day',
    },
  );

  // Constructors own the period metadata before identity construction.
  (boundary as unknown as { to: number }).to = second.to;
  calendar.periods['1d'].push(halfOpenIntervalSec(open + day, open + 2 * day));

  const nativeSource = await nativeProvider.resolveHistorySource('XYZ');
  const aggregateSource = await aggregateProvider.resolveHistorySource('XYZ');
  for (const source of [nativeSource, aggregateSource]) {
    expectDeepFrozenSource(source);
    expect(source.capabilities.calendar?.periods?.['1d']).toEqual([
      halfOpenIntervalSec(open, open + day),
    ]);
    expect(source.cacheIdentity).toContain('"periods"');
    expect(() =>
      (source.capabilities.calendar!.periods!['1d'] as unknown as Array<unknown>).push({}),
    ).toThrow();
  }

  const requested = halfOpenIntervalSec(open, open + day);
  const native = await acquireExactHistory(nativeSource, {
    targetTimeframe: '1d',
    requested,
  });
  expect(native.complete).toBe(true);
  expect(native.bars).toHaveLength(1);
  expect(native.bars[0]!.time).toBe(open);
  expect(native.covered).toEqual([requested]);

  const aggregated = await acquireExactHistory(aggregateSource, {
    targetTimeframe: '1d',
    requested,
  });
  expect(aggregated.complete).toBe(true);
  expect(aggregated.bars).toEqual([
    { time: open, open: 10, high: 23, low: 9, close: 22, volume: 4 },
  ]);
  expect(aggregated.covered).toEqual([requested]);
  expect(aggregated.provenance.aggregationVersion).toBe(4);
});

test('malformed authoritative calendar periods fail before identity or acquisition', () => {
  const day = 86_400;
  const open = 70 * day + 9 * 3_600;
  const base = {
    calendarId: 'BAD-PERIODS',
    version: 'v1',
    coverage: halfOpenIntervalSec(open, open + day),
    sessions: [
      halfOpenIntervalSec(open, open + 2 * 3_600),
      halfOpenIntervalSec(open + 3 * 3_600, open + 5 * 3_600),
    ],
  };

  for (const periods of [
    { '1d': [halfOpenIntervalSec(open, open + 4 * 3_600)] },
    { '1d': [halfOpenIntervalSec(open, open + 2 * 3_600)] },
    { '24h': [halfOpenIntervalSec(open, open + day)] },
  ]) {
    expect(
      () =>
        new StaticProvider(
          { 'XYZ|1d': [bar(open, 10)] },
          { alignment: 'exchange-calendar', calendar: { ...base, periods }, timeframes: ['1d'] },
        ),
    ).toThrow(ExactHistoryError);
    try {
      new StaticProvider(
        { 'XYZ|1d': [bar(open, 10)] },
        { alignment: 'exchange-calendar', calendar: { ...base, periods }, timeframes: ['1d'] },
      );
    } catch (error) {
      expect(error).toMatchObject({
        kind: 'malformed',
        code: 'calendar-period-metadata-invalid',
      });
    }
  }
});

test('authoritative split-session daily bars compose into one weekly aggregate', async () => {
  const day = 86_400;
  const open = 80 * day + 9 * 3_600;
  const secondOpen = open + day;
  const sessions = [
    halfOpenIntervalSec(open, open + 3_600),
    halfOpenIntervalSec(open + 2 * 3_600, open + 3 * 3_600),
    halfOpenIntervalSec(secondOpen, secondOpen + 3_600),
    halfOpenIntervalSec(secondOpen + 2 * 3_600, secondOpen + 3 * 3_600),
  ];
  const calendar = {
    calendarId: 'SPLIT-DAY-WEEK',
    version: 'v1',
    coverage: halfOpenIntervalSec(open, open + 7 * day),
    sessions,
    periods: {
      '1d': [
        halfOpenIntervalSec(open, open + day),
        halfOpenIntervalSec(secondOpen, secondOpen + day),
      ],
      '1w': [halfOpenIntervalSec(open, open + 7 * day)],
    },
  };
  const provider = new StaticProvider(
    { 'XYZ|1d': [bar(open, 10, 2), bar(secondOpen, 20, 3)] },
    {
      alignment: 'exchange-calendar',
      calendar,
      timeframes: ['1d'],
      cacheIdentity: 'split-day-week',
    },
  );

  const acquisition = await acquireExactHistory(await provider.resolveHistorySource('XYZ'), {
    targetTimeframe: '1w',
    requested: halfOpenIntervalSec(open, secondOpen + day),
  });

  expect(acquisition.complete).toBe(true);
  expect(acquisition.bars).toEqual([
    { time: open, open: 10, high: 22, low: 9, close: 21, volume: 5 },
  ]);
  expect(acquisition.covered).toEqual([halfOpenIntervalSec(open, secondOpen + day)]);
  expect(acquisition.provenance).toMatchObject({
    sourceTimeframe: '1d',
    targetTimeframe: '1w',
    aggregationVersion: 4,
  });
});

const WEEK_SECONDS = 7 * 86_400;
const MONDAY_UTC_WEEK_ANCHOR = unixSecond(4 * 86_400);

test('UTC native weekly validation accepts only the declared opening anchor', async () => {
  const mondayProvider = new StaticProvider(
    { 'BTC|1w': [bar(MONDAY_UTC_WEEK_ANCHOR, 100)] },
    {
      alignment: 'utc-24x7',
      weekAnchorSec: MONDAY_UTC_WEEK_ANCHOR,
      timeframes: ['1w'],
      cacheIdentity: 'monday-native-week',
    },
  );
  const accepted = await acquireExactHistory(await mondayProvider.resolveHistorySource('BTC'), {
    targetTimeframe: '1w',
    requested: halfOpenIntervalSec(MONDAY_UTC_WEEK_ANCHOR, MONDAY_UTC_WEEK_ANCHOR + WEEK_SECONDS),
  });

  expect(accepted.complete).toBe(true);
  expect(accepted.bars.map((value) => value.time)).toEqual([MONDAY_UTC_WEEK_ANCHOR]);
  expect(accepted.provenance.weekAnchorSec).toBe(MONDAY_UTC_WEEK_ANCHOR);

  const misaligned = new StaticProvider(
    { 'BTC|1w': [bar(0, 100)] },
    {
      alignment: 'utc-24x7',
      weekAnchorSec: MONDAY_UTC_WEEK_ANCHOR,
      timeframes: ['1w'],
      cacheIdentity: 'wrong-native-week',
    },
  );
  await expect(
    acquireExactHistory(await misaligned.resolveHistorySource('BTC'), {
      targetTimeframe: '1w',
      requested: halfOpenIntervalSec(0, WEEK_SECONDS),
    }),
  ).rejects.toMatchObject({ kind: 'malformed', code: 'bar-alignment' });
});

test('UTC daily aggregation forms Monday-to-Monday weeks from the declared anchor', async () => {
  const daily = Array.from({ length: 7 }, (_, index) =>
    bar(MONDAY_UTC_WEEK_ANCHOR + index * 86_400, 10 + index, index + 1),
  );
  const provider = new StaticProvider(
    { 'BTC|1d': daily },
    {
      alignment: 'utc-24x7',
      weekAnchorSec: MONDAY_UTC_WEEK_ANCHOR,
      timeframes: ['1d'],
      cacheIdentity: 'monday-aggregate-week',
    },
  );
  const acquisition = await acquireExactHistory(await provider.resolveHistorySource('BTC'), {
    targetTimeframe: '1w',
    requested: halfOpenIntervalSec(MONDAY_UTC_WEEK_ANCHOR, MONDAY_UTC_WEEK_ANCHOR + WEEK_SECONDS),
  });

  expect(acquisition.complete).toBe(true);
  expect(acquisition.bars).toEqual([
    {
      time: MONDAY_UTC_WEEK_ANCHOR,
      open: 10,
      high: 18,
      low: 9,
      close: 17,
      volume: 28,
    },
  ]);
  expect(acquisition.covered).toEqual([
    halfOpenIntervalSec(MONDAY_UTC_WEEK_ANCHOR, MONDAY_UTC_WEEK_ANCHOR + WEEK_SECONDS),
  ]);
  expect(acquisition.provenance.weekAnchorSec).toBe(MONDAY_UTC_WEEK_ANCHOR);
});

test('UTC weekly planning and acquisition fail closed without explicit anchor evidence', async () => {
  expect(
    planHistoryAcquisition({ timeframes: ['1d', '1w'], alignment: 'utc-24x7' }, '1w'),
  ).toMatchObject({ kind: 'unsupported', code: 'weekly-anchor-missing' });

  const provider = new StaticProvider(
    { 'BTC|1w': [bar(MONDAY_UTC_WEEK_ANCHOR, 100)] },
    { alignment: 'utc-24x7', timeframes: ['1w'], cacheIdentity: 'anchorless-week' },
  );
  await expect(
    acquireExactHistory(await provider.resolveHistorySource('BTC'), {
      targetTimeframe: '1w',
      requested: halfOpenIntervalSec(MONDAY_UTC_WEEK_ANCHOR, MONDAY_UTC_WEEK_ANCHOR + WEEK_SECONDS),
    }),
  ).rejects.toMatchObject({ kind: 'unsupported', code: 'weekly-anchor-missing' });

  // Equal durations are not aliases when their UTC grids have different anchors.
  expect(
    planHistoryAcquisition(
      {
        timeframes: ['1w'],
        alignment: 'utc-24x7',
        weekAnchorSec: MONDAY_UTC_WEEK_ANCHOR,
      },
      '7d',
    ),
  ).toMatchObject({ kind: 'unsupported', code: 'no-exact-divisor' });
});

test('weekly anchor changes capability, source, and acquisition identities', async () => {
  const monday = new StaticProvider(
    { 'X|1m': [bar(0, 10)] },
    {
      alignment: 'utc-24x7',
      weekAnchorSec: MONDAY_UTC_WEEK_ANCHOR,
      timeframes: ['1m'],
      cacheIdentity: 'same-week-anchor-fixture',
    },
  );
  const thursday = new StaticProvider(
    { 'X|1m': [bar(0, 10)] },
    {
      alignment: 'utc-24x7',
      weekAnchorSec: unixSecond(0),
      timeframes: ['1m'],
      cacheIdentity: 'same-week-anchor-fixture',
    },
  );
  const [mondaySource, thursdaySource] = await Promise.all([
    monday.resolveHistorySource('X'),
    thursday.resolveHistorySource('X'),
  ]);

  expect(mondaySource.capabilities.weekAnchorSec).toBe(MONDAY_UTC_WEEK_ANCHOR);
  expect(thursdaySource.capabilities.weekAnchorSec).toBe(0);
  expect(mondaySource.cacheIdentity).not.toBe(thursdaySource.cacheIdentity);

  const request = {
    targetTimeframe: '1m',
    requested: halfOpenIntervalSec(0, 60),
  };
  const [mondayAcquisition, thursdayAcquisition] = await Promise.all([
    acquireExactHistory(mondaySource, request),
    acquireExactHistory(thursdaySource, request),
  ]);
  expect(mondayAcquisition.provenance.weekAnchorSec).toBe(MONDAY_UTC_WEEK_ANCHOR);
  expect(thursdayAcquisition.provenance.weekAnchorSec).toBe(0);
  expect(mondayAcquisition.provenance).not.toEqual(thursdayAcquisition.provenance);
});

test('built-in crypto providers declare their observed UTC weekly anchors', async () => {
  const [binance, okx, kraken] = await Promise.all([
    new BinanceProvider().resolveHistorySource('BTCUSDT'),
    new OkxProvider().resolveHistorySource('BTCUSDT'),
    new KrakenProvider().resolveHistorySource('BTC/USD'),
  ]);

  expect(binance.capabilities.weekAnchorSec).toBe(MONDAY_UTC_WEEK_ANCHOR);
  expect(okx.capabilities.weekAnchorSec).toBe(MONDAY_UTC_WEEK_ANCHOR);
  expect(kraken.capabilities.weekAnchorSec).toBe(0);
});

test('exact target week anchors select a finer source instead of relabeling native weeks', async () => {
  const thursdayAnchor = unixSecond(0);
  expect(
    planHistoryAcquisition(
      {
        timeframes: ['1d', '1w'],
        alignment: 'utc-24x7',
        weekAnchorSec: thursdayAnchor,
      },
      '1w',
      MONDAY_UTC_WEEK_ANCHOR,
    ),
  ).toMatchObject({
    kind: 'aggregate',
    sourceTimeframe: '1d',
    targetTimeframe: '1w',
    alignment: {
      kind: 'utc',
      sourceWeekAnchorSec: thursdayAnchor,
      weekAnchorSec: MONDAY_UTC_WEEK_ANCHOR,
    },
  });

  const daily = Array.from({ length: 7 }, (_, index) =>
    bar(MONDAY_UTC_WEEK_ANCHOR + index * 86_400, 10 + index),
  );
  const provider = new StaticProvider(
    {
      'BTC|1d': daily,
      'BTC|1w': [bar(thursdayAnchor, 999)],
    },
    {
      alignment: 'utc-24x7',
      weekAnchorSec: thursdayAnchor,
      timeframes: ['1d', '1w'],
      cacheIdentity: 'target-week-anchor-source-selection',
    },
  );
  const acquisition = await acquireExactHistory(await provider.resolveHistorySource('BTC'), {
    targetTimeframe: '1w',
    targetWeekAnchorSec: MONDAY_UTC_WEEK_ANCHOR,
    requested: halfOpenIntervalSec(MONDAY_UTC_WEEK_ANCHOR, MONDAY_UTC_WEEK_ANCHOR + WEEK_SECONDS),
  });

  expect(acquisition.bars).toHaveLength(1);
  expect(acquisition.bars[0]?.time).toBe(MONDAY_UTC_WEEK_ANCHOR);
  expect(acquisition.provenance).toMatchObject({
    sourceTimeframe: '1d',
    targetTimeframe: '1w',
    weekAnchorSec: MONDAY_UTC_WEEK_ANCHOR,
    aggregationVersion: 4,
  });
});

test('native equivalent UTC grids normalize provenance to the requested week anchor', async () => {
  const requested = halfOpenIntervalSec(0, WEEK_SECONDS);
  const elapsedProvider = new StaticProvider(
    { 'BTC|7d': [bar(0, 100)] },
    {
      alignment: 'utc-24x7',
      timeframes: ['7d'],
      cacheIdentity: 'elapsed-seven-day-to-week',
    },
  );
  const congruentWeekProvider = new StaticProvider(
    { 'BTC|1w': [bar(0, 200)] },
    {
      alignment: 'utc-24x7',
      weekAnchorSec: unixSecond(WEEK_SECONDS),
      timeframes: ['1w'],
      cacheIdentity: 'congruent-week-anchor-normalization',
    },
  );

  const [elapsed, congruent] = await Promise.all([
    acquireExactHistory(await elapsedProvider.resolveHistorySource('BTC'), {
      targetTimeframe: '1w',
      targetWeekAnchorSec: unixSecond(0),
      requested,
    }),
    acquireExactHistory(await congruentWeekProvider.resolveHistorySource('BTC'), {
      targetTimeframe: '1w',
      targetWeekAnchorSec: unixSecond(0),
      requested,
    }),
  ]);

  expect(elapsed.provenance).toMatchObject({
    sourceTimeframe: '7d',
    targetTimeframe: '1w',
    weekAnchorSec: 0,
    aggregationVersion: 0,
  });
  expect(congruent.provenance).toMatchObject({
    sourceTimeframe: '1w',
    targetTimeframe: '1w',
    weekAnchorSec: 0,
    aggregationVersion: 0,
  });
});

test('complete-record aggregation admits partial and empty covered buckets inside the span', () => {
  const requested = halfOpenIntervalSec(0, 360);
  const raw = historyAcquisitionFromBars({
    bars: [bar(0, 10, 2), bar(300, 30, 5)],
    request: { timeframe: '1m', requested },
    cacheIdentity: 'complete-record-aggregate',
    normalizedSymbol: 'BTC',
    alignment: 'utc-24x7',
    coverageSemantics: 'complete-record',
    recordSpan: requested,
  });
  const acquisition = aggregateBars(raw, {
    sourceTimeframe: '1m',
    targetTimeframe: '2m',
    alignment: { kind: 'utc' },
  });

  expect(acquisition.complete).toBe(true);
  expect(acquisition.covered).toEqual([requested]);
  expect(acquisition.gaps).toEqual([]);
  expect(acquisition.bars).toEqual([
    { time: 0, open: 10, high: 12, low: 9, close: 11, volume: 2 },
    { time: 240, open: 30, high: 32, low: 29, close: 31, volume: 5 },
  ]);
  expect(acquisition.provenance).toMatchObject({
    coverageSemantics: 'complete-record',
    recordSpan: requested,
    aggregationVersion: 4,
  });
  validateHistoryAcquisition(acquisition, {
    alignment: 'utc-24x7',
    coverageSemantics: 'complete-record',
    recordSpan: requested,
  });
});

test('complete-record aggregation preserves record-edge gaps and rejects tampered evidence', () => {
  const requested = halfOpenIntervalSec(60, 300);
  const raw = historyAcquisitionFromBars({
    bars: [bar(60, 11), bar(120, 12), bar(240, 14)],
    request: { timeframe: '1m', requested, query: halfOpenIntervalSec(0, 360) },
    cacheIdentity: 'complete-record-edge',
    normalizedSymbol: 'BTC',
    alignment: 'utc-24x7',
    coverageSemantics: 'complete-record',
    recordSpan: requested,
  });
  const acquisition = aggregateBars(raw, {
    sourceTimeframe: '1m',
    targetTimeframe: '2m',
    alignment: { kind: 'utc' },
  });

  expect(acquisition.complete).toBe(false);
  expect(acquisition.covered).toEqual([halfOpenIntervalSec(120, 240)]);
  expect(acquisition.gaps).toEqual([
    { from: 60, to: 120, reason: 'partial-aggregate' },
    { from: 240, to: 300, reason: 'partial-aggregate' },
  ]);
  validateHistoryAcquisition(acquisition, {
    alignment: 'utc-24x7',
    coverageSemantics: 'complete-record',
    recordSpan: requested,
  });

  const tampered = {
    ...raw,
    provenance: {
      ...raw.provenance,
      recordSpan: halfOpenIntervalSec(60, 240),
    },
  };
  expect(() =>
    validateHistoryAcquisition(tampered, {
      alignment: 'utc-24x7',
      coverageSemantics: 'complete-record',
      recordSpan: requested,
    }),
  ).toThrow(ExactHistoryError);
  expect(() =>
    validateHistoryAcquisition(raw, {
      alignment: 'utc-24x7',
      coverageSemantics: 'bars-only',
    }),
  ).toThrow(ExactHistoryError);
});
