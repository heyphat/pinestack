import { expect, test } from 'bun:test';
import {
  InMemoryExecutionLease,
  MemoryLedger,
  PaperBroker,
  prepareIntrabarRun,
  recoverLedger,
  runIntrabarServer,
  type IntrabarBrokerFactory,
  type LedgerEventV3,
} from '@heyphat/pinelive';
import { ReplayProvider, StaticProvider, type Bar } from '@heyphat/pinery';

const native = Object.freeze({ kind: 'native' as const });
const dataConfig = {
  provider: 'csv',
  dataDir: '/path/must/not/be-read',
  cutoverTime: 7_200,
} as const;
const magnifiedEveryUpdateSource = `//@version=6
strategy("public replay", use_bar_magnifier=true, calc_on_every_tick=true, process_orders_on_close=true, default_qty_type=strategy.fixed, default_qty_value=1)
if close > open
    strategy.entry("L", strategy.long)
else
    strategy.close("L")
plot(strategy.position_size)`;

function bar(time: number, close = 9, open = 10): Bar {
  return {
    time,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 1,
  };
}

interface ReplayFixtureOptions {
  readonly liveChartBars: readonly Bar[];
  readonly securitySymbols?: readonly string[];
}

/** Real Replay paths only: no test-owned liveBars or closedBars implementation. */
function replayFixture(options: ReplayFixtureOptions): ReplayProvider {
  const warmup = [bar(0), bar(3_600)];
  const children = Array.from({ length: 12 }, (_, index) => bar(index * 600, 10 + index / 100));
  const series: Record<string, Bar[]> = {
    'X|1h': [...warmup, ...options.liveChartBars],
    'X|10m': children,
  };
  for (const symbol of options.securitySymbols ?? []) {
    series[`${symbol}|1h`] = [bar(0, 101, 100), bar(3_600, 102, 101)];
  }
  const source = new StaticProvider(series, {
    alignment: 'utc-24x7',
    timeframes: ['10m', '1h'],
    cacheIdentity: 'pinelive-public-intrabar-e2e',
  }).setInstrument('X', { minQty: 1, mintick: 0.01 });
  return new ReplayProvider(source, {
    cutoverTime: 7_200,
    instrument: { minOrderQty: 1 },
  });
}

function magnifiedComputeConfig() {
  return {
    configVersion: 3,
    strategy: 'public-replay.pine',
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 2,
    data: dataConfig,
    historical: {
      mode: 'bar-magnifier',
      maxMagnifierTargetBars: 12,
      maxMagnifierRawBars: 12,
    },
    live: { cadence: 'every-update', source: native },
    execution: { kind: 'compute-only' },
  } as const;
}

function securitySource(symbols: readonly string[]): string {
  const requests = symbols
    .map(
      (symbol, index) =>
        `security_${index} = request.security("${symbol}", "60", close)\nplot(security_${index})`,
    )
    .join('\n');
  return `//@version=6
strategy("public exact security", use_bar_magnifier=true, process_orders_on_close=true, default_qty_type=strategy.fixed, default_qty_value=1)
${requests}
if close > open
    strategy.entry("L", strategy.long)
else
    strategy.close("L")`;
}

interface SecurityBudgetOptions {
  readonly maxExactSecurityFeeds: number;
  readonly maxExactSecurityBarsPerFeed: number;
  readonly maxExactSecurityTotalBars: number;
}

function paperSecurityConfig(budgets: SecurityBudgetOptions) {
  return {
    configVersion: 3,
    strategy: 'public-exact-security.pine',
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 2,
    data: dataConfig,
    historical: {
      mode: 'bar-magnifier',
      maxMagnifierTargetBars: 12,
      maxMagnifierRawBars: 12,
    },
    security: {
      enabled: true,
      ...budgets,
      concurrency: 1,
      requestTimeoutMs: 30_000,
      maxStaleRefreshes: 0,
    },
    live: { cadence: 'bar-close' },
    execution: {
      kind: 'mirrored',
      mirrorOn: 'bar-close',
      broker: { id: 'paper', initialBalance: 10_000 },
      ledger: { path: '/unused/public-e2e.jsonl', durability: 'sync' },
      lease: { path: '/unused/public-e2e.lock' },
    },
  } as const;
}

function paperFactory(
  lease: InMemoryExecutionLease,
  ledger: MemoryLedger,
  calls: { value: number },
): IntrabarBrokerFactory {
  return ({ resolved }) => {
    calls.value++;
    expect(lease.snapshot).toBeDefined();
    expect(
      ledger.events.some((event) => event.recordType === 'lease' && event.action === 'acquired'),
    ).toBe(true);
    return new PaperBroker({
      instruments: {
        [resolved.venueSymbol]: {
          symbol: resolved.venueSymbol,
          dataSymbol: resolved.venueSymbol,
          brokerSymbol: resolved.venueSymbol,
          minQty: resolved.qtyStep,
          qtyStep: resolved.qtyStep,
          minOrderQty: resolved.minOrderQty,
          mintick: resolved.mintick,
          pointValue: resolved.pointValue,
          exchange: resolved.exchange,
          expiry: resolved.expiry,
        },
      },
      initialBalance: 10_000,
    });
  };
}

function decisionEvents(events: readonly LedgerEventV3[]) {
  return events.filter(
    (event): event is Extract<LedgerEventV3, { decisionId: string }> => 'decisionId' in event,
  );
}

test('public Replay preserves exact warmup, polling identity, cancellation, and final-cursor recovery', async () => {
  const final7_200 = bar(7_200, 11);
  const final10_800 = bar(10_800, 9);
  const prepared = prepareIntrabarRun(magnifiedComputeConfig(), magnifiedEveryUpdateSource);
  const ledger = new MemoryLedger();
  const controller = new AbortController();

  await expect(
    runIntrabarServer({
      prepared,
      dataFactory: () => replayFixture({ liveChartBars: [final7_200, final10_800] }),
      ledger,
      signal: controller.signal,
      onEvaluation: (evaluation) => {
        if (evaluation.update.barTime === 7_200) controller.abort();
      },
    }),
  ).rejects.toThrow('cancelled');

  const interruptedPrefix = structuredClone(ledger.events);
  const interrupted = recoverLedger(interruptedPrefix);
  expect(interrupted.activeBars.size).toBe(0);
  expect(interrupted.lastFinalCursor).toBe(7_200);
  const firstAuthority = interrupted.authority!.authority;
  expect(firstAuthority.prepared.historical).toMatchObject({
    mode: 'bar-magnifier',
    acquisition: { targetBarCount: 12, rawBarCount: 12 },
  });
  expect(firstAuthority.prepared.budgets.magnifier).toEqual({
    configured: { maxTargetBars: 12, maxRawBars: 12 },
    effective: { maxTargetBars: 12, maxRawBars: 12 },
    observed: { targetBars: 12, rawBars: 12 },
  });

  const second = await runIntrabarServer({
    prepared,
    dataFactory: () => replayFixture({ liveChartBars: [final7_200, final10_800] }),
    ledger,
    recoveredEvents: interruptedPrefix,
  });

  expect(second).toMatchObject({
    mode: 'compute-only',
    evaluations: 1,
    lastFinalCursor: 10_800,
  });
  expect(second.authority).toEqual(firstAuthority);
  const evaluations = ledger.events.filter(
    (event): event is Extract<LedgerEventV3, { recordType: 'evaluation.skipped' }> =>
      event.recordType === 'evaluation.skipped',
  );
  expect(
    evaluations.map((event) => [
      event.barTime,
      event.update.revision,
      event.update.authoritativeFinal,
      event.reason,
    ]),
  ).toEqual([
    [7_200, 1, true, 'compute-only'],
    [10_800, 1, true, 'compute-only'],
  ]);
  expect(new Set(evaluations.map((event) => event.decisionId)).size).toBe(2);
  expect(evaluations.every((event) => event.update.eventId === event.decisionId)).toBe(true);
  expect(
    evaluations.every((event) => ![600, 1_200, 1_800, 2_400, 3_000].includes(event.barTime)),
  ).toBe(true);
  const recovered = recoverLedger(ledger.events);
  expect(recovered.lastFinalCursor).toBe(10_800);
  expect(recovered.activeBars.size).toBe(0);
});

test('public close-only magnified exact-security run lazily effects one Paper correction', async () => {
  const source = securitySource(['AAPL']);
  const prepared = prepareIntrabarRun(
    paperSecurityConfig({
      maxExactSecurityFeeds: 1,
      maxExactSecurityBarsPerFeed: 2,
      maxExactSecurityTotalBars: 2,
    }),
    source,
  );
  const ledger = new MemoryLedger();
  const lease = new InMemoryExecutionLease('/unused/public-e2e.jsonl', {
    ownerId: 'public-e2e-owner',
    leaseId: 'public-e2e-lease',
  });
  const factoryCalls = { value: 0 };

  const result = await runIntrabarServer({
    prepared,
    dataFactory: () =>
      replayFixture({ liveChartBars: [bar(7_200, 11)], securitySymbols: ['AAPL'] }),
    ledger,
    lease,
    brokerFactory: paperFactory(lease, ledger, factoryCalls),
  });

  expect(factoryCalls.value).toBe(1);
  expect(result).toMatchObject({
    mode: 'mirrored',
    executionSafe: true,
    evaluations: 1,
    lastFinalCursor: 7_200,
    finalPosition: { symbol: 'X', qty: 1 },
  });
  expect(result.authority.prepared.historical).toMatchObject({
    mode: 'bar-magnifier',
    acquisition: { targetBarCount: 12, rawBarCount: 12 },
  });
  expect(result.authority.prepared.budgets.security).toEqual({
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
  const security = result.authority.prepared.security;
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

  const decisions = decisionEvents(ledger.events);
  expect(new Set(decisions.map((event) => event.decisionId)).size).toBe(1);
  expect(decisions.every((event) => event.barTime === 7_200)).toBe(true);
  expect(decisions.every((event) => event.update.kind === 'close-only')).toBe(true);
  expect(decisions.every((event) => event.update.authoritativeFinal)).toBe(true);
  expect(decisions.every((event) => event.update.eventId === event.decisionId)).toBe(true);
  expect(ledger.events.filter((event) => event.recordType === 'evaluation.accepted')).toHaveLength(
    1,
  );
  expect(ledger.events.filter((event) => event.recordType === 'evaluation.completed')).toHaveLength(
    1,
  );
  const intents = ledger.events.filter(
    (event): event is Extract<LedgerEventV3, { recordType: 'order.intent' }> =>
      event.recordType === 'order.intent',
  );
  const results = ledger.events.filter(
    (event): event is Extract<LedgerEventV3, { recordType: 'order.result' }> =>
      event.recordType === 'order.result',
  );
  const completions = ledger.events.filter(
    (event): event is Extract<LedgerEventV3, { recordType: 'order.completion' }> =>
      event.recordType === 'order.completion',
  );
  expect(intents).toHaveLength(1);
  expect(results).toHaveLength(1);
  expect(completions).toHaveLength(1);
  expect(intents[0]!.correctionSeq).toBe(1);
  expect(results[0]).toMatchObject({
    correctionSeq: 1,
    logicalOrderId: intents[0]!.logicalOrderId,
    outcome: 'filled',
  });
  expect(completions[0]).toMatchObject({
    correctionSeq: 1,
    logicalOrderId: intents[0]!.logicalOrderId,
    outcome: 'filled',
  });
});

test('close-only exact-security feed, per-feed, and total budgets fail before Paper factory', async () => {
  const cases = [
    {
      label: 'feed',
      symbols: ['AAPL', 'MSFT'],
      budgets: {
        maxExactSecurityFeeds: 1,
        maxExactSecurityBarsPerFeed: 2,
        maxExactSecurityTotalBars: 4,
      },
      message: 'exact security feed budget was exceeded',
    },
    {
      label: 'per-feed',
      symbols: ['AAPL'],
      budgets: {
        maxExactSecurityFeeds: 1,
        maxExactSecurityBarsPerFeed: 1,
        maxExactSecurityTotalBars: 2,
      },
      message: 'exact security per-feed bar budget was exceeded for AAPL',
    },
    {
      label: 'total',
      symbols: ['AAPL', 'MSFT'],
      budgets: {
        maxExactSecurityFeeds: 2,
        maxExactSecurityBarsPerFeed: 2,
        maxExactSecurityTotalBars: 3,
      },
      message: 'exact security total bar budget was exceeded',
    },
  ] as const;

  for (const fixture of cases) {
    const prepared = prepareIntrabarRun(
      paperSecurityConfig(fixture.budgets),
      securitySource(fixture.symbols),
    );
    const ledger = new MemoryLedger();
    const lease = new InMemoryExecutionLease(`/unused/${fixture.label}.jsonl`);
    let brokerFactoryCalls = 0;
    await expect(
      runIntrabarServer({
        prepared,
        dataFactory: () =>
          replayFixture({
            liveChartBars: [bar(7_200, 11)],
            securitySymbols: fixture.symbols,
          }),
        ledger,
        lease,
        brokerFactory: () => {
          brokerFactoryCalls++;
          throw new Error('Paper factory must remain untouched');
        },
      }),
    ).rejects.toThrow(fixture.message);
    expect(brokerFactoryCalls).toBe(0);
    expect(lease.snapshot).toBeUndefined();
    expect(ledger.events).toEqual([]);
  }
});

test('public preparation rejects every-update security before provider transport construction', () => {
  let transportCalls = 0;
  const poison = () => {
    transportCalls++;
    throw new Error('provider transport must remain untouched');
  };
  const config = {
    ...magnifiedComputeConfig(),
    symbol: 'TG:FU:X',
    data: {
      provider: 'tiger',
      assetClass: 'futures',
      transport: { resolveFuture: poison, bars: poison, connect: poison, disconnect: poison },
    },
    security: {
      enabled: true,
      maxExactSecurityFeeds: 1,
      maxExactSecurityBarsPerFeed: 2,
      maxExactSecurityTotalBars: 2,
      concurrency: 1,
      requestTimeoutMs: 30_000,
      maxStaleRefreshes: 0,
    },
  } as const;

  expect(() => prepareIntrabarRun(config, securitySource(['AAPL']))).toThrow(
    'config.security.enabled must be false for every-update',
  );
  expect(transportCalls).toBe(0);
});
