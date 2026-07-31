#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { CompileError, compile } from '@heyphat/piner';
import {
  assertLiveSymbolMatchesConfig,
  assertProviderConfig,
  type MarketDataProvider,
  type ProviderConfig,
  type ResolvedDataInstrument,
} from '@heyphat/pinery';
import { createNodeMarketDataProvider } from '@heyphat/pinery/node';
import { runForwardServer } from './core/server.js';
import {
  prepareIntrabarRun,
  runIntrabarServer,
  type IntrabarServerResult,
  type PreparedComputeOnlyIntrabarRun,
  type PreparedMirroredIntrabarRun,
} from './core/intrabar-server.js';
import {
  normalizeRunConfig,
  type NormalizedMirroredExecutionConfig,
  type NormalizedV1RunConfig,
  type NormalizedV2RunConfig,
} from './core/config.js';
import type { PreparedIntrabarAuthorityEnvelope } from './core/intrabar-authority.js';
import type { Broker } from './core/broker.js';
import type { ExecutionLease, ExecutionLeaseSnapshot } from './core/lease.js';
import { PaperBroker, type PaperBrokerOptions } from './brokers/paper.js';
import {
  FileExecutionLease,
  JsonlLedger,
  createNodeTigerBroker,
  readConfig,
  readJsonl,
  readJsonlPrefix,
  type JsonlLedgerOptions,
  type JsonlPrefix,
  type NodeExclusiveFileLeaseOptions,
  type ReadJsonlOptions,
  type TigerTradingCredentials,
} from './node.js';
import { compareLedgerParity } from './parity.js';
import type { ForwardRecord, LedgerRecord, LedgerSink } from './core/ledger.js';
import type { ExpectedPositionRecord } from './parity.js';

interface Args {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

type CliSignal = 'SIGINT' | 'SIGTERM';

export interface CliV2RuntimeStorage {
  readonly ledgerPath: string;
  readonly ledger: LedgerSink;
  readonly recoveredEvents: readonly unknown[];
  /** File ownership shared by the direct mirrored runtime or held internally for compute repair. */
  readonly fileLease: ExecutionLease;
}

export interface CliDependencies {
  readonly readConfig: typeof readConfig;
  readonly readSource: (path: string) => Promise<string>;
  readonly normalizeRunConfig: typeof normalizeRunConfig;
  readonly prepareIntrabarRun: typeof prepareIntrabarRun;
  readonly runForwardServer: typeof runForwardServer;
  readonly runIntrabarServer: typeof runIntrabarServer;
  readonly createMarketDataProvider: typeof createNodeMarketDataProvider;
  readonly createTigerBroker: typeof createNodeTigerBroker;
  readonly createPaperBroker: (options: PaperBrokerOptions) => Broker;
  readonly createJsonlLedger: (path: string, options?: JsonlLedgerOptions) => LedgerSink;
  readonly createFileExecutionLease: (
    path: string,
    options?: NodeExclusiveFileLeaseOptions,
  ) => ExecutionLease;
  readonly readJsonl: <T>(path: string, options?: ReadJsonlOptions | boolean) => Promise<T[]>;
  readonly readJsonlPrefix: <T>(
    path: string,
    options?: ReadJsonlOptions | boolean,
  ) => Promise<JsonlPrefix<T>>;
  readonly readTigerProfileOverride: () => string | undefined;
  readonly readTigerDataCredentials: () => Readonly<TigerTradingCredentials>;
  readonly readTigerTradingCredentials: () => Readonly<TigerTradingCredentials>;
  readonly log: (message: string) => void;
  readonly addSignalHandler: (signal: CliSignal, handler: () => void) => void;
  readonly removeSignalHandler: (signal: CliSignal, handler: () => void) => void;
}

export interface OrderPolicyConfig {
  type: 'market' | 'limit';
  /** Passive ticks from the closed-bar price. Buy subtracts; sell adds. */
  limitOffsetTicks?: number;
}

export interface RunConfig {
  configVersion?: 1;
  strategy: string;
  symbol: string;
  timeframe: string;
  warmupBars?: number;
  inputs?: Readonly<Record<string, unknown>>;
  executionId?: string;
  reconcileOnStart?: boolean;
  /** Market by default; limit mode derives a tick-aligned price from each closed bar. */
  order?: OrderPolicyConfig;
  /** Resolve `request.security` dependencies via secondary provider feeds. Default true. */
  resolveSecurity?: boolean;
  /** Secondary-feed bars fetched at startup. Defaults to chart-history bars actually received. */
  securityWarmupBars?: number;
  /** Hard total-series ceiling per secondary feed. */
  maxSecurityBars?: number;
  maxSecurityFeeds?: number;
  securityConcurrency?: number;
  securityRequestTimeoutMs?: number;
  maxSecurityStaleRefreshes?: number;
  data: ProviderConfig;
  /** One credential-profile path applied to Tiger data and broker sections that omit their own. */
  tigerProfile?: string;
  broker:
    | { id: 'paper'; initialBalance?: number; slippageBps?: number; commissionPerUnit?: number }
    | {
        id: 'tiger';
        profile?: string;
        account?: string;
        orderPollIntervalMs?: number;
        maxOrderPolls?: number;
        cancelStuckOrders?: boolean;
      };
  armed?: boolean;
  ledger?: string;
}

function parseArgs(args: string[]): Args {
  const parsed: Args = { positional: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      parsed.positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next != null && !next.startsWith('--')) {
      parsed.values.set(name, next);
      i++;
    } else parsed.flags.add(name);
  }
  return parsed;
}

export function parseRunConfig(value: Readonly<Record<string, unknown>>): RunConfig {
  assertConfigKeys(
    value,
    [
      'configVersion',
      'strategy',
      'symbol',
      'timeframe',
      'warmupBars',
      'inputs',
      'executionId',
      'reconcileOnStart',
      'order',
      'resolveSecurity',
      'securityWarmupBars',
      'maxSecurityBars',
      'maxSecurityFeeds',
      'securityConcurrency',
      'securityRequestTimeoutMs',
      'maxSecurityStaleRefreshes',
      'data',
      'tigerProfile',
      'broker',
      'armed',
      'ledger',
    ],
    'config',
  );
  for (const field of ['strategy', 'symbol', 'timeframe'] as const)
    if (typeof value[field] !== 'string' || !value[field])
      throw new Error(`config.${field} must be a non-empty string`);
  if (value.configVersion != null && value.configVersion !== 1)
    throw new Error('unsupported configVersion');
  if (
    value.warmupBars != null &&
    (!Number.isInteger(value.warmupBars) || (value.warmupBars as number) < 0)
  )
    throw new Error('config.warmupBars must be a non-negative integer');
  let order: OrderPolicyConfig | undefined;
  if (value.order != null) {
    if (typeof value.order !== 'object' || Array.isArray(value.order))
      throw new Error('config.order must be an object');
    const orderValue = value.order as Record<string, unknown>;
    assertConfigKeys(orderValue, ['type', 'limitOffsetTicks'], 'config.order');
    if (orderValue.type !== 'market' && orderValue.type !== 'limit')
      throw new Error('config.order.type must be "market" or "limit"');
    if (
      orderValue.limitOffsetTicks != null &&
      (!Number.isInteger(orderValue.limitOffsetTicks) ||
        (orderValue.limitOffsetTicks as number) < 0)
    )
      throw new Error('config.order.limitOffsetTicks must be a non-negative integer');
    if (orderValue.type === 'market' && orderValue.limitOffsetTicks != null)
      throw new Error('config.order.limitOffsetTicks is only valid for limit orders');
    order = {
      type: orderValue.type,
      limitOffsetTicks: orderValue.limitOffsetTicks as number | undefined,
    };
  }
  for (const field of [
    'securityWarmupBars',
    'maxSecurityBars',
    'maxSecurityFeeds',
    'securityConcurrency',
    'securityRequestTimeoutMs',
  ] as const)
    if (value[field] != null && (!Number.isInteger(value[field]) || (value[field] as number) < 1))
      throw new Error(`config.${field} must be a positive integer`);
  if (
    value.maxSecurityStaleRefreshes != null &&
    (!Number.isInteger(value.maxSecurityStaleRefreshes) ||
      (value.maxSecurityStaleRefreshes as number) < 0)
  )
    throw new Error('config.maxSecurityStaleRefreshes must be a non-negative integer');
  if (
    value.securityWarmupBars != null &&
    value.maxSecurityBars != null &&
    (value.securityWarmupBars as number) > (value.maxSecurityBars as number)
  )
    throw new Error('config.securityWarmupBars must not exceed config.maxSecurityBars');
  const data = assertProviderConfig(value.data);
  if (value.tigerProfile != null && typeof value.tigerProfile !== 'string')
    throw new Error('config.tigerProfile must be a string');
  const tigerProfile = value.tigerProfile as string | undefined;
  const brokerValue = value.broker === undefined ? { id: 'paper' } : value.broker;
  if (!brokerValue || typeof brokerValue !== 'object' || Array.isArray(brokerValue))
    throw new Error('config.broker must be an object');
  const broker = brokerValue as Record<string, unknown>;
  if (broker.id !== 'paper' && broker.id !== 'tiger')
    throw new Error('config.broker.id must be "paper" or "tiger"');
  if (broker.id === 'paper') {
    assertConfigKeys(
      broker,
      ['id', 'initialBalance', 'slippageBps', 'commissionPerUnit'],
      'config.broker',
    );
    for (const field of ['initialBalance', 'slippageBps', 'commissionPerUnit'] as const) {
      if (
        broker[field] != null &&
        (typeof broker[field] !== 'number' || !Number.isFinite(broker[field]))
      )
        throw new Error(`config.broker.${field} must be numeric`);
    }
  } else {
    assertConfigKeys(
      broker,
      ['id', 'profile', 'account', 'orderPollIntervalMs', 'maxOrderPolls', 'cancelStuckOrders'],
      'config.broker',
    );
    if (broker.profile != null && typeof broker.profile !== 'string')
      throw new Error('config.broker.profile must be a string');
    if (broker.account != null && typeof broker.account !== 'string')
      throw new Error('config.broker.account must be a string');
    for (const field of ['orderPollIntervalMs', 'maxOrderPolls'] as const)
      if (
        broker[field] != null &&
        (!Number.isInteger(broker[field]) || (broker[field] as number) < 0)
      )
        throw new Error(`config.broker.${field} must be a non-negative integer`);
    if (broker.cancelStuckOrders != null && typeof broker.cancelStuckOrders !== 'boolean')
      throw new Error('config.broker.cancelStuckOrders must be boolean');
    if (order?.type === 'limit' && broker.cancelStuckOrders !== true)
      throw new Error('Tiger limit orders require config.broker.cancelStuckOrders=true');
  }
  if (value.armed != null && typeof value.armed !== 'boolean')
    throw new Error('config.armed must be boolean');
  if (value.reconcileOnStart != null && typeof value.reconcileOnStart !== 'boolean')
    throw new Error('config.reconcileOnStart must be boolean');
  if (value.resolveSecurity != null && typeof value.resolveSecurity !== 'boolean')
    throw new Error('config.resolveSecurity must be boolean');
  if (value.executionId != null && typeof value.executionId !== 'string')
    throw new Error('config.executionId must be a string');
  if (value.ledger != null && typeof value.ledger !== 'string')
    throw new Error('config.ledger must be a string');
  if (
    value.inputs != null &&
    (typeof value.inputs !== 'object' || value.inputs == null || Array.isArray(value.inputs))
  )
    throw new Error('config.inputs must be an object');
  return {
    ...(value as unknown as RunConfig),
    configVersion: 1,
    order,
    // One profile path covers both sections; an explicit section value still wins.
    data:
      tigerProfile != null && data.provider === 'tiger' && data.profile == null
        ? { ...data, profile: tigerProfile }
        : data,
    broker: (tigerProfile != null && broker.id === 'tiger' && broker.profile == null
      ? { ...broker, profile: tigerProfile }
      : broker) as unknown as RunConfig['broker'],
  };
}

function assertConfigKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${path}.${unknown} is not allowed`);
}

const defaultCliDependencies: CliDependencies = {
  readConfig,
  readSource: (path) => readFile(path, 'utf8'),
  normalizeRunConfig,
  prepareIntrabarRun,
  runForwardServer,
  runIntrabarServer,
  createMarketDataProvider: createNodeMarketDataProvider,
  createTigerBroker: createNodeTigerBroker,
  createPaperBroker: (options) => new PaperBroker(options),
  createJsonlLedger: (path, options) => new JsonlLedger(path, options),
  createFileExecutionLease: (path, options) => new FileExecutionLease(path, options),
  readJsonl,
  readJsonlPrefix,
  readTigerProfileOverride: () => process.env.TIGEROPEN_CONFIG_PATH,
  readTigerDataCredentials: tigerDataCredentialsFromEnvironment,
  readTigerTradingCredentials: tigerTradingCredentialsFromEnvironment,
  log: (message) => console.log(message),
  addSignalHandler: (signal, handler) => process.once(signal, handler),
  removeSignalHandler: (signal, handler) => process.off(signal, handler),
};

export async function main(
  argv = process.argv.slice(2),
  overrides: Partial<CliDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultCliDependencies, ...overrides };
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    dependencies.log('pinelive run --config <pinelive.json> [--tiger-profile <path>]');
    dependencies.log('pinelive validate --config <pinelive.json>');
    dependencies.log('pinelive parity <live.jsonl> <expected.jsonl>');
    return;
  }
  if (command === 'parity') {
    const args = parseArgs(rest);
    const [livePath, expectedPath] = args.positional;
    if (!livePath || !expectedPath)
      throw new Error('parity requires <live.jsonl> <expected.jsonl>');
    const [ledger, expected] = await Promise.all([
      dependencies.readJsonl<LedgerRecord>(livePath),
      dependencies.readJsonl<ExpectedPositionRecord>(expectedPath),
    ]);
    const live = ledger.filter(
      (row): row is ForwardRecord =>
        row.schemaVersion !== 3 &&
        row.recordType !== 'binding' &&
        row.recordType !== 'startup' &&
        row.recordType !== 'security',
    );
    const differences = compareLedgerParity(live, expected);
    dependencies.log(JSON.stringify({ matches: differences.length === 0, differences }, null, 2));
    if (differences.length > 0) process.exitCode = 2;
    return;
  }
  if (command === 'validate') {
    const args = parseArgs(rest);
    const configPath = args.values.get('config');
    if (!configPath) throw new Error('validate requires --config <path>');
    const rawConfig = await dependencies.readConfig(configPath);
    const summary = await validateConfig(rawConfig, dependencies);
    dependencies.log(JSON.stringify({ valid: true, ...summary }));
    return;
  }
  if (command !== 'run') throw new Error(`unknown command "${command}"`);

  const args = parseArgs(rest);
  const configPath = args.values.get('config');
  if (!configPath)
    throw new Error('run requires --config <path>; direct --data CSV mode moved to pinery config');
  const rawConfig = await dependencies.readConfig(configPath);
  if (rawConfig.configVersion === 2) {
    await runV2Config(rawConfig, args, dependencies);
    return;
  }
  const config = dependencies.normalizeRunConfig(rawConfig);
  if (config.configVersion !== 1) throw new Error('internal v1 dispatch mismatch');
  await runV1Config(config, args, dependencies);
}

async function validateConfig(
  rawConfig: Readonly<Record<string, unknown>>,
  dependencies: CliDependencies,
): Promise<{
  configVersion: 1 | 2;
  mode: 'mirrored' | 'compute-only';
  cadence: 'bar-close' | 'every-update';
  history: 'standard' | 'bar-magnifier';
}> {
  if (rawConfig.configVersion === 2) {
    const source = await dependencies.readSource(strategyPath(rawConfig));
    const prepared = dependencies.prepareIntrabarRun(rawConfig, source);
    return {
      configVersion: 2,
      mode: prepared.config.execution.kind,
      cadence: prepared.config.live.cadence,
      history: prepared.config.historical.mode,
    };
  }

  const normalized = dependencies.normalizeRunConfig(rawConfig);
  if (normalized.configVersion !== 1) throw new Error('internal v1 validation mismatch');
  const source = await dependencies.readSource(normalized.strategy);
  validateV1Source(normalized, source);
  return {
    configVersion: 1,
    mode: 'mirrored',
    cadence: 'bar-close',
    history: 'standard',
  };
}

function validateV1Source(config: NormalizedV1RunConfig, source: string): void {
  assertLiveSymbolMatchesConfig(config.symbol, config.data);
  let compiled;
  try {
    compiled = compile(source);
  } catch (error) {
    throw new Error(error instanceof CompileError ? error.message : 'Pine compilation failed', {
      cause: error,
    });
  }
  const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Pine compilation failed: ${errors.map((error) => error.message).join('; ')}`);
  }
  if (!compiled.metadata.isStrategy) {
    throw new Error('Pine source must declare a strategy(), not an indicator()');
  }
  if (compiled.metadata.securityDependencies.length > 0 && config.resolveSecurity === false) {
    throw new Error(
      'this strategy uses request.security but resolveSecurity is disabled; those requests ' +
        'would degrade to na and the strategy would trade differently than it backtested',
    );
  }
}

async function runV1Config(
  config: NormalizedV1RunConfig,
  args: Args,
  dependencies: CliDependencies,
): Promise<void> {
  const usesTiger = config.data.provider === 'tiger' || config.broker.id === 'tiger';
  const tigerProfileOverride =
    args.values.get('tiger-profile') ??
    (usesTiger ? dependencies.readTigerProfileOverride() : undefined);
  if (tigerProfileOverride != null && config.tigerProfile == null) {
    if (config.data.provider === 'tiger' && config.data.profile == null)
      config.data = { ...config.data, profile: tigerProfileOverride };
    if (config.broker.id === 'tiger' && config.broker.profile == null)
      config.broker = { ...config.broker, profile: tigerProfileOverride };
  }
  const runSymbol = assertLiveSymbolMatchesConfig(config.symbol, config.data);
  const tradingCredentials =
    config.broker.id === 'tiger' ? dependencies.readTigerTradingCredentials() : undefined;
  const dataCredentials =
    config.data.provider === 'tiger'
      ? (tradingCredentials ?? dependencies.readTigerDataCredentials())
      : undefined;
  const data =
    config.data.provider === 'tiger'
      ? dependencies.createMarketDataProvider(config.data, {
          tigerCredentials: tigerDataCredentialSlice(dataCredentials!),
        })
      : dependencies.createMarketDataProvider(config.data);
  const armed = config.armed ?? false;

  let broker: Broker;
  if (config.broker.id === 'tiger') {
    broker = dependencies.createTigerBroker(config.broker, armed, tradingCredentials);
  } else {
    broker = dependencies.createPaperBroker({
      instrumentResolver: async (symbol) => {
        const resolved = await data.resolve(runSymbol, { strict: true });
        if (resolved.venueSymbol !== symbol)
          throw new Error('paper broker requested a contract different from pinery resolution');
        return paperInstrument(resolved);
      },
      initialBalance: config.broker.initialBalance,
      slippageBps: config.broker.slippageBps,
      commissionPerUnit: config.broker.commissionPerUnit,
    });
  }

  const source = await dependencies.readSource(config.strategy);
  const ledgerPath = config.ledger ?? '.pinelive/ledger.jsonl';
  const ledger = dependencies.createJsonlLedger(ledgerPath);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  dependencies.addSignalHandler('SIGINT', stop);
  dependencies.addSignalHandler('SIGTERM', stop);
  try {
    const result = await dependencies.runForwardServer({
      source,
      symbol: runSymbol,
      timeframe: config.timeframe,
      data,
      broker,
      ledger,
      warmupBars: config.warmupBars,
      inputs: config.inputs,
      executionId: config.executionId,
      reconcileOnStart: config.reconcileOnStart,
      resolveSecurity: config.resolveSecurity,
      securityWarmupBars: config.securityWarmupBars,
      maxSecurityBars: config.maxSecurityBars,
      maxSecurityFeeds: config.maxSecurityFeeds,
      securityConcurrency: config.securityConcurrency,
      securityRequestTimeoutMs: config.securityRequestTimeoutMs,
      maxSecurityStaleRefreshes: config.maxSecurityStaleRefreshes,
      mirror: {
        orderType: config.order?.type,
        limitOffsetTicks: config.order?.limitOffsetTicks,
      },
      signal: controller.signal,
      onLog: dependencies.log,
    });
    dependencies.log(
      `stopped: contract=${result.binding.executionSymbol} position=${result.finalPosition} equity=${result.finalEquity} ledger=${ledgerPath}`,
    );
  } finally {
    dependencies.removeSignalHandler('SIGINT', stop);
    dependencies.removeSignalHandler('SIGTERM', stop);
  }
}

async function runV2Config(
  rawConfig: Readonly<Record<string, unknown>>,
  args: Args,
  dependencies: CliDependencies,
): Promise<void> {
  const source = await dependencies.readSource(strategyPath(rawConfig));
  // The branded prepare result is the only normalized v2 value used below. No runtime factory
  // exists before this pure source/config gate completes.
  const prepared = dependencies.prepareIntrabarRun(rawConfig, source);
  if (args.values.has('tiger-profile')) {
    throw new Error('v2 requires Tiger profiles inside the strict data/broker sections');
  }
  const normalized = prepared.config;
  if (normalized.execution.kind === 'mirrored' && normalized.execution.broker.id === 'tiger') {
    throw new Error(
      'Tiger v2 broker execution is unavailable until the credentialed release gate passes',
    );
  }

  const dataFactory = (): MarketDataProvider =>
    normalized.data.provider === 'tiger'
      ? dependencies.createMarketDataProvider(normalized.data, {
          tigerCredentials: tigerDataCredentialSlice(dependencies.readTigerDataCredentials()),
        })
      : dependencies.createMarketDataProvider(normalized.data);

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  dependencies.addSignalHandler('SIGINT', stop);
  dependencies.addSignalHandler('SIGTERM', stop);
  try {
    const storage = await openV2RuntimeStorage(normalized, dependencies);
    const result = await runV2WithStorage(
      prepared,
      normalized,
      dataFactory,
      storage,
      controller.signal,
      dependencies,
    );
    printV2Result(result, storage.ledgerPath, dependencies.log);
  } finally {
    dependencies.removeSignalHandler('SIGINT', stop);
    dependencies.removeSignalHandler('SIGTERM', stop);
  }
}

async function runV2WithStorage(
  prepared: ReturnType<typeof prepareIntrabarRun>,
  normalized: NormalizedV2RunConfig,
  dataFactory: () => MarketDataProvider,
  storage: CliV2RuntimeStorage,
  signal: AbortSignal,
  dependencies: CliDependencies,
): Promise<IntrabarServerResult> {
  const ledger = new CliOwnedLedger(storage.ledger);
  const fileLease = new CliOwnedExecutionLease(storage.fileLease);
  const lease = normalized.execution.kind === 'mirrored' ? fileLease : undefined;
  let result: IntrabarServerResult | undefined;
  let primaryError: unknown;

  try {
    if (normalized.execution.kind === 'compute-only') {
      result = await dependencies.runIntrabarServer({
        prepared: prepared as PreparedComputeOnlyIntrabarRun,
        dataFactory,
        ledger,
        recoveredEvents: storage.recoveredEvents,
        signal,
        onLog: dependencies.log,
      });
    } else {
      if (!lease) throw new Error('mirrored v2 runtime requires an execution lease');
      const execution = normalized.execution;
      result = await dependencies.runIntrabarServer({
        prepared: prepared as PreparedMirroredIntrabarRun,
        dataFactory,
        ledger,
        recoveredEvents: storage.recoveredEvents,
        refreshRecoveryAfterLease: async () => {
          const refreshed = await readCrashSafePrefix(storage.ledgerPath, dependencies);
          return {
            records: refreshed.records,
            ...(refreshed.partialFinalLine == null
              ? {}
              : { partialFinalLine: refreshed.partialFinalLine }),
          };
        },
        lease,
        signal,
        onLog: dependencies.log,
        brokerFactory: ({ resolved, authority }) => {
          if (execution.broker.id === 'tiger') {
            throw new Error(
              'Tiger v2 broker execution is unavailable until the credentialed release gate passes',
            );
          }
          assertPaperAuthority(resolved, authority);
          return dependencies.createPaperBroker({
            instruments: {
              [resolved.venueSymbol]: paperInstrument(resolved),
            },
            initialBalance: execution.broker.initialBalance,
            slippageBps: execution.broker.slippageBps,
            commissionPerUnit: execution.broker.commissionPerUnit,
          });
        },
      });
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (!ledger.closeAttempted) {
    try {
      await ledger.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (fileLease.snapshot && !fileLease.releaseAttempted) {
    try {
      await fileLease.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'pinelive v2 runtime and ownership cleanup failed',
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'pinelive v2 ownership cleanup failed');
  }
  if (!result) throw new Error('pinelive v2 runtime stopped without a result');
  return result;
}

async function openV2RuntimeStorage(
  config: NormalizedV2RunConfig,
  dependencies: CliDependencies,
): Promise<CliV2RuntimeStorage> {
  const paths =
    config.execution.kind === 'mirrored'
      ? {
          ledgerPath: config.execution.ledger.path,
          leasePath: config.execution.lease.path,
        }
      : defaultComputeStatePaths(config);
  const fileLease = dependencies.createFileExecutionLease(paths.leasePath, {
    resource: paths.ledgerPath,
  });

  try {
    // Direct compute options intentionally contain no execution lease. Hold the ledger's repair
    // lease before reading so its recovery prefix cannot become stale before sequence allocation.
    if (config.execution.kind === 'compute-only') await fileLease.acquire();
    const prefix = await readCrashSafePrefix(paths.ledgerPath, dependencies);
    const ledger = dependencies.createJsonlLedger(paths.ledgerPath, {
      durability: 'sync',
      tailPolicy: 'repair',
      lease: fileLease,
    });
    return {
      ledgerPath: paths.ledgerPath,
      ledger,
      recoveredEvents: prefix.records,
      fileLease,
    };
  } catch (error) {
    if (!fileLease.snapshot) throw error;
    try {
      await fileLease.release();
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'v2 storage preparation and lease cleanup failed',
      );
    }
    throw error;
  }
}

async function readCrashSafePrefix(
  ledgerPath: string,
  dependencies: CliDependencies,
): Promise<JsonlPrefix<unknown>> {
  try {
    return await dependencies.readJsonlPrefix<unknown>(ledgerPath, {
      allowPartialFinalLine: true,
    });
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
    return { records: [], validBytes: 0, totalBytes: 0 };
  }
}

class CliOwnedLedger implements LedgerSink {
  closeAttempted = false;
  private closeValue?: Promise<void>;

  constructor(private readonly delegate: LedgerSink) {}

  append(record: LedgerRecord): Promise<void> {
    return this.delegate.append(record);
  }

  flush(): Promise<void> {
    return Promise.resolve(this.delegate.flush?.());
  }

  close(): Promise<void> {
    if (this.closeValue) return this.closeValue;
    this.closeAttempted = true;
    this.closeValue = Promise.resolve(this.delegate.close?.());
    return this.closeValue;
  }
}

class CliOwnedExecutionLease implements ExecutionLease {
  releaseAttempted = false;
  private releaseValue?: Promise<void>;

  constructor(private readonly delegate: ExecutionLease) {}

  get resource(): string {
    return this.delegate.resource;
  }

  get ownerId(): string {
    return this.delegate.ownerId;
  }

  get snapshot(): ExecutionLeaseSnapshot | undefined {
    return this.delegate.snapshot;
  }

  acquire(): Promise<ExecutionLeaseSnapshot> {
    return this.delegate.acquire();
  }

  assertHeld(): void | Promise<void> {
    return this.delegate.assertHeld();
  }

  release(): Promise<void> {
    if (this.releaseValue) return this.releaseValue;
    this.releaseAttempted = true;
    this.releaseValue = this.delegate.release();
    return this.releaseValue;
  }
}

function printV2Result(
  result: IntrabarServerResult,
  ledgerPath: string,
  log: (message: string) => void,
): void {
  const common = {
    mode: result.mode,
    authority: result.authority.identity,
    binding: result.binding.id,
    evaluations: result.evaluations,
    recoveredFromSequence: result.recoveredFromSequence,
    ...(result.lastFinalCursor == null ? {} : { lastFinalCursor: result.lastFinalCursor }),
    ...(result.latestDecision == null ? {} : { latestDecision: result.latestDecision }),
    ledger: ledgerPath,
  };
  if (result.mode === 'compute-only') {
    log(JSON.stringify(common));
    return;
  }
  if (!result.executionSafe) {
    throw new Error(`mirrored v2 execution stopped unsafe: ${result.unsafeReason}`);
  }
  log(
    JSON.stringify({
      ...common,
      executionSafe: true,
      finalPosition: result.finalPosition,
      finalAccount: result.finalAccount,
    }),
  );
}

function assertPaperAuthority(
  resolved: ResolvedDataInstrument,
  authority: PreparedIntrabarAuthorityEnvelope,
): void {
  const provider = authority.prepared.provider;
  if (
    provider.handle !== resolved.providerHandle ||
    provider.strategySymbol !== resolved.strategySymbol ||
    provider.venueSymbol !== resolved.venueSymbol ||
    provider.mintick !== resolved.mintick ||
    provider.qtyStep !== resolved.qtyStep ||
    provider.minOrderQty !== resolved.minOrderQty
  ) {
    throw new Error('prepared authority does not match the resolved Paper instrument');
  }
}

function paperInstrument(resolved: ResolvedDataInstrument) {
  return {
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
  };
}

function strategyPath(config: Readonly<Record<string, unknown>>): string {
  if (typeof config.strategy !== 'string' || config.strategy.length === 0) {
    throw new Error('config.strategy must be a non-empty string');
  }
  return config.strategy;
}

function defaultComputeStatePaths(config: NormalizedV2RunConfig): {
  ledgerPath: string;
  leasePath: string;
} {
  const key = `${config.strategy}-${config.symbol}-${config.timeframe}`.replace(
    /[^a-z0-9_.-]+/gi,
    '_',
  );
  const ledgerPath = `.pinelive/${key}.v2.jsonl`;
  return { ledgerPath, leasePath: `${ledgerPath}.lock` };
}

function tigerDataCredentialSlice(
  credentials: Readonly<TigerTradingCredentials>,
): TigerTradingCredentials {
  return {
    tigerId: credentials.tigerId,
    privateKey: credentials.privateKey,
    account: credentials.account,
    license: credentials.license,
    token: credentials.token,
  };
}

function tigerDataCredentialsFromEnvironment(): TigerTradingCredentials {
  return {
    tigerId: process.env.TIGEROPEN_TIGER_ID ?? process.env.TIGER_ID,
    privateKey: process.env.TIGEROPEN_PRIVATE_KEY ?? process.env.TIGER_PRIVATE_KEY,
    account: process.env.TIGEROPEN_ACCOUNT ?? process.env.TIGER_ACCOUNT,
    license: process.env.TIGEROPEN_LICENSE,
    token: process.env.TIGEROPEN_TOKEN,
  };
}

function tigerTradingCredentialsFromEnvironment(): TigerTradingCredentials {
  return {
    ...tigerDataCredentialsFromEnvironment(),
    secretKey: process.env.TIGEROPEN_SECRET_KEY,
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

if (import.meta.main)
  main().catch((error) => {
    console.error(`pinelive: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
