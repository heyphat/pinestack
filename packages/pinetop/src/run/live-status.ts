import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

export const LIVE_STATUS_CADENCE_MS = 5_000;
export const LIVE_STATUS_DEADLINE_MS = 4_000;
export const LIVE_STATUS_TERMINATE_GRACE_MS = 250;
export const LIVE_STATUS_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
export const LIVE_STATUS_STDERR_MAX_BYTES = 64 * 1024;
// Pinelive may return 1,000 inspected registry entries plus one cap-sentinel error.
export const LIVE_STATUS_MAX_ITEMS = 1_001;

const INSTANCE_ID = /^[a-f0-9]{32,128}$/;
const MAX_ID = 256;
const MAX_PATH = 4_096;
const MAX_TEXT = 1_024;
const MAX_REASONS = 256;
const MAX_EFFECTS = 1_000;
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export type LiveEvidence<T> =
  | { readonly availability: 'known'; readonly value: T }
  | {
      readonly availability: 'not-recorded' | 'not-inspected' | 'unsupported' | 'unknown';
      readonly reason: string;
    };

export interface LiveStatusWarning {
  readonly code: string;
  readonly message: string;
}

export interface LivePineliveStatusV1 {
  readonly statusVersion: 1;
  readonly generatedAt: string;
  readonly identity: { readonly runId?: string; readonly executionId?: string };
  readonly posture: LiveEvidence<'live' | 'monitor' | 'compute-only'>;
  readonly executionEligibility: LiveEvidence<{
    readonly state: 'enabled' | 'disabled-by-posture' | 'blocked';
    readonly reasons: readonly string[];
  }>;
  readonly ownership: {
    readonly durableLedgerLease: LiveEvidence<{
      readonly resource: string;
      readonly leaseId: string;
      readonly ownerId: string;
      readonly acquiredAt: string;
    }>;
    readonly durableAccountClaim: LiveEvidence<{
      readonly resourceDigest: string;
      readonly claimId: string;
      readonly ownerId: string;
      readonly acquiredAt: string;
    }>;
  };
  readonly breaker: LiveEvidence<{
    readonly latched: boolean;
    readonly reason?: string;
    readonly consecutiveErrors: number;
  }>;
  readonly unresolvedEffects: LiveEvidence<
    readonly {
      readonly logicalOrderId: string;
      readonly certainty: 'intent-only' | 'attempted' | 'unknown' | 'resolution-required';
      readonly target: number;
      readonly delta: number;
    }[]
  >;
  readonly latestObservation: LiveEvidence<{
    readonly decisionId: string;
    readonly target: number;
    readonly barTime: number;
    readonly observedAt: string;
    readonly recordType: string;
  }>;
  readonly recent: readonly {
    readonly recordType: string;
    readonly sequence: number;
    readonly recordedAt: string;
  }[];
  readonly ledger: {
    readonly path: string;
    readonly bytes: number;
    readonly validBytes: number;
    readonly partialTail: boolean;
    readonly ledgerSchemaVersion?: 3;
    readonly lastSequence?: number;
    readonly lastRecordAt?: string;
  };
  readonly warnings: readonly LiveStatusWarning[];
}

export interface LiveActiveRegistrationV1 {
  readonly registrationVersion: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly lifecycle: 'starting' | 'running' | 'stopping';
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly updatedAt: string;
  readonly configVersion: 3;
  readonly runId?: string;
  readonly executionId?: string;
  readonly brokerId: 'compute-only' | 'paper' | 'tiger';
  readonly posture: 'live' | 'monitor' | 'compute-only';
  readonly paths: {
    readonly ledger: string;
    readonly executionLease?: string;
    readonly accountClaim?: string;
    readonly config?: string;
    readonly log?: string;
  };
  readonly display?: {
    readonly strategyId?: string;
    readonly strategySymbol?: string;
    readonly executionSymbol?: string;
    readonly timeframe?: string;
  };
}

export interface LiveRunHistoryV1 {
  readonly historyVersion: 1;
  readonly instanceId: string;
  readonly runId?: string;
  readonly executionId?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: 'stopped' | 'failed-startup' | 'failed-runtime' | 'execution-latched';
  readonly finalLedgerPath?: string;
  readonly finalLedgerSequence?: number;
  readonly finalReasonCode?: string;
  readonly configVersion: 3;
  readonly brokerId: 'compute-only' | 'paper' | 'tiger';
  readonly posture: 'live' | 'monitor' | 'compute-only';
}

export interface LiveActiveDiscoveredRunV1 {
  readonly discoveryVersion: 1;
  readonly kind: 'active';
  readonly generatedAt: string;
  readonly instanceId: string;
  readonly registration: LiveActiveRegistrationV1;
  readonly durable: LivePineliveStatusV1;
  readonly lifecycle: {
    readonly state:
      | 'starting'
      | 'running'
      | 'stopping'
      | 'crashed'
      | 'blocked-stale-claim'
      | 'conflict'
      | 'unknown';
    readonly process: {
      readonly state:
        'matching' | 'dead' | 'alive-unverified' | 'permission-denied' | 'unsupported';
      readonly reason?: string;
    };
    readonly heartbeatAgeMs: number;
    readonly heartbeatStale: boolean;
    readonly physicalExecutionLease: LiveEvidence<
      'same-owner' | 'different-owner' | 'absent' | 'not-applicable'
    >;
    readonly physicalAccountClaim: LiveEvidence<
      'same-owner' | 'different-owner' | 'absent' | 'not-applicable'
    >;
    readonly reasons: readonly string[];
  };
  readonly warnings: readonly LiveStatusWarning[];
}

export interface LiveTerminalDiscoveredRunV1 {
  readonly discoveryVersion: 1;
  readonly kind: 'terminal';
  readonly generatedAt: string;
  readonly instanceId: string;
  readonly history: LiveRunHistoryV1;
  readonly leftoverRegistration?: LiveActiveRegistrationV1;
  readonly durable: LiveEvidence<LivePineliveStatusV1>;
  readonly lifecycle: { readonly state: 'stopped'; readonly reasons: readonly string[] };
  readonly warnings: readonly LiveStatusWarning[];
}

export type LiveDiscoveredRunV1 = LiveActiveDiscoveredRunV1 | LiveTerminalDiscoveredRunV1;

export type PineliveStatusListItemV1 =
  | { readonly ok: true; readonly value: LiveDiscoveredRunV1 }
  | {
      readonly ok: false;
      readonly instanceIdHint?: string;
      readonly path?: string;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface PineliveStatusListV1 {
  readonly statusListVersion: 1;
  readonly generatedAt: string;
  readonly items: readonly PineliveStatusListItemV1[];
}

export type LiveStatusPollErrorCode =
  | 'spawn-failed'
  | 'timeout'
  | 'stdout-too-large'
  | 'stderr-too-large'
  | 'nonzero-exit'
  | 'empty-output'
  | 'invalid-json'
  | 'invalid-envelope'
  | 'disposed';

export interface LiveStatusPollError {
  readonly code: LiveStatusPollErrorCode;
  readonly message: string;
}

export type LiveStatusPollEvent =
  | { readonly type: 'started'; readonly generation: number }
  | {
      readonly type: 'snapshot';
      readonly generation: number;
      readonly snapshot: PineliveStatusListV1;
      readonly receivedAt: string;
    }
  | {
      readonly type: 'error';
      readonly generation: number;
      readonly error: LiveStatusPollError;
    };

export class LiveStatusProtocolError extends Error {
  constructor(
    readonly code: 'invalid-json' | 'invalid-envelope',
    message: string,
  ) {
    super(message);
    this.name = 'LiveStatusProtocolError';
  }
}

export function resolvePineliveBin(
  options: Readonly<{
    bin?: string;
    env?: Readonly<Record<string, string | undefined>>;
  }> = {},
): string {
  return options.bin ?? options.env?.PINELIVE_BIN ?? process.env['PINELIVE_BIN'] ?? 'pinelive';
}

/** Poll diagnostics are rendered in a terminal, so controls must be visible rather than executable. */
function escapeTerminalText(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Parse and normalize the aggregate envelope without importing Pinelive runtime code. */
export function parsePineliveStatusList(input: string | unknown): PineliveStatusListV1 {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      throw new LiveStatusProtocolError('invalid-json', 'pinelive status emitted invalid JSON');
    }
  }

  try {
    const envelope = requiredObject(parsed, 'status envelope');
    if (envelope.statusListVersion !== 1)
      throw invalid('unsupported statusListVersion; expected 1');
    const generatedAt = timestamp(envelope.generatedAt, 'status generatedAt');
    const rawItems = boundedArray(envelope.items, 'status items', LIVE_STATUS_MAX_ITEMS);
    const items = rawItems.map((item, index) => normalizeListItem(item, index));
    return { statusListVersion: 1, generatedAt, items };
  } catch (error) {
    if (error instanceof LiveStatusProtocolError) throw error;
    throw invalid('pinelive status envelope is malformed');
  }
}

function normalizeListItem(value: unknown, index: number): PineliveStatusListItemV1 {
  const item = optionalObject(value);
  const hinted = optionalInstanceId(
    item?.instanceIdHint ?? optionalObject(item?.value)?.instanceId,
  );
  try {
    if (!item) throw invalid('status item must be an object');
    if (item.ok === true) return { ok: true, value: normalizeDiscovered(item.value) };
    if (item.ok !== false) throw invalid('status item ok must be boolean');
    const error = requiredObject(item.error, 'status item error');
    return {
      ok: false,
      ...(optionalInstanceId(item.instanceIdHint)
        ? { instanceIdHint: optionalInstanceId(item.instanceIdHint) }
        : {}),
      ...(optionalString(item.path, MAX_PATH) ? { path: optionalString(item.path, MAX_PATH) } : {}),
      error: {
        code: boundedString(error.code, 'status item error code', MAX_ID),
        message: boundedString(error.message, 'status item error message', MAX_TEXT),
      },
    };
  } catch {
    return {
      ok: false,
      ...(hinted ? { instanceIdHint: hinted } : {}),
      error: {
        code: 'invalid-status-item',
        message: `aggregate status item ${index + 1} is malformed`,
      },
    };
  }
}

function normalizeDiscovered(value: unknown): LiveDiscoveredRunV1 {
  const run = requiredObject(value, 'discovered run');
  if (run.discoveryVersion !== 1) throw invalid('unsupported discoveryVersion; expected 1');
  const generatedAt = timestamp(run.generatedAt, 'discovered generatedAt');
  const instanceId = validatedInstanceId(run.instanceId);
  const warnings = normalizeWarnings(run.warnings);
  if (run.kind === 'active') {
    const registration = normalizeRegistration(run.registration);
    if (registration.instanceId !== instanceId) throw invalid('active instanceId mismatch');
    return {
      discoveryVersion: 1,
      kind: 'active',
      generatedAt,
      instanceId,
      registration,
      durable: normalizeDurableStatus(run.durable),
      lifecycle: normalizeActiveLifecycle(run.lifecycle),
      warnings,
    };
  }
  if (run.kind === 'terminal') {
    const history = normalizeHistory(run.history);
    if (history.instanceId !== instanceId) throw invalid('terminal instanceId mismatch');
    const leftover = run.leftoverRegistration
      ? normalizeRegistration(run.leftoverRegistration)
      : undefined;
    if (leftover && leftover.instanceId !== instanceId)
      throw invalid('leftover registration instanceId mismatch');
    const lifecycle = requiredObject(run.lifecycle, 'terminal lifecycle');
    if (lifecycle.state !== 'stopped') throw invalid('terminal lifecycle must be stopped');
    return {
      discoveryVersion: 1,
      kind: 'terminal',
      generatedAt,
      instanceId,
      history,
      ...(leftover ? { leftoverRegistration: leftover } : {}),
      durable: normalizeEvidence(run.durable, normalizeDurableStatus, 'terminal durable'),
      lifecycle: {
        state: 'stopped',
        reasons: stringArray(lifecycle.reasons, 'terminal lifecycle reasons'),
      },
      warnings,
    };
  }
  throw invalid('discovered run kind is invalid');
}

function normalizeRegistration(value: unknown): LiveActiveRegistrationV1 {
  const registration = requiredObject(value, 'active registration');
  if (registration.registrationVersion !== 1 || registration.configVersion !== 3)
    throw invalid('active registration version is unsupported');
  const paths = requiredObject(registration.paths, 'active registration paths');
  const display = optionalObject(registration.display);
  return {
    registrationVersion: 1,
    instanceId: validatedInstanceId(registration.instanceId),
    pid: nonnegativeInteger(registration.pid, 'active registration pid', true),
    lifecycle: enumString(
      registration.lifecycle,
      ['starting', 'running', 'stopping'] as const,
      'active registration lifecycle',
    ),
    startedAt: timestamp(registration.startedAt, 'active registration startedAt'),
    heartbeatAt: timestamp(registration.heartbeatAt, 'active registration heartbeatAt'),
    updatedAt: timestamp(registration.updatedAt, 'active registration updatedAt'),
    configVersion: 3,
    ...(optionalString(registration.runId, MAX_ID)
      ? { runId: optionalString(registration.runId, MAX_ID) }
      : {}),
    ...(optionalString(registration.executionId, MAX_ID)
      ? { executionId: optionalString(registration.executionId, MAX_ID) }
      : {}),
    brokerId: enumString(
      registration.brokerId,
      ['compute-only', 'paper', 'tiger'] as const,
      'active registration brokerId',
    ),
    posture: enumString(
      registration.posture,
      ['live', 'monitor', 'compute-only'] as const,
      'active registration posture',
    ),
    paths: {
      ledger: boundedString(paths.ledger, 'ledger path', MAX_PATH),
      ...(optionalString(paths.executionLease, MAX_PATH)
        ? { executionLease: optionalString(paths.executionLease, MAX_PATH) }
        : {}),
      ...(optionalString(paths.accountClaim, MAX_PATH)
        ? { accountClaim: optionalString(paths.accountClaim, MAX_PATH) }
        : {}),
      ...(optionalString(paths.config, MAX_PATH)
        ? { config: optionalString(paths.config, MAX_PATH) }
        : {}),
      ...(optionalString(paths.log, MAX_PATH) ? { log: optionalString(paths.log, MAX_PATH) } : {}),
    },
    ...(display
      ? {
          display: {
            ...(optionalString(display.strategyId, MAX_ID)
              ? { strategyId: optionalString(display.strategyId, MAX_ID) }
              : {}),
            ...(optionalString(display.strategySymbol, MAX_ID)
              ? { strategySymbol: optionalString(display.strategySymbol, MAX_ID) }
              : {}),
            ...(optionalString(display.executionSymbol, MAX_ID)
              ? { executionSymbol: optionalString(display.executionSymbol, MAX_ID) }
              : {}),
            ...(optionalString(display.timeframe, MAX_ID)
              ? { timeframe: optionalString(display.timeframe, MAX_ID) }
              : {}),
          },
        }
      : {}),
  };
}

function normalizeHistory(value: unknown): LiveRunHistoryV1 {
  const history = requiredObject(value, 'run history');
  if (history.historyVersion !== 1 || history.configVersion !== 3)
    throw invalid('run history version is unsupported');
  return {
    historyVersion: 1,
    instanceId: validatedInstanceId(history.instanceId),
    ...(optionalString(history.runId, MAX_ID)
      ? { runId: optionalString(history.runId, MAX_ID) }
      : {}),
    ...(optionalString(history.executionId, MAX_ID)
      ? { executionId: optionalString(history.executionId, MAX_ID) }
      : {}),
    startedAt: timestamp(history.startedAt, 'history startedAt'),
    endedAt: timestamp(history.endedAt, 'history endedAt'),
    outcome: enumString(
      history.outcome,
      ['stopped', 'failed-startup', 'failed-runtime', 'execution-latched'] as const,
      'history outcome',
    ),
    ...(optionalString(history.finalLedgerPath, MAX_PATH)
      ? { finalLedgerPath: optionalString(history.finalLedgerPath, MAX_PATH) }
      : {}),
    ...(history.finalLedgerSequence === undefined
      ? {}
      : {
          finalLedgerSequence: nonnegativeInteger(
            history.finalLedgerSequence,
            'history final ledger sequence',
          ),
        }),
    ...(optionalString(history.finalReasonCode, MAX_ID)
      ? { finalReasonCode: optionalString(history.finalReasonCode, MAX_ID) }
      : {}),
    configVersion: 3,
    brokerId: enumString(
      history.brokerId,
      ['compute-only', 'paper', 'tiger'] as const,
      'history brokerId',
    ),
    posture: enumString(
      history.posture,
      ['live', 'monitor', 'compute-only'] as const,
      'history posture',
    ),
  };
}

function normalizeActiveLifecycle(value: unknown): LiveActiveDiscoveredRunV1['lifecycle'] {
  const lifecycle = requiredObject(value, 'active lifecycle');
  const process = requiredObject(lifecycle.process, 'active lifecycle process');
  return {
    state: enumString(
      lifecycle.state,
      [
        'starting',
        'running',
        'stopping',
        'crashed',
        'blocked-stale-claim',
        'conflict',
        'unknown',
      ] as const,
      'active lifecycle state',
    ),
    process: {
      state: enumString(
        process.state,
        ['matching', 'dead', 'alive-unverified', 'permission-denied', 'unsupported'] as const,
        'process state',
      ),
      ...(optionalString(process.reason, MAX_TEXT)
        ? { reason: optionalString(process.reason, MAX_TEXT) }
        : {}),
    },
    heartbeatAgeMs: nonnegativeNumber(lifecycle.heartbeatAgeMs, 'heartbeat age'),
    heartbeatStale: booleanValue(lifecycle.heartbeatStale, 'heartbeat stale'),
    physicalExecutionLease: normalizeEvidence(
      lifecycle.physicalExecutionLease,
      (claim) =>
        enumString(
          claim,
          ['same-owner', 'different-owner', 'absent', 'not-applicable'] as const,
          'physical execution lease',
        ),
      'physical execution lease evidence',
    ),
    physicalAccountClaim: normalizeEvidence(
      lifecycle.physicalAccountClaim,
      (claim) =>
        enumString(
          claim,
          ['same-owner', 'different-owner', 'absent', 'not-applicable'] as const,
          'physical account claim',
        ),
      'physical account claim evidence',
    ),
    reasons: stringArray(lifecycle.reasons, 'active lifecycle reasons'),
  };
}

function normalizeDurableStatus(value: unknown): LivePineliveStatusV1 {
  const status = requiredObject(value, 'durable status');
  if (status.statusVersion !== 1) throw invalid('unsupported durable statusVersion; expected 1');
  const identity = requiredObject(status.identity, 'durable identity');
  const ownership = requiredObject(status.ownership, 'durable ownership');
  const ledger = requiredObject(status.ledger, 'durable ledger');
  const ledgerBytes = nonnegativeInteger(ledger.bytes, 'durable ledger bytes');
  const ledgerValidBytes = nonnegativeInteger(ledger.validBytes, 'durable ledger valid bytes');
  const ledgerPartialTail = booleanValue(ledger.partialTail, 'durable ledger partial tail');
  if (ledgerValidBytes > ledgerBytes)
    throw invalid('durable ledger valid bytes must not exceed total bytes');
  const ledgerSchemaVersion =
    ledger.ledgerSchemaVersion === undefined
      ? undefined
      : ledger.ledgerSchemaVersion === 3
        ? (3 as const)
        : (() => {
            throw invalid('unsupported durable ledger schema version');
          })();
  const ledgerLastSequence =
    ledger.lastSequence === undefined
      ? undefined
      : nonnegativeInteger(ledger.lastSequence, 'durable last sequence');
  const ledgerLastRecordAt =
    ledger.lastRecordAt === undefined
      ? undefined
      : timestamp(ledger.lastRecordAt, 'durable lastRecordAt');
  const emptyLedger = ledgerBytes === 0 && ledgerValidBytes === 0;
  if (!emptyLedger && ledgerSchemaVersion !== 3)
    throw invalid('nonempty durable ledger requires schema version 3');
  if (
    emptyLedger &&
    (ledgerPartialTail || ledgerLastSequence !== undefined || ledgerLastRecordAt !== undefined)
  )
    throw invalid('empty durable ledger contains inconsistent evidence');
  return {
    statusVersion: 1,
    generatedAt: timestamp(status.generatedAt, 'durable generatedAt'),
    identity: {
      ...(optionalString(identity.runId, MAX_ID)
        ? { runId: optionalString(identity.runId, MAX_ID) }
        : {}),
      ...(optionalString(identity.executionId, MAX_ID)
        ? { executionId: optionalString(identity.executionId, MAX_ID) }
        : {}),
    },
    posture: normalizeEvidence(
      status.posture,
      (posture) =>
        enumString(posture, ['live', 'monitor', 'compute-only'] as const, 'durable posture'),
      'durable posture evidence',
    ),
    executionEligibility: normalizeEvidence(
      status.executionEligibility,
      (eligibility) => {
        const record = requiredObject(eligibility, 'execution eligibility');
        return {
          state: enumString(
            record.state,
            ['enabled', 'disabled-by-posture', 'blocked'] as const,
            'execution eligibility state',
          ),
          reasons: stringArray(record.reasons, 'execution eligibility reasons'),
        };
      },
      'execution eligibility evidence',
    ),
    ownership: {
      durableLedgerLease: normalizeEvidence(
        ownership.durableLedgerLease,
        (lease) => {
          const record = requiredObject(lease, 'durable ledger lease');
          return {
            resource: boundedString(record.resource, 'ledger lease resource', MAX_PATH),
            leaseId: boundedString(record.leaseId, 'ledger lease id', MAX_ID),
            ownerId: boundedString(record.ownerId, 'ledger lease owner', MAX_ID),
            acquiredAt: timestamp(record.acquiredAt, 'ledger lease acquiredAt'),
          };
        },
        'durable ledger lease evidence',
      ),
      durableAccountClaim: normalizeEvidence(
        ownership.durableAccountClaim,
        (claim) => {
          const record = requiredObject(claim, 'durable account claim');
          return {
            resourceDigest: boundedString(
              record.resourceDigest,
              'account claim resource digest',
              MAX_ID,
            ),
            claimId: boundedString(record.claimId, 'account claim id', MAX_ID),
            ownerId: boundedString(record.ownerId, 'account claim owner', MAX_ID),
            acquiredAt: timestamp(record.acquiredAt, 'account claim acquiredAt'),
          };
        },
        'durable account claim evidence',
      ),
    },
    breaker: normalizeEvidence(
      status.breaker,
      (breaker) => {
        const record = requiredObject(breaker, 'breaker state');
        return {
          latched: booleanValue(record.latched, 'breaker latched'),
          ...(optionalString(record.reason, MAX_TEXT)
            ? { reason: optionalString(record.reason, MAX_TEXT) }
            : {}),
          consecutiveErrors: nonnegativeInteger(record.consecutiveErrors, 'breaker errors'),
        };
      },
      'breaker evidence',
    ),
    unresolvedEffects: normalizeEvidence(
      status.unresolvedEffects,
      (effects) =>
        boundedArray(effects, 'unresolved effects', MAX_EFFECTS).map((effect) => {
          const record = requiredObject(effect, 'unresolved effect');
          return {
            logicalOrderId: boundedString(record.logicalOrderId, 'logical order id', MAX_ID),
            certainty: enumString(
              record.certainty,
              ['intent-only', 'attempted', 'unknown', 'resolution-required'] as const,
              'effect certainty',
            ),
            target: finiteNumber(record.target, 'effect target'),
            delta: finiteNumber(record.delta, 'effect delta'),
          };
        }),
      'unresolved effect evidence',
    ),
    latestObservation: normalizeEvidence(
      status.latestObservation,
      (observation) => {
        const record = requiredObject(observation, 'latest observation');
        return {
          decisionId: boundedString(record.decisionId, 'observation decision id', MAX_ID),
          target: finiteNumber(record.target, 'observation target'),
          barTime: finiteNumber(record.barTime, 'observation bar time'),
          observedAt: timestamp(record.observedAt, 'observation observedAt'),
          recordType: boundedString(record.recordType, 'observation record type', MAX_ID),
        };
      },
      'latest observation evidence',
    ),
    recent: boundedArray(status.recent, 'recent durable events', 100).map((event) => {
      const record = requiredObject(event, 'recent durable event');
      return {
        recordType: boundedString(record.recordType, 'recent record type', MAX_ID),
        sequence: nonnegativeInteger(record.sequence, 'recent sequence'),
        recordedAt: timestamp(record.recordedAt, 'recent recordedAt'),
      };
    }),
    ledger: {
      path: boundedString(ledger.path, 'durable ledger path', MAX_PATH),
      bytes: ledgerBytes,
      validBytes: ledgerValidBytes,
      partialTail: ledgerPartialTail,
      ...(ledgerSchemaVersion === undefined ? {} : { ledgerSchemaVersion }),
      ...(ledgerLastSequence === undefined ? {} : { lastSequence: ledgerLastSequence }),
      ...(ledgerLastRecordAt === undefined ? {} : { lastRecordAt: ledgerLastRecordAt }),
    },
    warnings: normalizeWarnings(status.warnings),
  };
}

function normalizeEvidence<T>(
  value: unknown,
  knownValue: (value: unknown) => T,
  label: string,
): LiveEvidence<T> {
  const evidence = requiredObject(value, label);
  const availability = enumString(
    evidence.availability,
    ['known', 'not-recorded', 'not-inspected', 'unsupported', 'unknown'] as const,
    `${label} availability`,
  );
  if (availability === 'known') return { availability, value: knownValue(evidence.value) };
  return {
    availability,
    reason: boundedString(evidence.reason, `${label} reason`, MAX_TEXT),
  };
}

function normalizeWarnings(value: unknown): readonly LiveStatusWarning[] {
  return boundedArray(value, 'warnings', MAX_REASONS).map((warning) => {
    const record = requiredObject(warning, 'warning');
    return {
      code: boundedString(record.code, 'warning code', MAX_ID),
      message: boundedString(record.message, 'warning message', MAX_TEXT),
    };
  });
}

function stringArray(value: unknown, label: string): readonly string[] {
  return boundedArray(value, label, MAX_REASONS).map((item) =>
    boundedString(item, label, MAX_TEXT),
  );
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  const record = optionalObject(value);
  if (!record) throw invalid(`${label} must be an object`);
  return record;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw invalid(`${label} must be a bounded array`);
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    TERMINAL_CONTROL.test(value)
  )
    throw invalid(`${label} must be a nonempty bounded string without terminal controls`);
  return value;
}

function optionalString(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, 'optional string', maximum);
}

function validatedInstanceId(value: unknown): string {
  if (typeof value !== 'string' || !INSTANCE_ID.test(value)) throw invalid('instanceId is invalid');
  return value;
}

function optionalInstanceId(value: unknown): string | undefined {
  return typeof value === 'string' && INSTANCE_ID.test(value) ? value : undefined;
}

function timestamp(value: unknown, label: string): string {
  const text = boundedString(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) throw invalid(`${label} must be a timestamp`);
  return text;
}

function enumString<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalid(`${label} is invalid`);
  return value as T[number];
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw invalid(`${label} must be finite`);
  return value;
}

function nonnegativeNumber(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number < 0) throw invalid(`${label} must not be negative`);
  return number;
}

function nonnegativeInteger(value: unknown, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0))
    throw invalid(`${label} must be a ${positive ? 'positive' : 'nonnegative'} integer`);
  return value as number;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw invalid(`${label} must be boolean`);
  return value;
}

function invalid(message: string): LiveStatusProtocolError {
  return new LiveStatusProtocolError('invalid-envelope', message);
}

export interface LiveStatusChild {
  readonly stdout: Readable;
  readonly stderr: Readable;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface LiveStatusSpawnOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
}

export type LiveStatusSpawn = (
  bin: string,
  argv: readonly string[],
  options: LiveStatusSpawnOptions,
) => LiveStatusChild;

export interface LiveStatusPollerOptions {
  readonly bin?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cadenceMs?: number;
  readonly deadlineMs?: number;
  readonly terminateGraceMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly spawn?: LiveStatusSpawn;
  readonly now?: () => Date;
}

export interface LiveStatusPollerLike {
  subscribe(listener: (event: LiveStatusPollEvent) => void): () => void;
  /** Start or resume the cadence and trigger one immediate best-effort poll. */
  start(): void;
  /** Pause future cadence polls without discarding the last snapshot. */
  pause?(): void;
  poll(): Promise<boolean>;
  dispose(): Promise<void>;
}

interface ActiveAttempt {
  readonly generation: number;
  readonly done: Promise<void>;
  readonly terminate: (error: LiveStatusPollError) => void;
}

/** Bounded, non-overlapping polling of `pinelive status --all --json`. */
export class LiveStatusPoller implements LiveStatusPollerLike {
  readonly bin: string;
  readonly cadenceMs: number;
  readonly deadlineMs: number;
  readonly terminateGraceMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;

  private readonly cwd?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnChild: LiveStatusSpawn;
  private readonly now: () => Date;
  private readonly listeners = new Set<(event: LiveStatusPollEvent) => void>();
  private cadenceTimer?: ReturnType<typeof setInterval>;
  private active?: ActiveAttempt;
  private generation = 0;
  private running = false;
  private disposed = false;

  constructor(options: LiveStatusPollerOptions = {}) {
    this.env = options.env ?? process.env;
    this.bin = resolvePineliveBin({ bin: options.bin, env: this.env });
    this.cwd = options.cwd;
    this.cadenceMs = positiveOption(options.cadenceMs, LIVE_STATUS_CADENCE_MS, 'cadenceMs');
    this.deadlineMs = positiveOption(options.deadlineMs, LIVE_STATUS_DEADLINE_MS, 'deadlineMs');
    this.terminateGraceMs = positiveOption(
      options.terminateGraceMs,
      LIVE_STATUS_TERMINATE_GRACE_MS,
      'terminateGraceMs',
    );
    this.maxStdoutBytes = positiveOption(
      options.maxStdoutBytes,
      LIVE_STATUS_STDOUT_MAX_BYTES,
      'maxStdoutBytes',
    );
    this.maxStderrBytes = positiveOption(
      options.maxStderrBytes,
      LIVE_STATUS_STDERR_MAX_BYTES,
      'maxStderrBytes',
    );
    this.spawnChild =
      options.spawn ??
      ((bin, argv, spawnOptions) =>
        spawn(bin, [...argv], {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as LiveStatusChild);
    this.now = options.now ?? (() => new Date());
  }

  subscribe(listener: (event: LiveStatusPollEvent) => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    void this.poll();
    this.cadenceTimer = setInterval(() => {
      void this.poll();
    }, this.cadenceMs);
    this.cadenceTimer.unref?.();
  }

  pause(): void {
    if (this.cadenceTimer) clearInterval(this.cadenceTimer);
    this.cadenceTimer = undefined;
    this.running = false;
  }

  /** Returns false when a previous poll is still active or the poller was disposed. */
  async poll(): Promise<boolean> {
    if (this.disposed || this.active) return false;
    const generation = ++this.generation;
    this.emit({ type: 'started', generation });
    const attempt = this.createAttempt(generation);
    this.active = attempt;
    await attempt.done;
    if (this.active === attempt) this.active = undefined;
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.pause();
    const active = this.active;
    if (active) {
      active.terminate({ code: 'disposed', message: 'live status poller was disposed' });
      await active.done;
      if (this.active === active) this.active = undefined;
    }
    this.listeners.clear();
  }

  private createAttempt(generation: number): ActiveAttempt {
    let terminate = (_error: LiveStatusPollError): void => undefined;
    const done = new Promise<void>((resolve) => {
      let child: LiveStatusChild;
      try {
        child = this.spawnChild(this.bin, ['status', '--all', '--json'], {
          cwd: this.cwd,
          env: this.env,
        });
      } catch {
        this.emitCurrent(generation, {
          type: 'error',
          generation,
          error: { code: 'spawn-failed', message: `could not start ${this.bin}` },
        });
        resolve();
        return;
      }

      let finished = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const stdout: Buffer[] = [];
      let terminationError: LiveStatusPollError | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (forceTimer) clearTimeout(forceTimer);
        deadlineTimer = undefined;
        forceTimer = undefined;
        child.stdout.off('data', onStdout);
        child.stderr.off('data', onStderr);
        child.off('error', onError);
        child.off('close', onClose);
      };

      const finish = (error?: LiveStatusPollError, code?: number | null): void => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) {
          this.emitCurrent(generation, { type: 'error', generation, error });
          resolve();
          return;
        }
        if (code !== 0) {
          this.emitCurrent(generation, {
            type: 'error',
            generation,
            error: {
              code: 'nonzero-exit',
              message: `${this.bin} status exited ${code == null ? 'without a status' : code}`,
            },
          });
          resolve();
          return;
        }
        const output = Buffer.concat(stdout, stdoutBytes).toString('utf8').trim();
        if (output === '') {
          this.emitCurrent(generation, {
            type: 'error',
            generation,
            error: { code: 'empty-output', message: `${this.bin} status produced no output` },
          });
          resolve();
          return;
        }
        try {
          const snapshot = parsePineliveStatusList(output);
          this.emitCurrent(generation, {
            type: 'snapshot',
            generation,
            snapshot,
            receivedAt: this.now().toISOString(),
          });
        } catch (parseError) {
          const normalized =
            parseError instanceof LiveStatusProtocolError
              ? parseError
              : new LiveStatusProtocolError(
                  'invalid-envelope',
                  'pinelive status envelope is malformed',
                );
          this.emitCurrent(generation, {
            type: 'error',
            generation,
            error: { code: normalized.code, message: normalized.message },
          });
        }
        resolve();
      };

      const requestTermination = (error: LiveStatusPollError): void => {
        if (finished) return;
        terminationError ??= error;
        try {
          child.kill('SIGTERM');
        } catch {
          // The bounded forced path below is still attempted.
        }
        if (forceTimer) return;
        forceTimer = setTimeout(() => {
          forceTimer = undefined;
          try {
            child.kill('SIGKILL');
          } catch {
            // The attempt still settles; no child reference is retained.
          }
          finish(terminationError);
        }, this.terminateGraceMs);
        forceTimer.unref?.();
      };
      terminate = requestTermination;

      const onStdout = (chunk: string | Buffer): void => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += bytes.byteLength;
        if (stdoutBytes > this.maxStdoutBytes) {
          requestTermination({
            code: 'stdout-too-large',
            message: `pinelive status exceeded ${this.maxStdoutBytes} stdout bytes`,
          });
          return;
        }
        stdout.push(bytes);
      };
      const onStderr = (chunk: string | Buffer): void => {
        stderrBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
        if (stderrBytes > this.maxStderrBytes) {
          requestTermination({
            code: 'stderr-too-large',
            message: `pinelive status exceeded ${this.maxStderrBytes} stderr bytes`,
          });
        }
      };
      const onError = (): void => {
        finish({ code: 'spawn-failed', message: `could not start ${this.bin}` });
      };
      const onClose = (code: number | null): void => {
        finish(terminationError, code);
      };

      child.stdout.on('data', onStdout);
      child.stderr.on('data', onStderr);
      child.on('error', onError);
      child.on('close', onClose);
      deadlineTimer = setTimeout(() => {
        requestTermination({
          code: 'timeout',
          message: `pinelive status exceeded ${this.deadlineMs} ms`,
        });
      }, this.deadlineMs);
      deadlineTimer.unref?.();
    });
    return { generation, done, terminate: (error) => terminate(error) };
  }

  private emitCurrent(generation: number, event: LiveStatusPollEvent): void {
    if (this.disposed || generation !== this.generation) return;
    this.emit(event);
  }

  private emit(event: LiveStatusPollEvent): void {
    if (event.type === 'error') {
      const safeEvent: LiveStatusPollEvent = {
        ...event,
        error: {
          ...event.error,
          message: escapeTerminalText(event.error.message),
        },
      };
      for (const listener of this.listeners) listener(safeEvent);
      return;
    }
    for (const listener of this.listeners) listener(event);
  }
}

function positiveOption(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0)
    throw new RangeError(`${label} must be a positive integer`);
  return selected;
}
