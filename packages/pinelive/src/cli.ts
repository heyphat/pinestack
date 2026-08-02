#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { type MarketDataProvider, type ResolvedDataInstrument } from '@heyphat/pinery';
import { createNodeMarketDataProvider } from '@heyphat/pinery/node';
import {
  prepareIntrabarRun,
  runIntrabarServer,
  type AccountInstrumentClaimFactoryContext,
  type IntrabarServerReadiness,
  type IntrabarServerResult,
  type IntrabarServerTerminal,
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
  NodeRunRegistry,
  createNodeAccountInstrumentClaim,
  createRunInstanceId,
  createNodeTigerBroker,
  readBootBoundProcessIdentity,
  readPineliveInstanceStatus,
  readPineliveStatus,
  readPineliveStatusList,
  recoverStalePineliveClaims,
  resolveRunRegistrationPath,
  readConfig,
  readJsonl,
  readJsonlPrefix,
  type ActiveRunRegistrationV1,
  type DiscoveredRunStatusV1,
  type JsonlLedgerOptions,
  type JsonlPrefix,
  type NodeExclusiveFileLeaseOptions,
  type PineliveStatusListV1,
  type ReadJsonlOptions,
  type RunHistoryOutcome,
  type RunHistoryRecordV1,
  type TigerTradingCredentials,
} from './node.js';
import { compareLedgerParity } from './parity.js';
import type { EffectiveRunPosture, LedgerRecord, LedgerSink } from './core/ledger.js';
import { recoverLedger, type LedgerRecoveryState } from './core/recovery.js';
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

export interface CliHeartbeatService {
  start(): void;
  stop(): Promise<void>;
}

export interface CliRunRegistry {
  writeActive(record: ActiveRunRegistrationV1): Promise<void>;
  updateActive(
    instanceId: string,
    update: (
      current: ActiveRunRegistrationV1,
    ) => ActiveRunRegistrationV1 | Promise<ActiveRunRegistrationV1>,
  ): Promise<ActiveRunRegistrationV1>;
  createHeartbeatService(
    instanceId: string,
    options?: {
      readonly onWarning?: (warning: {
        readonly code: 'heartbeat-write-failed';
        readonly failureCount: number;
      }) => void;
    },
  ): CliHeartbeatService;
  completeRun(record: RunHistoryRecordV1): Promise<{ readonly activeRemoved: boolean }>;
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
  readonly readPineliveStatusList: typeof readPineliveStatusList;
  readonly readPineliveInstanceStatus: typeof readPineliveInstanceStatus;
  readonly createRunRegistry: () => CliRunRegistry;
  readonly createRunInstanceId: typeof createRunInstanceId;
  readonly readBootBoundProcessIdentity: typeof readBootBoundProcessIdentity;
  readonly resolveRunRegistrationPath: typeof resolveRunRegistrationPath;
  /** Upper bound for each advisory registry or terminal-status operation. */
  readonly registryOperationTimeoutMs: number;
  readonly now: () => Date;
  readonly pid: number;
  readonly cwd: () => string;
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
  readPineliveStatusList,
  readPineliveInstanceStatus,
  createRunRegistry: () => new NodeRunRegistry(),
  createRunInstanceId,
  readBootBoundProcessIdentity,
  resolveRunRegistrationPath,
  registryOperationTimeoutMs: 1_000,
  now: () => new Date(),
  pid: process.pid,
  cwd: () => process.cwd(),
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

function printStatusList(status: PineliveStatusListV1, log: (message: string) => void): void {
  log(
    escapeTerminalText(
      `statusListVersion=${status.statusListVersion} generatedAt=${status.generatedAt} items=${status.items.length}`,
    ),
  );
  for (const item of status.items) {
    if (item.ok) log(formatDiscoveredStatus(item.value));
    else
      log(
        escapeTerminalText(
          `error instance=${item.instanceIdHint ?? 'unknown'} code=${item.error.code}` +
            `${item.path ? ` path=${item.path}` : ''} message=${item.error.message}`,
        ),
      );
  }
}

function formatDiscoveredStatus(status: DiscoveredRunStatusV1): string {
  const identity = status.kind === 'active' ? status.registration : status.history;
  const identifiers =
    `instance=${status.instanceId}` +
    `${identity.runId ? ` run=${identity.runId}` : ''}` +
    `${identity.executionId ? ` execution=${identity.executionId}` : ''}`;
  if (status.kind === 'terminal') {
    const durable = status.durable;
    const ledger =
      durable.availability === 'known'
        ? ` ledger=${durable.value.ledger.path} sequence=${durable.value.ledger.lastSequence ?? 0}`
        : ` durable=${durable.availability} reason=${durable.reason}`;
    return escapeTerminalText(
      `${identifiers} kind=terminal outcome=${status.history.outcome} endedAt=${status.history.endedAt}${ledger}${formatWarnings(status.warnings)}`,
    );
  }
  const posture =
    status.durable.posture.availability === 'known'
      ? status.durable.posture.value
      : status.durable.posture.availability;
  const eligibility =
    status.durable.executionEligibility.availability === 'known'
      ? status.durable.executionEligibility.value.state
      : status.durable.executionEligibility.availability;
  const reasons = status.lifecycle.reasons.length
    ? ` reasons=${status.lifecycle.reasons.join('|')}`
    : '';
  return escapeTerminalText(
    `${identifiers} kind=active lifecycle=${status.lifecycle.state} posture=${posture}` +
      ` eligibility=${eligibility} heartbeatAgeMs=${status.lifecycle.heartbeatAgeMs}` +
      ` ledger=${status.durable.ledger.path} sequence=${status.durable.ledger.lastSequence ?? 0}` +
      reasons +
      formatWarnings(status.warnings),
  );
}

function formatWarnings(warnings: readonly { readonly code: string }[]): string {
  return warnings.length ? ` warnings=${warnings.map((warning) => warning.code).join('|')}` : '';
}

const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

/** Human output must never emit raw terminal controls even if an injected reader is unsafe. */
function escapeTerminalText(value: string): string {
  return value.replace(
    TERMINAL_CONTROL,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
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
    dependencies.log('pinelive status --all [--json] [--recent <n>]');
    dependencies.log('pinelive status --instance <instance-id> [--json] [--recent <n>]');
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
    assertCommandArgs(args, 'status', ['ledger', 'recent', 'instance'], ['json', 'all']);
    const ledgerPath = args.values.get('ledger');
    const instanceId = args.values.get('instance');
    const all = args.flags.has('all');
    const selectors = Number(ledgerPath != null) + Number(instanceId != null) + Number(all);
    if (selectors !== 1)
      throw new Error('status requires exactly one of --ledger <path>, --all, or --instance <id>');
    const recentValue = args.values.get('recent');
    const recent = recentValue == null ? undefined : Number(recentValue);
    if (ledgerPath) {
      const status = await dependencies.readPineliveStatus({
        ledgerPath,
        ...(recent == null ? {} : { recent }),
      });
      if (args.flags.has('json')) dependencies.log(JSON.stringify(status));
      else
        dependencies.log(
          escapeTerminalText(
            `ledger=${status.ledger.path} schema=${status.ledger.ledgerSchemaVersion ?? 'none'} sequence=${status.ledger.lastSequence ?? 0} partialTail=${status.ledger.partialTail}`,
          ),
        );
      return;
    }
    if (all) {
      const status = await dependencies.readPineliveStatusList({
        ...(recent == null ? {} : { recent }),
      });
      if (args.flags.has('json')) dependencies.log(JSON.stringify(status));
      else printStatusList(status, dependencies.log);
      return;
    }
    const status = await dependencies.readPineliveInstanceStatus(instanceId!, {
      ...(recent == null ? {} : { recent }),
    });
    if (args.flags.has('json')) dependencies.log(JSON.stringify(status));
    else dependencies.log(formatDiscoveredStatus(status));
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
  await runConfig(rawConfig, configPath, dependencies);
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

interface CliRunRegistrationSession {
  readonly registry: CliRunRegistry;
  readonly instanceId: string;
  readonly cwd: string;
  active: ActiveRunRegistrationV1;
  heartbeat?: CliHeartbeatService;
  readiness?: IntrabarServerReadiness;
  terminal?: IntrabarServerTerminal;
  ownedLedgerSequence?: number;
  accountClaimPath?: string;
}

async function boundedAdvisoryOperation<T>(
  dependencies: CliDependencies,
  operation: () => Promise<T>,
): Promise<T> {
  const timeoutMs = dependencies.registryOperationTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('registryOperationTimeoutMs must be a positive safe integer');
  const task = Promise.resolve().then(operation);
  void task.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`advisory operation exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function beginRunRegistration(
  config: NormalizedRunConfig,
  configPath: string,
  dependencies: CliDependencies,
): Promise<CliRunRegistrationSession | undefined> {
  try {
    const registry = dependencies.createRunRegistry();
    const instanceId = dependencies.createRunInstanceId();
    const cwd = dependencies.cwd();
    const at = dependencies.now().toISOString();
    const runtimePaths = runtimeStatePaths(config);
    let processIdentity;
    try {
      processIdentity = await dependencies.readBootBoundProcessIdentity(dependencies.pid);
    } catch {
      dependencies.log('pinelive registry warning: process-identity-unavailable');
    }
    const brokerId =
      config.execution.kind === 'compute-only' ? 'compute-only' : config.execution.broker.id;
    const posture: EffectiveRunPosture =
      config.execution.kind === 'compute-only'
        ? 'compute-only'
        : config.execution.broker.id === 'tiger' && !config.execution.armed
          ? 'monitor'
          : 'live';
    const active: ActiveRunRegistrationV1 = {
      registrationVersion: 1,
      instanceId,
      pid: dependencies.pid,
      ...(processIdentity ? { processIdentity } : {}),
      lifecycle: 'starting',
      startedAt: at,
      heartbeatAt: at,
      updatedAt: at,
      configVersion: 3,
      ...(config.execution.kind === 'mirrored' && config.execution.executionId
        ? { executionId: config.execution.executionId }
        : {}),
      brokerId,
      posture,
      paths: {
        ledger: dependencies.resolveRunRegistrationPath(runtimePaths.ledgerPath, cwd),
        executionLease: dependencies.resolveRunRegistrationPath(runtimePaths.leasePath, cwd),
        config: dependencies.resolveRunRegistrationPath(configPath, cwd),
      },
      display: {
        strategyId: config.strategy,
        strategySymbol: config.symbol,
        timeframe: config.timeframe,
      },
    };
    await boundedAdvisoryOperation(dependencies, () => registry.writeActive(active));
    const session: CliRunRegistrationSession = { registry, instanceId, cwd, active };
    try {
      session.heartbeat = registry.createHeartbeatService(instanceId, {
        onWarning: ({ failureCount }) =>
          dependencies.log(
            `pinelive registry warning: heartbeat-write-failed count=${failureCount}`,
          ),
      });
      session.heartbeat.start();
    } catch {
      dependencies.log('pinelive registry warning: heartbeat-start-failed');
    }
    return session;
  } catch {
    dependencies.log('pinelive registry warning: initial-registration-failed');
    return undefined;
  }
}

async function updateRunRegistration(
  session: CliRunRegistrationSession,
  dependencies: CliDependencies,
  label: string,
  update: (current: ActiveRunRegistrationV1, updatedAt: string) => ActiveRunRegistrationV1,
): Promise<void> {
  try {
    const active = await boundedAdvisoryOperation(dependencies, () =>
      session.registry.updateActive(session.instanceId, (current) => {
        const updatedAt = monotonicRegistrationTime(current, dependencies.now());
        return update(current, updatedAt);
      }),
    );
    session.active = active;
  } catch {
    dependencies.log(`pinelive registry warning: ${label}-update-failed`);
  }
}

async function markRunRegistrationReady(
  session: CliRunRegistrationSession,
  readiness: IntrabarServerReadiness,
  dependencies: CliDependencies,
): Promise<void> {
  session.readiness = readiness;
  await updateRunRegistration(session, dependencies, 'running', (current, updatedAt) => ({
    ...current,
    lifecycle: 'running',
    runId: readiness.runId,
    executionId: readiness.executionId,
    posture: readiness.posture,
    updatedAt,
    display: {
      ...current.display,
      executionSymbol: readiness.executionSymbol,
    },
    paths: {
      ...current.paths,
      ...(session.accountClaimPath ? { accountClaim: session.accountClaimPath } : {}),
    },
  }));
}

async function markRunRegistrationStopping(
  session: CliRunRegistrationSession,
  dependencies: CliDependencies,
): Promise<void> {
  if (session.active.lifecycle === 'stopping') return;
  await updateRunRegistration(session, dependencies, 'stopping', (current, updatedAt) => ({
    ...current,
    lifecycle: 'stopping',
    updatedAt,
  }));
}

async function completeRunRegistration(
  session: CliRunRegistrationSession | undefined,
  storage: CliRuntimeStorage | undefined,
  result: IntrabarServerResult | undefined,
  primaryError: unknown,
  dependencies: CliDependencies,
): Promise<void> {
  if (!session) return;
  await markRunRegistrationStopping(session, dependencies);
  try {
    if (session.heartbeat)
      await boundedAdvisoryOperation(dependencies, () => session.heartbeat!.stop());
  } catch {
    dependencies.log('pinelive registry warning: heartbeat-stop-failed');
  }

  const finalLedgerSequence = session.terminal?.ledgerSequence ?? session.ownedLedgerSequence;
  let recovery: LedgerRecoveryState | undefined;
  if (storage && finalLedgerSequence !== undefined) {
    try {
      const prefix = await boundedAdvisoryOperation(dependencies, () =>
        readCrashSafePrefix(storage.ledgerPath, dependencies),
      );
      const completeRecovery =
        prefix.records.length > 0 ? recoverLedger(prefix.records) : recoverLedger([]);
      if (finalLedgerSequence > completeRecovery.lastSequence)
        throw new RangeError('captured terminal sequence exceeds the durable ledger tail');
      const terminalEvents = completeRecovery.events.slice(0, finalLedgerSequence);
      if (finalLedgerSequence > 0 && terminalEvents.at(-1)?.sequence !== finalLedgerSequence)
        throw new RangeError('captured terminal sequence is not a durable boundary');
      recovery = recoverLedger(terminalEvents);
    } catch {
      dependencies.log('pinelive registry warning: terminal-ledger-read-failed');
    }
  }

  const runId = session.terminal?.runId ?? recovery?.runId ?? session.readiness?.runId;
  const executionId =
    session.terminal?.executionId ?? recovery?.executionId ?? session.readiness?.executionId;
  if (
    (runId !== undefined && runId !== session.active.runId) ||
    (executionId !== undefined && executionId !== session.active.executionId)
  ) {
    await updateRunRegistration(
      session,
      dependencies,
      'terminal-identity',
      (current, updatedAt) => ({
        ...current,
        ...(runId ? { runId } : {}),
        ...(executionId ? { executionId } : {}),
        updatedAt,
      }),
    );
  }

  const outcome = terminalRunOutcome(
    primaryError,
    result,
    recovery,
    session.readiness != null,
    session.terminal?.executionLatchReason,
  );
  const finalReasonCode = terminalRunReasonCode(
    outcome,
    recovery,
    session.terminal?.executionLatchReason,
  );
  const history: RunHistoryRecordV1 = {
    historyVersion: 1,
    instanceId: session.instanceId,
    ...(runId ? { runId } : {}),
    ...(executionId ? { executionId } : {}),
    startedAt: session.active.startedAt,
    endedAt: monotonicRegistrationTime(session.active, dependencies.now()),
    outcome,
    ...(storage ? { finalLedgerPath: session.active.paths.ledger } : {}),
    ...(storage && finalLedgerSequence !== undefined ? { finalLedgerSequence } : {}),
    ...(finalReasonCode ? { finalReasonCode } : {}),
    configVersion: 3,
    brokerId: session.active.brokerId,
    posture: session.active.posture,
  };
  try {
    await boundedAdvisoryOperation(dependencies, () => session.registry.completeRun(history));
  } catch {
    dependencies.log('pinelive registry warning: terminal-history-write-failed');
  }
}

function terminalRunOutcome(
  primaryError: unknown,
  result: IntrabarServerResult | undefined,
  recovery: LedgerRecoveryState | undefined,
  becameReady: boolean,
  terminalLatchReason?: IntrabarServerTerminal['executionLatchReason'],
): RunHistoryOutcome {
  if (primaryError !== undefined || !result)
    return becameReady ? 'failed-runtime' : 'failed-startup';
  if (
    terminalLatchReason !== undefined ||
    recovery?.breaker.latched ||
    (recovery?.unresolvedIntents.size ?? 0) > 0
  )
    return 'execution-latched';
  return 'stopped';
}

function terminalRunReasonCode(
  outcome: RunHistoryOutcome,
  recovery: LedgerRecoveryState | undefined,
  terminalLatchReason?: IntrabarServerTerminal['executionLatchReason'],
): string | undefined {
  if (outcome === 'failed-startup') return 'startup-failed';
  if (outcome === 'failed-runtime') return 'runtime-failed';
  if (outcome !== 'execution-latched') return undefined;
  if (terminalLatchReason) return terminalLatchReason;
  if ((recovery?.unresolvedIntents.size ?? 0) > 0) return 'unresolved-effects';
  return 'breaker-latched';
}

function monotonicRegistrationTime(current: ActiveRunRegistrationV1, now: Date): string {
  const timestamp = Math.max(
    Date.parse(current.startedAt),
    Date.parse(current.heartbeatAt),
    Date.parse(current.updatedAt),
    now.getTime(),
  );
  if (!Number.isFinite(timestamp)) throw new RangeError('run registration clock is invalid');
  return new Date(timestamp).toISOString();
}

async function runConfig(
  rawConfig: Readonly<Record<string, unknown>>,
  configPath: string,
  dependencies: CliDependencies,
): Promise<void> {
  const source = await dependencies.readSource(strategyPath(rawConfig));
  // The branded prepare result is the only normalized value used below. No runtime factory
  // exists before this pure source/config gate completes.
  const prepared = dependencies.prepareIntrabarRun(rawConfig, source);
  const normalized = prepared.config;
  const registration = await beginRunRegistration(normalized, configPath, dependencies);

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
  let storage: CliRuntimeStorage | undefined;
  let result: IntrabarServerResult | undefined;
  let primaryError: unknown;
  try {
    storage = await openRuntimeStorage(normalized, dependencies);
    result = await runWithStorage(
      prepared,
      normalized,
      dataFactory,
      storage,
      controller.signal,
      dependencies,
      registration,
    );
  } catch (error) {
    primaryError = error;
  } finally {
    dependencies.removeSignalHandler('SIGINT', stop);
    dependencies.removeSignalHandler('SIGTERM', stop);
    await completeRunRegistration(registration, storage, result, primaryError, dependencies);
  }

  if (primaryError !== undefined) throw primaryError;
  if (!result || !storage) throw new Error('pinelive runtime stopped without a result');
  printResult(result, storage.ledgerPath, dependencies.log);
}

async function runWithStorage(
  prepared: ReturnType<typeof prepareIntrabarRun>,
  normalized: NormalizedRunConfig,
  dataFactory: () => MarketDataProvider,
  storage: CliRuntimeStorage,
  signal: AbortSignal,
  dependencies: CliDependencies,
  registration?: CliRunRegistrationSession,
): Promise<IntrabarServerResult> {
  const ledger = new CliOwnedLedger(storage.ledger);
  const fileLease = new CliOwnedExecutionLease(storage.fileLease);
  const administrativeLease = new CliOwnedExecutionLease(storage.administrativeLease);
  const lease = normalized.execution.kind === 'mirrored' ? fileLease : undefined;
  let mirroredRuntimeOwnsLease = false;
  let result: IntrabarServerResult | undefined;
  let primaryError: unknown;
  if (registration) {
    try {
      registration.ownedLedgerSequence = recoverLedger(storage.recoveredEvents).lastSequence;
    } catch {
      // The runtime remains authoritative for ledger validation and its normal cleanup path.
    }
  }
  const lifecycleCallbacks = registration
    ? {
        onReady: (readiness: IntrabarServerReadiness) =>
          markRunRegistrationReady(registration, readiness, dependencies),
        onStopping: () => markRunRegistrationStopping(registration, dependencies),
        onTerminal: (terminal: IntrabarServerTerminal) => {
          registration.terminal = terminal;
          registration.ownedLedgerSequence = terminal.ledgerSequence;
        },
      }
    : {};

  try {
    if (normalized.execution.kind === 'compute-only') {
      result = await dependencies.runIntrabarServer({
        prepared: prepared as PreparedComputeOnlyIntrabarRun,
        dataFactory,
        ledger,
        recoveredEvents: storage.recoveredEvents,
        alertChannels: buildAlertChannels(normalized.alerts, dependencies),
        signal,
        ...lifecycleCallbacks,
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
        ...lifecycleCallbacks,
        onLog: dependencies.log,
        ...(execution.broker.id === 'tiger'
          ? {
              accountClaimFactory: (context: AccountInstrumentClaimFactoryContext) => {
                const claim = dependencies.createAccountInstrumentClaim(
                  {
                    identity: context.identity,
                    executionSymbol: context.executionSymbol,
                  },
                  { ownerId: context.ownerId },
                );
                if (registration)
                  registration.accountClaimPath = dependencies.resolveRunRegistrationPath(
                    claim.path,
                    registration.cwd,
                  );
                return claim;
              },
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
  const paths = runtimeStatePaths(config);
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

function runtimeStatePaths(config: NormalizedRunConfig): {
  ledgerPath: string;
  leasePath: string;
} {
  return config.execution.kind === 'mirrored'
    ? {
        ledgerPath: config.execution.ledger.path,
        leasePath: config.execution.lease.path,
      }
    : defaultComputeStatePaths(config);
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
