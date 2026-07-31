import { expect, test } from 'bun:test';
import {
  ReplayProvider,
  StaticProvider,
  type Bar,
  type BarUpdate,
  type MarketDataProvider,
  type ResolvedDataInstrument,
} from '@heyphat/pinery';
import { main, parseRunConfig, type CliDependencies } from '../src/cli.js';
import { PaperBroker } from '../src/brokers/paper.js';
import { InMemoryExecutionLease } from '../src/core/lease.js';
import type { LedgerEventV3, LedgerRecord, LedgerSink } from '../src/core/ledger.js';
import { recoverLedger } from '../src/core/recovery.js';
import { normalizeRunConfig } from '../src/core/config.js';
import type { Broker } from '../src/core/broker.js';
import {
  createNodeTigerBroker,
  createOfficialTigerTradingTransport,
  registerTigerTradingTransport,
} from '../src/node.js';

const baseConfig = {
  strategy: 'strategy.pine',
  symbol: 'X',
  timeframe: '1m',
  data: { provider: 'csv', dataDir: 'data', cutoverTime: 1 },
  broker: { id: 'paper' },
};

test('run config requires boolean reconcileOnStart and exact broker fields', () => {
  expect(() => parseRunConfig({ ...baseConfig, reconcileOnStart: 'false' })).toThrow(
    'reconcileOnStart must be boolean',
  );
  expect(() => parseRunConfig({ ...baseConfig, broker: { id: 'paper', profile: 'demo' } })).toThrow(
    'config.broker.profile is not allowed',
  );
  expect(() => parseRunConfig({ ...baseConfig, unexpected: true })).toThrow(
    'config.unexpected is not allowed',
  );
  expect(parseRunConfig({ ...baseConfig, reconcileOnStart: false }).reconcileOnStart).toBe(false);
});

test('run config validates request.security safety controls', () => {
  for (const field of [
    'securityWarmupBars',
    'maxSecurityBars',
    'maxSecurityFeeds',
    'securityConcurrency',
    'securityRequestTimeoutMs',
  ] as const) {
    expect(() => parseRunConfig({ ...baseConfig, [field]: 0 })).toThrow(
      `config.${field} must be a positive integer`,
    );
  }
  expect(() => parseRunConfig({ ...baseConfig, maxSecurityStaleRefreshes: -1 })).toThrow(
    'config.maxSecurityStaleRefreshes must be a non-negative integer',
  );
  expect(() =>
    parseRunConfig({ ...baseConfig, securityWarmupBars: 10, maxSecurityBars: 5 }),
  ).toThrow('securityWarmupBars must not exceed config.maxSecurityBars');
  expect(
    parseRunConfig({
      ...baseConfig,
      maxSecurityFeeds: 8,
      securityConcurrency: 2,
      securityRequestTimeoutMs: 1000,
      maxSecurityStaleRefreshes: 1,
    }),
  ).toMatchObject({
    maxSecurityFeeds: 8,
    securityConcurrency: 2,
    securityRequestTimeoutMs: 1000,
    maxSecurityStaleRefreshes: 1,
  });
});

test('one tigerProfile applies to both Tiger data and broker sections', () => {
  const tigerData = { provider: 'tiger', assetClass: 'futures' } as const;
  const applied = parseRunConfig({
    ...baseConfig,
    symbol: 'TG:FU:MGC',
    data: tigerData,
    broker: { id: 'tiger' },
    tigerProfile: '/tmp/tiger_openapi_config.properties',
  });
  expect(applied.data).toMatchObject({ profile: '/tmp/tiger_openapi_config.properties' });
  expect(applied.broker).toMatchObject({ profile: '/tmp/tiger_openapi_config.properties' });

  // An explicit section value still wins over the shared default.
  const explicit = parseRunConfig({
    ...baseConfig,
    symbol: 'TG:FU:MGC',
    data: { ...tigerData, profile: '/data.properties' },
    broker: { id: 'tiger', profile: '/broker.properties' },
    tigerProfile: '/shared.properties',
  });
  expect(explicit.data).toMatchObject({ profile: '/data.properties' });
  expect(explicit.broker).toMatchObject({ profile: '/broker.properties' });

  expect(() => parseRunConfig({ ...baseConfig, tigerProfile: 7 })).toThrow(
    'config.tigerProfile must be a string',
  );
});

test('official Tiger trading transport rejects a missing credential profile path', () => {
  expect(() =>
    createOfficialTigerTradingTransport({ propertiesFilePath: '/nonexistent/tiger.properties' }),
  ).toThrow('credential profile not found');
});

test('Tiger trading registry validates config and receives only credential fields', () => {
  expect(() =>
    createNodeTigerBroker({ id: 'tiger', unrelatedSecret: 'nope' } as never, true, {}),
  ).toThrow('does not allow');

  let receivedConfig: unknown;
  let receivedCredentials: unknown;
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
  createNodeTigerBroker({ id: 'tiger', profile: 'demo', account: 'paper' }, true, {
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
});

const v2Strategy = `//@version=6
strategy("cli-v2", calc_on_every_tick=true, process_orders_on_close=true, default_qty_type=strategy.fixed, default_qty_value=1)
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

function computeV2Config(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    configVersion: 2,
    strategy: 'cli-v2.pine',
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 2,
    data: { provider: 'csv', dataDir: '/must/not/be-read', cutoverTime: 120 },
    execution: { kind: 'compute-only' },
    ...overrides,
  } as const;
}

function paperV2Config(overrides: Readonly<Record<string, unknown>> = {}) {
  return computeV2Config({
    execution: {
      kind: 'mirrored',
      mirrorOn: 'bar-close',
      broker: { id: 'paper', initialBalance: 10_000 },
      ledger: { path: '/virtual/cli-v2.jsonl', durability: 'sync' },
      lease: { path: '/virtual/cli-v2.lock' },
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
      cacheIdentity: 'cli-v2-replay-v1',
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
  readonly counts: {
    provider: number;
    paperBroker: number;
    tigerBroker: number;
    ledger: number;
    ledgerClose: number;
    lease: number;
    dataCredentials: number;
    tradingCredentials: number;
    profile: number;
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
  const counts = {
    provider: 0,
    paperBroker: 0,
    tigerBroker: 0,
    ledger: 0,
    ledgerClose: 0,
    lease: 0,
    dataCredentials: 0,
    tradingCredentials: 0,
    profile: 0,
    flatten: 0,
  };
  const sequence = ++harnessSequence;
  const dependencies: Partial<CliDependencies> = {
    readConfig: async () => config,
    readSource: async () => options.source ?? v2Strategy,
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
        ownerId: `cli-owner-${sequence}-${counts.lease}`,
        leaseId: `cli-lease-${sequence}-${counts.lease}`,
      });
    },
    readTigerDataCredentials: () => {
      counts.dataCredentials++;
      throw new Error('Tiger data credentials must remain untouched');
    },
    readTigerTradingCredentials: () => {
      counts.tradingCredentials++;
      throw new Error('Tiger trading credentials must remain untouched');
    },
    readTigerProfileOverride: () => {
      counts.profile++;
      throw new Error('Tiger profile environment must remain untouched');
    },
    log: (message) => logs.push(message),
    addSignalHandler: (signal) => addedSignals.push(signal),
    removeSignalHandler: (signal) => removedSignals.push(signal),
  };
  return { dependencies, events, logs, addedSignals, removedSignals, counts };
}

function finalJsonLog(logs: readonly string[]): Record<string, unknown> {
  const line = [...logs].reverse().find((value) => value.startsWith('{'));
  if (!line) throw new Error('test expected a JSON result line');
  return JSON.parse(line) as Record<string, unknown>;
}

test('CLI help advertises run, validate, and parity', async () => {
  const logs: string[] = [];
  await main(['help'], { log: (message) => logs.push(message) });
  expect(logs).toEqual([
    'pinelive run --config <pinelive.json> [--tiger-profile <path>]',
    'pinelive validate --config <pinelive.json>',
    'pinelive parity <live.jsonl> <expected.jsonl>',
  ]);
});

test('validate performs only pure config/source gates and prints the v2 summary', async () => {
  const harness = createCliHarness(computeV2Config(), () => {
    throw new Error('provider factory must remain untouched');
  });

  await main(['validate', '--config', 'virtual.json'], harness.dependencies);

  expect(finalJsonLog(harness.logs)).toEqual({
    valid: true,
    configVersion: 2,
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
    profile: 0,
    flatten: 0,
  });
  expect(harness.addedSignals).toEqual([]);
});

test('invalid v2 compilation rejects before every runtime factory and signal handler', async () => {
  const harness = createCliHarness(
    computeV2Config(),
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
  const base = paperV2Config({
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
      profile: 0,
      flatten: 0,
    });
    expect(harness.addedSignals).toEqual([]);
    expect(harness.removedSignals).toEqual([]);
  }
});

test('v1 dispatch stays on runForwardServer and does not touch v2 or Tiger-only resources', async () => {
  const trace: string[] = [];
  const logs: string[] = [];
  let normalized = 0;
  let captured: Record<string, unknown> | undefined;
  const data = { id: 'v1-data' } as MarketDataProvider;
  const broker = { id: 'paper' } as Broker;
  const ledger: LedgerSink = { async append() {} };

  await main(['run', '--config', 'v1.json'], {
    readConfig: async () => baseConfig,
    normalizeRunConfig: (value) => {
      trace.push('normalize');
      normalized++;
      return normalizeRunConfig(value);
    },
    prepareIntrabarRun: (() => {
      throw new Error('v2 prepare must remain untouched');
    }) as CliDependencies['prepareIntrabarRun'],
    createMarketDataProvider: (() => {
      trace.push('data');
      return data;
    }) as CliDependencies['createMarketDataProvider'],
    createPaperBroker: () => {
      trace.push('broker');
      return broker;
    },
    readSource: async () => {
      trace.push('source');
      return v2Strategy;
    },
    createJsonlLedger: () => {
      trace.push('ledger');
      return ledger;
    },
    runForwardServer: (async (options) => {
      trace.push('runForwardServer');
      captured = options as unknown as Record<string, unknown>;
      return {
        binding: { executionSymbol: 'X' },
        finalPosition: 1,
        finalEquity: 10_001,
      } as never;
    }) as CliDependencies['runForwardServer'],
    readJsonlPrefix: (async () => {
      throw new Error('v2 recovery must remain untouched');
    }) as CliDependencies['readJsonlPrefix'],
    createFileExecutionLease: () => {
      throw new Error('v2 lease must remain untouched');
    },
    createTigerBroker: (() => {
      throw new Error('Tiger broker must remain untouched');
    }) as CliDependencies['createTigerBroker'],
    readTigerProfileOverride: () => {
      throw new Error('Tiger profile must remain untouched');
    },
    readTigerDataCredentials: () => {
      throw new Error('Tiger data credentials must remain untouched');
    },
    readTigerTradingCredentials: () => {
      throw new Error('Tiger execution credentials must remain untouched');
    },
    log: (message) => logs.push(message),
    addSignalHandler: (signal) => trace.push(`add:${signal}`),
    removeSignalHandler: (signal) => trace.push(`remove:${signal}`),
  });

  expect(normalized).toBe(1);
  expect(trace).toEqual([
    'normalize',
    'data',
    'broker',
    'source',
    'ledger',
    'add:SIGINT',
    'add:SIGTERM',
    'runForwardServer',
    'remove:SIGINT',
    'remove:SIGTERM',
  ]);
  expect(captured).toMatchObject({
    source: v2Strategy,
    symbol: 'X',
    timeframe: '1m',
    data,
    broker,
    ledger,
  });
  expect(logs.at(-1)).toBe(
    'stopped: contract=X position=1 equity=10001 ledger=.pinelive/ledger.jsonl',
  );
});

test('v2 compute-only runs bar-close through Replay without broker or account output', async () => {
  let resolves = 0;
  const harness = createCliHarness(computeV2Config(), () =>
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

test('v2 mirrored Paper runs bar-close through Replay, reuses authority resolution, and never flattens', async () => {
  let resolves = 0;
  const harness = createCliHarness(paperV2Config(), () =>
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
  const config = paperV2Config();
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
  const config = computeV2Config({
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

test('Tiger v2 mirrored execution fails in pure prepare before credentials, providers, or storage', async () => {
  const tigerConfig = paperV2Config({
    execution: {
      kind: 'mirrored',
      mirrorOn: 'bar-close',
      broker: { id: 'tiger', profile: '/must/not/be-read' },
      armed: false,
      ledger: { path: '/virtual/tiger-v2.jsonl', durability: 'sync' },
      lease: { path: '/virtual/tiger-v2.lock' },
    },
  });
  const harness = createCliHarness(tigerConfig, () => {
    throw new Error('provider must remain untouched');
  });

  await expect(main(['run', '--config', 'tiger.json'], harness.dependencies)).rejects.toThrow(
    'credentialed release gate',
  );
  expect(harness.counts.provider).toBe(0);
  expect(harness.counts.tigerBroker).toBe(0);
  expect(harness.counts.ledger).toBe(0);
  expect(harness.counts.lease).toBe(0);
  expect(harness.counts.profile).toBe(0);
  expect(harness.counts.dataCredentials).toBe(0);
  expect(harness.counts.tradingCredentials).toBe(0);
  expect(harness.addedSignals).toEqual([]);
});

test('invalid v2 config rejects before providers, credentials, ledger, lease, or signals', async () => {
  const harness = createCliHarness(computeV2Config({ unexpected: true }), () => {
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

test('unsafe mirrored results are not printed and pre-owned storage is still closed', async () => {
  const harness = createCliHarness(paperV2Config(), () => {
    throw new Error('stub runtime must not invoke its data factory');
  });
  const dependencies: Partial<CliDependencies> = {
    ...harness.dependencies,
    runIntrabarServer: (async () => ({
      mode: 'mirrored',
      executionSafe: false,
      unsafeReason: 'breaker-open',
      authority: { identity: 'sha256-test' },
      binding: { id: 'binding-test' },
      evaluations: 0,
      recoveredFromSequence: 0,
    })) as CliDependencies['runIntrabarServer'],
  };

  await expect(main(['run', '--config', 'unsafe.json'], dependencies)).rejects.toThrow(
    'mirrored v2 execution stopped unsafe: breaker-open',
  );
  expect(harness.logs.some((line) => line.startsWith('{"mode":"mirrored"'))).toBe(false);
  expect(harness.counts.ledgerClose).toBe(1);
  expect(harness.removedSignals).toEqual(['SIGINT', 'SIGTERM']);
});

test('mirrored handoff refreshes recovery after lease acquisition before broker construction', async () => {
  const config = paperV2Config();
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

  expect(trace.slice(0, 4)).toEqual(['read:1', 'lease:acquire', 'read:2', 'broker:factory']);
  expect(finalJsonLog(handoff.logs).recoveredFromSequence).toBe(ownedRecovery.lastSequence);
  expect(() => recoverLedger(currentEvents)).not.toThrow();
});

test('mirrored handoff refresh accepts an old active row after its durable release', async () => {
  const config = paperV2Config();
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

  expect(trace.slice(0, 3)).toEqual(['read:1', 'lease:acquire', 'read:2']);
  expect(finalJsonLog(handoff.logs).recoveredFromSequence).toBe(
    recoverLedger(ownedPrefix).lastSequence,
  );
  expect(() => recoverLedger(currentEvents)).not.toThrow();
});
