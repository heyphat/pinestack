import { expect, test } from 'bun:test';
import {
  ReplayProvider,
  StaticProvider,
  type Bar,
  type BarUpdate,
  type MarketDataProvider,
  type ResolvedDataInstrument,
} from '@heyphat/pinery';
import { main, type CliDependencies } from '../src/cli.js';
import { PaperBroker } from '../src/brokers/paper.js';
import { InMemoryExecutionLease } from '../src/core/lease.js';
import type { LedgerEventV3, LedgerRecord, LedgerSink } from '../src/core/ledger.js';
import { recoverLedger } from '../src/core/recovery.js';
import type { Broker } from '../src/core/broker.js';
import {
  createNodeTigerBroker,
  createOfficialTigerTradingTransport,
  registerTigerTradingTransport,
  type ActiveRunRegistrationV1,
  type RunHistoryRecordV1,
} from '../src/node.js';

test('official Tiger trading transport rejects a missing credential profile path', () => {
  expect(() =>
    createOfficialTigerTradingTransport({ propertiesFilePath: '/nonexistent/tiger.properties' }),
  ).toThrow('credential profile not found');
});

test('Tiger trading registry validates config, receives only credentials, and guards by default', async () => {
  expect(() =>
    createNodeTigerBroker({ id: 'tiger', unrelatedSecret: 'nope' } as never, true, {}),
  ).toThrow('does not allow');

  let receivedConfig: unknown;
  let receivedCredentials: unknown;
  let submitCalls = 0;
  registerTigerTradingTransport((config, credentials) => {
    receivedConfig = config;
    receivedCredentials = credentials;
    return {
      async account() {
        return { id: 'demo', currency: 'USD', balance: 1, equity: 1 };
      },
      async instrument(symbol) {
        return { symbol, mintick: 0.1, qtyStep: 1, minOrderQty: 1 };
      },
      async position(_accountId, symbol) {
        return { symbol, qty: 0 };
      },
      async findOrderByClientId() {
        return undefined;
      },
      async submitMarket(_accountId, request) {
        submitCalls++;
        return {
          ...request,
          requestedQty: request.qty,
          filledQty: request.qty,
          price: 1,
          status: 'filled',
        };
      },
    };
  });
  const broker = createNodeTigerBroker({ id: 'tiger', profile: 'demo', account: 'paper' }, true, {
    tigerId: 'id',
    privateKey: 'key',
    account: 'paper',
    secretKey: 'secret-key',
    license: 'license',
    token: 'token',
    PATH: 'secret',
  } as never);
  expect(receivedConfig).toEqual({ id: 'tiger', profile: 'demo', account: 'paper' });
  expect(receivedCredentials).toEqual({
    tigerId: 'id',
    privateKey: 'key',
    account: 'paper',
    secretKey: 'secret-key',
    license: 'license',
    token: 'token',
  });
  await expect(
    broker.submit({ symbol: 'X', side: 'buy', qty: 1, type: 'market', clientId: 'safety-bypass' }),
  ).rejects.toThrow('blocked until production safety synchronization completes');
  expect(submitCalls).toBe(0);
});

const strategySource = `//@version=6
strategy("cli-current", calc_on_every_tick=true, process_orders_on_close=true, default_qty_type=strategy.fixed, default_qty_value=1)
if close > open
    strategy.entry("L", strategy.long)
else
    strategy.close("L")
plot(strategy.position_size)`;
const nativeSource = Object.freeze({ kind: 'native' as const });
let harnessSequence = 0;

function testBar(time: number, close = 9, open = 10): Bar {
  return {
    time,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 1,
  };
}

function testUpdate(value: Bar, revision: number, isClose: boolean): BarUpdate {
  return {
    bar: value,
    revision,
    isClose,
    eventTime: value.time * 1_000 + revision,
    source: nativeSource,
  };
}

function computeConfig(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    configVersion: 3,
    strategy: 'cli-current.pine',
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 2,
    data: { provider: 'csv', dataDir: '/must/not/be-read', cutoverTime: 120 },
    execution: { kind: 'compute-only' },
    ...overrides,
  } as const;
}

function paperConfig(overrides: Readonly<Record<string, unknown>> = {}) {
  return computeConfig({
    execution: {
      kind: 'mirrored',
      mirrorOn: 'bar-close',
      broker: { id: 'paper', initialBalance: 10_000 },
      ledger: { path: '/virtual/cli-current.jsonl', durability: 'sync' },
      lease: { path: '/virtual/cli-current.lock' },
    },
    ...overrides,
  });
}

interface ReplayHarnessOptions {
  readonly id?: string;
  readonly history?: readonly Bar[];
  readonly updates?: readonly BarUpdate[];
  readonly rawUpdates?: boolean;
  readonly onResolve?: () => void;
  readonly onDisconnect?: () => void;
}

function replayProvider(options: ReplayHarnessOptions = {}): MarketDataProvider {
  const history = options.history ?? [testBar(0), testBar(60), testBar(120, 11)];
  const source = new StaticProvider(
    { 'X|1m': [...history] },
    {
      alignment: 'utc-24x7',
      timeframes: ['1m'],
      cacheIdentity: 'cli-current-replay',
    },
  ).setInstrument('X', { minQty: 1, mintick: 0.01 });
  const replay = new ReplayProvider(source, {
    cutoverTime: 120,
    ...(options.rawUpdates
      ? {}
      : {
          updates:
            options.updates && options.updates.length > 0 ? { 'X|1m': options.updates } : undefined,
        }),
    instrument: { minOrderQty: 1 },
  });

  return {
    id: options.id ?? replay.id,
    assetClass: replay.assetClass,
    async resolve(symbol, resolveOptions) {
      options.onResolve?.();
      return replay.resolve(symbol, resolveOptions);
    },
    history: replay.history.bind(replay),
    historyResolved: replay.historyResolved.bind(replay),
    closedBars: replay.closedBars.bind(replay),
    ...(options.rawUpdates
      ? {
          async *liveBars() {
            for (const update of options.updates ?? []) yield structuredClone(update);
          },
        }
      : { liveBars: replay.liveBars.bind(replay) }),
    async disconnect() {
      options.onDisconnect?.();
      await replay.disconnect();
    },
  };
}

class SharedEventLedger implements LedgerSink {
  constructor(
    private readonly events: LedgerEventV3[],
    private readonly onClose: () => void,
  ) {}

  async append(record: LedgerRecord): Promise<void> {
    if (record.schemaVersion === 3) this.events.push(structuredClone(record));
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {
    this.onClose();
  }
}

interface CliHarness {
  readonly dependencies: Partial<CliDependencies>;
  readonly events: LedgerEventV3[];
  readonly logs: string[];
  readonly addedSignals: string[];
  readonly removedSignals: string[];
  readonly registrations: ActiveRunRegistrationV1[];
  readonly histories: RunHistoryRecordV1[];
  readonly registryCounts: { heartbeatStarts: number; heartbeatStops: number };
  readonly counts: {
    provider: number;
    paperBroker: number;
    tigerBroker: number;
    ledger: number;
    ledgerClose: number;
    lease: number;
    dataCredentials: number;
    tradingCredentials: number;
    flatten: number;
  };
}

function createCliHarness(
  config: Readonly<Record<string, unknown>>,
  providerFactory: (call: number) => MarketDataProvider,
  options: {
    readonly source?: string;
    readonly events?: LedgerEventV3[];
  } = {},
): CliHarness {
  const events = options.events ?? [];
  const logs: string[] = [];
  const addedSignals: string[] = [];
  const removedSignals: string[] = [];
  const registrations: ActiveRunRegistrationV1[] = [];
  const histories: RunHistoryRecordV1[] = [];
  const registryCounts = { heartbeatStarts: 0, heartbeatStops: 0 };
  const activeRegistrations = new Map<string, ActiveRunRegistrationV1>();
  const counts = {
    provider: 0,
    paperBroker: 0,
    tigerBroker: 0,
    ledger: 0,
    ledgerClose: 0,
    lease: 0,
    dataCredentials: 0,
    tradingCredentials: 0,
    flatten: 0,
  };
  const sequence = ++harnessSequence;
  const dependencies: Partial<CliDependencies> = {
    readConfig: async () => config,
    readSource: async () => options.source ?? strategySource,
    createMarketDataProvider: (() => {
      counts.provider++;
      return providerFactory(counts.provider);
    }) as CliDependencies['createMarketDataProvider'],
    createPaperBroker: (brokerOptions) => {
      counts.paperBroker++;
      const paper = new PaperBroker(brokerOptions);
      return new Proxy(paper, {
        get(target, property) {
          if (property === 'flatten') {
            return async (symbol: string) => {
              counts.flatten++;
              return target.flatten(symbol);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as Broker;
    },
    createTigerBroker: (() => {
      counts.tigerBroker++;
      throw new Error('Tiger broker factory must remain untouched');
    }) as CliDependencies['createTigerBroker'],
    readJsonlPrefix: (async () => ({
      records: structuredClone(events),
      validBytes: events.length,
      totalBytes: events.length,
    })) as CliDependencies['readJsonlPrefix'],
    createJsonlLedger: () => {
      counts.ledger++;
      return new SharedEventLedger(events, () => counts.ledgerClose++);
    },
    createFileExecutionLease: (path, leaseOptions) => {
      counts.lease++;
      return new InMemoryExecutionLease(leaseOptions?.resource ?? path, {
        ownerId: leaseOptions?.ownerId ?? `cli-owner-${sequence}-${counts.lease}`,
        leaseId: `cli-lease-${sequence}-${counts.lease}`,
      });
    },
    createRunRegistry: () => ({
      async writeActive(record) {
        const value = structuredClone(record);
        activeRegistrations.set(record.instanceId, value);
        registrations.push(value);
      },
      async updateActive(instanceId, update) {
        const current = activeRegistrations.get(instanceId);
        if (!current) throw new Error('test active registration is missing');
        const value = structuredClone(await update(structuredClone(current)));
        activeRegistrations.set(instanceId, value);
        registrations.push(value);
        return value;
      },
      createHeartbeatService() {
        return {
          start() {
            registryCounts.heartbeatStarts++;
          },
          async stop() {
            registryCounts.heartbeatStops++;
          },
        };
      },
      async completeRun(record) {
        histories.push(structuredClone(record));
        return { activeRemoved: activeRegistrations.delete(record.instanceId) };
      },
    }),
    createRunInstanceId: () => sequence.toString(16).padStart(32, '0'),
    readBootBoundProcessIdentity: async () => undefined,
    resolveRunRegistrationPath: (path) => (path.startsWith('/') ? path : `/virtual/${path}`),
    now: () => new Date(sequence * 1_000),
    pid: 10_000 + sequence,
    cwd: () => '/virtual',
    readTigerDataCredentials: () => {
      counts.dataCredentials++;
      throw new Error('Tiger data credentials must remain untouched');
    },
    readTigerTradingCredentials: () => {
      counts.tradingCredentials++;
      throw new Error('Tiger trading credentials must remain untouched');
    },
    log: (message) => logs.push(message),
    addSignalHandler: (signal) => addedSignals.push(signal),
    removeSignalHandler: (signal) => removedSignals.push(signal),
  };
  return {
    dependencies,
    events,
    logs,
    addedSignals,
    removedSignals,
    registrations,
    histories,
    registryCounts,
    counts,
  };
}

function finalJsonLog(logs: readonly string[]): Record<string, unknown> {
  const line = [...logs].reverse().find((value) => value.startsWith('{'));
  if (!line) throw new Error('test expected a JSON result line');
  return JSON.parse(line) as Record<string, unknown>;
}

test('CLI help advertises run, validate, parity, upgrade, and version', async () => {
  const logs: string[] = [];
  await main(['help'], { log: (message) => logs.push(message) });
  expect(logs).toEqual([
    'pinelive run --config <pinelive.json>',
    'pinelive validate --config <pinelive.json>',
    'pinelive status --ledger <path> [--json] [--recent <n>]',
    'pinelive status --all [--json] [--recent <n>]',
    'pinelive status --instance <instance-id> [--json] [--recent <n>]',
    'pinelive recover --ledger <path> --lease <path> [--account-claim <path>] --confirm',
    'pinelive parity <live.jsonl> <expected.jsonl>',
    'pinelive upgrade [--check]',
    'pinelive --version',
  ]);
});

test('CLI --version self-reports without touching any dependency factory', async () => {
  const logs: string[] = [];
  await main(['--version'], { log: (message) => logs.push(message) });
  expect(logs).toHaveLength(1);
  // Source runs fall back to the package manifest; compiled binaries use the
  // build define. Either way the line starts with the binary's own name.
  expect(logs[0]!).toMatch(/^pinelive \d+\.\d+\.\d+/);
});

test('validate performs only pure config/source gates and prints the current summary', async () => {
  const harness = createCliHarness(computeConfig(), () => {
    throw new Error('provider factory must remain untouched');
  });

  await main(['validate', '--config', 'virtual.json'], harness.dependencies);

  expect(finalJsonLog(harness.logs)).toEqual({
    valid: true,
    configVersion: 3,
    mode: 'compute-only',
    cadence: 'bar-close',
    history: 'standard',
  });
  expect(harness.counts).toEqual({
    provider: 0,
    paperBroker: 0,
    tigerBroker: 0,
    ledger: 0,
    ledgerClose: 0,
    lease: 0,
    dataCredentials: 0,
    tradingCredentials: 0,
    flatten: 0,
  });
  expect(harness.addedSignals).toEqual([]);
});

test('CLI validate and run reject config versions 1 and 2 before runtime construction', async () => {
  for (const configVersion of [1, 2]) {
    for (const command of ['validate', 'run'] as const) {
      const harness = createCliHarness(computeConfig({ configVersion }), () => {
        throw new Error('provider factory must remain untouched');
      });

      await expect(
        main([command, '--config', `config-${configVersion}.json`], harness.dependencies),
      ).rejects.toThrow('unsupported configVersion; expected 3');
      expect(harness.counts.provider).toBe(0);
      expect(harness.counts.paperBroker).toBe(0);
      expect(harness.counts.tigerBroker).toBe(0);
      expect(harness.counts.ledger).toBe(0);
      expect(harness.counts.lease).toBe(0);
      expect(harness.addedSignals).toEqual([]);
    }
  }
});

test('invalid current compilation rejects before every runtime factory and signal handler', async () => {
  const harness = createCliHarness(
    computeConfig(),
    () => {
      throw new Error('provider factory must remain untouched');
    },
    { source: '//@version=6\nindicator("not a strategy")\nplot(close)' },
  );

  await expect(main(['run', '--config', 'virtual.json'], harness.dependencies)).rejects.toThrow(
    'strategy',
  );
  expect(harness.counts.provider).toBe(0);
  expect(harness.counts.paperBroker).toBe(0);
  expect(harness.counts.ledger).toBe(0);
  expect(harness.counts.lease).toBe(0);
  expect(harness.counts.dataCredentials).toBe(0);
  expect(harness.counts.tradingCredentials).toBe(0);
  expect(harness.addedSignals).toEqual([]);
});

test('CLI validate and run reject Paper every-update effects before runtime construction', async () => {
  const base = paperConfig({
    live: { cadence: 'every-update', source: nativeSource },
  });
  const config = {
    ...base,
    execution: {
      ...base.execution,
      mirrorOn: 'every-update',
      intrabarExecutionArmed: true,
    },
  } as const;

  for (const command of ['validate', 'run'] as const) {
    const harness = createCliHarness(config, () => {
      throw new Error('provider factory must remain untouched');
    });
    await expect(
      main([command, '--config', 'paper-every-update.json'], harness.dependencies),
    ).rejects.toThrow(
      'Paper mirrorOn "every-update" is unavailable because the public piner runtime does not expose a provable pending-order/fill lifecycle',
    );
    expect(harness.counts).toEqual({
      provider: 0,
      paperBroker: 0,
      tigerBroker: 0,
      ledger: 0,
      ledgerClose: 0,
      lease: 0,
      dataCredentials: 0,
      tradingCredentials: 0,
      flatten: 0,
    });
    expect(harness.addedSignals).toEqual([]);
    expect(harness.removedSignals).toEqual([]);
  }
});

test('current compute-only runs bar-close through Replay without broker or account output', async () => {
  let resolves = 0;
  const harness = createCliHarness(computeConfig(), () =>
    replayProvider({ onResolve: () => resolves++ }),
  );

  await main(['run', '--config', 'compute.json'], harness.dependencies);

  const result = finalJsonLog(harness.logs);
  expect(result).toMatchObject({ mode: 'compute-only', evaluations: 1 });
  expect(result).not.toHaveProperty('finalPosition');
  expect(result).not.toHaveProperty('finalAccount');
  expect(result).not.toHaveProperty('executionSafe');
  expect(resolves).toBe(1);
  expect(harness.counts.provider).toBe(1);
  expect(harness.counts.paperBroker).toBe(0);
  expect(harness.counts.tigerBroker).toBe(0);
  expect(harness.counts.dataCredentials).toBe(0);
  expect(harness.counts.tradingCredentials).toBe(0);
  expect(harness.counts.ledgerClose).toBe(1);
  expect(harness.addedSignals).toEqual(['SIGINT', 'SIGTERM']);
  expect(harness.removedSignals).toEqual(['SIGINT', 'SIGTERM']);
  expect(harness.events.some((event) => event.recordType === 'evaluation.skipped')).toBe(true);
});

test('current mirrored Paper runs bar-close through Replay, reuses authority resolution, and never flattens', async () => {
  let resolves = 0;
  const harness = createCliHarness(paperConfig(), () =>
    replayProvider({ onResolve: () => resolves++ }),
  );

  await main(['run', '--config', 'paper.json'], harness.dependencies);

  const result = finalJsonLog(harness.logs);
  expect(result).toMatchObject({
    mode: 'mirrored',
    executionSafe: true,
    evaluations: 1,
  });
  expect(result).toHaveProperty('finalPosition');
  expect(result).toHaveProperty('finalAccount');
  expect(resolves).toBe(1);
  expect(harness.counts.paperBroker).toBe(1);
  expect(harness.counts.flatten).toBe(0);
  expect(harness.counts.tradingCredentials).toBe(0);
  expect(harness.events.some((event) => event.recordType === 'order.intent')).toBe(true);
  expect(
    harness.events.some((event) => event.recordType === 'lease' && event.action === 'released'),
  ).toBe(true);
});

test('recovered strong authority mismatch rejects before the Paper broker factory', async () => {
  const config = paperConfig();
  const sharedEvents: LedgerEventV3[] = [];
  const first = createCliHarness(config, () => replayProvider({ id: 'authority-a' }), {
    events: sharedEvents,
  });
  await main(['run', '--config', 'paper.json'], first.dependencies);
  expect(first.counts.paperBroker).toBe(1);

  const second = createCliHarness(config, () => replayProvider({ id: 'authority-b' }), {
    events: sharedEvents,
  });
  await expect(main(['run', '--config', 'paper.json'], second.dependencies)).rejects.toThrow(
    'prepared authority mismatch',
  );
  expect(second.counts.paperBroker).toBe(0);
  expect(second.counts.tigerBroker).toBe(0);
  expect(second.counts.ledgerClose).toBe(1);
  expect(second.removedSignals).toEqual(['SIGINT', 'SIGTERM']);
});

test('CLI direct recovery preserves an active bar and inhibits its first post-restart final', async () => {
  const config = computeConfig({
    live: { cadence: 'every-update', source: nativeSource },
  });
  const sharedEvents: LedgerEventV3[] = [];
  const first = createCliHarness(
    config,
    () =>
      replayProvider({
        history: [testBar(0), testBar(60)],
        rawUpdates: true,
        updates: [testUpdate(testBar(120, 10.5), 1, false)],
      }),
    { events: sharedEvents },
  );
  await main(['run', '--config', 'active.json'], first.dependencies);
  expect(recoverLedger(sharedEvents).activeBars.size).toBe(1);

  const second = createCliHarness(
    config,
    () =>
      replayProvider({
        history: [testBar(0), testBar(60)],
        rawUpdates: true,
        updates: [testUpdate(testBar(120, 11), 2, true), testUpdate(testBar(180, 11), 1, true)],
      }),
    { events: sharedEvents },
  );
  await main(['run', '--config', 'active.json'], second.dependencies);

  expect(
    sharedEvents.some(
      (event) =>
        event.recordType === 'evaluation.skipped' &&
        event.reason === 'startup-discontinuity' &&
        event.barTime === 120,
    ),
  ).toBe(true);
  expect(recoverLedger(sharedEvents).lastFinalCursor).toBe(180);
});

test('Tiger current validation remains pure before credentials, providers, or storage', async () => {
  const tigerConfig = paperConfig({
    execution: {
      kind: 'mirrored',
      mirrorOn: 'bar-close',
      broker: { id: 'tiger', profile: '/must/not/be-read' },
      armed: false,
      ledger: { path: '/virtual/tiger-current.jsonl', durability: 'sync' },
      lease: { path: '/virtual/tiger-current.lock' },
    },
  });
  const harness = createCliHarness(tigerConfig, () => {
    throw new Error('provider must remain untouched');
  });

  await main(['validate', '--config', 'tiger.json'], harness.dependencies);
  expect(finalJsonLog(harness.logs)).toMatchObject({
    valid: true,
    configVersion: 3,
    mode: 'mirrored',
  });
  expect(harness.counts.provider).toBe(0);
  expect(harness.counts.tigerBroker).toBe(0);
  expect(harness.counts.ledger).toBe(0);
  expect(harness.counts.lease).toBe(0);
  expect(harness.counts.dataCredentials).toBe(0);
  expect(harness.counts.tradingCredentials).toBe(0);
  expect(harness.addedSignals).toEqual([]);
});

test('invalid current config rejects before providers, credentials, ledger, lease, or signals', async () => {
  const harness = createCliHarness(computeConfig({ unexpected: true }), () => {
    throw new Error('provider factory must remain untouched');
  });

  await expect(main(['run', '--config', 'invalid.json'], harness.dependencies)).rejects.toThrow(
    'config.unexpected is not allowed',
  );
  expect(harness.counts.provider).toBe(0);
  expect(harness.counts.paperBroker).toBe(0);
  expect(harness.counts.ledger).toBe(0);
  expect(harness.counts.lease).toBe(0);
  expect(harness.counts.dataCredentials).toBe(0);
  expect(harness.counts.tradingCredentials).toBe(0);
  expect(harness.addedSignals).toEqual([]);
});

test('unsafe mirrored results are printed as structured blocked data and storage is closed', async () => {
  const harness = createCliHarness(paperConfig(), () => {
    throw new Error('stub runtime must not invoke its data factory');
  });
  const dependencies: Partial<CliDependencies> = {
    ...harness.dependencies,
    runIntrabarServer: (async () => ({
      mode: 'mirrored',
      executionSafe: false,
      posture: 'live',
      executionEligibility: 'blocked',
      eligibilityReasons: ['breaker-open'],
      unsafeReason: 'breaker-open',
      authority: { identity: 'sha256-test' },
      binding: { id: 'binding-test' },
      evaluations: 0,
      recoveredFromSequence: 0,
    })) as CliDependencies['runIntrabarServer'],
  };

  await main(['run', '--config', 'unsafe.json'], dependencies);
  expect(finalJsonLog(harness.logs)).toMatchObject({
    mode: 'mirrored',
    posture: 'live',
    executionEligibility: 'blocked',
    executionSafe: false,
    unsafeReason: 'breaker-open',
  });
  expect(harness.counts.ledgerClose).toBe(1);
  expect(harness.removedSignals).toEqual(['SIGINT', 'SIGTERM']);
});

test('mirrored CLI preserves its lease when runtime ownership cleanup fails', async () => {
  const harness = createCliHarness(paperConfig(), () => {
    throw new Error('stub runtime must not invoke its data factory');
  });
  const administrativeLease = new InMemoryExecutionLease(
    'pinelive-admin:/virtual/cli-current.jsonl',
    {
      ownerId: 'admin-owner',
      leaseId: 'admin-lease',
    },
  );
  const mirroredLease = new InMemoryExecutionLease('/virtual/cli-current.jsonl', {
    ownerId: 'mirrored-owner',
    leaseId: 'mirrored-lease',
  });
  let ledgerOptions: Parameters<CliDependencies['createJsonlLedger']>[1];
  const createJsonlLedger = harness.dependencies.createJsonlLedger!;
  const dependencies: Partial<CliDependencies> = {
    ...harness.dependencies,
    createJsonlLedger: (path, options) => {
      ledgerOptions = options;
      return createJsonlLedger(path, options);
    },
    createFileExecutionLease: (path) =>
      path.endsWith('.admin.lock') ? administrativeLease : mirroredLease,
    runIntrabarServer: (async (options) => {
      if (!options.lease) throw new Error('test expected a mirrored execution lease');
      await options.lease.acquire();
      await options.releaseAdministrativeLeaseAfterOwnershipRecorded?.();
      throw new Error('account claim release failed');
    }) as CliDependencies['runIntrabarServer'],
  };

  try {
    await expect(
      main(['run', '--config', 'claim-release-failure.json'], dependencies),
    ).rejects.toThrow('account claim release failed');
    expect(ledgerOptions?.releaseLeaseOnClose).toBe(false);
    expect(mirroredLease.snapshot).toMatchObject({
      ownerId: 'mirrored-owner',
      leaseId: 'mirrored-lease',
    });
    expect(() => mirroredLease.assertHeld()).not.toThrow();
    expect(administrativeLease.snapshot).toBeUndefined();
    expect(harness.counts.ledgerClose).toBe(1);
  } finally {
    if (mirroredLease.snapshot) await mirroredLease.release();
    if (administrativeLease.snapshot) await administrativeLease.release();
  }
});

test('mirrored CLI retains administrative and execution ownership when acquisition durability is uncertain', async () => {
  const harness = createCliHarness(paperConfig(), () => {
    throw new Error('stub runtime must not invoke its data factory');
  });
  const administrativeLease = new InMemoryExecutionLease(
    'pinelive-admin:/virtual/cli-current.jsonl',
    {
      ownerId: 'shared-runtime-owner',
      leaseId: 'uncertain-admin-lease',
    },
  );
  const mirroredLease = new InMemoryExecutionLease('/virtual/cli-current.jsonl', {
    ownerId: 'shared-runtime-owner',
    leaseId: 'uncertain-execution-lease',
  });
  const dependencies: Partial<CliDependencies> = {
    ...harness.dependencies,
    createFileExecutionLease: (path) =>
      path.endsWith('.admin.lock') ? administrativeLease : mirroredLease,
    runIntrabarServer: (async (options) => {
      if (!options.lease) throw new Error('test expected a mirrored execution lease');
      await options.lease.acquire();
      throw new Error('lease acquisition stable-storage acknowledgement failed');
    }) as CliDependencies['runIntrabarServer'],
  };

  try {
    await expect(
      main(['run', '--config', 'uncertain-lease-acquisition.json'], dependencies),
    ).rejects.toThrow('lease acquisition stable-storage acknowledgement failed');
    expect(mirroredLease.snapshot).toBeDefined();
    expect(administrativeLease.snapshot).toBeDefined();
    expect(harness.counts.ledgerClose).toBe(1);
  } finally {
    if (mirroredLease.snapshot) await mirroredLease.release();
    if (administrativeLease.snapshot) await administrativeLease.release();
  }
});

test('mirrored handoff refreshes recovery after lease acquisition before broker construction', async () => {
  const config = paperConfig();
  const events: LedgerEventV3[] = [];
  const first = createCliHarness(config, () => replayProvider(), { events });
  await main(['run', '--config', 'handoff.json'], first.dependencies);
  const stalePrefix = structuredClone(events);

  const intervening = createCliHarness(config, () => replayProvider(), { events });
  await main(['run', '--config', 'handoff.json'], intervening.dependencies);
  const ownedPrefix = structuredClone(events);
  const ownedRecovery = recoverLedger(ownedPrefix);
  expect(ownedRecovery.lastSequence).toBeGreaterThan(recoverLedger(stalePrefix).lastSequence);

  const currentEvents = structuredClone(ownedPrefix);
  const handoff = createCliHarness(config, () => replayProvider(), {
    events: currentEvents,
  });
  const trace: string[] = [];
  let reads = 0;
  const createPaperBroker = handoff.dependencies.createPaperBroker!;
  const dependencies: Partial<CliDependencies> = {
    ...handoff.dependencies,
    readJsonlPrefix: (async () => {
      reads++;
      trace.push(`read:${reads}`);
      const records = reads === 1 ? stalePrefix : ownedPrefix;
      return {
        records: structuredClone(records),
        validBytes: records.length,
        totalBytes: records.length,
      };
    }) as CliDependencies['readJsonlPrefix'],
    createFileExecutionLease: (path, options) => {
      const inner = new InMemoryExecutionLease(options?.resource ?? path, {
        ownerId: 'handoff-owner',
        leaseId: 'handoff-lease',
      });
      return {
        get resource() {
          return inner.resource;
        },
        get ownerId() {
          return inner.ownerId;
        },
        get snapshot() {
          return inner.snapshot;
        },
        async acquire() {
          trace.push('lease:acquire');
          return inner.acquire();
        },
        assertHeld() {
          return inner.assertHeld();
        },
        release() {
          return inner.release();
        },
      };
    },
    createPaperBroker: (options) => {
      trace.push('broker:factory');
      return createPaperBroker(options);
    },
  };

  await main(['run', '--config', 'handoff.json'], dependencies);

  expect(trace.slice(0, 5)).toEqual([
    'lease:acquire',
    'read:1',
    'lease:acquire',
    'read:2',
    'broker:factory',
  ]);
  expect(finalJsonLog(handoff.logs).recoveredFromSequence).toBe(ownedRecovery.lastSequence);
  expect(() => recoverLedger(currentEvents)).not.toThrow();
});

test('mirrored handoff refresh accepts an old active row after its durable release', async () => {
  const config = paperConfig();
  const completedEvents: LedgerEventV3[] = [];
  const completed = createCliHarness(config, () => replayProvider(), {
    events: completedEvents,
  });
  await main(['run', '--config', 'active-handoff.json'], completed.dependencies);

  const releaseIndex = completedEvents.findIndex(
    (event) => event.recordType === 'lease' && event.action === 'released',
  );
  expect(releaseIndex).toBeGreaterThan(0);
  const staleActivePrefix = structuredClone(completedEvents.slice(0, releaseIndex));
  expect(recoverLedger(staleActivePrefix).activeLease).toBeDefined();
  const ownedPrefix = structuredClone(completedEvents);
  expect(recoverLedger(ownedPrefix).activeLease).toBeUndefined();

  const currentEvents = structuredClone(ownedPrefix);
  const handoff = createCliHarness(config, () => replayProvider(), {
    events: currentEvents,
  });
  const trace: string[] = [];
  let reads = 0;
  const createFileExecutionLease = handoff.dependencies.createFileExecutionLease!;
  const dependencies: Partial<CliDependencies> = {
    ...handoff.dependencies,
    readJsonlPrefix: (async () => {
      reads++;
      trace.push(`read:${reads}`);
      const records = reads === 1 ? staleActivePrefix : ownedPrefix;
      return {
        records: structuredClone(records),
        validBytes: records.length,
        totalBytes: records.length,
      };
    }) as CliDependencies['readJsonlPrefix'],
    createFileExecutionLease: (path, options) => {
      const lease = createFileExecutionLease(path, options);
      return {
        get resource() {
          return lease.resource;
        },
        get ownerId() {
          return lease.ownerId;
        },
        get snapshot() {
          return lease.snapshot;
        },
        async acquire() {
          trace.push('lease:acquire');
          return lease.acquire();
        },
        assertHeld() {
          return lease.assertHeld();
        },
        release() {
          return lease.release();
        },
      };
    },
  };

  await main(['run', '--config', 'active-handoff.json'], dependencies);

  expect(trace.slice(0, 4)).toEqual(['lease:acquire', 'read:1', 'lease:acquire', 'read:2']);
  expect(finalJsonLog(handoff.logs).recoveredFromSequence).toBe(
    recoverLedger(ownedPrefix).lastSequence,
  );
  expect(() => recoverLedger(currentEvents)).not.toThrow();
});

test('CLI rejects unknown command flags before config or runtime construction', async () => {
  let configReads = 0;
  await expect(
    main(['run', '--config', 'ignored.json', '--force'], {
      readConfig: async () => {
        configReads++;
        return computeConfig();
      },
    }),
  ).rejects.toThrow('run does not allow --force');
  expect(configReads).toBe(0);
});

test('status CLI is read-only and prints the versioned JSON payload', async () => {
  const logs: string[] = [];
  let statusReads = 0;
  await main(['status', '--ledger', '/virtual/ledger.jsonl', '--json'], {
    readPineliveStatus: async ({ ledgerPath }) => {
      statusReads++;
      return {
        statusVersion: 1,
        generatedAt: new Date(0).toISOString(),
        identity: {},
        posture: { availability: 'not-recorded', reason: 'none' },
        executionEligibility: { availability: 'not-recorded', reason: 'none' },
        ownership: {
          durableLedgerLease: { availability: 'not-recorded', reason: 'none' },
          durableAccountClaim: { availability: 'not-recorded', reason: 'none' },
        },
        breaker: { availability: 'not-recorded', reason: 'none' },
        unresolvedEffects: { availability: 'not-recorded', reason: 'none' },
        latestObservation: { availability: 'not-recorded', reason: 'none' },
        counters: { availability: 'not-recorded', reason: 'none' },
        recent: [],
        ledger: {
          path: ledgerPath,
          bytes: 0,
          validBytes: 0,
          partialTail: false,
        },
        warnings: [],
      };
    },
    createMarketDataProvider: (() => {
      throw new Error('status must not create a provider');
    }) as CliDependencies['createMarketDataProvider'],
    createTigerBroker: (() => {
      throw new Error('status must not create a broker');
    }) as CliDependencies['createTigerBroker'],
    createFileExecutionLease: (() => {
      throw new Error('status must not create a claim');
    }) as CliDependencies['createFileExecutionLease'],
    log: (message) => logs.push(message),
  });
  expect(statusReads).toBe(1);
  expect(JSON.parse(logs[0]!)).toMatchObject({
    statusVersion: 1,
    ledger: { path: '/virtual/ledger.jsonl', partialTail: false },
  });
});

test('recover CLI requires explicit confirmation before calling recovery', async () => {
  let recoveryCalls = 0;
  await expect(
    main(['recover', '--ledger', 'ledger.jsonl', '--lease', 'ledger.lock'], {
      recoverStalePineliveClaims: async () => {
        recoveryCalls++;
        throw new Error('must not be called');
      },
    }),
  ).rejects.toThrow('requires --confirm');
  expect(recoveryCalls).toBe(0);
});

test('mirrored startup releases its administrative mutex only after durable lease ownership', async () => {
  const events: LedgerEventV3[] = [];
  const harness = createCliHarness(paperConfig(), () => replayProvider(), { events });
  const createFileExecutionLease = harness.dependencies.createFileExecutionLease!;
  let releaseObservedDurableOwner = false;
  const dependencies: Partial<CliDependencies> = {
    ...harness.dependencies,
    createFileExecutionLease: (path, options) => {
      const lease = createFileExecutionLease(path, options);
      if (!path.endsWith('.admin.lock')) return lease;
      return {
        get resource() {
          return lease.resource;
        },
        get ownerId() {
          return lease.ownerId;
        },
        get snapshot() {
          return lease.snapshot;
        },
        acquire() {
          return lease.acquire();
        },
        assertHeld() {
          return lease.assertHeld();
        },
        async release() {
          const activeLease = recoverLedger(events).activeLease;
          expect(activeLease).toBeDefined();
          expect(activeLease?.ownerId).toBe(options?.ownerId);
          releaseObservedDurableOwner = true;
          await lease.release();
        },
      };
    },
  };

  await main(['run', '--config', 'durable-handoff.json'], dependencies);
  expect(releaseObservedDurableOwner).toBe(true);
});

test('status aggregate and exact-instance selectors are read-only and mutually exclusive', async () => {
  const logs: string[] = [];
  let aggregateReads = 0;
  let instanceReads = 0;
  let explicitLedgerReads = 0;
  const instanceId = 'a'.repeat(32);
  const aggregate = {
    statusListVersion: 1 as const,
    generatedAt: new Date(0).toISOString(),
    items: [],
  };
  const terminal = {
    discoveryVersion: 1 as const,
    kind: 'terminal' as const,
    generatedAt: new Date(0).toISOString(),
    instanceId,
    history: {
      historyVersion: 1 as const,
      instanceId,
      startedAt: new Date(0).toISOString(),
      endedAt: new Date(1).toISOString(),
      outcome: 'failed-startup' as const,
      finalReasonCode: 'startup-failed',
      configVersion: 3 as const,
      brokerId: 'compute-only' as const,
      posture: 'compute-only' as const,
    },
    durable: { availability: 'not-recorded' as const, reason: 'startup failed before storage' },
    lifecycle: { state: 'stopped' as const, reasons: [] },
    warnings: [],
  };
  const dependencies: Partial<CliDependencies> = {
    readPineliveStatusList: async () => {
      aggregateReads++;
      return aggregate;
    },
    readPineliveInstanceStatus: async () => {
      instanceReads++;
      return terminal;
    },
    readPineliveStatus: async () => {
      explicitLedgerReads++;
      throw new Error('explicit ledger reader must remain untouched');
    },
    createMarketDataProvider: (() => {
      throw new Error('status must not create a provider');
    }) as CliDependencies['createMarketDataProvider'],
    createTigerBroker: (() => {
      throw new Error('status must not create a broker');
    }) as CliDependencies['createTigerBroker'],
    createRunRegistry: () => {
      throw new Error('injected status readers must own registry access');
    },
    log: (message) => logs.push(message),
  };

  await main(['status', '--all', '--json'], dependencies);
  expect(JSON.parse(logs.pop()!)).toEqual(aggregate);
  await main(['status', '--instance', instanceId, '--json'], dependencies);
  expect(JSON.parse(logs.pop()!)).toEqual(terminal);
  expect(aggregateReads).toBe(1);
  expect(instanceReads).toBe(1);
  expect(explicitLedgerReads).toBe(0);

  await expect(
    main(['status', '--all', '--ledger', '/virtual/ledger.jsonl'], dependencies),
  ).rejects.toThrow('requires exactly one');
  await expect(main(['status', '--all', '--recover'], dependencies)).rejects.toThrow(
    'status does not allow --recover',
  );
  expect(aggregateReads).toBe(1);
  expect(instanceReads).toBe(1);
  expect(explicitLedgerReads).toBe(0);
});

test('run registration advances starting to running and stopping before terminal history', async () => {
  const harness = createCliHarness(computeConfig(), () => replayProvider());

  await main(['run', '--config', 'registered.json'], harness.dependencies);

  expect(harness.registrations.map((record) => record.lifecycle)).toEqual([
    'starting',
    'running',
    'stopping',
  ]);
  expect(harness.registrations[0]).toMatchObject({
    brokerId: 'compute-only',
    posture: 'compute-only',
    paths: {
      ledger: '/virtual/.pinelive/cli-current.pine-X-1m.jsonl',
      executionLease: '/virtual/.pinelive/cli-current.pine-X-1m.jsonl.lock',
      config: '/virtual/registered.json',
    },
  });
  expect(harness.registrations[1]).toMatchObject({
    lifecycle: 'running',
    runId: expect.any(String),
    executionId: expect.any(String),
  });
  expect(harness.histories).toHaveLength(1);
  expect(harness.histories[0]).toMatchObject({
    instanceId: harness.registrations[0]!.instanceId,
    outcome: 'stopped',
    finalLedgerPath: '/virtual/.pinelive/cli-current.pine-X-1m.jsonl',
    finalLedgerSequence: recoverLedger(harness.events).lastSequence,
    brokerId: 'compute-only',
    posture: 'compute-only',
  });
  expect(harness.registryCounts).toEqual({ heartbeatStarts: 1, heartbeatStops: 1 });
});

test('registry failures stay advisory and never block an otherwise successful runtime', async () => {
  const harness = createCliHarness(computeConfig(), () => replayProvider());

  await main(['run', '--config', 'registry-unavailable.json'], {
    ...harness.dependencies,
    createRunRegistry: () => ({
      async writeActive() {
        throw new Error('sensitive registry failure');
      },
      async updateActive() {
        throw new Error('must not update');
      },
      createHeartbeatService() {
        throw new Error('must not heartbeat');
      },
      async completeRun() {
        throw new Error('must not complete');
      },
    }),
  });

  expect(finalJsonLog(harness.logs)).toMatchObject({ mode: 'compute-only' });
  expect(harness.logs).toContain('pinelive registry warning: initial-registration-failed');
  expect(harness.logs.join('\n')).not.toContain('sensitive registry failure');
});

test('a failure before storage opens produces normalized failed-startup history', async () => {
  const harness = createCliHarness(computeConfig(), () => replayProvider());

  await expect(
    main(['run', '--config', 'startup-failure.json'], {
      ...harness.dependencies,
      createFileExecutionLease: () => {
        throw new Error('storage constructor failed');
      },
    }),
  ).rejects.toThrow('storage constructor failed');

  expect(harness.registrations.map((record) => record.lifecycle)).toEqual(['starting', 'stopping']);
  expect(harness.histories).toEqual([
    expect.objectContaining({
      outcome: 'failed-startup',
      finalReasonCode: 'startup-failed',
    }),
  ]);
  expect(harness.histories[0]).not.toHaveProperty('finalLedgerPath');
  expect(harness.histories[0]).not.toHaveProperty('finalLedgerSequence');
  expect(harness.registryCounts).toEqual({ heartbeatStarts: 1, heartbeatStops: 1 });
});

test('nonsettling registry operations remain bounded and cannot hold CLI shutdown open', async () => {
  const harness = createCliHarness(computeConfig(), () => replayProvider());
  const never = new Promise<never>(() => undefined);
  const dependencies: Partial<CliDependencies> = {
    ...harness.dependencies,
    registryOperationTimeoutMs: 5,
    createRunRegistry: () => ({
      async writeActive(record) {
        harness.registrations.push(structuredClone(record));
      },
      updateActive() {
        return never;
      },
      createHeartbeatService() {
        return {
          start() {
            harness.registryCounts.heartbeatStarts++;
          },
          stop() {
            return never;
          },
        };
      },
      completeRun() {
        return never;
      },
    }),
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      main(['run', '--config', 'nonsettling-registry.json'], dependencies),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('nonsettling advisory registry blocked CLI shutdown')),
          500,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  expect(finalJsonLog(harness.logs)).toMatchObject({ mode: 'compute-only' });
  expect(harness.counts.ledgerClose).toBe(1);
  expect(harness.logs).toContain('pinelive registry warning: stopping-update-failed');
  expect(harness.logs).toContain('pinelive registry warning: heartbeat-stop-failed');
  expect(harness.logs).toContain('pinelive registry warning: terminal-history-write-failed');
});

test('human status output visibly escapes C0, C1, ESC, and OSC controls', async () => {
  const logs: string[] = [];
  const controls = `line\nalert\u0007\u001b]0;title\u0007\u001b]52;c;Y2FuYXJ5\u0007`;
  await main(['status', '--all'], {
    readPineliveStatusList: async () => ({
      statusListVersion: 1,
      generatedAt: new Date(0).toISOString(),
      items: [
        {
          ok: false,
          path: `/tmp/${controls}`,
          error: { code: 'corrupt-record', message: controls },
        },
      ],
    }),
    log: (message) => logs.push(message),
  });

  const output = logs.join('');
  expect(output).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  expect(output).toContain('\\u000a');
  expect(output).toContain('\\u0007');
  expect(output).toContain('\\u001b]52');
});
