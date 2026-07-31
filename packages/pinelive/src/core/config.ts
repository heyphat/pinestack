import { assertProviderConfig, type ProviderConfig } from '@heyphat/pinery';

export interface V1OrderPolicyConfig {
  type: 'market' | 'limit';
  limitOffsetTicks?: number;
}

export interface NormalizedV1RunConfig {
  configVersion: 1;
  strategy: string;
  symbol: string;
  timeframe: string;
  warmupBars?: number;
  inputs?: Readonly<Record<string, unknown>>;
  executionId?: string;
  reconcileOnStart?: boolean;
  order?: V1OrderPolicyConfig;
  resolveSecurity?: boolean;
  securityWarmupBars?: number;
  maxSecurityBars?: number;
  maxSecurityFeeds?: number;
  securityConcurrency?: number;
  securityRequestTimeoutMs?: number;
  maxSecurityStaleRefreshes?: number;
  data: ProviderConfig;
  tigerProfile?: string;
  broker:
    | {
        id: 'paper';
        initialBalance?: number;
        slippageBps?: number;
        commissionPerUnit?: number;
      }
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

export type NormalizedV2OrderPolicyConfig =
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
  readonly order: NormalizedV2OrderPolicyConfig;
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

interface NormalizedV2RunConfigCommon {
  readonly configVersion: 2;
  readonly strategy: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly warmupBars?: number;
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly data: ProviderConfig;
  readonly historical: NormalizedHistoricalConfig;
}

export type NormalizedBarCloseV2RunConfig = NormalizedV2RunConfigCommon & {
  readonly live: NormalizedBarCloseLiveConfig;
  readonly security: NormalizedSecurityConfig;
  readonly execution:
    NormalizedComputeOnlyExecutionConfig | NormalizedBarCloseMirroredExecutionConfig;
};

export type NormalizedEveryUpdateV2RunConfig = NormalizedV2RunConfigCommon & {
  readonly live: NormalizedEveryUpdateLiveConfig;
  readonly security: NormalizedSecurityDisabledConfig;
  readonly execution:
    NormalizedComputeOnlyExecutionConfig | NormalizedEveryUpdateCadenceMirroredExecutionConfig;
};

/** Only combinations that the strict normalizer can emit are represented. */
export type NormalizedV2RunConfig =
  NormalizedBarCloseV2RunConfig | NormalizedEveryUpdateV2RunConfig;

export type NormalizedComputeOnlyV2RunConfig =
  | (Omit<NormalizedBarCloseV2RunConfig, 'execution'> & {
      readonly execution: NormalizedComputeOnlyExecutionConfig;
    })
  | (Omit<NormalizedEveryUpdateV2RunConfig, 'execution'> & {
      readonly execution: NormalizedComputeOnlyExecutionConfig;
    });

export type NormalizedMirroredV2RunConfig =
  | (Omit<NormalizedBarCloseV2RunConfig, 'execution'> & {
      readonly execution: NormalizedBarCloseMirroredExecutionConfig;
    })
  | (Omit<NormalizedEveryUpdateV2RunConfig, 'execution'> & {
      readonly execution: NormalizedEveryUpdateCadenceMirroredExecutionConfig;
    });

export type NormalizedRunConfig = NormalizedV1RunConfig | NormalizedV2RunConfig;

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
  return config.configVersion === 2 ? normalizeV2(config) : normalizeV1(config);
}

/**
 * Apply source-dependent gates after compilation but before provider or broker
 * construction. The caller must pass the compiler's metadata object itself.
 */
export function validateCompiledIntrabarConfig(
  compiledMetadata: CompiledIntrabarMetadata,
  config: NormalizedV2RunConfig,
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
    throw new Error(
      'v2 exact security requires config.historical.mode "bar-magnifier"; standard close-only security remains on the v1 runtime',
    );
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

function normalizeV1(value: Readonly<Record<string, unknown>>): NormalizedV1RunConfig {
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
  for (const field of ['strategy', 'symbol', 'timeframe'] as const) {
    if (typeof value[field] !== 'string' || !value[field]) {
      throw new Error(`config.${field} must be a non-empty string`);
    }
  }
  if (value.configVersion != null && value.configVersion !== 1) {
    throw new Error('unsupported configVersion');
  }
  if (
    value.warmupBars != null &&
    (!Number.isInteger(value.warmupBars) || (value.warmupBars as number) < 0)
  ) {
    throw new Error('config.warmupBars must be a non-negative integer');
  }

  let order: V1OrderPolicyConfig | undefined;
  if (value.order != null) {
    if (typeof value.order !== 'object' || Array.isArray(value.order)) {
      throw new Error('config.order must be an object');
    }
    const orderValue = value.order as Record<string, unknown>;
    assertConfigKeys(orderValue, ['type', 'limitOffsetTicks'], 'config.order');
    if (orderValue.type !== 'market' && orderValue.type !== 'limit') {
      throw new Error('config.order.type must be "market" or "limit"');
    }
    if (
      orderValue.limitOffsetTicks != null &&
      (!Number.isInteger(orderValue.limitOffsetTicks) ||
        (orderValue.limitOffsetTicks as number) < 0)
    ) {
      throw new Error('config.order.limitOffsetTicks must be a non-negative integer');
    }
    if (orderValue.type === 'market' && orderValue.limitOffsetTicks != null) {
      throw new Error('config.order.limitOffsetTicks is only valid for limit orders');
    }
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
  ] as const) {
    if (value[field] != null && (!Number.isInteger(value[field]) || (value[field] as number) < 1)) {
      throw new Error(`config.${field} must be a positive integer`);
    }
  }
  if (
    value.maxSecurityStaleRefreshes != null &&
    (!Number.isInteger(value.maxSecurityStaleRefreshes) ||
      (value.maxSecurityStaleRefreshes as number) < 0)
  ) {
    throw new Error('config.maxSecurityStaleRefreshes must be a non-negative integer');
  }
  if (
    value.securityWarmupBars != null &&
    value.maxSecurityBars != null &&
    (value.securityWarmupBars as number) > (value.maxSecurityBars as number)
  ) {
    throw new Error('config.securityWarmupBars must not exceed config.maxSecurityBars');
  }

  const data = assertProviderConfig(value.data);
  if (value.tigerProfile != null && typeof value.tigerProfile !== 'string') {
    throw new Error('config.tigerProfile must be a string');
  }
  const tigerProfile = value.tigerProfile as string | undefined;
  const brokerValue = value.broker === undefined ? { id: 'paper' } : value.broker;
  if (!brokerValue || typeof brokerValue !== 'object' || Array.isArray(brokerValue)) {
    throw new Error('config.broker must be an object');
  }
  const broker = brokerValue as Record<string, unknown>;
  if (broker.id !== 'paper' && broker.id !== 'tiger') {
    throw new Error('config.broker.id must be "paper" or "tiger"');
  }
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
      ) {
        throw new Error(`config.broker.${field} must be numeric`);
      }
    }
  } else {
    assertConfigKeys(
      broker,
      ['id', 'profile', 'account', 'orderPollIntervalMs', 'maxOrderPolls', 'cancelStuckOrders'],
      'config.broker',
    );
    if (broker.profile != null && typeof broker.profile !== 'string') {
      throw new Error('config.broker.profile must be a string');
    }
    if (broker.account != null && typeof broker.account !== 'string') {
      throw new Error('config.broker.account must be a string');
    }
    for (const field of ['orderPollIntervalMs', 'maxOrderPolls'] as const) {
      if (
        broker[field] != null &&
        (!Number.isInteger(broker[field]) || (broker[field] as number) < 0)
      ) {
        throw new Error(`config.broker.${field} must be a non-negative integer`);
      }
    }
    if (broker.cancelStuckOrders != null && typeof broker.cancelStuckOrders !== 'boolean') {
      throw new Error('config.broker.cancelStuckOrders must be boolean');
    }
    if (order?.type === 'limit' && broker.cancelStuckOrders !== true) {
      throw new Error('Tiger limit orders require config.broker.cancelStuckOrders=true');
    }
  }
  if (value.armed != null && typeof value.armed !== 'boolean') {
    throw new Error('config.armed must be boolean');
  }
  if (value.reconcileOnStart != null && typeof value.reconcileOnStart !== 'boolean') {
    throw new Error('config.reconcileOnStart must be boolean');
  }
  if (value.resolveSecurity != null && typeof value.resolveSecurity !== 'boolean') {
    throw new Error('config.resolveSecurity must be boolean');
  }
  if (value.executionId != null && typeof value.executionId !== 'string') {
    throw new Error('config.executionId must be a string');
  }
  if (value.ledger != null && typeof value.ledger !== 'string') {
    throw new Error('config.ledger must be a string');
  }
  if (
    value.inputs != null &&
    (typeof value.inputs !== 'object' || value.inputs == null || Array.isArray(value.inputs))
  ) {
    throw new Error('config.inputs must be an object');
  }

  return {
    ...(value as unknown as NormalizedV1RunConfig),
    configVersion: 1,
    order,
    data:
      tigerProfile != null && data.provider === 'tiger' && data.profile == null
        ? { ...data, profile: tigerProfile }
        : data,
    broker: (tigerProfile != null && broker.id === 'tiger' && broker.profile == null
      ? { ...broker, profile: tigerProfile }
      : broker) as NormalizedV1RunConfig['broker'],
  };
}

function normalizeV2(value: Readonly<Record<string, unknown>>): NormalizedV2RunConfig {
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
  const common = {
    configVersion: 2 as const,
    strategy,
    symbol,
    timeframe,
    ...(warmupBars !== undefined ? { warmupBars } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    data,
    historical,
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
  const order = normalizeV2Order(execution.order);
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

function normalizeV2Order(value: unknown): NormalizedV2OrderPolicyConfig {
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
