import { assertProviderConfig, type ProviderConfig } from '@heyphat/pinery';
import {
  DEFAULT_ALERT_ATTEMPTS,
  DEFAULT_ALERT_FREQUENCY,
  DEFAULT_ALERT_RETRY_DELAY_MS,
  DEFAULT_ALERT_SEND_TIMEOUT_MS,
  DEFAULT_MAX_ALERTS_PER_BAR,
  type AlertFrequency,
} from './alerts.js';

export interface NormalizedWebhookChannelConfig {
  readonly id: 'webhook';
  /** Unique ledger-safe name; the URL and headers stay construction secrets. */
  readonly name: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface NormalizedTelegramChannelConfig {
  readonly id: 'telegram';
  /** Unique ledger-safe name; the bot token and chat id stay construction secrets. */
  readonly name: string;
  readonly botToken: string;
  readonly chatId: string;
  readonly disableNotification?: boolean;
}

export type NormalizedAlertChannelConfig =
  NormalizedWebhookChannelConfig | NormalizedTelegramChannelConfig;

export interface NormalizedAlertsConfig {
  readonly channels: readonly NormalizedAlertChannelConfig[];
  readonly frequency: AlertFrequency;
  readonly sendTimeoutMs: number;
  readonly attempts: number;
  readonly retryDelayMs: number;
  readonly maxPerBar: number;
}

export const MAX_ALERT_CHANNELS = 8;

export interface NormalizedStandardHistoricalConfig {
  readonly mode: 'standard';
  readonly maxMagnifierTargetBars?: never;
  readonly maxMagnifierRawBars?: never;
}

export interface NormalizedBarMagnifierHistoricalConfig {
  readonly mode: 'bar-magnifier';
  /** Maximum post-aggregation bars admitted for piner injection. */
  readonly maxMagnifierTargetBars: number;
  /** Maximum planner-source rows admitted before target aggregation. */
  readonly maxMagnifierRawBars: number;
}

export type NormalizedHistoricalConfig =
  NormalizedStandardHistoricalConfig | NormalizedBarMagnifierHistoricalConfig;

export interface NormalizedBarCloseLiveConfig {
  readonly cadence: 'bar-close';
  readonly source?: never;
  readonly throttleMs?: never;
  readonly maxPendingFinals?: never;
  readonly reconnectAttempts?: never;
  readonly reconnectDelayMs?: never;
  readonly reconnectMaxDelayMs?: never;
}

export type NormalizedLiveSourceConfig =
  | { readonly kind: 'native'; readonly timeframe?: never }
  | { readonly kind: 'lower-bars'; readonly timeframe: string };

export interface NormalizedEveryUpdateLiveConfig {
  readonly cadence: 'every-update';
  readonly source: NormalizedLiveSourceConfig;
  readonly throttleMs: number;
  readonly maxPendingFinals: number;
  readonly reconnectAttempts: number;
  readonly reconnectDelayMs: number;
  readonly reconnectMaxDelayMs: number;
}

export type NormalizedLiveConfig = NormalizedBarCloseLiveConfig | NormalizedEveryUpdateLiveConfig;

export interface NormalizedSecurityDisabledConfig {
  readonly enabled: false;
  readonly maxExactSecurityFeeds?: never;
  readonly maxExactSecurityBarsPerFeed?: never;
  readonly maxExactSecurityTotalBars?: never;
  readonly concurrency?: never;
  readonly requestTimeoutMs?: never;
  readonly maxStaleRefreshes?: never;
}

export interface NormalizedSecurityEnabledConfig {
  readonly enabled: true;
  readonly maxExactSecurityFeeds: number;
  readonly maxExactSecurityBarsPerFeed: number;
  readonly maxExactSecurityTotalBars: number;
  readonly concurrency: number;
  readonly requestTimeoutMs: number;
  readonly maxStaleRefreshes: number;
}

export type NormalizedSecurityConfig =
  NormalizedSecurityDisabledConfig | NormalizedSecurityEnabledConfig;

export type NormalizedOrderPolicyConfig =
  | { readonly type: 'market'; readonly limitOffsetTicks?: never }
  | { readonly type: 'limit'; readonly limitOffsetTicks: number };

export interface NormalizedPaperBrokerConfig {
  readonly id: 'paper';
  readonly initialBalance?: number;
  readonly slippageBps?: number;
  readonly commissionPerUnit?: number;
  readonly profile?: never;
  readonly account?: never;
  readonly orderPollIntervalMs?: never;
  readonly maxOrderPolls?: never;
  readonly cancelStuckOrders?: never;
}

export interface NormalizedTigerBrokerConfig {
  readonly id: 'tiger';
  readonly profile?: string;
  readonly account?: string;
  readonly orderPollIntervalMs?: number;
  readonly maxOrderPolls?: number;
  readonly cancelStuckOrders?: boolean;
  readonly initialBalance?: never;
  readonly slippageBps?: never;
  readonly commissionPerUnit?: never;
}

export type NormalizedBrokerConfig = NormalizedPaperBrokerConfig | NormalizedTigerBrokerConfig;

export interface NormalizedSyncLedgerConfig {
  readonly path: string;
  readonly durability: 'sync';
}

/** An exclusive, non-stealable file lease. Stale-takeover settings are intentionally absent. */
export interface NormalizedExclusiveLeaseConfig {
  readonly path: string;
}

export interface NormalizedExecutionSchedulerConfig {
  readonly minReconcileIntervalMs: number;
  readonly maxOrdersPerBar: number;
  readonly maxOrdersPerMinute: number;
  readonly maxTargetChangesPerBar: number;
  readonly maxConsecutiveExecutionErrors: number;
}

export interface NormalizedComputeOnlyExecutionConfig {
  readonly kind: 'compute-only';
  readonly mirrorOn?: never;
  readonly broker?: never;
  readonly account?: never;
  readonly order?: never;
  readonly armed?: never;
  readonly intrabarExecutionArmed?: never;
  readonly executionId?: never;
  readonly reconcileOnStart?: never;
  readonly scheduler?: never;
  readonly ledger?: never;
  readonly lease?: never;
}

interface NormalizedMirroredExecutionBase {
  readonly kind: 'mirrored';
  readonly order: NormalizedOrderPolicyConfig;
  readonly executionId?: string;
  readonly ledger: NormalizedSyncLedgerConfig;
  readonly lease: NormalizedExclusiveLeaseConfig;
}

export type NormalizedBarCloseMirroredExecutionConfig = NormalizedMirroredExecutionBase & {
  readonly mirrorOn: 'bar-close';
  readonly reconcileOnStart: boolean;
  readonly intrabarExecutionArmed?: never;
  readonly scheduler?: never;
} & (
    | {
        readonly broker: NormalizedPaperBrokerConfig;
        readonly armed?: never;
      }
    | {
        readonly broker: NormalizedTigerBrokerConfig;
        readonly armed: boolean;
      }
  );

export type NormalizedEveryUpdateCadenceMirroredExecutionConfig =
  NormalizedMirroredExecutionBase & {
    readonly broker: NormalizedPaperBrokerConfig;
    readonly armed?: never;
    readonly intrabarExecutionArmed: true;
    readonly reconcileOnStart?: never;
    /** Forming updates are computed and journaled; only authoritative finals are mirrored. */
    readonly mirrorOn: 'bar-close';
    readonly scheduler?: never;
  };

export type NormalizedMirroredExecutionConfig =
  NormalizedBarCloseMirroredExecutionConfig | NormalizedEveryUpdateCadenceMirroredExecutionConfig;

export type NormalizedExecutionConfig =
  NormalizedComputeOnlyExecutionConfig | NormalizedMirroredExecutionConfig;

interface NormalizedRunConfigCommon {
  readonly configVersion: 3;
  readonly strategy: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly warmupBars?: number;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly data: ProviderConfig;
  readonly historical: NormalizedHistoricalConfig;
  readonly alerts?: NormalizedAlertsConfig;
}

export type NormalizedBarCloseRunConfig = NormalizedRunConfigCommon & {
  readonly live: NormalizedBarCloseLiveConfig;
  readonly security: NormalizedSecurityConfig;
  readonly execution:
    NormalizedComputeOnlyExecutionConfig | NormalizedBarCloseMirroredExecutionConfig;
};

export type NormalizedEveryUpdateRunConfig = NormalizedRunConfigCommon & {
  readonly live: NormalizedEveryUpdateLiveConfig;
  readonly security: NormalizedSecurityDisabledConfig;
  readonly execution:
    NormalizedComputeOnlyExecutionConfig | NormalizedEveryUpdateCadenceMirroredExecutionConfig;
};

/** Only combinations that the strict normalizer can emit are represented. */
export type NormalizedRunConfig = NormalizedBarCloseRunConfig | NormalizedEveryUpdateRunConfig;

export type NormalizedComputeOnlyRunConfig =
  | (Omit<NormalizedBarCloseRunConfig, 'execution'> & {
      readonly execution: NormalizedComputeOnlyExecutionConfig;
    })
  | (Omit<NormalizedEveryUpdateRunConfig, 'execution'> & {
      readonly execution: NormalizedComputeOnlyExecutionConfig;
    });

export type NormalizedMirroredRunConfig =
  | (Omit<NormalizedBarCloseRunConfig, 'execution'> & {
      readonly execution: NormalizedBarCloseMirroredExecutionConfig;
    })
  | (Omit<NormalizedEveryUpdateRunConfig, 'execution'> & {
      readonly execution: NormalizedEveryUpdateCadenceMirroredExecutionConfig;
    });

export interface CompiledIntrabarMetadata {
  readonly isStrategy?: unknown;
  readonly strategy?: unknown;
  readonly securityDependencies?: unknown;
}

export const DEFAULT_LIVE_THROTTLE_MS = 250;
export const DEFAULT_MAX_PENDING_FINALS = 256;
export const DEFAULT_LIVE_RECONNECT_ATTEMPTS = 8;
export const DEFAULT_LIVE_RECONNECT_DELAY_MS = 250;
export const DEFAULT_LIVE_RECONNECT_MAX_DELAY_MS = 30_000;
export const DEFAULT_SECURITY_CONCURRENCY = 4;
export const DEFAULT_SECURITY_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_SECURITY_STALE_REFRESHES = 0;
export const DEFAULT_MIN_RECONCILE_INTERVAL_MS = 1_000;
export const DEFAULT_MAX_ORDERS_PER_BAR = 4;
export const DEFAULT_MAX_ORDERS_PER_MINUTE = 20;
export const DEFAULT_MAX_TARGET_CHANGES_PER_BAR = 8;
export const DEFAULT_MAX_CONSECUTIVE_EXECUTION_ERRORS = 3;

/**
 * Purely validate and normalize a Pinelive run configuration. This function does
 * not read files, resolve providers, load credentials, construct brokers, or
 * invoke any supplied transport method.
 */
export function normalizeRunConfig(value: unknown): NormalizedRunConfig {
  const config = configObject(value, 'config');
  if (config.configVersion !== 3) throw new Error('unsupported configVersion; expected 3');
  return normalizeConfig(config);
}

/**
 * Apply source-dependent gates after compilation but before provider or broker
 * construction. The caller must pass the compiler's metadata object itself.
 */
export function validateCompiledIntrabarConfig(
  compiledMetadata: CompiledIntrabarMetadata,
  config: NormalizedRunConfig,
): void {
  const metadata = configObject(compiledMetadata, 'compiled metadata');
  if (metadata.isStrategy !== true) {
    throw new Error('compiled source must be a strategy for Pinelive execution');
  }
  const strategy = optionalMetadataRecord(metadata.strategy);
  if (!strategy) {
    throw new Error('compiled strategy metadata must be an object');
  }

  if (!Array.isArray(metadata.securityDependencies)) {
    throw new Error('compiled security dependency metadata must be a complete array');
  }
  const dependencies = metadata.securityDependencies as readonly unknown[];

  if (config.live.cadence === 'every-update') {
    if (strategy.calcOnEveryTick !== true) {
      throw new Error(
        'config.live.cadence "every-update" requires strategy(calc_on_every_tick=true)',
      );
    }
    if (config.security.enabled) {
      throw new Error('every-update does not allow security resolution to be enabled');
    }
    if (dependencies.length > 0) {
      throw new Error(
        'every-update rejects every request.security and request.security_lower_tf dependency',
      );
    }
  } else if (!config.security.enabled && dependencies.length > 0) {
    throw new Error(
      'compiled source has security dependencies but config.security.enabled is false',
    );
  }

  if (config.security.enabled && config.historical.mode !== 'bar-magnifier') {
    throw new Error('exact security requires config.historical.mode "bar-magnifier"');
  }

  if (config.historical.mode !== 'bar-magnifier') return;
  if (Object.prototype.hasOwnProperty.call(strategy, 'calcOnOrderFills')) {
    if (typeof strategy.calcOnOrderFills !== 'boolean') {
      throw new Error('compiled calc_on_order_fills metadata is ambiguous');
    }
    if (strategy.calcOnOrderFills) {
      throw new Error(
        'bar-magnifier with calc_on_order_fills=true is unsupported by the pinned piner runtime',
      );
    }
  }

  if (!config.security.enabled) return;
  for (const dependency of dependencies) {
    if (!isCompleteStaticSecurityDependency(dependency)) {
      throw new Error(
        'bar-magnifier requires every security dependency to be statically and completely classified',
      );
    }
  }
}

function normalizeConfig(value: Readonly<Record<string, unknown>>): NormalizedRunConfig {
  assertConfigKeys(
    value,
    [
      'configVersion',
      'strategy',
      'symbol',
      'timeframe',
      'warmupBars',
      'inputs',
      'data',
      'historical',
      'live',
      'security',
      'execution',
      'alerts',
    ],
    'config',
  );
  const strategy = nonEmptyString(value.strategy, 'config.strategy');
  const symbol = nonEmptyString(value.symbol, 'config.symbol');
  const timeframe = nonEmptyString(value.timeframe, 'config.timeframe');
  const warmupBars = optionalNonNegativeSafeInteger(value.warmupBars, 'config.warmupBars');
  const inputs = optionalInputs(value.inputs);
  const historical = normalizeHistorical(value.historical);
  const live = normalizeLive(value.live, timeframe);
  const dataValue = configObject(value.data, 'config.data');
  assertNoExplicitNullProperties(dataValue, 'config.data');
  assertNoExplicitNullProviderInternals(dataValue);
  const data = assertProviderConfig(dataValue);
  const alerts = normalizeAlerts(value.alerts);
  const common = {
    configVersion: 3 as const,
    strategy,
    symbol,
    timeframe,
    ...(warmupBars !== undefined ? { warmupBars } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    data,
    historical,
    ...(alerts ? { alerts } : {}),
  };

  if (live.cadence === 'every-update') {
    const security = normalizeSecurity(value.security, live.cadence);
    const execution = normalizeExecution(value.execution, live);
    return { ...common, live, security, execution };
  }
  const security = normalizeSecurity(value.security, live.cadence);
  const execution = normalizeExecution(value.execution, live);
  return { ...common, live, security, execution };
}

function normalizeHistorical(value: unknown): NormalizedHistoricalConfig {
  if (value === undefined) return { mode: 'standard' };
  const historical = configObject(value, 'config.historical');
  if (historical.mode === 'standard') {
    assertConfigKeys(historical, ['mode'], 'config.historical');
    return { mode: 'standard' };
  }
  if (historical.mode !== 'bar-magnifier') {
    throw new Error('config.historical.mode must be "standard" or "bar-magnifier"');
  }
  assertConfigKeys(
    historical,
    ['mode', 'maxMagnifierTargetBars', 'maxMagnifierRawBars'],
    'config.historical',
  );
  const maxMagnifierTargetBars = positiveSafeInteger(
    historical.maxMagnifierTargetBars,
    'config.historical.maxMagnifierTargetBars',
  );
  const maxMagnifierRawBars = positiveSafeInteger(
    historical.maxMagnifierRawBars,
    'config.historical.maxMagnifierRawBars',
  );
  if (maxMagnifierTargetBars > maxMagnifierRawBars) {
    throw new Error('config.historical.maxMagnifierTargetBars must not exceed maxMagnifierRawBars');
  }
  return { mode: 'bar-magnifier', maxMagnifierTargetBars, maxMagnifierRawBars };
}

function normalizeLive(value: unknown, chartTimeframe: string): NormalizedLiveConfig {
  if (value === undefined) return { cadence: 'bar-close' };
  const live = configObject(value, 'config.live');
  if (live.cadence === 'bar-close') {
    assertConfigKeys(live, ['cadence'], 'config.live');
    return { cadence: 'bar-close' };
  }
  if (live.cadence !== 'every-update') {
    throw new Error('config.live.cadence must be "bar-close" or "every-update"');
  }
  assertConfigKeys(
    live,
    [
      'cadence',
      'source',
      'throttleMs',
      'maxPendingFinals',
      'reconnectAttempts',
      'reconnectDelayMs',
      'reconnectMaxDelayMs',
    ],
    'config.live',
  );
  fixedTimeframeSeconds(chartTimeframe, 'config.timeframe');
  const source = normalizeLiveSource(live.source, chartTimeframe);
  const throttleMs = boundedSafeInteger(
    live.throttleMs === undefined ? DEFAULT_LIVE_THROTTLE_MS : live.throttleMs,
    'config.live.throttleMs',
    0,
    60_000,
  );
  const maxPendingFinals = boundedSafeInteger(
    live.maxPendingFinals === undefined ? DEFAULT_MAX_PENDING_FINALS : live.maxPendingFinals,
    'config.live.maxPendingFinals',
    1,
    10_000,
  );
  const reconnectAttempts = boundedSafeInteger(
    live.reconnectAttempts === undefined ? DEFAULT_LIVE_RECONNECT_ATTEMPTS : live.reconnectAttempts,
    'config.live.reconnectAttempts',
    0,
    100,
  );
  const reconnectDelayMs = boundedSafeInteger(
    live.reconnectDelayMs === undefined ? DEFAULT_LIVE_RECONNECT_DELAY_MS : live.reconnectDelayMs,
    'config.live.reconnectDelayMs',
    0,
    60_000,
  );
  const reconnectMaxDelayMs = boundedSafeInteger(
    live.reconnectMaxDelayMs === undefined
      ? DEFAULT_LIVE_RECONNECT_MAX_DELAY_MS
      : live.reconnectMaxDelayMs,
    'config.live.reconnectMaxDelayMs',
    1,
    300_000,
  );
  if (reconnectMaxDelayMs < reconnectDelayMs) {
    throw new Error('config.live.reconnectMaxDelayMs must not be below reconnectDelayMs');
  }
  return {
    cadence: 'every-update',
    source,
    throttleMs,
    maxPendingFinals,
    reconnectAttempts,
    reconnectDelayMs,
    reconnectMaxDelayMs,
  };
}

function normalizeLiveSource(value: unknown, chartTimeframe: string): NormalizedLiveSourceConfig {
  const source = configObject(value, 'config.live.source');
  if (source.kind === 'native') {
    assertConfigKeys(source, ['kind'], 'config.live.source');
    return { kind: 'native' };
  }
  if (source.kind !== 'lower-bars') {
    throw new Error('config.live.source.kind must be "native" or "lower-bars"');
  }
  assertConfigKeys(source, ['kind', 'timeframe'], 'config.live.source');
  const timeframe = nonEmptyString(source.timeframe, 'config.live.source.timeframe');
  const sourceSeconds = fixedTimeframeSeconds(timeframe, 'config.live.source.timeframe');
  const chartSeconds = fixedTimeframeSeconds(chartTimeframe, 'config.timeframe');
  if (sourceSeconds >= chartSeconds || chartSeconds % sourceSeconds !== 0) {
    throw new Error(
      'config.live.source.timeframe must be a strict exact child of config.timeframe',
    );
  }
  return { kind: 'lower-bars', timeframe };
}

function normalizeSecurity(
  value: unknown,
  cadence: 'every-update',
): NormalizedSecurityDisabledConfig;
function normalizeSecurity(value: unknown, cadence: 'bar-close'): NormalizedSecurityConfig;
function normalizeSecurity(
  value: unknown,
  cadence: NormalizedLiveConfig['cadence'],
): NormalizedSecurityConfig {
  if (value === undefined) return { enabled: false };
  const security = configObject(value, 'config.security');
  if (security.enabled !== true && security.enabled !== false) {
    throw new Error('config.security.enabled must be boolean');
  }
  if (!security.enabled) {
    assertConfigKeys(security, ['enabled'], 'config.security');
    return { enabled: false };
  }
  if (cadence === 'every-update') {
    throw new Error('config.security.enabled must be false for every-update');
  }
  assertConfigKeys(
    security,
    [
      'enabled',
      'maxExactSecurityFeeds',
      'maxExactSecurityBarsPerFeed',
      'maxExactSecurityTotalBars',
      'concurrency',
      'requestTimeoutMs',
      'maxStaleRefreshes',
    ],
    'config.security',
  );
  const maxExactSecurityFeeds = positiveSafeInteger(
    security.maxExactSecurityFeeds,
    'config.security.maxExactSecurityFeeds',
  );
  const maxExactSecurityBarsPerFeed = positiveSafeInteger(
    security.maxExactSecurityBarsPerFeed,
    'config.security.maxExactSecurityBarsPerFeed',
  );
  const maxExactSecurityTotalBars = positiveSafeInteger(
    security.maxExactSecurityTotalBars,
    'config.security.maxExactSecurityTotalBars',
  );
  const concurrency = positiveSafeInteger(
    security.concurrency === undefined ? DEFAULT_SECURITY_CONCURRENCY : security.concurrency,
    'config.security.concurrency',
  );
  const requestTimeoutMs = positiveSafeInteger(
    security.requestTimeoutMs === undefined
      ? DEFAULT_SECURITY_REQUEST_TIMEOUT_MS
      : security.requestTimeoutMs,
    'config.security.requestTimeoutMs',
  );
  const maxStaleRefreshes = nonNegativeSafeInteger(
    security.maxStaleRefreshes === undefined
      ? DEFAULT_MAX_SECURITY_STALE_REFRESHES
      : security.maxStaleRefreshes,
    'config.security.maxStaleRefreshes',
  );
  if (maxExactSecurityBarsPerFeed > maxExactSecurityTotalBars) {
    throw new Error(
      'config.security.maxExactSecurityBarsPerFeed must not exceed maxExactSecurityTotalBars',
    );
  }
  if (concurrency > maxExactSecurityFeeds) {
    throw new Error('config.security.concurrency must not exceed maxExactSecurityFeeds');
  }
  return {
    enabled: true,
    maxExactSecurityFeeds,
    maxExactSecurityBarsPerFeed,
    maxExactSecurityTotalBars,
    concurrency,
    requestTimeoutMs,
    maxStaleRefreshes,
  };
}

function normalizeExecution(
  value: unknown,
  live: NormalizedBarCloseLiveConfig,
): NormalizedComputeOnlyExecutionConfig | NormalizedBarCloseMirroredExecutionConfig;
function normalizeExecution(
  value: unknown,
  live: NormalizedEveryUpdateLiveConfig,
): NormalizedComputeOnlyExecutionConfig | NormalizedEveryUpdateCadenceMirroredExecutionConfig;
function normalizeExecution(value: unknown, live: NormalizedLiveConfig): NormalizedExecutionConfig {
  const execution = configObject(value, 'config.execution');
  if (execution.kind === 'compute-only') {
    assertConfigKeys(execution, ['kind'], 'config.execution');
    return { kind: 'compute-only' };
  }
  if (execution.kind !== 'mirrored') {
    throw new Error('config.execution.kind must be "compute-only" or "mirrored"');
  }
  assertConfigKeys(
    execution,
    [
      'kind',
      'mirrorOn',
      'broker',
      'order',
      'armed',
      'intrabarExecutionArmed',
      'executionId',
      'reconcileOnStart',
      'scheduler',
      'ledger',
      'lease',
    ],
    'config.execution',
  );
  if (execution.mirrorOn !== 'bar-close' && execution.mirrorOn !== 'every-update') {
    throw new Error('config.execution.mirrorOn must be "bar-close" or "every-update"');
  }
  const mirrorOn: 'bar-close' | 'every-update' = execution.mirrorOn;
  if (mirrorOn === 'every-update' && live.cadence !== 'every-update') {
    throw new Error('config.execution.mirrorOn "every-update" requires every-update cadence');
  }
  if (mirrorOn === 'every-update') {
    throw new Error(
      'Paper mirrorOn "every-update" is unavailable because the public piner runtime does not expose a provable pending-order/fill lifecycle',
    );
  }

  const broker = normalizeBroker(execution.broker);
  if (live.cadence === 'every-update' && broker.id === 'tiger') {
    throw new Error(
      'Tiger intrabar execution is unavailable until the credentialed release gate passes; offline facade evidence is insufficient',
    );
  }
  const order = normalizeOrder(execution.order);
  if (broker.id === 'tiger' && order.type === 'limit' && broker.cancelStuckOrders !== true) {
    throw new Error('Tiger limit orders require config.execution.broker.cancelStuckOrders=true');
  }

  if (live.cadence === 'every-update') {
    if (Object.prototype.hasOwnProperty.call(execution, 'reconcileOnStart')) {
      throw new Error('config.execution.reconcileOnStart is not allowed for every-update');
    }
    if (execution.intrabarExecutionArmed !== true) {
      throw new Error(
        'every-update mirrored execution requires config.execution.intrabarExecutionArmed=true',
      );
    }
  } else if (Object.prototype.hasOwnProperty.call(execution, 'intrabarExecutionArmed')) {
    throw new Error(
      'config.execution.intrabarExecutionArmed is only valid for every-update cadence',
    );
  }

  let reconcileOnStart: boolean | undefined;
  if (live.cadence === 'bar-close') {
    if (
      execution.reconcileOnStart !== undefined &&
      typeof execution.reconcileOnStart !== 'boolean'
    ) {
      throw new Error('config.execution.reconcileOnStart must be boolean');
    }
    reconcileOnStart =
      execution.reconcileOnStart === undefined ? false : execution.reconcileOnStart;
  }

  if (Object.prototype.hasOwnProperty.call(execution, 'scheduler')) {
    throw new Error(
      'config.execution.scheduler is unavailable while mirrorOn "every-update" is fail-closed',
    );
  }

  if (broker.id === 'paper' && Object.prototype.hasOwnProperty.call(execution, 'armed')) {
    throw new Error('config.execution.armed is only valid for the Tiger broker');
  }
  let armed: boolean | undefined;
  if (broker.id === 'tiger') {
    if (execution.armed !== undefined && typeof execution.armed !== 'boolean') {
      throw new Error('config.execution.armed must be boolean');
    }
    armed = execution.armed === undefined ? false : execution.armed;
  }

  const executionId = optionalNonEmptyString(execution.executionId, 'config.execution.executionId');
  const ledger = normalizeLedger(execution.ledger);
  const lease = normalizeLease(execution.lease);
  if (ledger.path === lease.path) {
    throw new Error('config.execution.ledger.path and lease.path must be different');
  }
  const base = {
    kind: 'mirrored' as const,
    order,
    ...(executionId !== undefined ? { executionId } : {}),
    ledger,
    lease,
  };

  if (live.cadence === 'every-update') {
    if (broker.id !== 'paper') {
      throw new Error(
        'Tiger intrabar execution is unavailable until the credentialed release gate passes; offline facade evidence is insufficient',
      );
    }
    return { ...base, mirrorOn: 'bar-close', broker, intrabarExecutionArmed: true };
  }

  if (broker.id === 'tiger') {
    return {
      ...base,
      mirrorOn: 'bar-close',
      broker,
      armed: armed!,
      reconcileOnStart: reconcileOnStart!,
    };
  }
  return {
    ...base,
    mirrorOn: 'bar-close',
    broker,
    reconcileOnStart: reconcileOnStart!,
  };
}

function normalizeOrder(value: unknown): NormalizedOrderPolicyConfig {
  if (value === undefined) return { type: 'market' };
  const order = configObject(value, 'config.execution.order');
  assertConfigKeys(order, ['type', 'limitOffsetTicks'], 'config.execution.order');
  if (order.type === 'market') {
    if (Object.prototype.hasOwnProperty.call(order, 'limitOffsetTicks')) {
      throw new Error('config.execution.order.limitOffsetTicks is only valid for limit orders');
    }
    return { type: 'market' };
  }
  if (order.type !== 'limit') {
    throw new Error('config.execution.order.type must be "market" or "limit"');
  }
  const limitOffsetTicks = nonNegativeSafeInteger(
    order.limitOffsetTicks === undefined ? 0 : order.limitOffsetTicks,
    'config.execution.order.limitOffsetTicks',
  );
  return { type: 'limit', limitOffsetTicks };
}

function normalizeBroker(value: unknown): NormalizedBrokerConfig {
  const broker = configObject(value, 'config.execution.broker');
  if (broker.id === 'paper') {
    assertConfigKeys(
      broker,
      ['id', 'initialBalance', 'slippageBps', 'commissionPerUnit'],
      'config.execution.broker',
    );
    const initialBalance = optionalPositiveNumber(
      broker.initialBalance,
      'config.execution.broker.initialBalance',
    );
    const slippageBps = optionalNonNegativeNumber(
      broker.slippageBps,
      'config.execution.broker.slippageBps',
    );
    const commissionPerUnit = optionalNonNegativeNumber(
      broker.commissionPerUnit,
      'config.execution.broker.commissionPerUnit',
    );
    return {
      id: 'paper',
      ...(initialBalance !== undefined ? { initialBalance } : {}),
      ...(slippageBps !== undefined ? { slippageBps } : {}),
      ...(commissionPerUnit !== undefined ? { commissionPerUnit } : {}),
    };
  }
  if (broker.id !== 'tiger') {
    throw new Error('config.execution.broker.id must be "paper" or "tiger"');
  }
  assertConfigKeys(
    broker,
    ['id', 'profile', 'account', 'orderPollIntervalMs', 'maxOrderPolls', 'cancelStuckOrders'],
    'config.execution.broker',
  );
  const profile = optionalNonEmptyString(broker.profile, 'config.execution.broker.profile');
  const account = optionalNonEmptyString(broker.account, 'config.execution.broker.account');
  const orderPollIntervalMs = optionalNonNegativeSafeInteger(
    broker.orderPollIntervalMs,
    'config.execution.broker.orderPollIntervalMs',
  );
  const maxOrderPolls = optionalPositiveSafeInteger(
    broker.maxOrderPolls,
    'config.execution.broker.maxOrderPolls',
  );
  if (broker.cancelStuckOrders !== undefined && typeof broker.cancelStuckOrders !== 'boolean') {
    throw new Error('config.execution.broker.cancelStuckOrders must be boolean');
  }
  return {
    id: 'tiger',
    ...(profile !== undefined ? { profile } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(orderPollIntervalMs !== undefined ? { orderPollIntervalMs } : {}),
    ...(maxOrderPolls !== undefined ? { maxOrderPolls } : {}),
    ...(broker.cancelStuckOrders !== undefined
      ? { cancelStuckOrders: broker.cancelStuckOrders as boolean }
      : {}),
  };
}

function normalizeScheduler(value: unknown): NormalizedExecutionSchedulerConfig {
  const scheduler =
    value === undefined
      ? ({} as Readonly<Record<string, unknown>>)
      : configObject(value, 'config.execution.scheduler');
  assertConfigKeys(
    scheduler,
    [
      'minReconcileIntervalMs',
      'maxOrdersPerBar',
      'maxOrdersPerMinute',
      'maxTargetChangesPerBar',
      'maxConsecutiveExecutionErrors',
    ],
    'config.execution.scheduler',
  );
  return {
    minReconcileIntervalMs: boundedSafeInteger(
      scheduler.minReconcileIntervalMs === undefined
        ? DEFAULT_MIN_RECONCILE_INTERVAL_MS
        : scheduler.minReconcileIntervalMs,
      'config.execution.scheduler.minReconcileIntervalMs',
      0,
      60_000,
    ),
    maxOrdersPerBar: boundedSafeInteger(
      scheduler.maxOrdersPerBar === undefined
        ? DEFAULT_MAX_ORDERS_PER_BAR
        : scheduler.maxOrdersPerBar,
      'config.execution.scheduler.maxOrdersPerBar',
      1,
      100,
    ),
    maxOrdersPerMinute: boundedSafeInteger(
      scheduler.maxOrdersPerMinute === undefined
        ? DEFAULT_MAX_ORDERS_PER_MINUTE
        : scheduler.maxOrdersPerMinute,
      'config.execution.scheduler.maxOrdersPerMinute',
      1,
      1_000,
    ),
    maxTargetChangesPerBar: boundedSafeInteger(
      scheduler.maxTargetChangesPerBar === undefined
        ? DEFAULT_MAX_TARGET_CHANGES_PER_BAR
        : scheduler.maxTargetChangesPerBar,
      'config.execution.scheduler.maxTargetChangesPerBar',
      1,
      1_000,
    ),
    maxConsecutiveExecutionErrors: boundedSafeInteger(
      scheduler.maxConsecutiveExecutionErrors === undefined
        ? DEFAULT_MAX_CONSECUTIVE_EXECUTION_ERRORS
        : scheduler.maxConsecutiveExecutionErrors,
      'config.execution.scheduler.maxConsecutiveExecutionErrors',
      1,
      100,
    ),
  };
}

function normalizeLedger(value: unknown): NormalizedSyncLedgerConfig {
  const ledger = configObject(value, 'config.execution.ledger');
  assertConfigKeys(ledger, ['path', 'durability'], 'config.execution.ledger');
  const path = nonEmptyString(ledger.path, 'config.execution.ledger.path');
  if (ledger.durability !== 'sync') {
    throw new Error('config.execution.ledger.durability must be "sync"');
  }
  return { path, durability: 'sync' };
}

function normalizeLease(value: unknown): NormalizedExclusiveLeaseConfig {
  const lease = configObject(value, 'config.execution.lease');
  assertConfigKeys(lease, ['path'], 'config.execution.lease');
  return { path: nonEmptyString(lease.path, 'config.execution.lease.path') };
}

function optionalInputs(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isObjectRecord(value)) throw new Error('config.inputs must be an object');
  assertNoExplicitNullDeep(value, 'config.inputs');
  return { ...value };
}

function fixedTimeframeSeconds(value: string, path: string): number {
  const match = /^(\d+)([smhdw])$/.exec(value);
  if (!match) {
    throw new Error(`${path} must be a fixed canonical timeframe`);
  }
  const count = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 }[
    match[2] as 's' | 'm' | 'h' | 'd' | 'w'
  ];
  const seconds = count * multiplier;
  if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(seconds)) {
    throw new Error(`${path} must be a positive fixed canonical timeframe`);
  }
  return seconds;
}

function isCompleteStaticSecurityDependency(value: unknown): boolean {
  if (
    !isObjectRecord(value) ||
    value.dynamic !== false ||
    typeof value.lowerTf !== 'boolean' ||
    typeof value.self !== 'boolean' ||
    typeof value.tfSelf !== 'boolean'
  ) {
    return false;
  }
  if (
    (value.self && value.symbol !== null) ||
    (!value.self && (typeof value.symbol !== 'string' || value.symbol.length === 0)) ||
    (value.tfSelf && value.timeframe !== null) ||
    (!value.tfSelf && (typeof value.timeframe !== 'string' || value.timeframe.length === 0))
  ) {
    return false;
  }
  if (value.lowerTf ? value.lookahead !== null : typeof value.lookahead !== 'boolean') {
    return false;
  }
  return (
    Number.isSafeInteger(value.expressionPriorBars) && (value.expressionPriorBars as number) >= 0
  );
}

function optionalMetadataRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

/** Strict `alerts` section. Absent/undefined disables alerting. */
export function normalizeAlerts(value: unknown): NormalizedAlertsConfig | undefined {
  if (value === undefined) return undefined;
  const alerts = configObject(value, 'config.alerts');
  assertConfigKeys(
    alerts,
    ['channels', 'frequency', 'sendTimeoutMs', 'attempts', 'retryDelayMs', 'maxPerBar'],
    'config.alerts',
  );
  const rawChannels = alerts.channels === undefined ? [] : alerts.channels;
  if (!Array.isArray(rawChannels)) throw new Error('config.alerts.channels must be an array');
  if (rawChannels.length > MAX_ALERT_CHANNELS)
    throw new Error(`config.alerts.channels allows at most ${MAX_ALERT_CHANNELS} channels`);
  const names = new Set<string>();
  const channels: NormalizedAlertChannelConfig[] = rawChannels.map((raw, index) => {
    const at = `config.alerts.channels[${index}]`;
    const channel = configObject(raw, at);
    if (channel.id !== 'webhook' && channel.id !== 'telegram')
      throw new Error(`${at}.id must be "webhook" or "telegram"`);
    const name =
      channel.name === undefined
        ? `${channel.id}-${index + 1}`
        : nonEmptyString(channel.name, `${at}.name`);
    if (names.has(name)) throw new Error(`${at}.name "${name}" is not unique`);
    names.add(name);

    if (channel.id === 'webhook') {
      assertConfigKeys(channel, ['id', 'name', 'url', 'headers'], at);
      const url = nonEmptyString(channel.url, `${at}.url`);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`${at}.url must be a valid URL`);
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        throw new Error(`${at}.url must be http(s)`);
      let headers: Readonly<Record<string, string>> | undefined;
      if (channel.headers !== undefined) {
        const rawHeaders = configObject(channel.headers, `${at}.headers`);
        for (const [key, headerValue] of Object.entries(rawHeaders)) {
          if (typeof headerValue !== 'string')
            throw new Error(`${at}.headers.${key} must be a string`);
        }
        headers = { ...(rawHeaders as Record<string, string>) };
      }
      return { id: 'webhook' as const, name, url, ...(headers ? { headers } : {}) };
    }

    assertConfigKeys(channel, ['id', 'name', 'botToken', 'chatId', 'disableNotification'], at);
    const botToken = nonEmptyString(channel.botToken, `${at}.botToken`);
    if (!/^\d+:[\w-]+$/.test(botToken))
      throw new Error(`${at}.botToken must look like "<digits>:<secret>"`);
    // Numeric ids (users, and negative group ids) are accepted and canonicalized.
    const chatId =
      typeof channel.chatId === 'number' && Number.isSafeInteger(channel.chatId)
        ? String(channel.chatId)
        : nonEmptyString(channel.chatId, `${at}.chatId`);
    if (channel.disableNotification != null && typeof channel.disableNotification !== 'boolean')
      throw new Error(`${at}.disableNotification must be boolean`);
    return {
      id: 'telegram' as const,
      name,
      botToken,
      chatId,
      ...(typeof channel.disableNotification === 'boolean'
        ? { disableNotification: channel.disableNotification }
        : {}),
    };
  });
  const frequency = alerts.frequency === undefined ? DEFAULT_ALERT_FREQUENCY : alerts.frequency;
  if (frequency !== 'all' && frequency !== 'once_per_bar' && frequency !== 'once_per_bar_close')
    throw new Error(
      'config.alerts.frequency must be "all", "once_per_bar", or "once_per_bar_close"',
    );
  return {
    channels,
    frequency,
    sendTimeoutMs: boundedSafeInteger(
      alerts.sendTimeoutMs === undefined ? DEFAULT_ALERT_SEND_TIMEOUT_MS : alerts.sendTimeoutMs,
      'config.alerts.sendTimeoutMs',
      1,
      120_000,
    ),
    attempts: boundedSafeInteger(
      alerts.attempts === undefined ? DEFAULT_ALERT_ATTEMPTS : alerts.attempts,
      'config.alerts.attempts',
      1,
      5,
    ),
    retryDelayMs: boundedSafeInteger(
      alerts.retryDelayMs === undefined ? DEFAULT_ALERT_RETRY_DELAY_MS : alerts.retryDelayMs,
      'config.alerts.retryDelayMs',
      0,
      10_000,
    ),
    maxPerBar: boundedSafeInteger(
      alerts.maxPerBar === undefined ? DEFAULT_MAX_ALERTS_PER_BAR : alerts.maxPerBar,
      'config.alerts.maxPerBar',
      1,
      1_000,
    ),
  };
}

function configObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isObjectRecord(value)) throw new Error(`${path} must be an object`);
  return value;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertNoExplicitNullDeep(
  value: unknown,
  path: string,
  seen: Set<object> = new Set(),
): void {
  if (value === null) throw new Error(`${path} must not be null`);
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const key of Object.keys(value)) {
    assertNoExplicitNullDeep(
      (value as Readonly<Record<string, unknown>>)[key],
      `${path}.${key}`,
      seen,
    );
  }
}

function assertNoExplicitNullProviderInternals(value: Readonly<Record<string, unknown>>): void {
  const transport = value.transport;
  if (transport === undefined || transport === null) return;
  if (typeof transport !== 'object' && typeof transport !== 'function') return;
  const fields = transport as Readonly<Record<string, unknown>>;
  for (const key of ['resolveFuture', 'bars', 'connect', 'disconnect'] as const) {
    if (fields[key] === null) throw new Error(`config.data.transport.${key} must not be null`);
  }
}

function assertNoExplicitNullProperties(
  value: Readonly<Record<string, unknown>>,
  path: string,
): void {
  const nullKey = Object.keys(value).find((key) => value[key] === null);
  if (nullKey) throw new Error(`${path}.${nullKey} must not be null`);
}

function assertConfigKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${path}.${unknown} is not allowed`);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(value, path);
}

function positiveSafeInteger(value: unknown, path: string): number {
  return boundedSafeInteger(value, path, 1, Number.MAX_SAFE_INTEGER);
}

function optionalPositiveSafeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveSafeInteger(value, path);
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  return boundedSafeInteger(value, path, 0, Number.MAX_SAFE_INTEGER);
}

function optionalNonNegativeSafeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return nonNegativeSafeInteger(value, path);
}

function boundedSafeInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    const bound =
      maximum === Number.MAX_SAFE_INTEGER
        ? minimum === 0
          ? 'a non-negative safe integer'
          : 'a positive safe integer'
        : `a safe integer from ${minimum} to ${maximum}`;
    throw new Error(`${path} must be ${bound}`);
  }
  return value;
}

function optionalPositiveNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive finite number`);
  }
  return value;
}

function optionalNonNegativeNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a non-negative finite number`);
  }
  return value;
}
