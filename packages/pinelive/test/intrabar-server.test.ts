import { expect, test } from 'bun:test';
import {
  ReplayProvider,
  StaticProvider,
  type Bar,
  type BarUpdate,
  type MarketDataProvider,
  type ResolvedDataInstrument,
} from '@heyphat/pinery';
import { PaperBroker, type MarkableBroker } from '../src/brokers/paper.js';
import type { Broker, Capabilities, ExactOrderLookupResult } from '../src/core/broker.js';
import type { RunInstrumentBinding } from '../src/core/binding.js';
import { InMemoryExecutionLease, type ExecutionLease } from '../src/core/lease.js';
import {
  MemoryLedger,
  SequencedLedger,
  type LedgerEventV3,
  type LedgerRecord,
  type LedgerSink,
} from '../src/core/ledger.js';
import { recoverLedger } from '../src/core/recovery.js';
import {
  ComputeDecisionJournal,
  prepareIntrabarRun,
  runIntrabarServer,
  type IntrabarBrokerFactory,
} from '../src/core/intrabar-server.js';
import type { Account, Fill, Instrument, OrderRequest, Position } from '../src/core/types.js';

const native = Object.freeze({ kind: 'native' as const });
const strategy = `//@version=6
strategy("server", calc_on_every_tick=true, process_orders_on_close=true, default_qty_type=strategy.fixed, default_qty_value=1)
if close > open
    strategy.entry("L", strategy.long)
else
    strategy.close("L")
plot(strategy.position_size)`;
const dataConfig = {
  provider: 'csv',
  dataDir: '/path/must/not/be-read',
  cutoverTime: 1,
} as const;

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

function update(value: Bar, revision: number, isClose: boolean): BarUpdate {
  return {
    bar: value,
    revision,
    isClose,
    eventTime: value.time * 1_000 + revision,
    source: native,
  };
}

function computeConfig() {
  return {
    configVersion: 2,
    strategy: 'server.pine',
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 2,
    data: dataConfig,
    live: { cadence: 'every-update', source: native },
    execution: { kind: 'compute-only' },
  } as const;
}

function mirroredConfig(everyUpdate = false) {
  return {
    configVersion: 2,
    strategy: 'server.pine',
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 2,
    data: dataConfig,
    ...(everyUpdate ? { live: { cadence: 'every-update' as const, source: native } } : {}),
    execution: {
      kind: 'mirrored',
      mirrorOn: 'bar-close',
      broker: { id: 'paper', initialBalance: 10_000 },
      ...(everyUpdate ? { intrabarExecutionArmed: true as const } : {}),
      ledger: { path: '/unused/ledger.jsonl', durability: 'sync' },
      lease: { path: '/unused/run.lease' },
    },
  } as const;
}

class TrackingLedger implements LedgerSink {
  readonly events: LedgerEventV3[] = [];

  constructor(
    private readonly trace: string[] = [],
    private readonly closeError?: Error,
  ) {}

  async append(record: LedgerRecord): Promise<void> {
    this.trace.push(`ledger:${record.recordType ?? 'cycle'}`);
    if (record.schemaVersion === 3) this.events.push(structuredClone(record));
  }

  async flush(): Promise<void> {
    this.trace.push('ledger:flush');
  }

  async close(): Promise<void> {
    this.trace.push('ledger:close');
    if (this.closeError) throw this.closeError;
  }
}

class TrackingLease implements ExecutionLease {
  private readonly inner: InMemoryExecutionLease;

  constructor(
    readonly resource: string,
    private readonly trace: string[] = [],
    private readonly releaseError?: Error,
  ) {
    this.inner = new InMemoryExecutionLease(resource, {
      ownerId: `owner:${resource}`,
      leaseId: `lease:${resource}`,
    });
  }

  get ownerId(): string {
    return this.inner.ownerId;
  }

  get snapshot() {
    return this.inner.snapshot;
  }

  async acquire() {
    this.trace.push('lease:acquire');
    return this.inner.acquire();
  }

  assertHeld(): void {
    this.trace.push('lease:assert');
    this.inner.assertHeld();
  }

  async release(): Promise<void> {
    this.trace.push('lease:release');
    await this.inner.release();
    if (this.releaseError) throw this.releaseError;
  }
}

function provider(
  updates: readonly BarUpdate[] = [],
  options: {
    id?: string;
    trace?: string[];
    disconnectError?: Error;
  } = {},
): MarketDataProvider {
  const history = [bar(0), bar(60)];
  const source = new StaticProvider(
    { 'X|1m': history },
    {
      alignment: 'utc-24x7',
      timeframes: ['1m'],
      cacheIdentity: 'intrabar-server-v1',
    },
  ).setInstrument('X', { minQty: 1, mintick: 0.01 });
  const replay = new ReplayProvider(source, {
    cutoverTime: 120,
    instrument: { minOrderQty: 1 },
  });
  return {
    id: options.id ?? 'intrabar-server-provider',
    history: replay.history.bind(replay),
    resolve: replay.resolve.bind(replay),
    historyResolved: replay.historyResolved.bind(replay),
    async *closedBars() {},
    async *liveBars() {
      options.trace?.push('provider:subscribe');
      for (const item of updates) yield item;
    },
    async disconnect() {
      options.trace?.push('provider:disconnect');
      if (options.disconnectError) throw options.disconnectError;
    },
  };
}

class TracedPaperBroker implements Broker, MarkableBroker {
  readonly id = 'paper';
  private readonly paper: PaperBroker;

  constructor(
    resolved: ResolvedDataInstrument,
    private readonly trace: string[] = [],
    private readonly disconnectError?: Error,
  ) {
    this.paper = new PaperBroker({
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
  }

  async connect(): Promise<void> {
    this.trace.push('broker:connect');
  }

  async disconnect(): Promise<void> {
    this.trace.push('broker:disconnect');
    if (this.disconnectError) throw this.disconnectError;
  }

  capabilities(): Capabilities {
    return this.paper.capabilities();
  }

  instrument(symbol: string): Promise<Instrument> {
    this.trace.push('broker:instrument');
    return this.paper.instrument(symbol);
  }

  getPosition(symbol: string): Promise<Position> {
    this.trace.push('broker:position');
    return this.paper.getPosition(symbol);
  }

  getAccount(): Promise<Account> {
    this.trace.push('broker:account');
    return this.paper.getAccount();
  }

  submit(order: OrderRequest): Promise<Fill> {
    this.trace.push('broker:submit');
    return this.paper.submit(order);
  }

  lookupOrder(order: Readonly<OrderRequest>): Promise<ExactOrderLookupResult> {
    return this.paper.lookupOrder(order);
  }

  flatten(symbol: string): Promise<void> {
    this.trace.push('broker:flatten');
    return this.paper.flatten(symbol);
  }

  mark(symbol: string, price: number, time?: number): void {
    this.trace.push(`broker:mark:${String(time)}`);
    this.paper.mark(symbol, price, time);
  }
}

function paperFactory(trace: string[], disconnectError?: Error): IntrabarBrokerFactory {
  return ({ resolved }) => {
    trace.push('broker:factory');
    return new TracedPaperBroker(resolved, trace, disconnectError);
  };
}

test('pure prepare rejects before data factories and compute-only never owns broker fields', async () => {
  let dataCalls = 0;
  let brokerCalls = 0;
  const dataFactory = () => {
    dataCalls++;
    return provider();
  };
  const brokerFactory = () => {
    brokerCalls++;
    throw new Error('broker factory must remain untouched');
  };

  expect(() =>
    prepareIntrabarRun(computeConfig(), '//@version=6\nindicator("not a strategy")\nplot(close)'),
  ).toThrow('strategy');
  expect(() =>
    prepareIntrabarRun(
      {
        ...mirroredConfig(true),
        execution: {
          ...mirroredConfig(true).execution,
          mirrorOn: 'every-update' as const,
        },
      },
      strategy,
    ),
  ).toThrow('public piner runtime does not expose a provable pending-order/fill lifecycle');
  expect(dataCalls).toBe(0);

  const prepared = prepareIntrabarRun(computeConfig(), strategy);
  await expect(
    runIntrabarServer({
      prepared,
      dataFactory,
      ledger: new TrackingLedger(),
      brokerFactory,
    } as never),
  ).rejects.toThrow('compute-only intrabar options cannot contain brokerFactory');
  expect(dataCalls).toBe(0);
  expect(brokerCalls).toBe(0);

  const result = await runIntrabarServer({
    prepared,
    dataFactory,
    ledger: new TrackingLedger(),
  });
  expect(result.mode).toBe('compute-only');
  expect(result.evaluations).toBe(0);
  expect('finalPosition' in result).toBe(false);
  expect('finalAccount' in result).toBe(false);
  expect(brokerCalls).toBe(0);
});

test('authority is deterministic and a recovered mismatch fails before lease or broker factory', async () => {
  const prepared = prepareIntrabarRun(mirroredConfig(), strategy);
  const firstLedger = new TrackingLedger();
  const first = await runIntrabarServer({
    prepared,
    dataFactory: () => provider(),
    ledger: firstLedger,
    lease: new TrackingLease('authority-first'),
    brokerFactory: paperFactory([]),
  });
  const second = await runIntrabarServer({
    prepared,
    dataFactory: () => provider(),
    ledger: new TrackingLedger(),
    lease: new TrackingLease('authority-second'),
    brokerFactory: paperFactory([]),
  });
  expect(second.authority).toEqual(first.authority);
  expect(second.authority.identity).toBe(first.authority.identity);
  expect(Object.isFrozen(first.authority.prepared.budgets)).toBe(true);
  expect(
    firstLedger.events.map((event) =>
      event.recordType === 'lease' ? `${event.recordType}:${event.action}` : event.recordType,
    ),
  ).toEqual(['authority', 'lease:acquired', 'recovery', 'binding', 'lease:released']);

  const trace: string[] = [];
  let factoryCalls = 0;
  await expect(
    runIntrabarServer({
      prepared,
      dataFactory: () => provider([], { id: 'different-provider' }),
      ledger: new TrackingLedger(trace),
      recoveredEvents: firstLedger.events,
      lease: new TrackingLease('authority-mismatch', trace),
      brokerFactory: () => {
        factoryCalls++;
        throw new Error('must not construct a broker');
      },
    }),
  ).rejects.toThrow('prepared authority mismatch');
  expect(factoryCalls).toBe(0);
  expect(trace).not.toContain('lease:acquire');
});

test('active-bar recovery seeds discontinuity and only authoritative finals advance the cursor', async () => {
  const prepared = prepareIntrabarRun(computeConfig(), strategy);
  const ledger = new TrackingLedger();
  const first = await runIntrabarServer({
    prepared,
    dataFactory: () => provider([update(bar(120, 10.5), 1, false)]),
    ledger,
  });
  expect(first.latestDecision).toMatchObject({
    barTime: 120,
    authoritativeFinal: false,
  });
  const recoveredFirst = recoverLedger(ledger.events);
  expect(recoveredFirst.activeBars.size).toBe(1);
  expect(recoveredFirst.lastFinalCursor).toBeUndefined();

  const reasons: Array<[number, string]> = [];
  const prefix = structuredClone(ledger.events);
  const second = await runIntrabarServer({
    prepared,
    dataFactory: () => provider([update(bar(120, 11), 2, true), update(bar(180, 9), 1, true)]),
    ledger,
    recoveredEvents: prefix,
    onEvaluation: (evaluation) => reasons.push([evaluation.update.barTime, evaluation.reason]),
  });

  expect(reasons).toEqual([
    [120, 'startup-discontinuity'],
    [180, 'eligible'],
  ]);
  expect(second.lastFinalCursor).toBe(180);
  expect(recoverLedger(ledger.events).lastFinalCursor).toBe(180);
});

test('mirrored active-bar restart journals discontinuity before the next final effect', async () => {
  const prepared = prepareIntrabarRun(mirroredConfig(true), strategy);
  const ledger = new TrackingLedger();
  await runIntrabarServer({
    prepared,
    dataFactory: () => provider([update(bar(120, 10.5), 1, false)]),
    ledger,
    lease: new TrackingLease('mirrored-active-bar'),
    brokerFactory: paperFactory([]),
  });
  expect(recoverLedger(ledger.events).activeBars.size).toBe(1);

  const prefix = structuredClone(ledger.events);
  const reasons: Array<[number, string]> = [];
  const trace: string[] = [];
  const second = await runIntrabarServer({
    prepared,
    dataFactory: () => provider([update(bar(120, 11), 2, true), update(bar(180, 11), 1, true)]),
    ledger,
    recoveredEvents: prefix,
    lease: new TrackingLease('mirrored-active-bar'),
    brokerFactory: paperFactory(trace),
    onEvaluation: (evaluation) => reasons.push([evaluation.update.barTime, evaluation.reason]),
  });

  expect(reasons).toEqual([
    [120, 'startup-discontinuity'],
    [180, 'eligible'],
  ]);
  expect(trace.filter((item) => item.startsWith('broker:mark:'))).toEqual(['broker:mark:180']);
  expect(second).toMatchObject({
    mode: 'mirrored',
    executionSafe: true,
    lastFinalCursor: 180,
  });
  expect(recoverLedger(ledger.events).lastFinalCursor).toBe(180);
});

test('mirrored Paper acquires and records the lease before its lazy factory and effects finals only', async () => {
  const trace: string[] = [];
  const ledger = new TrackingLedger(trace);
  const lease = new TrackingLease('paper-final-only', trace);
  const prepared = prepareIntrabarRun(mirroredConfig(true), strategy);
  const evaluations: boolean[] = [];

  const result = await runIntrabarServer({
    prepared,
    dataFactory: () =>
      provider([update(bar(120, 10.5), 1, false), update(bar(120, 11), 2, true)], { trace }),
    ledger,
    lease,
    brokerFactory: ({ resolved }) => {
      expect(lease.snapshot).toBeDefined();
      expect(ledger.events.some((event) => event.recordType === 'lease')).toBe(true);
      trace.push('broker:factory');
      return new TracedPaperBroker(resolved, trace);
    },
    onEvaluation: (evaluation) => evaluations.push(evaluation.finalCommit),
  });

  expect(trace.indexOf('lease:acquire')).toBeLessThan(trace.indexOf('broker:factory'));
  expect(trace.indexOf('ledger:lease')).toBeLessThan(trace.indexOf('broker:factory'));
  expect(evaluations).toEqual([false, true]);
  expect(trace.filter((item) => item.startsWith('broker:mark:'))).toEqual(['broker:mark:120']);
  expect(ledger.events.filter((event) => event.recordType === 'evaluation.skipped')).toHaveLength(
    1,
  );
  expect(ledger.events.filter((event) => event.recordType === 'evaluation.accepted')).toHaveLength(
    1,
  );
  expect(trace).not.toContain('broker:flatten');
  expect(result).toMatchObject({ mode: 'mirrored', executionSafe: true });
  if (result.executionSafe) {
    expect(result.finalPosition.symbol).toBe('X');
    expect(result.finalAccount.id.length).toBeGreaterThan(0);
  }
  expect(trace).toContain('lease:release');
  expect(trace).toContain('broker:disconnect');
  expect(trace).toContain('provider:disconnect');
  expect(trace).toContain('ledger:close');
});

test('cleanup attempts lease, broker, provider, and ledger teardown after independent failures', async () => {
  const trace: string[] = [];
  const ledger = new TrackingLedger(trace, new Error('ledger close failed'));
  const lease = new TrackingLease('cleanup-failures', trace, new Error('lease release failed'));
  const prepared = prepareIntrabarRun(mirroredConfig(), strategy);

  await expect(
    runIntrabarServer({
      prepared,
      dataFactory: () =>
        provider([], {
          trace,
          disconnectError: new Error('provider disconnect failed'),
        }),
      ledger,
      lease,
      brokerFactory: paperFactory(trace, new Error('broker disconnect failed')),
      teardownTimeoutMs: 100,
    }),
  ).rejects.toThrow('intrabar server cleanup failed');

  expect(trace).toContain('lease:release');
  expect(trace).toContain('broker:disconnect');
  expect(trace).toContain('provider:disconnect');
  expect(trace).toContain('ledger:close');
  expect(trace).not.toContain('broker:flatten');
});

test('compute journal rebuilds and applies its retention horizon on restart', async () => {
  const binding: RunInstrumentBinding = {
    id: 'compute-retention-binding',
    fingerprint: 'compute-retention-binding',
    strategySymbol: 'ROOT',
    providerId: 'test-provider',
    providerHandle: 'test:X',
    executionSymbol: 'X',
    qtyStep: 1,
    minOrderQty: 1,
    mintick: 0.01,
    brokerId: 'compute-only',
  };
  const evaluation = (barTime: number, index: number) => ({
    target: 0,
    cursor: barTime,
    decisionId: `compute-decision-${index}`,
    update: {
      kind: 'intrabar' as const,
      eventId: `compute-final-${index}`,
      revision: 1,
      authoritativeFinal: true,
      recovered: false,
      discontinuity: false,
    },
    context: {
      strategySymbol: binding.strategySymbol,
      executionSymbol: binding.executionSymbol,
      bindingId: binding.id,
      strategyId: 'strategy',
      timeframe: '1m',
      barTime,
      sequence: index,
    },
  });

  const durable = new MemoryLedger();
  const firstWriter = new SequencedLedger(durable, {
    runId: 'compute-retention-run',
    executionId: 'compute-retention-execution',
  });
  const first = new ComputeDecisionJournal({
    writer: firstWriter,
    leaseRecorded: false,
    recovery: recoverLedger([]),
    binding,
    strategyId: 'strategy',
    retainBars: 1,
  });
  await first.initialize();
  for (let index = 1; index <= 5; index++)
    await first.journal(evaluation(index * 60, index), 'compute-only');
  expect(first.state).toEqual({
    retainedDecisions: 1,
    retainedBars: 1,
    prunedThroughBarTime: 240,
  });

  const recovery = recoverLedger(durable.events);
  expect(recovery.decisions.size).toBe(5); // Durable rows are never pruned.
  const restartedWriter = new SequencedLedger(new MemoryLedger(), {
    runId: recovery.runId!,
    executionId: recovery.executionId!,
    nextSequence: recovery.nextSequence,
    lastTimestamp: Date.parse(durable.events.at(-1)!.recordedAt),
  });
  const restarted = new ComputeDecisionJournal({
    writer: restartedWriter,
    leaseRecorded: false,
    recovery,
    binding,
    strategyId: 'strategy',
    retainBars: 1,
  });

  // Recovery rebuilds ownership before pruning instead of leaving all recovered IDs resident.
  expect(restarted.state).toEqual(first.state);
  await restarted.initialize();
  await restarted.journal(evaluation(300, 5), 'compute-only'); // retained duplicate is read-only
  await expect(restarted.journal(evaluation(60, 1), 'compute-only')).rejects.toThrow(
    'predates the retained dedupe horizon',
  );
});
