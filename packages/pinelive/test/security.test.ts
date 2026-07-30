import { expect, test } from 'bun:test';
import { compile } from '@heyphat/piner';
import type {
  Bar,
  ClosedBarsOptions,
  HistoryRange,
  MarketDataProvider,
  ResolvedDataInstrument,
} from '@heyphat/pinery';
import {
  ForwardRunner,
  ForwardRunnerError,
  MemoryLedger,
  PaperBroker,
  runForwardServer,
  SecurityFeedManager,
  planSecurityFromRequests,
  planSecurityFromStatic,
  type ForwardRecord,
} from '../src/index.js';

const HOUR = 3600;
const DAY = 86_400;

function hourly(count: number, close: (index: number) => number, start = 1_700_000_000): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const value = close(index);
    return {
      time: start + index * HOUR,
      open: value,
      high: value + 1,
      low: value - 1,
      close: value,
      volume: 10,
    };
  });
}

function fiveMinute(count: number, close: (index: number) => number, start = 1_700_000_000): Bar[] {
  return Array.from({ length: count }, (_, index) => {
    const value = close(index);
    return {
      time: start + index * 300,
      open: value,
      high: value + 1,
      low: value - 1,
      close: value,
      volume: 10,
    };
  });
}

/**
 * Provider with a virtual venue clock, so secondary feeds grow as the chart advances —
 * which is what the live refresh path has to cope with. `historyResolved` only returns
 * bars that have CLOSED by `now`, and `closedBars` advances `now` to each chart bar's close
 * just before yielding it.
 */
class FeedProvider implements MarketDataProvider {
  readonly id = 'feed-test';
  historyCalls: {
    symbol: string;
    timeframe: string;
    from?: number;
    to?: number;
    limit?: number;
  }[] = [];
  resolveCalls: string[] = [];
  failFeeds = new Set<string>();
  failRefreshFeeds = new Set<string>();
  failCounts = new Map<string, number>();
  emptyFeeds = new Set<string>();
  unresolvable = new Set<string>();
  private now: number;

  constructor(
    private readonly series: Record<string, Bar[]>,
    cutoverIndex: number,
    private readonly chartSymbol = 'X',
  ) {
    const chart = series[`${chartSymbol}|1h`] ?? [];
    // Warmup sees exactly the bars that closed before the cutover.
    this.now = (chart[cutoverIndex - 1]?.time ?? 0) + HOUR;
    this.cutoverIndex = cutoverIndex;
  }

  private readonly cutoverIndex: number;

  private key(symbol: string, timeframe: string): string {
    return `${symbol}|${timeframe}`;
  }

  revise(symbol: string, timeframe: string, index: number, patch: Partial<Bar>): void {
    const bar = this.series[this.key(symbol, timeframe)]?.[index];
    if (!bar) throw new Error('missing test bar to revise');
    Object.assign(bar, patch);
  }

  failNext(symbol: string, timeframe: string, count = 1): void {
    this.failCounts.set(this.key(symbol, timeframe), count);
  }

  async resolve(symbol: string): Promise<ResolvedDataInstrument> {
    this.resolveCalls.push(symbol);
    if (this.unresolvable.has(symbol))
      throw new Error(`no such instrument "${symbol}" at this venue`);
    return Object.freeze({
      strategySymbol: symbol,
      providerHandle: `${this.id}:${symbol}`,
      venueSymbol: symbol,
      mintick: 0.01,
      qtyStep: 1,
      minOrderQty: 1,
    });
  }

  async instrument() {
    return { minQty: 1, mintick: 0.01 };
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const resolved = await this.resolve(symbol);
    return this.historyResolved(resolved, timeframe, range);
  }

  async historyResolved(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    range?: HistoryRange,
  ): Promise<Bar[]> {
    const symbol = instrument.strategySymbol;
    const key = this.key(symbol, timeframe);
    this.historyCalls.push({
      symbol,
      timeframe,
      from: range?.from,
      to: range?.to,
      limit: range?.limit,
    });
    const failures = this.failCounts.get(key) ?? 0;
    if (range?.from != null && this.failRefreshFeeds.has(key))
      throw new Error(`refresh upstream 503 for ${key}`);
    if (failures > 0) {
      this.failCounts.set(key, failures - 1);
      throw new Error(`transient upstream 503 for ${key}`);
    }
    if (this.failFeeds.has(key)) throw new Error(`upstream 503 for ${key}`);
    if (this.emptyFeeds.has(key)) return [];
    const bars = this.series[key];
    if (!bars) throw new Error(`feed-test: no series for ${key}`);
    const tfSeconds = timeframe === '1d' ? 86_400 : timeframe === '5m' ? 300 : HOUR;
    let closed = bars.filter((bar) => bar.time + tfSeconds <= this.now);
    if (range?.from != null) closed = closed.filter((bar) => bar.time >= range.from!);
    if (range?.to != null) closed = closed.filter((bar) => bar.time <= range.to!);
    const limit = range?.limit;
    return (limit != null && closed.length > limit ? closed.slice(-limit) : closed).map((bar) => ({
      ...bar,
    }));
  }

  async *closedBars(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    options: ClosedBarsOptions = {},
  ): AsyncIterable<Bar> {
    const bars = this.series[this.key(instrument.strategySymbol, timeframe)] ?? [];
    for (const bar of bars.slice(this.cutoverIndex)) {
      if (options.signal?.aborted) return;
      if (options.after != null && bar.time <= options.after) continue;
      this.now = bar.time + HOUR; // the venue clock reaches this bar's close
      yield { ...bar };
    }
  }
}

class HangingProvider extends FeedProvider {
  override async historyResolved(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    range?: HistoryRange,
    signal?: AbortSignal,
  ): Promise<Bar[]> {
    if (instrument.strategySymbol === 'Y')
      return new Promise<Bar[]>((_, reject) => {
        const abort = () => reject(new Error('hanging request aborted'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    return super.historyResolved(instrument, timeframe, range);
  }
}

/** Deliberately violates cancellation to prove timed-out work retains its real concurrency slot. */
class IgnoringAbortProvider extends FeedProvider {
  refreshCalls = 0;
  active = 0;
  maxActive = 0;

  override async historyResolved(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    range?: HistoryRange,
    _signal?: AbortSignal,
  ): Promise<Bar[]> {
    if (instrument.strategySymbol === 'Y' && range?.from != null) {
      this.refreshCalls++;
      this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      return new Promise<Bar[]>(() => {});
    }
    return super.historyResolved(instrument, timeframe, range);
  }
}

/** Returns all bars even when a range is supplied, exercising the manager's own as-of filter. */
class RangeIgnoringProvider implements MarketDataProvider {
  readonly id = 'range-ignoring';
  readonly calls: HistoryRange[] = [];

  constructor(private readonly bars: Bar[]) {}

  async resolve(symbol: string): Promise<ResolvedDataInstrument> {
    return Object.freeze({
      strategySymbol: symbol,
      providerHandle: `${this.id}:${symbol}`,
      venueSymbol: symbol,
      mintick: 0.01,
      qtyStep: 1,
      minOrderQty: 1,
    });
  }

  async instrument() {
    return { minQty: 1, mintick: 0.01 };
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    return this.historyResolved(await this.resolve(symbol), timeframe, range);
  }

  async historyResolved(
    _instrument: ResolvedDataInstrument,
    _timeframe: string,
    range: HistoryRange = {},
  ): Promise<Bar[]> {
    this.calls.push({ ...range });
    return this.bars.map((bar) => ({ ...bar }));
  }

  async *closedBars(): AsyncIterable<Bar> {}
}

class TrackingProvider extends FeedProvider {
  active = 0;
  maxActive = 0;

  override async historyResolved(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    range?: HistoryRange,
  ): Promise<Bar[]> {
    if (instrument.strategySymbol === 'X')
      return super.historyResolved(instrument, timeframe, range);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Bun.sleep(5);
    try {
      return await super.historyResolved(instrument, timeframe, range);
    } finally {
      this.active--;
    }
  }
}

function paper() {
  return new PaperBroker({
    instruments: { X: { symbol: 'X', minQty: 1, qtyStep: 1, minOrderQty: 1, mintick: 0.01 } },
  });
}

// ── planning (no I/O) ────────────────────────────────────────

test('a cross-symbol request plans one feed at the chart timeframe, keyed by bare symbol', () => {
  const deps = compile(
    '//@version=6\nstrategy("s")\ny = request.security("Y", "60", close)\nplot(y)',
  ).metadata.securityDependencies;
  expect(planSecurityFromStatic(deps, '1h', 'X')).toEqual([
    { key: 'Y', symbol: 'Y', self: false, fetchTf: '1h', rawTf: '60', kind: 'cross' },
  ]);
});

test('a plain cross-symbol lower timeframe fetches the finer base under the bare key', () => {
  const deps = compile(
    '//@version=6\nstrategy("s")\ny = request.security("Y", "5", close)\nplot(y)',
  ).metadata.securityDependencies;
  expect(planSecurityFromStatic(deps, '1h', 'X')).toEqual([
    { key: 'Y', symbol: 'Y', self: false, fetchTf: '5m', rawTf: '5', kind: 'cross' },
  ]);
});

test('a self higher-timeframe request keys by chart symbol and fetches the exact timeframe', () => {
  const deps = compile(
    '//@version=6\nstrategy("s")\nd = request.security(syminfo.tickerid, "D", close)\nplot(d)',
  ).metadata.securityDependencies;
  expect(planSecurityFromStatic(deps, '1h', 'X')).toEqual([
    { key: 'X@D', symbol: 'X', self: true, fetchTf: '1d', rawTf: 'D', kind: 'self' },
  ]);
});

test('the chart timeframe itself needs no feed — piner passes it through', () => {
  const deps = compile(
    '//@version=6\nstrategy("s")\nc = request.security(syminfo.tickerid, timeframe.period, close)\nplot(c)',
  ).metadata.securityDependencies;
  expect(planSecurityFromStatic(deps, '1h', 'X')).toEqual([]);
});

test('lower_tf plans a finer fetch timeframe but keeps the requested string in the key', () => {
  const deps = compile(
    '//@version=6\nstrategy("s")\nv = request.security_lower_tf(syminfo.tickerid, "5", close)\nplot(array.size(v))',
  ).metadata.securityDependencies;
  expect(planSecurityFromStatic(deps, '1h', 'X')).toEqual([
    { key: 'X@5', symbol: 'X', self: true, fetchTf: '5m', rawTf: '5', kind: 'self-lower-tf' },
  ]);
});

test('a runtime-computed argument defers planning to a discovery run', () => {
  const deps = compile(
    '//@version=6\nstrategy("s")\nsym = input.symbol("Y")\ny = request.security(sym, "60", close)\nplot(y)',
  ).metadata.securityDependencies;
  expect(planSecurityFromStatic(deps, '1h', 'X')).toBeNull();
  // What the discovery run reports instead: the probe symbol marks self-references.
  expect(
    planSecurityFromRequests(
      [
        { symbol: 'Y', timeframe: '60', lowerTf: false },
        { symbol: '__pinelive_probe__', timeframe: 'D', lowerTf: false },
      ],
      '1h',
      'X',
    ),
  ).toEqual([
    { key: 'Y', symbol: 'Y', self: false, fetchTf: '1h', rawTf: '60', kind: 'cross' },
    { key: 'X@D', symbol: 'X', self: true, fetchTf: '1d', rawTf: 'D', kind: 'self' },
  ]);
});

test('duplicate call sites collapse into a single feed', () => {
  const deps = compile(
    `//@version=6
strategy("s")
a = request.security("Y", "60", close)
b = request.security("Y", "60", open)
plot(a + b)`,
  ).metadata.securityDependencies;
  expect(planSecurityFromStatic(deps, '1h', 'X')).toHaveLength(1);
});

// ── live runs ────────────────────────────────────────────────

/** Long only while the OTHER symbol is above 100 — proves the feed reached the strategy. */
const CROSS_STRATEGY = `//@version=6
strategy("cross", default_qty_type=strategy.fixed, default_qty_value=1)
y = request.security("Y", "60", close)
if not na(y) and y > 100
    strategy.entry("L", strategy.long)
else
    strategy.close("L")`;

test('a cross-symbol strategy runs live and trades off the secondary feed', async () => {
  // Y crosses above 100 only at index 6, which is a LIVE bar, not warmup.
  const provider = new FeedProvider(
    { 'X|1h': hourly(10, () => 50), 'Y|1h': hourly(10, (i) => (i >= 6 ? 105 : 95)) },
    4,
  );
  const broker = paper();
  const records: ForwardRecord[] = [];
  const runner = new ForwardRunner(provider, broker, {
    source: CROSS_STRATEGY,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    onRecord: (record) => records.push(record),
  });
  await runner.start();

  expect(runner.securityFeedSpecs.map((spec) => spec.key)).toEqual(['Y']);
  expect(records.map((record) => record.bar.time)).toHaveLength(6);
  // Live bars are chart indexes 4..9 and Y crosses 100 at index 6. The position appears on
  // index 7 because a Pine entry submitted at a bar's close fills on the next bar — the same
  // lag the backtest has. Before the cross the strategy is flat, which is the proof the feed
  // arrived as real data rather than na (na would keep it flat forever).
  expect(records.map((record) => record.target)).toEqual([0, 0, 0, 1, 1, 1]);
});

test('the secondary feed is refreshed before each live bar, not just at startup', async () => {
  const provider = new FeedProvider(
    { 'X|1h': hourly(8, () => 50), 'Y|1h': hourly(8, () => 95) },
    4,
  );
  await new ForwardRunner(provider, paper(), {
    source: CROSS_STRATEGY,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
  }).start();

  const feedCalls = provider.historyCalls.filter((call) => call.symbol === 'Y');
  expect(feedCalls).toHaveLength(5); // one warmup + one bounded catch-up per live chart bar
  expect(feedCalls[0]!.limit).toBe(7);
  expect(feedCalls[0]!.to).toBe(hourly(4, () => 0).at(-1)!.time + HOUR);
  expect(feedCalls.slice(1).every((call) => call.limit === 5000)).toBe(true);
  expect(feedCalls.slice(1).every((call) => call.from != null && call.to != null)).toBe(true);
});

test('warmup filters provider data at the newest chart-history close before counting depth', async () => {
  const end = 1_700_000_000 + 2 * HOUR;
  const provider = new RangeIgnoringProvider([
    ...hourly(1, () => 90, end - HOUR),
    ...hourly(3, () => 100, end),
  ]);
  const chartInstrument = await provider.resolve('X');
  const manager = new SecurityFeedManager(
    provider,
    [
      {
        key: 'Y',
        symbol: 'Y',
        self: false,
        fetchTf: '1h',
        rawTf: '60',
        kind: 'cross',
      },
    ],
    {
      chartTf: '1h',
      chartInstrument,
      chartWarmupEnd: end,
      warmupBars: 2,
      maxBars: 10,
    },
  );

  await expect(manager.warmup()).rejects.toThrow(
    /returned 1 aligned bars at the chart warmup horizon but 2 are required/,
  );
  expect(provider.calls[0]).toMatchObject({ to: end, limit: 5 });
});

test('warmup stops when a provider ignores limit and exceeds maxSecurityBars', async () => {
  const bars = hourly(6, () => 90);
  const provider = new RangeIgnoringProvider(bars);
  const chartInstrument = await provider.resolve('X');
  const manager = new SecurityFeedManager(
    provider,
    [
      {
        key: 'Y',
        symbol: 'Y',
        self: false,
        fetchTf: '1h',
        rawTf: '60',
        kind: 'cross',
      },
    ],
    {
      chartTf: '1h',
      chartInstrument,
      chartWarmupEnd: bars.at(-1)!.time + HOUR,
      warmupBars: 1,
      maxBars: 5,
    },
  );

  await expect(manager.warmup()).rejects.toThrow(
    /returned 6 aligned bars, exceeding maxSecurityBars 5; refusing to truncate/,
  );
});

test('monthly refresh uses the calendar close and excludes data after the true boundary', async () => {
  const februaryOpen = Date.UTC(2024, 1, 1) / 1000;
  const marchOpen = Date.UTC(2024, 2, 1) / 1000;
  const prior = Array.from({ length: 30 }, (_, index) => {
    const time = februaryOpen - (30 - index) * DAY;
    return { time, open: 90, high: 91, low: 89, close: 90, volume: 1 };
  });
  const provider = new RangeIgnoringProvider([
    ...prior,
    {
      time: Date.UTC(2024, 1, 29) / 1000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
    },
    { time: marchOpen, open: 110, high: 111, low: 109, close: 110, volume: 1 },
  ]);
  const chartInstrument = await provider.resolve('X');
  const manager = new SecurityFeedManager(
    provider,
    [
      {
        key: 'Y',
        symbol: 'Y',
        self: false,
        fetchTf: '1d',
        rawTf: 'D',
        kind: 'cross',
      },
    ],
    {
      chartTf: '1M',
      chartInstrument,
      chartWarmupEnd: februaryOpen,
      warmupBars: 1,
      maxBars: 100,
    },
  );

  await manager.warmup();
  await manager.refresh(februaryOpen);

  expect(provider.calls.at(-1)?.to).toBe(marchOpen);
  expect(manager.describe()[0]?.bars).toBe(31); // March 1 daily bar closes after February
});

test('init fails closed when a secondary symbol cannot be resolved', async () => {
  const provider = new FeedProvider({ 'X|1h': hourly(6, () => 50) }, 4);
  provider.unresolvable.add('Y');
  const runner = new ForwardRunner(provider, paper(), {
    source: CROSS_STRATEGY,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
  });
  await expect(runner.init()).rejects.toThrow(/feed "Y" could not resolve symbol/);
});

test('init fails closed when a secondary feed has no history rather than trading on na', async () => {
  const provider = new FeedProvider(
    { 'X|1h': hourly(6, () => 50), 'Y|1h': hourly(6, () => 95) },
    4,
  );
  provider.emptyFeeds.add('Y|1h');
  const broker = paper();
  await expect(
    new ForwardRunner(provider, broker, {
      source: CROSS_STRATEGY,
      symbol: 'X',
      timeframe: '1h',
      warmupBars: 4,
    }).init(),
  ).rejects.toThrow(/returned 0 aligned bars at the chart warmup horizon but 4 are required/);
  expect((await broker.getPosition('X')).qty).toBe(0);
});

test('init fails closed when a secondary feed fetch errors', async () => {
  const provider = new FeedProvider(
    { 'X|1h': hourly(6, () => 50), 'Y|1h': hourly(6, () => 95) },
    4,
  );
  provider.failFeeds.add('Y|1h');
  await expect(
    new ForwardRunner(provider, paper(), {
      source: CROSS_STRATEGY,
      symbol: 'X',
      timeframe: '1h',
      warmupBars: 4,
    }).init(),
  ).rejects.toThrow(/history fetch failed/);
});

test('a live refresh failure stops before reconciliation by default', async () => {
  const provider = new FeedProvider(
    { 'X|1h': hourly(8, () => 50), 'Y|1h': hourly(8, (i) => (i >= 6 ? 105 : 95)) },
    4,
  );
  const stale: string[] = [];
  const health: unknown[] = [];
  const records: ForwardRecord[] = [];
  const runner = new ForwardRunner(provider, paper(), {
    source: CROSS_STRATEGY,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    onSecurityError: (key, error) => stale.push(`${key}: ${error}`),
    onSecurityHealth: (record) => health.push(record),
    onRecord: (record) => records.push(record),
  });
  await runner.init();
  provider.failFeeds.add('Y|1h');
  await expect(runner.start()).rejects.toThrow(/reconciliation stopped/);

  expect(stale).toHaveLength(1);
  expect(stale[0]).toContain('1 consecutive failed refresh');
  expect(health).toHaveLength(1);
  expect(records).toHaveLength(0);
});

test('successful no-progress refresh does not clear an earlier tolerated failure', async () => {
  const provider = new FeedProvider(
    { 'X|1h': hourly(6, () => 50), 'Y|1h': hourly(4, () => 95) },
    4,
  );
  const records: ForwardRecord[] = [];
  const runner = new ForwardRunner(provider, paper(), {
    source: CROSS_STRATEGY,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    maxSecurityStaleRefreshes: 2,
    onRecord: (record) => records.push(record),
  });
  await runner.init();
  provider.failNext('Y', '1h');
  await runner.start();

  expect(records).toHaveLength(2);
  expect(records.every((record) => record.securityFeeds?.[0]?.status === 'stale')).toBe(true);
  expect(records.every((record) => record.securityFeeds?.[0]?.consecutiveFailures === 1)).toBe(
    true,
  );
});

test('disabling security resolution refuses a strategy that depends on it', async () => {
  const provider = new FeedProvider({ 'X|1h': hourly(6, () => 50) }, 4);
  await expect(
    new ForwardRunner(provider, paper(), {
      source: CROSS_STRATEGY,
      symbol: 'X',
      timeframe: '1h',
      warmupBars: 4,
      resolveSecurity: false,
    }).init(),
  ).rejects.toBeInstanceOf(ForwardRunnerError);
  expect(provider.resolveCalls).toHaveLength(0); // rejected before any I/O
});

test('a self higher-timeframe feed reuses the chart instrument instead of re-resolving', async () => {
  const source = `//@version=6
strategy("htf", default_qty_type=strategy.fixed, default_qty_value=1)
d = request.security(syminfo.tickerid, "D", close)
if not na(d)
    strategy.entry("L", strategy.long)`;
  const provider = new FeedProvider(
    {
      'X|1h': hourly(8, () => 50),
      'X|1d': [
        { time: 1_699_920_000, open: 50, high: 51, low: 49, close: 50, volume: 1 },
        { time: 1_700_006_400, open: 50, high: 51, low: 49, close: 50, volume: 1 },
      ],
    },
    4,
  );
  const runner = new ForwardRunner(provider, paper(), {
    source,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    securityWarmupBars: 1,
  });
  await runner.init();
  expect(runner.securityFeedSpecs).toEqual([
    { key: 'X@D', symbol: 'X', self: true, fetchTf: '1d', rawTf: 'D', kind: 'self' },
  ]);
  // The chart symbol is resolved once; the self feed reuses that resolution so a futures
  // run cannot bind two different contract months.
  expect(provider.resolveCalls).toEqual(['X']);
  expect(provider.historyCalls.some((call) => call.timeframe === '1d')).toBe(true);
});

/** Midnight UTC, so the 1h chart bars line up with daily boundaries. */
const MIDNIGHT = 1_700_006_400;

test('a self higher-timeframe request resolves against the FETCHED daily series', async () => {
  // The daily closes (50 then 500) deliberately disagree with the 1h closes (all 50). If piner
  // resampled the chart's own bars instead of reading the injected series, `d` would never
  // exceed 100 and the strategy would stay flat for the whole run.
  const source = `//@version=6
strategy("selfhtf", default_qty_type=strategy.fixed, default_qty_value=1)
d = request.security(syminfo.tickerid, "D", close)
if not na(d) and d > 100
    strategy.entry("L", strategy.long)
else
    strategy.close("L")`;
  const provider = new FeedProvider(
    {
      'X|1h': hourly(30, () => 50, MIDNIGHT),
      'X|1d': [
        { time: MIDNIGHT - DAY, open: 50, high: 51, low: 49, close: 50, volume: 1 },
        { time: MIDNIGHT, open: 400, high: 501, low: 399, close: 500, volume: 1 },
      ],
    },
    20,
  );
  const records: ForwardRecord[] = [];
  await new ForwardRunner(provider, paper(), {
    source,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 20,
    securityWarmupBars: 1,
    onRecord: (record) => records.push(record),
  }).start();

  // Live bars are chart indexes 20..29. The MIDNIGHT daily bar closes exactly at chart bar 23's
  // close, so that is the first bar allowed to see close=500 (no lookahead), and the entry it
  // submits fills on bar 24.
  expect(records).toHaveLength(10);
  expect(records.map((record) => record.target)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);

  // Refresh uses an explicit overlap/catch-up range on every chart bar; provider finality and
  // calendar-aware close checks decide whether the daily series actually advances.
  const dailyCalls = provider.historyCalls.filter((call) => call.timeframe === '1d');
  expect(dailyCalls).toHaveLength(11); // one warmup + ten live chart bars
  expect(dailyCalls.slice(1).every((call) => call.from != null && call.to != null)).toBe(true);
});

test('plain cross-symbol lower-timeframe data is fetched and injected under the bare symbol key', async () => {
  const source = `//@version=6
strategy("cross-ltf")
y = request.security("Y", "5", close)
plot(y)`;
  const provider = new FeedProvider(
    { 'X|1h': hourly(6, () => 50), 'Y|5m': fiveMinute(72, (i) => i) },
    4,
  );
  const runner = new ForwardRunner(provider, paper(), {
    source,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
  });
  await runner.start();

  expect(runner.securityFeedSpecs).toEqual([
    { key: 'Y', symbol: 'Y', self: false, fetchTf: '5m', rawTf: '5', kind: 'cross' },
  ]);
  expect(provider.historyCalls.some((call) => call.symbol === 'Y' && call.timeframe === '5m')).toBe(
    true,
  );
  expect(provider.historyCalls.some((call) => call.symbol === 'Y' && call.timeframe === '1h')).toBe(
    false,
  );
});

test('request.security_lower_tf receives live closed intrabars end to end', async () => {
  const source = `//@version=6
strategy("lower", default_qty_type=strategy.fixed, default_qty_value=1)
a = request.security_lower_tf(syminfo.tickerid, "5", close)
if array.size(a) == 12
    strategy.entry("L", strategy.long)`;
  const provider = new FeedProvider(
    { 'X|1h': hourly(6, () => 50), 'X|5m': fiveMinute(72, (i) => i) },
    4,
  );
  const records: ForwardRecord[] = [];
  const runner = new ForwardRunner(provider, paper(), {
    source,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    onRecord: (record) => records.push(record),
  });
  await runner.start();

  expect(runner.securityFeedSpecs.map((feed) => feed.key)).toEqual(['X@5']);
  expect(records.some((record) => record.target === 1)).toBe(true);
});

test('a dependency first selected on a live bar stops before broker reconciliation', async () => {
  const source = `//@version=6
strategy("dynamic", default_qty_type=strategy.fixed, default_qty_value=1)
sym = close > 100 ? "Z" : "Y"
y = request.security(sym, "60", close)
if not na(y)
    strategy.entry("L", strategy.long)`;
  const provider = new FeedProvider(
    { 'X|1h': hourly(6, (i) => (i >= 4 ? 150 : 50)), 'Y|1h': hourly(6, () => 95) },
    4,
  );
  const broker = paper();
  const records: ForwardRecord[] = [];
  const runner = new ForwardRunner(provider, broker, {
    source,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    onRecord: (record) => records.push(record),
  });

  await expect(runner.start()).rejects.toThrow(/dependency after initialization \(Z@1h\)/);
  expect(records).toHaveLength(0);
  expect((await broker.getPosition('X')).qty).toBe(0);
});

test('a transient outage catches up every missed bar from an explicit range', async () => {
  const provider = new FeedProvider(
    { 'X|1h': hourly(8, () => 50), 'Y|1h': hourly(8, (i) => (i >= 5 ? 105 : 95)) },
    4,
  );
  const records: ForwardRecord[] = [];
  const runner = new ForwardRunner(provider, paper(), {
    source: CROSS_STRATEGY,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    maxSecurityStaleRefreshes: 1,
    onRecord: (record) => records.push(record),
  });
  await runner.init();
  provider.failNext('Y', '1h');
  await runner.start();

  expect(records.at(-1)?.securityFeeds?.[0]?.bars).toBe(8);
  expect(records.at(-1)?.securityFeeds?.[0]?.status).toBe('healthy');
  expect(records.some((record) => record.target === 1)).toBe(true);
  const refreshes = provider.historyCalls.filter(
    (call) => call.symbol === 'Y' && call.from != null,
  );
  expect(refreshes.every((call) => call.to != null)).toBe(true);
});

test('a corrected bar with an existing timestamp replaces the injected value', async () => {
  const provider = new FeedProvider(
    { 'X|1h': hourly(6, () => 50), 'Y|1h': hourly(4, () => 95) },
    4,
  );
  const records: ForwardRecord[] = [];
  const runner = new ForwardRunner(provider, paper(), {
    source: CROSS_STRATEGY,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    onRecord: (record) => records.push(record),
  });
  await runner.init();
  provider.revise('Y', '1h', 3, { open: 105, high: 106, low: 104, close: 105 });
  await runner.start();

  expect(records.at(-1)?.target).toBe(1);
});

test('maxSecurityBars stops instead of truncating indicator history', async () => {
  const provider = new FeedProvider(
    { 'X|1h': hourly(8, () => 50), 'Y|1h': hourly(8, () => 95) },
    4,
  );
  const records: ForwardRecord[] = [];
  const runner = new ForwardRunner(provider, paper(), {
    source: CROSS_STRATEGY,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    maxSecurityBars: 5,
    onRecord: (record) => records.push(record),
  });

  await expect(runner.start()).rejects.toThrow(/refusing to truncate indicator history/);
  expect(records).toHaveLength(1);
});

test('direct API options validate feed limits before security execution', async () => {
  const provider = new FeedProvider(
    { 'X|1h': hourly(6, () => 50), 'Y|1h': hourly(6, () => 95) },
    4,
  );
  await expect(
    new ForwardRunner(provider, paper(), {
      source: CROSS_STRATEGY,
      symbol: 'X',
      timeframe: '1h',
      warmupBars: 4,
      maxSecurityBars: 0,
    }).init(),
  ).rejects.toThrow(/maxBars must be a positive integer/);

  await expect(
    new ForwardRunner(provider, paper(), {
      source: CROSS_STRATEGY,
      symbol: 'X',
      timeframe: '1h',
      warmupBars: 4,
      securityWarmupBars: 5,
      maxSecurityBars: 4,
    }).init(),
  ).rejects.toThrow(/warmupBars 5 exceeds maxBars 4/);
});

test('secondary warmup concurrency is bounded', async () => {
  const source = `//@version=6
strategy("many")
a = request.security("Y", "60", close)
b = request.security("Z", "60", close)
c = request.security("W", "60", close)
plot(a + b + c)`;
  const provider = new TrackingProvider(
    {
      'X|1h': hourly(6, () => 50),
      'Y|1h': hourly(6, () => 90),
      'Z|1h': hourly(6, () => 91),
      'W|1h': hourly(6, () => 92),
    },
    4,
  );
  await new ForwardRunner(provider, paper(), {
    source,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    securityConcurrency: 2,
  }).init();
  expect(provider.maxActive).toBe(2);
});

test('a hung secondary request times out and cancellation interrupts immediately', async () => {
  const provider = new HangingProvider({ 'X|1h': hourly(6, () => 50) }, 4);
  await expect(
    new ForwardRunner(provider, paper(), {
      source: CROSS_STRATEGY,
      symbol: 'X',
      timeframe: '1h',
      warmupBars: 4,
      securityRequestTimeoutMs: 10,
    }).init(),
  ).rejects.toThrow(/timed out after 10ms/);

  const provider2 = new HangingProvider({ 'X|1h': hourly(6, () => 50) }, 4);
  const runner = new ForwardRunner(provider2, paper(), {
    source: CROSS_STRATEGY,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    securityRequestTimeoutMs: 10_000,
  });
  const pending = runner.init();
  setTimeout(() => runner.cancel(), 5);
  await expect(pending).rejects.toThrow(/aborted/);
});

test('a provider that ignores abort cannot exceed concurrency after timeout', async () => {
  const provider = new IgnoringAbortProvider(
    { 'X|1h': hourly(6, () => 50), 'Y|1h': hourly(6, () => 95) },
    4,
  );
  const records: ForwardRecord[] = [];
  await new ForwardRunner(provider, paper(), {
    source: CROSS_STRATEGY,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
    securityConcurrency: 1,
    securityRequestTimeoutMs: 5,
    maxSecurityStaleRefreshes: 2,
    onRecord: (record) => records.push(record),
  }).start();

  expect(provider.refreshCalls).toBe(1);
  expect(provider.maxActive).toBe(1);
  expect(records).toHaveLength(2);
  expect(records.every((record) => record.securityFeeds?.[0]?.status === 'stale')).toBe(true);
});

test('concurrent start calls are rejected', async () => {
  const provider = new FeedProvider(
    { 'X|1h': hourly(6, () => 50), 'Y|1h': hourly(6, () => 95) },
    4,
  );
  const runner = new ForwardRunner(provider, paper(), {
    source: CROSS_STRATEGY,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 4,
  });
  const first = runner.start();
  await expect(runner.start()).rejects.toThrow(/already running/);
  await first;
});

test('server ledgers feed health before fail-closed refresh shutdown', async () => {
  const provider = new FeedProvider(
    { 'X|1h': hourly(6, () => 50), 'Y|1h': hourly(6, () => 95) },
    4,
  );
  provider.failRefreshFeeds.add('Y|1h');
  const ledger = new MemoryLedger();
  await expect(
    runForwardServer({
      source: CROSS_STRATEGY,
      symbol: 'X',
      timeframe: '1h',
      data: provider,
      broker: paper(),
      ledger,
      warmupBars: 4,
    }),
  ).rejects.toThrow(/reconciliation stopped/);

  expect(ledger.security).toHaveLength(1);
  expect(ledger.security[0]).toMatchObject({
    recordType: 'security',
    key: 'Y',
    feeds: [{ status: 'stale', consecutiveFailures: 1 }],
  });
});
