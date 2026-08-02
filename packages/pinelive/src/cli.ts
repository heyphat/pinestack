#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { type MarketDataProvider, type ResolvedDataInstrument } from '@heyphat/pinery';
import { createNodeMarketDataProvider } from '@heyphat/pinery/node';
import {
  prepareIntrabarRun,
  runIntrabarServer,
  type AccountInstrumentClaimFactoryContext,
  type IntrabarServerResult,
  type PreparedComputeOnlyIntrabarRun,
  type PreparedMirroredIntrabarRun,
} from './core/intrabar-server.js';
import type { NormalizedRunConfig } from './core/config.js';
import type { PreparedIntrabarAuthorityEnvelope } from './core/intrabar-authority.js';
import type { Broker } from './core/broker.js';
import type { ExecutionLease, ExecutionLeaseSnapshot } from './core/lease.js';
import { PaperBroker, type PaperBrokerOptions } from './brokers/paper.js';
import { WebhookAlertChannel, type WebhookAlertChannelOptions } from './alerts/webhook.js';
import { TelegramAlertChannel, type TelegramAlertChannelOptions } from './alerts/telegram.js';
import type { AlertChannel } from './core/alerts.js';
import { normalizeAlerts, type NormalizedAlertsConfig } from './core/config.js';
import {
  FileExecutionLease,
  JsonlLedger,
  createNodeAccountInstrumentClaim,
  createNodeTigerBroker,
  readPineliveStatus,
  recoverStalePineliveClaims,
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
import type { LedgerRecord, LedgerSink } from './core/ledger.js';
import type { ExpectedPositionRecord } from './parity.js';

// Injected by scripts/build-bin.ts (`bun build --define`) so the compiled binary
// self-reports its release version + commit. Absent when running from source,
// where resolveVersion() falls back to this package's package.json — the
// compiled binary has no package.json on disk to read.
declare const PINELIVE_VERSION: string | undefined;
declare const PINELIVE_REVISION: string | undefined;

/** The CLI's version — the build define, else package.json (source runs). */
function resolveVersion(): string | undefined {
  if (typeof PINELIVE_VERSION === 'string') return PINELIVE_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version;
  } catch {
    return undefined;
  }
}

/** "pinelive <version>[ (<commit>)]" for --version. Mirrors pinerun's own line. */
function cliVersion(): string {
  const revision = typeof PINELIVE_REVISION === 'string' ? ` (${PINELIVE_REVISION})` : '';
  return `pinelive ${resolveVersion() ?? 'unknown'}${revision}`;
}

interface Args {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

type CliSignal = 'SIGINT' | 'SIGTERM';

export interface CliRuntimeStorage {
  readonly ledgerPath: string;
  readonly ledger: LedgerSink;
  readonly recoveredEvents: readonly unknown[];
  /** Shared ordinary-startup/explicit-recovery mutex for this ledger resource. */
  readonly administrativeLease: ExecutionLease;
  /** File ownership shared by the direct mirrored runtime or held internally for compute repair. */
  readonly fileLease: ExecutionLease;
}

export interface CliDependencies {
  readonly readConfig: typeof readConfig;
  readonly readSource: (path: string) => Promise<string>;
  readonly prepareIntrabarRun: typeof prepareIntrabarRun;
  readonly runIntrabarServer: typeof runIntrabarServer;
  readonly createMarketDataProvider: typeof createNodeMarketDataProvider;
  readonly createTigerBroker: typeof createNodeTigerBroker;
  readonly createAccountInstrumentClaim: typeof createNodeAccountInstrumentClaim;
  readonly createPaperBroker: (options: PaperBrokerOptions) => Broker;
  readonly createWebhookAlertChannel: (options: WebhookAlertChannelOptions) => AlertChannel;
  readonly createTelegramAlertChannel: (options: TelegramAlertChannelOptions) => AlertChannel;
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
  readonly readPineliveStatus: typeof readPineliveStatus;
  readonly recoverStalePineliveClaims: typeof recoverStalePineliveClaims;
  readonly readTigerDataCredentials: () => Readonly<TigerTradingCredentials>;
  readonly readTigerTradingCredentials: () => Readonly<TigerTradingCredentials>;
  readonly log: (message: string) => void;
  readonly addSignalHandler: (signal: CliSignal, handler: () => void) => void;
  readonly removeSignalHandler: (signal: CliSignal, handler: () => void) => void;
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

function assertCommandArgs(
  args: Args,
  command: string,
  allowedValues: readonly string[],
  allowedFlags: readonly string[],
): void {
  const unknownValue = [...args.values.keys()].find((name) => !allowedValues.includes(name));
  if (unknownValue) throw new Error(`${command} does not allow --${unknownValue}`);
  const unknownFlag = [...args.flags].find((name) => !allowedFlags.includes(name));
  if (unknownFlag) throw new Error(`${command} does not allow --${unknownFlag}`);
  if (args.positional.length > 0 && command !== 'parity')
    throw new Error(`${command} does not allow positional arguments`);
  if (command === 'parity' && args.positional.length > 2)
    throw new Error('parity accepts exactly two positional paths');
}

const defaultCliDependencies: CliDependencies = {
  readConfig,
  readSource: (path) => readFile(path, 'utf8'),
  prepareIntrabarRun,
  runIntrabarServer,
  createMarketDataProvider: createNodeMarketDataProvider,
  createTigerBroker: createNodeTigerBroker,
  createAccountInstrumentClaim: createNodeAccountInstrumentClaim,
  createPaperBroker: (options) => new PaperBroker(options),
  createWebhookAlertChannel: (options) => new WebhookAlertChannel(options),
  createTelegramAlertChannel: (options) => new TelegramAlertChannel(options),
  createJsonlLedger: (path, options) => new JsonlLedger(path, options),
  createFileExecutionLease: (path, options) => new FileExecutionLease(path, options),
  readJsonl,
  readJsonlPrefix,
  readPineliveStatus,
  recoverStalePineliveClaims,
  readTigerDataCredentials: tigerDataCredentialsFromEnvironment,
  readTigerTradingCredentials: tigerTradingCredentialsFromEnvironment,
  log: (message) => console.log(message),
  addSignalHandler: (signal, handler) => process.once(signal, handler),
  removeSignalHandler: (signal, handler) => process.off(signal, handler),
};

/** Construct the built-in channel kinds declared by config.alerts. Run-path only. */
function buildAlertChannels(
  alerts: NormalizedAlertsConfig | undefined,
  dependencies: CliDependencies,
): AlertChannel[] {
  if (!alerts || alerts.channels.length === 0) return [];
  return alerts.channels.map((channel) =>
    channel.id === 'webhook'
      ? dependencies.createWebhookAlertChannel({
          name: channel.name,
          url: channel.url,
          ...(channel.headers ? { headers: channel.headers } : {}),
          attempts: alerts.attempts,
          retryDelayMs: alerts.retryDelayMs,
        })
      : dependencies.createTelegramAlertChannel({
          name: channel.name,
          botToken: channel.botToken,
          chatId: channel.chatId,
          ...(channel.disableNotification === undefined
            ? {}
            : { disableNotification: channel.disableNotification }),
          attempts: alerts.attempts,
          retryDelayMs: alerts.retryDelayMs,
        }),
  );
}

export async function main(
  argv = process.argv.slice(2),
  overrides: Partial<CliDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaultCliDependencies, ...overrides };
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    dependencies.log('pinelive run --config <pinelive.json>');
    dependencies.log('pinelive validate --config <pinelive.json>');
    dependencies.log('pinelive status --ledger <path> [--json] [--recent <n>]');
    dependencies.log(
      'pinelive recover --ledger <path> --lease <path> [--account-claim <path>] --confirm',
    );
    dependencies.log('pinelive parity <live.jsonl> <expected.jsonl>');
    dependencies.log('pinelive upgrade [--check]');
    dependencies.log('pinelive --version');
    return;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    dependencies.log(cliVersion());
    return;
  }
  // Self-update before anything touches a config, provider, or ledger. The
  // implementation is pinerun's — same download, same mandatory sha256 check
  // against the release's checksums.txt, same atomic swap — asked to operate
  // on the `pinelive` asset.
  if (command === 'upgrade') {
    const args = parseArgs(rest);
    assertCommandArgs(args, 'upgrade', [], ['check']);
    const { runUpgrade } = await import('@heyphat/pinerun');
    await runUpgrade({
      check: args.flags.has('check'),
      currentVersion: resolveVersion(),
      binary: 'pinelive',
    });
    return;
  }
  if (command === 'status') {
    const args = parseArgs(rest);
    assertCommandArgs(args, 'status', ['ledger', 'recent'], ['json']);
    const ledgerPath = args.values.get('ledger');
    if (!ledgerPath) throw new Error('status requires --ledger <path>');
    const recentValue = args.values.get('recent');
    const recent = recentValue == null ? undefined : Number(recentValue);
    const status = await dependencies.readPineliveStatus({
      ledgerPath,
      ...(recent == null ? {} : { recent }),
    });
    if (args.flags.has('json')) dependencies.log(JSON.stringify(status));
    else
      dependencies.log(
        `ledger=${status.ledger.path} schema=${status.ledger.ledgerSchemaVersion ?? 'none'} sequence=${status.ledger.lastSequence ?? 0} partialTail=${status.ledger.partialTail}`,
      );
    return;
  }
  if (command === 'recover') {
    const args = parseArgs(rest);
    assertCommandArgs(args, 'recover', ['ledger', 'lease', 'account-claim'], ['confirm', 'json']);
    const ledgerPath = args.values.get('ledger');
    const leasePath = args.values.get('lease');
    if (!ledgerPath || !leasePath)
      throw new Error('recover requires --ledger <path> and --lease <path>');
    if (!args.flags.has('confirm'))
      throw new Error('recover requires --confirm after verifying the recorded process is gone');
    const recovered = await dependencies.recoverStalePineliveClaims({
      ledgerPath,
      leasePath,
      ...(args.values.has('account-claim')
        ? { accountClaimPath: args.values.get('account-claim')! }
        : {}),
      confirmed: true,
    });
    dependencies.log(
      args.flags.has('json')
        ? JSON.stringify(recovered)
        : `recovered ledger=${recovered.ledgerPath} sequence=${recovered.finalSequence} quarantined=${recovered.quarantinedPaths.length}`,
    );
    return;
  }
  if (command === 'parity') {
    const args = parseArgs(rest);
    assertCommandArgs(args, 'parity', [], []);
    const [livePath, expectedPath] = args.positional;
    if (!livePath || !expectedPath)
      throw new Error('parity requires <live.jsonl> <expected.jsonl>');
    const [ledger, expected] = await Promise.all([
      dependencies.readJsonl<unknown>(livePath),
      dependencies.readJsonl<ExpectedPositionRecord>(expectedPath),
    ]);
    const differences = compareLedgerParity(ledger, expected);
    dependencies.log(JSON.stringify({ matches: differences.length === 0, differences }, null, 2));
    if (differences.length > 0) process.exitCode = 2;
    return;
  }
  if (command === 'validate') {
    const args = parseArgs(rest);
    assertCommandArgs(args, 'validate', ['config'], []);
    const configPath = args.values.get('config');
    if (!configPath) throw new Error('validate requires --config <path>');
    const rawConfig = await dependencies.readConfig(configPath);
    const summary = await validateConfig(rawConfig, dependencies);
    dependencies.log(JSON.stringify({ valid: true, ...summary }));
    return;
  }
  if (command !== 'run') throw new Error(`unknown command "${command}"`);

  const args = parseArgs(rest);
  assertCommandArgs(args, 'run', ['config'], []);
  const configPath = args.values.get('config');
  if (!configPath)
    throw new Error('run requires --config <path>; direct --data CSV mode moved to pinery config');
  const rawConfig = await dependencies.readConfig(configPath);
  await runConfig(rawConfig, dependencies);
}

async function validateConfig(
  rawConfig: Readonly<Record<string, unknown>>,
  dependencies: CliDependencies,
): Promise<{
  configVersion: 3;
  mode: 'mirrored' | 'compute-only';
  cadence: 'bar-close' | 'every-update';
  history: 'standard' | 'bar-magnifier';
}> {
  const source = await dependencies.readSource(strategyPath(rawConfig));
  const prepared = dependencies.prepareIntrabarRun(rawConfig, source);
  return {
    configVersion: 3,
    mode: prepared.config.execution.kind,
    cadence: prepared.config.live.cadence,
    history: prepared.config.historical.mode,
  };
}

async function runConfig(
  rawConfig: Readonly<Record<string, unknown>>,
  dependencies: CliDependencies,
): Promise<void> {
  const source = await dependencies.readSource(strategyPath(rawConfig));
  // The branded prepare result is the only normalized value used below. No runtime factory
  // exists before this pure source/config gate completes.
  const prepared = dependencies.prepareIntrabarRun(rawConfig, source);
  const normalized = prepared.config;

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
    const storage = await openRuntimeStorage(normalized, dependencies);
    const result = await runWithStorage(
      prepared,
      normalized,
      dataFactory,
      storage,
      controller.signal,
      dependencies,
    );
    printResult(result, storage.ledgerPath, dependencies.log);
  } finally {
    dependencies.removeSignalHandler('SIGINT', stop);
    dependencies.removeSignalHandler('SIGTERM', stop);
  }
}

async function runWithStorage(
  prepared: ReturnType<typeof prepareIntrabarRun>,
  normalized: NormalizedRunConfig,
  dataFactory: () => MarketDataProvider,
  storage: CliRuntimeStorage,
  signal: AbortSignal,
  dependencies: CliDependencies,
): Promise<IntrabarServerResult> {
  const ledger = new CliOwnedLedger(storage.ledger);
  const fileLease = new CliOwnedExecutionLease(storage.fileLease);
  const administrativeLease = new CliOwnedExecutionLease(storage.administrativeLease);
  const lease = normalized.execution.kind === 'mirrored' ? fileLease : undefined;
  let mirroredRuntimeOwnsLease = false;
  let result: IntrabarServerResult | undefined;
  let primaryError: unknown;

  try {
    if (normalized.execution.kind === 'compute-only') {
      result = await dependencies.runIntrabarServer({
        prepared: prepared as PreparedComputeOnlyIntrabarRun,
        dataFactory,
        ledger,
        recoveredEvents: storage.recoveredEvents,
        alertChannels: buildAlertChannels(normalized.alerts, dependencies),
        signal,
        onLog: dependencies.log,
      });
    } else {
      if (!lease) throw new Error('mirrored runtime requires an execution lease');
      const execution = normalized.execution;
      mirroredRuntimeOwnsLease = true;
      result = await dependencies.runIntrabarServer({
        prepared: prepared as PreparedMirroredIntrabarRun,
        dataFactory,
        ledger,
        recoveredEvents: storage.recoveredEvents,
        alertChannels: buildAlertChannels(normalized.alerts, dependencies),
        refreshRecoveryAfterLease: async () => {
          const refreshed = await readCrashSafePrefix(storage.ledgerPath, dependencies);
          return {
            records: refreshed.records,
            ...(refreshed.partialFinalLine == null
              ? {}
              : { partialFinalLine: refreshed.partialFinalLine }),
          };
        },
        releaseAdministrativeLeaseAfterOwnershipRecorded: () => administrativeLease.release(),
        lease,
        signal,
        onLog: dependencies.log,
        ...(execution.broker.id === 'tiger'
          ? {
              accountClaimFactory: (context: AccountInstrumentClaimFactoryContext) =>
                dependencies.createAccountInstrumentClaim(
                  {
                    identity: context.identity,
                    executionSymbol: context.executionSymbol,
                  },
                  { ownerId: context.ownerId },
                ),
            }
          : {}),
        brokerFactory: ({ resolved, authority }) => {
          if (execution.broker.id === 'tiger') {
            return dependencies.createTigerBroker(
              execution.broker,
              execution.armed ?? false,
              dependencies.readTigerTradingCredentials(),
              { requireExecutionSafety: true },
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
  if (fileLease.snapshot && !fileLease.releaseAttempted && !mirroredRuntimeOwnsLease) {
    try {
      await fileLease.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (
    administrativeLease.snapshot &&
    !administrativeLease.releaseAttempted &&
    !(mirroredRuntimeOwnsLease && fileLease.snapshot)
  ) {
    try {
      await administrativeLease.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'pinelive runtime and ownership cleanup failed',
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'pinelive ownership cleanup failed');
  }
  if (!result) throw new Error('pinelive runtime stopped without a result');
  return result;
}

async function openRuntimeStorage(
  config: NormalizedRunConfig,
  dependencies: CliDependencies,
): Promise<CliRuntimeStorage> {
  const paths =
    config.execution.kind === 'mirrored'
      ? {
          ledgerPath: config.execution.ledger.path,
          leasePath: config.execution.lease.path,
        }
      : defaultComputeStatePaths(config);
  const runtimeOwnerId = `pinelive-runtime:${globalThis.crypto.randomUUID()}`;
  const administrativeLease = dependencies.createFileExecutionLease(
    `${paths.leasePath}.admin.lock`,
    { resource: `pinelive-admin:${paths.ledgerPath}`, ownerId: runtimeOwnerId },
  );
  const fileLease = dependencies.createFileExecutionLease(paths.leasePath, {
    resource: paths.ledgerPath,
    ownerId: runtimeOwnerId,
  });

  try {
    await administrativeLease.acquire();
    // Direct compute options intentionally contain no execution lease. Hold the ledger's repair
    // lease before reading so its recovery prefix cannot become stale before sequence allocation.
    if (config.execution.kind === 'compute-only') await fileLease.acquire();
    const prefix = await readCrashSafePrefix(paths.ledgerPath, dependencies);
    const ledger = dependencies.createJsonlLedger(paths.ledgerPath, {
      durability: 'sync',
      tailPolicy: 'repair',
      lease: fileLease,
      releaseLeaseOnClose: config.execution.kind === 'compute-only',
    });
    if (config.execution.kind === 'compute-only') await administrativeLease.release();
    return {
      ledgerPath: paths.ledgerPath,
      ledger,
      recoveredEvents: prefix.records,
      administrativeLease,
      fileLease,
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (fileLease.snapshot) {
      try {
        await fileLease.release();
      } catch (releaseError) {
        cleanupErrors.push(releaseError);
      }
    }
    if (administrativeLease.snapshot) {
      try {
        await administrativeLease.release();
      } catch (releaseError) {
        cleanupErrors.push(releaseError);
      }
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        [error, ...cleanupErrors],
        'storage preparation and ownership cleanup failed',
      );
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

function printResult(
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
    log(
      JSON.stringify({
        ...common,
        posture: result.posture,
        executionEligibility: result.executionEligibility,
        eligibilityReasons: result.eligibilityReasons,
        executionSafe: false,
        unsafeReason: result.unsafeReason,
      }),
    );
    return;
  }
  log(
    JSON.stringify({
      ...common,
      posture: result.posture,
      executionEligibility: result.executionEligibility,
      eligibilityReasons: result.eligibilityReasons,
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

function defaultComputeStatePaths(config: NormalizedRunConfig): {
  ledgerPath: string;
  leasePath: string;
} {
  const key = `${config.strategy}-${config.symbol}-${config.timeframe}`.replace(
    /[^a-z0-9_.-]+/gi,
    '_',
  );
  const ledgerPath = `.pinelive/${key}.jsonl`;
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
