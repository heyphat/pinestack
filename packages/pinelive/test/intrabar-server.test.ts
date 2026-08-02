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
import {
  TigerBroker,
  type TigerOrderResult,
  type TigerTradingTransport,
} from '../src/brokers/tiger.js';
import type {
  AccountSynchronizationSession,
  Broker,
  Capabilities,
  ExactOrderLookupResult,
} from '../src/core/broker.js';
import type { RunInstrumentBinding } from '../src/core/binding.js';
import {
  InMemoryExecutionLease,
  type ExecutionLease,
  type ExecutionLeaseSnapshot,
} from '../src/core/lease.js';
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
  type IntrabarServerReadiness,
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
    configVersion: 3,
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
    configVersion: 3,
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

class AfterWriteFailureLedger extends TrackingLedger {
  private failure: Error | undefined;

  constructor(private readonly shouldFail: (record: LedgerRecord) => boolean) {
    super();
  }

  override async append(record: LedgerRecord): Promise<void> {
    if (this.failure) throw this.failure;
    await super.append(record);
    if (this.shouldFail(record)) {
      this.failure = new Error(`stable-storage acknowledgement failed after ${record.recordType}`);
      throw this.failure;
    }
  }

  override async flush(): Promise<void> {
    if (this.failure) throw this.failure;
    await super.flush();
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

class SnapshotClearingReleaseFailureLease implements ExecutionLease {
  private current?: ExecutionLeaseSnapshot;

  constructor(
    readonly resource: string,
    readonly ownerId: string,
  ) {}

  get snapshot(): ExecutionLeaseSnapshot | undefined {
    return this.current;
  }

  async acquire(): Promise<ExecutionLeaseSnapshot> {
    if (this.current) throw new Error('claim is already held');
    this.current = {
      resource: this.resource,
      ownerId: this.ownerId,
      leaseId: 'claim-release-failure-id',
      acquiredAt: new Date(0).toISOString(),
    };
    return this.current;
  }

  assertHeld(): void {
    if (!this.current) throw new Error('claim is not held');
  }

  async release(): Promise<void> {
    this.current = undefined;
    throw new Error('claim release failed after clearing its snapshot');
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
      cacheIdentity: 'intrabar-server-current',
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
  ).toEqual([
    'authority',
    'lease:acquired',
    'recovery',
    'binding',
    'execution-eligibility',
    'execution-eligibility',
    'lease:released',
  ]);

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
    bindingVersion: 2,
    id: `binding-v2-${'a'.repeat(64)}`,
    fingerprint: `binding-v2-${'a'.repeat(64)}`,
    authority: {
      algorithm: 'sha256',
      identity: `sha256-${'b'.repeat(64)}`,
      prepared: {},
    } as never,
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

function tigerMirroredConfig(armed: boolean) {
  return {
    ...mirroredConfig(),
    execution: {
      kind: 'mirrored',
      mirrorOn: 'bar-close',
      broker: { id: 'tiger' },
      armed,
      order: { type: 'market' },
      reconcileOnStart: false,
      ledger: { path: '/unused/tiger-ledger.jsonl', durability: 'sync' },
      lease: { path: '/unused/tiger-run.lease' },
    },
  } as const;
}

function tigerBarCloseProvider(values: readonly Bar[]): MarketDataProvider {
  const base = provider();
  return {
    ...base,
    async *closedBars() {
      for (const value of values) yield structuredClone(value);
    },
  };
}

class SynchronizedTigerTransport implements TigerTradingTransport {
  readonly accountId = 'demo';
  readonly accountEnvironment = 'test';
  qty = 0;
  submits = 0;
  synchronizationCalls = 0;
  synchronizationAssertions = 0;
  safetyAssertions = 0;
  synchronizationCloses = 0;
  failSynchronizationAfter?: number;
  unsafeAccountState = false;
  openOrders: AccountSynchronizationSession['snapshot']['openOrders'] = [];
  readonly orders = new Map<string, TigerOrderResult>();

  async account() {
    return { id: 'demo', currency: 'USD', balance: 10_000, equity: 10_000 };
  }
  async instrument(symbol: string) {
    return { symbol, mintick: 0.01, qtyStep: 1, minOrderQty: 1 };
  }
  async position(_accountId: string, symbol: string) {
    return { symbol, qty: this.qty };
  }
  async findOrderByClientId(_accountId: string, clientId: string) {
    return this.orders.get(clientId);
  }
  async lookupOrderExact() {
    return { status: 'not-found' as const };
  }
  async synchronizeAccount(_accountId: string, symbol: string) {
    this.synchronizationCalls++;
    const transport = this;
    return {
      snapshot: {
        synchronizationVersion: 1 as const,
        accountIdentity: {
          identityVersion: 1 as const,
          brokerId: 'tiger',
          opaqueAccountId: 'demo',
          environment: 'test',
        },
        account: { id: 'demo', currency: 'USD', balance: 10_000, equity: 10_000 },
        position: { symbol, qty: this.qty },
        openOrders: this.openOrders,
        inventoryComplete: true as const,
        exactOrderLookup: 'authoritative' as const,
        snapshotToken: 'snapshot-1',
        resumeFrom: 'sequence-1',
        observedAt: new Date(0).toISOString(),
      },
      assertSynchronized() {
        transport.synchronizationAssertions++;
        if (
          transport.failSynchronizationAfter != null &&
          transport.synchronizationAssertions > transport.failSynchronizationAfter
        ) {
          throw new Error('account stream continuity was lost');
        }
      },
      assertSafeToExecute() {
        transport.safetyAssertions++;
        if (transport.unsafeAccountState) {
          throw new Error('synchronized account state changed outside guarded execution');
        }
      },
      close() {
        transport.synchronizationCloses++;
      },
    };
  }
  async submitMarket(
    _accountId: string,
    request: { symbol: string; side: 'buy' | 'sell'; qty: number; clientId: string },
  ) {
    this.submits++;
    this.qty += request.side === 'buy' ? request.qty : -request.qty;
    const result: TigerOrderResult = {
      ...request,
      orderId: `order-${this.submits}`,
      requestedQty: request.qty,
      filledQty: request.qty,
      price: 10,
      commission: 0,
      time: 1,
      status: 'filled',
    };
    this.orders.set(request.clientId, result);
    return result;
  }
}

function tigerClaim(ownerId: string, resourceSuffix: string): InMemoryExecutionLease {
  return new InMemoryExecutionLease(`sha256-${resourceSuffix.padStart(64, '0')}`, {
    ownerId,
    leaseId: `claim-${resourceSuffix}`,
  });
}

test('armed Tiger stays broker-connected but blocked when complete synchronization is unsupported', async () => {
  const transport = new SynchronizedTigerTransport();
  transport.synchronizeAccount = undefined as never;
  const ledger = new TrackingLedger();
  const result = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
    dataFactory: () => provider(),
    ledger,
    lease: new TrackingLease('tiger-unsupported-sync'),
    brokerFactory: () => new TigerBroker({ transport, armed: true, requireExecutionSafety: true }),
    accountClaimFactory: ({ ownerId }) => tigerClaim(ownerId, '1'),
  });

  expect(result).toMatchObject({
    mode: 'mirrored',
    posture: 'live',
    executionEligibility: 'blocked',
    executionSafe: false,
  });
  expect(result.eligibilityReasons.join(' ')).toContain('complete open-order inventory');
  expect(transport.submits).toBe(0);
  expect(
    ledger.events.some(
      (event) => event.recordType === 'account-claim' && event.action === 'released',
    ),
  ).toBe(true);
});

test('armed Tiger blocks on synchronized working or uncertain orders', async () => {
  const transport = new SynchronizedTigerTransport();
  transport.openOrders = [
    {
      brokerOrderId: 'working-1',
      symbol: 'X',
      side: 'buy',
      type: 'market',
      requestedQty: 1,
      filledQty: 0,
      status: 'working',
      observedAt: new Date(0).toISOString(),
    },
  ];
  const result = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
    dataFactory: () => tigerBarCloseProvider([bar(120, 11)]),
    ledger: new TrackingLedger(),
    lease: new TrackingLease('tiger-open-order'),
    brokerFactory: () => new TigerBroker({ transport, armed: true, requireExecutionSafety: true }),
    accountClaimFactory: ({ ownerId }) => tigerClaim(ownerId, '5'),
  });

  expect(result).toMatchObject({
    mode: 'mirrored',
    executionEligibility: 'blocked',
    executionSafe: false,
  });
  expect(result.eligibilityReasons.join(' ')).toContain('working or uncertain order');
  expect(transport.submits).toBe(0);
});

test('armed Tiger blocks on a synchronized unexplained position', async () => {
  const transport = new SynchronizedTigerTransport();
  transport.qty = 2;
  const result = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
    dataFactory: () => tigerBarCloseProvider([bar(120, 11)]),
    ledger: new TrackingLedger(),
    lease: new TrackingLease('tiger-unexplained-position'),
    brokerFactory: () => new TigerBroker({ transport, armed: true, requireExecutionSafety: true }),
    accountClaimFactory: ({ ownerId }) => tigerClaim(ownerId, '6'),
  });

  expect(result).toMatchObject({
    mode: 'mirrored',
    executionEligibility: 'blocked',
    executionSafe: false,
  });
  expect(result.eligibilityReasons.join(' ')).toContain('non-zero unexplained position');
  expect(transport.submits).toBe(0);
});

test('armed Tiger executes only while ledger claim, account claim, and stream guard all hold', async () => {
  const transport = new SynchronizedTigerTransport();
  const ledger = new TrackingLedger();
  const result = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
    dataFactory: () => tigerBarCloseProvider([bar(120, 11)]),
    ledger,
    lease: new TrackingLease('tiger-synchronized'),
    brokerFactory: () => new TigerBroker({ transport, armed: true, requireExecutionSafety: true }),
    accountClaimFactory: ({ ownerId }) => tigerClaim(ownerId, '2'),
  });

  expect(result).toMatchObject({
    mode: 'mirrored',
    posture: 'live',
    executionEligibility: 'enabled',
    executionSafe: true,
  });
  expect(transport.submits).toBe(1);
  expect(transport.synchronizationAssertions).toBeGreaterThan(1);
  expect(transport.synchronizationCloses).toBe(1);
  const recovered = recoverLedger(ledger.events);
  expect(recovered.activeAccountClaim).toBeUndefined();
  expect(recovered.executionEligibility).toMatchObject({
    state: 'blocked',
    reasons: ['runtime stopped and execution capability was revoked'],
  });
});

test('after-write lease acquisition failure retains physical ownership for exact recovery', async () => {
  const ledger = new AfterWriteFailureLedger(
    (record) =>
      record.schemaVersion === 3 && record.recordType === 'lease' && record.action === 'acquired',
  );
  const lease = new TrackingLease('lease-acquisition-uncertain');

  try {
    await expect(
      runIntrabarServer({
        prepared: prepareIntrabarRun(mirroredConfig(), strategy),
        dataFactory: () => provider(),
        ledger,
        lease,
        brokerFactory: paperFactory([]),
      }),
    ).rejects.toThrow('intrabar server and cleanup failed');

    expect(lease.snapshot).toBeDefined();
    expect(recoverLedger(ledger.events).activeLease).toMatchObject({
      leaseId: lease.snapshot!.leaseId,
      ownerId: lease.snapshot!.ownerId,
    });
  } finally {
    if (lease.snapshot) await lease.release();
  }
});

test('after-write account-claim acquisition failure retains both physical ownership layers', async () => {
  const ledger = new AfterWriteFailureLedger(
    (record) => record.schemaVersion === 3 && record.recordType === 'account-claim',
  );
  const ledgerLease = new TrackingLease('claim-acquisition-uncertain');
  const accountClaim = tigerClaim(ledgerLease.ownerId, '7');
  const transport = new SynchronizedTigerTransport();

  try {
    await expect(
      runIntrabarServer({
        prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
        dataFactory: () => provider(),
        ledger,
        lease: ledgerLease,
        brokerFactory: () =>
          new TigerBroker({ transport, armed: true, requireExecutionSafety: true }),
        accountClaimFactory: () => accountClaim,
      }),
    ).rejects.toThrow('intrabar server and cleanup failed');

    expect(accountClaim.snapshot).toBeDefined();
    expect(ledgerLease.snapshot).toBeDefined();
    const recovery = recoverLedger(ledger.events);
    expect(recovery.activeLease?.ownerId).toBe(ledgerLease.ownerId);
    expect(recovery.activeAccountClaim).toMatchObject({
      claimId: accountClaim.snapshot!.leaseId,
      ownerId: ledgerLease.ownerId,
    });
    expect(transport.submits).toBe(0);
  } finally {
    if (accountClaim.snapshot) await accountClaim.release();
    if (ledgerLease.snapshot) await ledgerLease.release();
  }
});

test('account-claim release failure retains the ledger lease even after its snapshot clears', async () => {
  const transport = new SynchronizedTigerTransport();
  const ledger = new TrackingLedger();
  const ledgerLease = new TrackingLease('tiger-claim-release-failure');
  const accountClaim = new SnapshotClearingReleaseFailureLease(
    `sha256-${'f'.repeat(64)}`,
    ledgerLease.ownerId,
  );

  try {
    await expect(
      runIntrabarServer({
        prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
        dataFactory: () => provider(),
        ledger,
        lease: ledgerLease,
        brokerFactory: () =>
          new TigerBroker({ transport, armed: true, requireExecutionSafety: true }),
        accountClaimFactory: () => accountClaim,
      }),
    ).rejects.toThrow('intrabar server cleanup failed');

    expect(accountClaim.snapshot).toBeUndefined();
    expect(ledgerLease.snapshot).toBeDefined();
    expect(
      ledger.events.some(
        (event) =>
          event.recordType === 'lease' &&
          event.action === 'released' &&
          event.leaseId === ledgerLease.snapshot!.leaseId,
      ),
    ).toBe(false);
    expect(
      ledger.events.some(
        (event) =>
          event.recordType === 'account-claim' &&
          event.action === 'release-started' &&
          event.claimId === 'claim-release-failure-id',
      ),
    ).toBe(true);
    expect(
      ledger.events.some(
        (event) =>
          event.recordType === 'account-claim' &&
          event.action === 'released' &&
          event.claimId === 'claim-release-failure-id',
      ),
    ).toBe(false);
    const recovery = recoverLedger(ledger.events);
    expect(recovery.activeAccountClaim?.claimId).toBe('claim-release-failure-id');
    expect(recovery.accountClaimReleaseStarted?.claimId).toBe('claim-release-failure-id');
    expect(transport.submits).toBe(0);
  } finally {
    if (ledgerLease.snapshot) await ledgerLease.release();
  }
});

test('Tiger final result rechecks the complete execution interlock', async () => {
  const transport = new SynchronizedTigerTransport();
  transport.failSynchronizationAfter = 9;
  const result = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
    dataFactory: () => tigerBarCloseProvider([bar(120, 11)]),
    ledger: new TrackingLedger(),
    lease: new TrackingLease('tiger-final-interlock'),
    brokerFactory: () => new TigerBroker({ transport, armed: true, requireExecutionSafety: true }),
    accountClaimFactory: ({ ownerId }) => tigerClaim(ownerId, '9'),
  });

  expect(transport.submits).toBe(1);
  expect(result).toMatchObject({ mode: 'mirrored', executionSafe: false });
  expect(result.unsafeReason).toContain('final broker state is unavailable');
});

test('Tiger stream continuity loss latches before transmission', async () => {
  const transport = new SynchronizedTigerTransport();
  transport.failSynchronizationAfter = 1;
  const result = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
    dataFactory: () => tigerBarCloseProvider([bar(120, 11)]),
    ledger: new TrackingLedger(),
    lease: new TrackingLease('tiger-stream-loss'),
    brokerFactory: () => new TigerBroker({ transport, armed: true, requireExecutionSafety: true }),
    accountClaimFactory: ({ ownerId }) => tigerClaim(ownerId, '3'),
  });

  expect(result).toMatchObject({ mode: 'mirrored', executionSafe: false });
  expect(result.unsafeReason).toContain('execution breaker is latched');
  expect(transport.submits).toBe(0);
});

test('authoritative startup reconciliation resumes after terminal completion without retransmission', async () => {
  const firstTransport = new SynchronizedTigerTransport();
  firstTransport.submitMarket = async () => {
    firstTransport.submits++;
    throw new Error('transport timed out after transmission may have started');
  };
  const ledger = new TrackingLedger();
  const first = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
    dataFactory: () => tigerBarCloseProvider([bar(120, 11)]),
    ledger,
    lease: new TrackingLease('tiger-ambiguous-first'),
    brokerFactory: () =>
      new TigerBroker({
        transport: firstTransport,
        armed: true,
        requireExecutionSafety: true,
      }),
    accountClaimFactory: ({ ownerId }) => tigerClaim(ownerId, '7'),
  });
  expect(first).toMatchObject({ mode: 'mirrored', executionSafe: false });
  expect(firstTransport.submits).toBe(1);
  expect(recoverLedger(ledger.events).unresolvedIntents.size).toBe(1);

  const recoveryTransport = new SynchronizedTigerTransport();
  recoveryTransport.qty = 1;
  recoveryTransport.lookupOrderExact = async (_accountId, order) => ({
    status: 'filled',
    fill: {
      clientId: order.clientId,
      brokerOrderId: 'recovered-order-1',
      symbol: order.symbol,
      side: order.side,
      status: 'filled',
      requestedQty: order.qty,
      filledQty: order.qty,
      price: 10,
      commission: 0,
      time: 1,
    },
  });
  const reconciliationLeaseResource = 'tiger-ambiguous-reconcile';
  const reconciled = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
    dataFactory: () => provider(),
    ledger,
    recoveredEvents: structuredClone(ledger.events),
    lease: new TrackingLease(reconciliationLeaseResource),
    brokerFactory: () =>
      new TigerBroker({
        transport: recoveryTransport,
        armed: true,
        requireExecutionSafety: true,
      }),
    accountClaimFactory: ({ ownerId }) => tigerClaim(ownerId, '8'),
  });
  expect(reconciled).toMatchObject({ executionEligibility: 'enabled', executionSafe: true });
  expect(recoveryTransport.submits).toBe(0);

  const resetIndex = ledger.events.findIndex(
    (event) =>
      event.recordType === 'breaker' &&
      event.state === 'reset' &&
      event.reason === 'venue-reconciled',
  );
  expect(resetIndex).toBeGreaterThan(0);
  const interruptedEvents = structuredClone(ledger.events.slice(0, resetIndex));
  const interrupted = recoverLedger(interruptedEvents);
  expect(interrupted.unresolvedIntents.size).toBe(0);
  expect(interrupted.breaker.latched).toBe(true);
  expect(interrupted.activeLease).toBeDefined();
  expect(interrupted.activeAccountClaim).toBeDefined();

  const resumedLedger = new TrackingLedger();
  resumedLedger.events.push(...structuredClone(interruptedEvents));
  const recoveryTimestamp = Date.parse(interruptedEvents.at(-1)!.recordedAt);
  const recoveryWriter = new SequencedLedger(resumedLedger, {
    runId: interrupted.runId!,
    executionId: interrupted.executionId!,
    nextSequence: interrupted.nextSequence,
    lastTimestamp: recoveryTimestamp,
    // Keep simulated recovery rows at the existing wall-clock instant. Sequence
    // numbers provide ordering without pushing the immediate restart into the future.
    now: () => recoveryTimestamp,
  });
  await recoveryWriter.append({
    recordType: 'account-claim',
    action: 'lost',
    resourceDigest: interrupted.activeAccountClaim!.resourceDigest,
    claimId: interrupted.activeAccountClaim!.claimId,
    ownerId: interrupted.activeAccountClaim!.ownerId,
    detail: 'simulated explicit stale-owner recovery after process interruption',
  });
  await recoveryWriter.append({
    recordType: 'lease',
    action: 'lost',
    resource: interrupted.activeLease!.resource,
    leaseId: interrupted.activeLease!.leaseId,
    ownerId: interrupted.activeLease!.ownerId,
    detail: 'simulated explicit stale-owner recovery after process interruption',
  });
  await recoveryWriter.flush();
  const restartEvents = structuredClone(resumedLedger.events);

  const mismatchedLedger = new TrackingLedger();
  mismatchedLedger.events.push(...structuredClone(restartEvents));
  const mismatchedTransport = new SynchronizedTigerTransport();
  mismatchedTransport.qty = 2;
  const mismatched = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
    dataFactory: () => provider(),
    ledger: mismatchedLedger,
    recoveredEvents: restartEvents,
    lease: new TrackingLease('tiger-ambiguous-mismatch'),
    brokerFactory: () =>
      new TigerBroker({
        transport: mismatchedTransport,
        armed: true,
        requireExecutionSafety: true,
      }),
    accountClaimFactory: ({ ownerId }) => tigerClaim(ownerId, 'a'),
  });
  expect(mismatched).toMatchObject({ executionEligibility: 'blocked', executionSafe: false });
  expect(mismatched.eligibilityReasons.join(' ')).toContain(
    'position does not match the durable terminal reconciliation',
  );
  expect(mismatchedTransport.submits).toBe(0);

  const resumedTransport = new SynchronizedTigerTransport();
  resumedTransport.qty = 1;
  const resumed = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
    dataFactory: () => provider(),
    ledger: resumedLedger,
    recoveredEvents: restartEvents,
    lease: new TrackingLease('tiger-ambiguous-resume'),
    brokerFactory: () =>
      new TigerBroker({
        transport: resumedTransport,
        armed: true,
        requireExecutionSafety: true,
      }),
    accountClaimFactory: ({ ownerId }) => tigerClaim(ownerId, '9'),
  });

  expect(resumed).toMatchObject({
    mode: 'mirrored',
    executionEligibility: 'enabled',
    executionSafe: true,
    finalPosition: { qty: 1 },
  });
  expect(resumedTransport.submits).toBe(0);
  const recovered = recoverLedger(resumedLedger.events);
  expect(recovered.unresolvedIntents.size).toBe(0);
  expect(recovered.breaker.latched).toBe(false);
  expect(
    resumedLedger.events.some(
      (event) =>
        event.recordType === 'breaker' &&
        event.state === 'reset' &&
        event.reason === 'venue-reconciled',
    ),
  ).toBe(true);
});

test('unarmed Tiger monitor connects and journals without claims, synchronization, or effects', async () => {
  const transport = new SynchronizedTigerTransport();
  let claimCalls = 0;
  const ledger = new TrackingLedger();
  const result = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(false), strategy),
    dataFactory: () => tigerBarCloseProvider([bar(120, 11)]),
    ledger,
    lease: new TrackingLease('tiger-monitor'),
    brokerFactory: () => new TigerBroker({ transport, armed: false, requireExecutionSafety: true }),
    accountClaimFactory: ({ ownerId }) => {
      claimCalls++;
      return tigerClaim(ownerId, '4');
    },
  });

  expect(result).toMatchObject({
    mode: 'mirrored',
    posture: 'monitor',
    executionEligibility: 'disabled-by-posture',
    executionSafe: false,
  });
  expect(claimCalls).toBe(0);
  expect(transport.synchronizationCalls).toBe(0);
  expect(transport.submits).toBe(0);
  expect(
    ledger.events.some(
      (event) =>
        event.recordType === 'evaluation.skipped' && event.reason === 'execution-ineligible',
    ),
  ).toBe(true);
});

test('post-bootstrap unsafe account state latches before another Tiger mutation', async () => {
  const transport = new SynchronizedTigerTransport();
  const data = tigerBarCloseProvider([]);
  const result = await runIntrabarServer({
    prepared: prepareIntrabarRun(tigerMirroredConfig(true), strategy),
    dataFactory: () => ({
      ...data,
      async *closedBars() {
        transport.unsafeAccountState = true;
        yield bar(120, 11);
      },
    }),
    ledger: new TrackingLedger(),
    lease: new TrackingLease('tiger-post-bootstrap-account-change'),
    brokerFactory: () => new TigerBroker({ transport, armed: true, requireExecutionSafety: true }),
    accountClaimFactory: ({ ownerId }) => tigerClaim(ownerId, 'b'),
  });

  expect(result).toMatchObject({ mode: 'mirrored', executionSafe: false });
  expect(result.unsafeReason).toContain('execution breaker is latched');
  expect(transport.safetyAssertions).toBeGreaterThan(1);
  expect(transport.submits).toBe(0);
});

test('advisory lifecycle callbacks observe durable readiness before subscription and stopping before cleanup', async () => {
  const trace: string[] = [];
  const ledger = new TrackingLedger(trace);
  let readiness: IntrabarServerReadiness | undefined;
  let stoppingCalls = 0;

  await runIntrabarServer({
    prepared: prepareIntrabarRun(computeConfig(), strategy),
    dataFactory: () => provider([], { trace }),
    ledger,
    onReady: (value) => {
      readiness = value;
      trace.push('lifecycle:ready');
    },
    onStopping: () => {
      stoppingCalls++;
      trace.push('lifecycle:stopping');
    },
  });

  expect(readiness).toMatchObject({
    runId: expect.any(String),
    executionId: expect.any(String),
    posture: 'compute-only',
    executionEligibility: 'disabled-by-posture',
  });
  expect(readiness!.ledgerSequence).toBeGreaterThan(0);
  expect(trace.indexOf('ledger:execution-eligibility')).toBeLessThan(
    trace.indexOf('lifecycle:ready'),
  );
  expect(trace.indexOf('lifecycle:ready')).toBeLessThan(trace.indexOf('provider:subscribe'));
  expect(trace.indexOf('lifecycle:stopping')).toBeLessThan(trace.indexOf('provider:disconnect'));
  expect(stoppingCalls).toBe(1);
});

test('advisory lifecycle callback failures are logged and isolated from runtime cleanup', async () => {
  const trace: string[] = [];
  const logs: string[] = [];
  const result = await runIntrabarServer({
    prepared: prepareIntrabarRun(computeConfig(), strategy),
    dataFactory: () => provider([], { trace }),
    ledger: new TrackingLedger(trace),
    onReady: () => {
      throw new Error('ready observer failed');
    },
    onStopping: () => {
      throw new Error('stopping observer failed');
    },
    onLog: (message) => logs.push(message),
  });

  expect(result.mode).toBe('compute-only');
  expect(logs).toContain('lifecycle readiness callback failed: ready observer failed');
  expect(logs).toContain('lifecycle stopping callback failed: stopping observer failed');
  expect(trace).toContain('provider:disconnect');
  expect(trace).toContain('ledger:close');
});

test('nonsettling advisory lifecycle callbacks never gate runtime completion or cleanup', async () => {
  const trace: string[] = [];
  const never = new Promise<void>(() => undefined);
  let readinessCalls = 0;
  let stoppingCalls = 0;
  let terminalCalls = 0;
  const run = runIntrabarServer({
    prepared: prepareIntrabarRun(mirroredConfig(), strategy),
    dataFactory: () => provider([], { trace }),
    ledger: new TrackingLedger(trace),
    lease: new TrackingLease('nonsettling-lifecycle', trace),
    brokerFactory: paperFactory(trace),
    onReady: () => {
      readinessCalls++;
      return never;
    },
    onStopping: () => {
      stoppingCalls++;
      return never;
    },
    onTerminal: () => {
      terminalCalls++;
      trace.push('lifecycle:terminal');
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      run,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('nonsettling lifecycle callback gated runtime cleanup')),
          250,
        );
      }),
    ]);
    expect(result.mode).toBe('mirrored');
  } finally {
    if (timer) clearTimeout(timer);
  }

  expect(readinessCalls).toBe(1);
  expect(stoppingCalls).toBe(1);
  expect(terminalCalls).toBe(1);
  expect(trace).toContain('lease:release');
  expect(trace).toContain('provider:disconnect');
  expect(trace).toContain('ledger:close');
  expect(trace.indexOf('lifecycle:terminal')).toBeLessThan(trace.indexOf('provider:disconnect'));
});
