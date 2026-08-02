import { expect, test } from 'bun:test';
import {
  ReplayProvider,
  StaticProvider,
  type Bar,
  type BarUpdate,
  type MarketDataProvider,
  type ResolvedHistorySource,
} from '@heyphat/pinery';
import {
  IntrabarRunner,
  type IntrabarBackend,
  type IntrabarEvaluation,
  type IntrabarRunnerOptions,
} from '../src/core/intrabar-runner.js';

const native = Object.freeze({ kind: 'native' as const });
const everyUpdateSource = `//@version=6
strategy("compute", calc_on_every_tick=true, process_orders_on_close=true, default_qty_type=strategy.fixed, default_qty_value=1)
if close > open
    strategy.entry("L", strategy.long)
else
    strategy.close("L")
plot(strategy.position_size)`;

function bar(time: number, close = 11, open = 10): Bar {
  return {
    time,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 1,
  };
}

function update(value: Bar, revision: number, isClose: boolean, eventTime: number): BarUpdate {
  return { bar: value, revision, isClose, eventTime, source: native };
}

function minuteReplay(updates: readonly BarUpdate[] = []): ReplayProvider {
  const history = [bar(0, 9), bar(60, 11), bar(120, 11), bar(180, 9)];
  const source = new StaticProvider(
    { 'X|1m': history },
    {
      alignment: 'utc-24x7',
      timeframes: ['1m'],
      cacheIdentity: 'intrabar-minute-v1',
    },
  ).setInstrument('X', { minQty: 1, mintick: 0.01 });
  return new ReplayProvider(source, {
    cutoverTime: 120,
    updates: updates.length > 0 ? { 'X|1m': updates } : undefined,
    instrument: { minOrderQty: 1 },
  });
}

function everyUpdateRunner(
  provider: MarketDataProvider,
  evaluations: IntrabarEvaluation[],
  backend: IntrabarBackend = 'js',
  startupDiscontinuity = false,
): IntrabarRunner {
  return new IntrabarRunner(provider, {
    source: everyUpdateSource,
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 2,
    backend,
    historical: { mode: 'standard' },
    live: {
      cadence: 'every-update',
      source: native,
      startupDiscontinuity,
    },
    onEvaluation: (evaluation) => evaluations.push(evaluation),
  });
}

test('every-update drives forming snapshots and one authoritative final on both backends', async () => {
  const final = bar(120, 11);
  const traces = [
    update(bar(120, 10.5), 1, false, 120_001),
    update(bar(120, 9.5), 2, false, 120_002),
    update(final, 3, true, 120_003),
  ];
  const byBackend = {} as Record<IntrabarBackend, IntrabarEvaluation[]>;

  for (const backend of ['js', 'interp'] as const) {
    const evaluations: IntrabarEvaluation[] = [];
    await everyUpdateRunner(minuteReplay(traces), evaluations, backend).start();
    expect(evaluations.map((item) => item.finalCommit)).toEqual([false, false, true]);
    expect(evaluations.map((item) => item.update.revision)).toEqual([1, 2, 3]);
    expect(evaluations.map((item) => item.update.barTime)).toEqual([120, 120, 120]);
    expect(new Set(evaluations.map((item) => item.decisionId)).size).toBe(3);
    expect(evaluations.every((item) => Object.isFrozen(item))).toBe(true);
    byBackend[backend] = evaluations;
  }

  expect(byBackend.interp.map(projectEvaluation)).toEqual(byBackend.js.map(projectEvaluation));
  expect(byBackend.interp.map((item) => item.decisionId)).not.toEqual(
    byBackend.js.map((item) => item.decisionId),
  );

  const repeated: IntrabarEvaluation[] = [];
  await everyUpdateRunner(minuteReplay(traces), repeated, 'js').start();
  expect(repeated.map((item) => item.decisionId)).toEqual(
    byBackend.js.map((item) => item.decisionId),
  );
});

test('bar-close closedBars and final-only live updates produce equivalent final targets', async () => {
  const closeOnly: IntrabarEvaluation[] = [];
  await new IntrabarRunner(minuteReplay(), {
    source: everyUpdateSource,
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 2,
    historical: { mode: 'standard' },
    live: { cadence: 'bar-close' },
    onEvaluation: (evaluation) => closeOnly.push(evaluation),
  }).start();

  const finalOnly: IntrabarEvaluation[] = [];
  await everyUpdateRunner(
    minuteReplay([update(bar(120, 11), 1, true, 120_001), update(bar(180, 9), 1, true, 180_001)]),
    finalOnly,
  ).start();

  expect(closeOnly.map((item) => [item.update.barTime, item.target, item.finalCommit])).toEqual(
    finalOnly.map((item) => [item.update.barTime, item.target, item.finalCommit]),
  );
  expect(closeOnly.every((item) => item.update.kind === 'closed-bar')).toBe(true);
  expect(finalOnly.every((item) => item.update.kind === 'live-update')).toBe(true);
});

test('recovered finals compute but are explicitly non-executable', async () => {
  const evaluations: IntrabarEvaluation[] = [];
  await everyUpdateRunner(
    minuteReplay([
      update(bar(120, 10.5), 1, false, 120_001),
      update(bar(180, 9), 1, true, 180_001),
    ]),
    evaluations,
  ).start();

  expect(evaluations.map((item) => [item.update.barTime, item.update.recovered])).toEqual([
    [120, false],
    [120, true],
    [180, false],
  ]);
  expect(evaluations[1]).toMatchObject({
    executable: false,
    reason: 'recovered-final',
    finalCommit: true,
  });
});

test('startup discontinuity inhibits the first live chart time through its final', async () => {
  const evaluations: IntrabarEvaluation[] = [];
  await everyUpdateRunner(
    minuteReplay([
      update(bar(120, 10.5), 1, false, 120_001),
      update(bar(120, 11), 2, true, 120_002),
      update(bar(180, 9), 1, true, 180_001),
    ]),
    evaluations,
    'js',
    true,
  ).start();

  expect(evaluations.map((item) => [item.update.barTime, item.executable, item.reason])).toEqual([
    [120, false, 'startup-discontinuity'],
    [120, false, 'startup-discontinuity'],
    [180, true, 'eligible'],
  ]);
});

test('compile, cadence, and security failures occur before provider I/O', async () => {
  const cases = [
    {
      source: '//@version=6\nindicator("x")\nplot(close)',
      error: 'strategy()',
    },
    {
      source: '//@version=6\nstrategy("x")\nplot(close)',
      error: 'calc_on_every_tick=true',
    },
    {
      source:
        '//@version=6\nstrategy("x", calc_on_every_tick=true)\ny=request.security("Y", "1", close)\nplot(y)',
      error: 'does not support request.security',
    },
    {
      source:
        '//@version=6\nstrategy("x", calc_on_every_tick=true)\nsym=input.symbol("Y")\ny=request.security(sym, "1", close)\nplot(y)',
      error: 'does not support request.security',
    },
  ];

  for (const fixture of cases) {
    const { provider, calls } = untouchedProvider(true);
    await expect(
      new IntrabarRunner(provider, {
        source: fixture.source,
        symbol: 'X',
        timeframe: '1m',
        warmupBars: 1,
        live: { cadence: 'every-update', source: native },
      }).init(),
    ).rejects.toThrow(fixture.error);
    expect(calls).toEqual({ resolve: 0, history: 0, exact: 0, closed: 0, live: 0 });
  }

  const unsupported = untouchedProvider(false);
  await expect(
    new IntrabarRunner(unsupported.provider, {
      source: everyUpdateSource,
      symbol: 'X',
      timeframe: '1m',
      warmupBars: 1,
      live: { cadence: 'every-update', source: native },
    }).init(),
  ).rejects.toThrow('authoritative liveBars support');
  expect(unsupported.calls.resolve).toBe(0);
});

test('compute options reject execution ownership fields without touching their values', async () => {
  const { provider, calls } = untouchedProvider(false);
  let factoryCalls = 0;
  const options = {
    source: everyUpdateSource,
    symbol: 'X',
    timeframe: '1m',
    live: { cadence: 'bar-close' },
    brokerFactory: () => {
      factoryCalls++;
      throw new Error('must remain unreachable');
    },
  } as unknown as IntrabarRunnerOptions;

  await expect(new IntrabarRunner(provider, options).init()).rejects.toThrow(
    'unsupported fields: brokerFactory',
  );
  expect(factoryCalls).toBe(0);
  expect(calls).toEqual({ resolve: 0, history: 0, exact: 0, closed: 0, live: 0 });
});

const magnifierSource = `//@version=6
strategy("magnified", use_bar_magnifier=true)
plot(close)`;

function magnifierReplay(): ReplayProvider {
  const chart = [bar(0, 11), bar(3_600, 12), bar(7_200, 13)];
  const children = Array.from({ length: 12 }, (_, index) => bar(index * 600, 10 + index / 10));
  const source = new StaticProvider(
    {
      'X|1h': chart,
      'X|10m': children,
    },
    {
      alignment: 'utc-24x7',
      timeframes: ['1h', '10m'],
      cacheIdentity: 'intrabar-magnifier-v1',
    },
  ).setInstrument('X', { minQty: 1, mintick: 0.01 });
  return new ReplayProvider(source, {
    cutoverTime: 7_200,
    instrument: { minOrderQty: 1 },
  });
}

function magnifierRunner(
  provider: MarketDataProvider,
  options: {
    maxMagnifierTargetBars?: number;
    maxMagnifierRawBars?: number;
    backend?: IntrabarBackend;
  } = {},
  evaluations?: IntrabarEvaluation[],
): IntrabarRunner {
  const { backend = 'js', ...historical } = options;
  return new IntrabarRunner(provider, {
    source: magnifierSource,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 2,
    backend,
    historical: { mode: 'bar-magnifier', ...historical },
    live: { cadence: 'bar-close' },
    onEvaluation: evaluations
      ? (evaluation) => {
          evaluations.push(evaluation);
        }
      : undefined,
  });
}

test('magnified warmup exposes frozen exact acquisition, coverage, digest, and cutover facts', async () => {
  const runner = magnifierRunner(magnifierReplay(), {
    maxMagnifierTargetBars: 12,
    maxMagnifierRawBars: 12,
  });
  await runner.init();

  const binding = runner.binding!;
  expect(binding.historical.mode).toBe('bar-magnifier');
  if (binding.historical.mode !== 'bar-magnifier') throw new Error('missing exact binding');
  expect(binding.historical.exactSource).toMatchObject({
    requestedSymbol: 'X',
    normalizedSymbol: 'X',
  });
  expect(binding.historical.acquisition).toMatchObject({
    targetCanonicalTimeframe: '10m',
    sourceCanonicalTimeframe: '10m',
    targetBarCount: 12,
    rawBarCount: 12,
    maxMagnifierTargetBars: 12,
    maxMagnifierRawBars: 12,
    coverage: {
      requested: { from: 0, to: 7_200_000 },
      complete: true,
      gaps: [],
    },
  });
  expect(binding.runIdentity).toMatch(/^X:60:[a-f0-9]{64}$/);
  expect(binding.historical.acquisition.barsDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(binding.historical.acquisition.acquisitionKey.length).toBeGreaterThan(20);
  expect(binding.cutover).toEqual({
    after: 3_600,
    finalHistoricalClose: 7_200,
    firstAdmissibleLiveOpen: 7_200,
  });
  expect(Object.isFrozen(binding)).toBe(true);
  expect(Object.isFrozen(binding.historical.acquisition)).toBe(true);
  expect(Object.isFrozen(binding.historical.acquisition.coverage)).toBe(true);
});

test('magnifier target/raw budgets fail independently and source mismatch fails before acquisition', async () => {
  await expect(
    magnifierRunner(magnifierReplay(), { maxMagnifierTargetBars: 11 }).init(),
  ).rejects.toThrow('maxMagnifierTargetBars');
  await expect(
    magnifierRunner(magnifierReplay(), { maxMagnifierRawBars: 11 }).init(),
  ).rejects.toThrow('maxMagnifierRawBars');

  const base = magnifierReplay();
  const mismatched: MarketDataProvider = {
    id: 'mismatched-exact-source',
    history: base.history.bind(base),
    resolve: base.resolve.bind(base),
    historyResolved: base.historyResolved.bind(base),
    closedBars: base.closedBars.bind(base),
    disconnect: base.disconnect.bind(base),
    async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
      const source = await base.resolveHistorySource!(symbol);
      return { ...source, normalizedSymbol: 'Y' };
    },
  };
  await expect(magnifierRunner(mismatched).init()).rejects.toThrow(
    'exact-history source symbol does not match',
  );
});

test('magnifier child bars never become chart evaluations after cutover on either backend', async () => {
  const byBackend = {} as Record<IntrabarBackend, IntrabarEvaluation[]>;
  for (const backend of ['js', 'interp'] as const) {
    const evaluations: IntrabarEvaluation[] = [];
    const runner = magnifierRunner(magnifierReplay(), { backend }, evaluations);
    await runner.start();
    expect(runner.binding!.chart.backend).toBe(backend);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]).toMatchObject({
      update: { kind: 'closed-bar', barTime: 7_200 },
      finalCommit: true,
    });
    expect(evaluations.some((item) => item.update.barTime % 3_600 !== 0)).toBe(false);
    byBackend[backend] = evaluations;
  }
  expect(byBackend.interp.map(projectEvaluation)).toEqual(byBackend.js.map(projectEvaluation));
});

test('active Bar Magnifier plus calc_on_order_fills is rejected before data resolution', async () => {
  const { provider, calls } = untouchedProvider(false);
  await expect(
    new IntrabarRunner(provider, {
      source:
        '//@version=6\nstrategy("x", use_bar_magnifier=true, calc_on_order_fills=true)\nplot(close)',
      symbol: 'X',
      timeframe: '1h',
      warmupBars: 1,
      historical: { mode: 'bar-magnifier' },
      live: { cadence: 'bar-close' },
    }).init(),
  ).rejects.toThrow('calc_on_order_fills is unsupported');
  expect(calls.resolve).toBe(0);
});

function projectEvaluation(value: IntrabarEvaluation) {
  return {
    update: value.update,
    target: value.target,
    executable: value.executable,
    reason: value.reason,
    finalCommit: value.finalCommit,
  };
}

function untouchedProvider(withLiveBars: boolean): {
  provider: MarketDataProvider;
  calls: { resolve: number; history: number; exact: number; closed: number; live: number };
} {
  const calls = { resolve: 0, history: 0, exact: 0, closed: 0, live: 0 };
  const provider: MarketDataProvider = {
    id: 'untouched',
    async history() {
      calls.history++;
      throw new Error('history must not be called');
    },
    async resolveHistorySource() {
      calls.exact++;
      throw new Error('exact source must not be called');
    },
    async resolve() {
      calls.resolve++;
      throw new Error('resolve must not be called');
    },
    async historyResolved() {
      calls.history++;
      throw new Error('resolved history must not be called');
    },
    async *closedBars() {
      calls.closed++;
    },
  };
  if (withLiveBars) {
    provider.liveBars = async function* () {
      calls.live++;
    };
  }
  return { provider, calls };
}

test('magnified bar-close rejects security dependencies before finite data resolution', async () => {
  const { provider, calls } = untouchedProvider(false);
  await expect(
    new IntrabarRunner(provider, {
      source:
        '//@version=6\nstrategy("x", use_bar_magnifier=true)\ny=request.security("Y", "60", close)\nplot(y)',
      symbol: 'X',
      timeframe: '1h',
      warmupBars: 1,
      historical: { mode: 'bar-magnifier' },
      live: { cadence: 'bar-close' },
    }).init(),
  ).rejects.toThrow('bar-close security dependencies require exact security to be enabled');
  expect(calls).toEqual({ resolve: 0, history: 0, exact: 0, closed: 0, live: 0 });
});

test('recovered final cursor seeds the close-only subscription boundary', async () => {
  const base = minuteReplay();
  let subscribedAfter: number | undefined;
  const provider: MarketDataProvider = {
    id: base.id,
    history: base.history.bind(base),
    resolve: base.resolve.bind(base),
    historyResolved: base.historyResolved.bind(base),
    async *closedBars(instrument, timeframe, options) {
      subscribedAfter = options.after;
      yield* base.closedBars(instrument, timeframe, options);
    },
    disconnect: base.disconnect.bind(base),
  };
  const evaluations: IntrabarEvaluation[] = [];
  const runner = new IntrabarRunner(provider, {
    source: everyUpdateSource,
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 2,
    live: { cadence: 'bar-close' },
    onEvaluation: (evaluation) => evaluations.push(evaluation),
  });

  await runner.initialize();
  runner.configureRecovery({ lastFinalCursor: 120 });
  await runner.start();

  expect(subscribedAfter).toBe(120);
  expect(evaluations.map((evaluation) => evaluation.update.barTime)).toEqual([180]);
  expect(runner.finalizedCursor).toBe(180);
});

const exactSecuritySource = `//@version=6
strategy("exact security", use_bar_magnifier=true)
plot(request.security("AAPL", "60", close))`;

function exactSecurityReplay(): ReplayProvider {
  const chart = [bar(0, 11), bar(3_600, 12), bar(7_200, 13)];
  const children = Array.from({ length: 12 }, (_, index) => bar(index * 600, 10 + index / 10));
  const source = new StaticProvider(
    {
      'X|1h': chart,
      'X|10m': children,
      'AAPL|1h': chart,
    },
    {
      alignment: 'utc-24x7',
      timeframes: ['10m', '1h'],
      cacheIdentity: 'intrabar-exact-security-v1',
    },
  ).setInstrument('X', { minQty: 1, mintick: 0.01 });
  return new ReplayProvider(source, {
    cutoverTime: 7_200,
    instrument: { minOrderQty: 1 },
  });
}

function exactSecurityRunner(
  maxBarsPerFeed: number,
  backend: IntrabarBackend = 'js',
): IntrabarRunner {
  return new IntrabarRunner(exactSecurityReplay(), {
    source: exactSecuritySource,
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 2,
    backend,
    historical: {
      mode: 'bar-magnifier',
      maxMagnifierTargetBars: 12,
      maxMagnifierRawBars: 12,
    },
    security: {
      enabled: true,
      maxExactSecurityFeeds: 1,
      maxExactSecurityBarsPerFeed: maxBarsPerFeed,
      maxExactSecurityTotalBars: 2,
      concurrency: 1,
      requestTimeoutMs: 30_000,
      maxStaleRefreshes: 0,
    },
    live: { cadence: 'bar-close' },
  });
}

test('exact-security authority and budgets agree on both backends before Engine continuation', async () => {
  let baselineSecurity: unknown;
  for (const backend of ['js', 'interp'] as const) {
    const runner = exactSecurityRunner(2, backend);
    await runner.initialize();

    const authority = runner.binding!.authority.prepared;
    expect(authority.chart.backend).toBe(backend);
    expect(authority.budgets.magnifier).toMatchObject({
      configured: { maxTargetBars: 12, maxRawBars: 12 },
      observed: { targetBars: 12, rawBars: 12 },
    });
    expect(authority.budgets.security).toEqual({
      configured: {
        maxFeeds: 1,
        maxBarsPerFeed: 2,
        maxTotalBars: 2,
        concurrency: 1,
        requestTimeoutMs: 30_000,
        maxStaleRefreshes: 0,
      },
      effective: { maxFeeds: 1, maxBarsPerFeed: 2, maxTotalBars: 2 },
      observed: { feeds: 1, totalBars: 2, maxBarsPerFeed: 2, barsPerFeed: { AAPL: 2 } },
    });
    const security = authority.security;
    expect(security).toHaveLength(1);
    expect(security[0]).toMatchObject({
      key: 'AAPL',
      requestedSymbol: 'AAPL',
      barCount: 2,
      targetCanonicalTf: '60m',
      complete: true,
      gaps: [],
    });
    expect(security[0]!.barsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(security[0]!.acquisitionKey.length).toBeGreaterThan(20);
    expect(Object.isFrozen(security[0])).toBe(true);
    if (baselineSecurity === undefined) baselineSecurity = security;
    else expect(security).toEqual(baselineSecurity);
  }

  await expect(exactSecurityRunner(1).initialize()).rejects.toThrow(
    'exact security per-feed bar budget was exceeded for AAPL',
  );
});
