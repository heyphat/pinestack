import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  probeProcessOwner,
  type BootBoundProcessIdentity,
  type ProcessOwnerProbe,
} from './coordination.js';
import {
  NodeRunRegistry,
  RunRegistryError,
  type ActiveRunRegistrationV1,
  type NodeRunRegistryOptions,
  type RunHistoryRecordV1,
  type RunRegistryErrorCode,
  type RunRegistryEnumeration,
  type RunRegistryEnumerationEntry,
} from './run-registry.js';
import {
  readPineliveStatus,
  type PineliveStatus,
  type PineliveStatusOptions,
  type StatusEvidence,
} from './status.js';

export const STATUS_DISCOVERY_HEARTBEAT_STALE_MS = 15_000;
export const PHYSICAL_CLAIM_RECORD_MAX_BYTES = 64 * 1024;
const STATUS_DISCOVERY_CONCURRENCY = 4;
const STATUS_DISCOVERY_MAX_RECENT = 100;
const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4_096;
const MAX_PROCESS_IDENTITY_LENGTH = 512;
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export type DiscoveryEvidence<T> =
  | { readonly availability: 'known'; readonly value: T }
  | {
      readonly availability: 'not-recorded' | 'not-inspected' | 'unsupported' | 'unknown';
      readonly reason: string;
    };

export type PhysicalClaimComparison =
  'same-owner' | 'different-owner' | 'absent' | 'not-applicable';

export interface ActiveLifecycleStatusV1 {
  readonly state:
    | 'starting'
    | 'running'
    | 'stopping'
    | 'crashed'
    | 'blocked-stale-claim'
    | 'conflict'
    | 'unknown';
  readonly process: ProcessOwnerProbe;
  readonly heartbeatAgeMs: number;
  readonly heartbeatStale: boolean;
  readonly physicalExecutionLease: DiscoveryEvidence<PhysicalClaimComparison>;
  readonly physicalAccountClaim: DiscoveryEvidence<PhysicalClaimComparison>;
  readonly reasons: readonly string[];
}

export interface ActiveDiscoveredRunStatusV1 {
  readonly discoveryVersion: 1;
  readonly kind: 'active';
  readonly generatedAt: string;
  readonly instanceId: string;
  readonly registration: ActiveRunRegistrationV1;
  readonly durable: PineliveStatus;
  readonly lifecycle: ActiveLifecycleStatusV1;
  readonly warnings: readonly StatusDiscoveryWarning[];
}

export interface TerminalDiscoveredRunStatusV1 {
  readonly discoveryVersion: 1;
  readonly kind: 'terminal';
  readonly generatedAt: string;
  readonly instanceId: string;
  readonly history: RunHistoryRecordV1;
  readonly leftoverRegistration?: ActiveRunRegistrationV1;
  readonly durable: DiscoveryEvidence<PineliveStatus>;
  readonly lifecycle: {
    readonly state: 'stopped';
    readonly reasons: readonly string[];
  };
  readonly warnings: readonly StatusDiscoveryWarning[];
}

export type DiscoveredRunStatusV1 = ActiveDiscoveredRunStatusV1 | TerminalDiscoveredRunStatusV1;

export interface PineliveStatusListV1 {
  readonly statusListVersion: 1;
  readonly generatedAt: string;
  readonly items: readonly PineliveStatusListItemV1[];
}

export type PineliveStatusListItemV1 =
  | { readonly ok: true; readonly value: DiscoveredRunStatusV1 }
  | {
      readonly ok: false;
      readonly instanceIdHint?: string;
      readonly path?: string;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface StatusDiscoveryWarning {
  readonly code: string;
  readonly message: string;
}

export interface PhysicalExecutionLeaseV2 {
  readonly leaseVersion: 2;
  readonly resource: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly pid: number;
  readonly processIdentity?: BootBoundProcessIdentity;
}

export interface PhysicalAccountClaimV1 {
  readonly claimVersion: 1;
  readonly kind: 'account-instrument';
  readonly resourceDigest: string;
  readonly accountDigest: string;
  readonly instrumentDigest: string;
  readonly claimId: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly pid: number;
  readonly processIdentity?: BootBoundProcessIdentity;
}

interface RunRegistryReader {
  enumerate(): Promise<RunRegistryEnumeration>;
}

export interface PineliveStatusDiscoveryOptions {
  readonly rootDir?: string;
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly env?: Readonly<{ PINELIVE_RUNS_DIR?: string }>;
  readonly registry?: RunRegistryReader;
  readonly recent?: number;
  readonly now?: Date;
  readonly heartbeatStaleAfterMs?: number;
  /** Deterministic read-only test seam. Production uses the existing conservative process probe. */
  readonly processProbe?: (
    evidence: Readonly<{ pid: number; processIdentity?: BootBoundProcessIdentity }>,
  ) => Promise<ProcessOwnerProbe>;
  /** Deterministic read-only test seam. Production folds the existing statusVersion 1 contract. */
  readonly statusReader?: (options: PineliveStatusOptions) => Promise<PineliveStatus>;
}

export type StatusDiscoveryErrorCode =
  | RunRegistryErrorCode
  | 'artifact-unreadable'
  | 'durable-identity-mismatch'
  | 'durable-status-error'
  | 'history-active-mismatch'
  | 'history-watermark-mismatch'
  | 'invalid-instance-id'
  | 'not-found'
  | 'physical-account-claim-invalid'
  | 'physical-execution-lease-invalid';

export class StatusDiscoveryError extends Error {
  constructor(
    readonly code: StatusDiscoveryErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'StatusDiscoveryError';
  }
}

interface DiscoveryContext {
  readonly generatedAt: string;
  readonly nowMs: number;
  readonly recent?: number;
  readonly heartbeatStaleAfterMs: number;
  readonly processProbe: NonNullable<PineliveStatusDiscoveryOptions['processProbe']>;
  readonly statusReader: NonNullable<PineliveStatusDiscoveryOptions['statusReader']>;
}

interface PreparedActive {
  readonly kind: 'active';
  readonly registration: ActiveRunRegistrationV1;
  readonly durable: PineliveStatus;
  readonly process: ProcessOwnerProbe;
  readonly executionLease?: PhysicalExecutionLeaseV2;
  readonly accountClaim?: PhysicalAccountClaimV1;
  readonly physicalExecutionLease: DiscoveryEvidence<PhysicalClaimComparison>;
  readonly physicalAccountClaim: DiscoveryEvidence<PhysicalClaimComparison>;
  readonly heartbeatAgeMs: number;
  readonly heartbeatStale: boolean;
  readonly heartbeatFuture: boolean;
  readonly warnings: readonly StatusDiscoveryWarning[];
}

interface PreparedTerminal {
  readonly kind: 'terminal';
  readonly value: TerminalDiscoveredRunStatusV1;
}

type PreparedRun = PreparedActive | PreparedTerminal;
type PreparedResult =
  | { readonly ok: true; readonly prepared: PreparedRun }
  | {
      readonly ok: false;
      readonly item: PineliveStatusListItemV1;
      readonly activeInstanceId?: string;
      readonly accountResources: readonly string[];
    };

class PartialPreparationError extends Error {
  constructor(
    readonly failure: unknown,
    readonly accountResources: readonly string[],
  ) {
    super('discovery entry preparation failed');
    this.name = 'PartialPreparationError';
  }
}

interface ActiveConflictEvidence {
  readonly reasons: readonly string[];
  readonly warnings: readonly StatusDiscoveryWarning[];
}

/** Strict bounded decoder for the existing physical execution-lease V2 bytes. */
export function decodePhysicalExecutionLeaseV2(
  input: string | Uint8Array,
): PhysicalExecutionLeaseV2 {
  const record = physicalObject(input, 'physical execution lease');
  exactKeys(
    record,
    ['leaseVersion', 'resource', 'leaseId', 'ownerId', 'acquiredAt', 'pid', 'processIdentity'],
    'physical execution lease',
  );
  if (record.leaseVersion !== 2)
    throw invalidPhysical('physical execution lease requires leaseVersion 2');
  return {
    leaseVersion: 2,
    resource: boundedString(record.resource, 'physical execution lease resource', MAX_PATH_LENGTH),
    leaseId: boundedString(record.leaseId, 'physical execution lease leaseId', MAX_ID_LENGTH),
    ownerId: boundedString(record.ownerId, 'physical execution lease ownerId', MAX_ID_LENGTH),
    acquiredAt: timestamp(record.acquiredAt, 'physical execution lease acquiredAt'),
    pid: positiveInteger(record.pid, 'physical execution lease pid'),
    ...(record.processIdentity === undefined
      ? {}
      : { processIdentity: processIdentity(record.processIdentity) }),
  };
}

/** Strict bounded decoder for the existing physical account/instrument claim V1 bytes. */
export function decodePhysicalAccountClaimV1(input: string | Uint8Array): PhysicalAccountClaimV1 {
  const record = physicalObject(input, 'physical account claim');
  exactKeys(
    record,
    [
      'claimVersion',
      'kind',
      'resourceDigest',
      'accountDigest',
      'instrumentDigest',
      'claimId',
      'ownerId',
      'acquiredAt',
      'pid',
      'processIdentity',
    ],
    'physical account claim',
  );
  if (record.claimVersion !== 1 || record.kind !== 'account-instrument')
    throw invalidPhysical('physical account claim requires account-instrument claimVersion 1');
  const resourceDigest = boundedString(
    record.resourceDigest,
    'physical account claim resourceDigest',
    71,
  );
  const accountDigest = boundedString(
    record.accountDigest,
    'physical account claim accountDigest',
    64,
  );
  const instrumentDigest = boundedString(
    record.instrumentDigest,
    'physical account claim instrumentDigest',
    64,
  );
  if (!/^sha256-[a-f0-9]{64}$/.test(resourceDigest))
    throw invalidPhysical('physical account claim resourceDigest is invalid');
  if (!/^[a-f0-9]{64}$/.test(accountDigest) || !/^[a-f0-9]{64}$/.test(instrumentDigest))
    throw invalidPhysical('physical account claim digest is invalid');
  return {
    claimVersion: 1,
    kind: 'account-instrument',
    resourceDigest,
    accountDigest,
    instrumentDigest,
    claimId: boundedString(record.claimId, 'physical account claim claimId', MAX_ID_LENGTH),
    ownerId: boundedString(record.ownerId, 'physical account claim ownerId', MAX_ID_LENGTH),
    acquiredAt: timestamp(record.acquiredAt, 'physical account claim acquiredAt'),
    pid: positiveInteger(record.pid, 'physical account claim pid'),
    ...(record.processIdentity === undefined
      ? {}
      : { processIdentity: processIdentity(record.processIdentity) }),
  };
}

/** Read one exact physical execution lease without following a symlink or mutating it. */
export async function readPhysicalExecutionLeaseV2(
  path: string,
): Promise<PhysicalExecutionLeaseV2 | undefined> {
  const bytes = await readBoundedPhysicalFile(path, 'physical execution lease');
  if (!bytes) return undefined;
  try {
    return decodePhysicalExecutionLeaseV2(bytes);
  } catch {
    throw discoveryError(
      'physical-execution-lease-invalid',
      'physical execution lease could not be validated',
      path,
    );
  }
}

/** Read one exact physical account claim without following a symlink or mutating it. */
export async function readPhysicalAccountClaimV1(
  path: string,
): Promise<PhysicalAccountClaimV1 | undefined> {
  const bytes = await readBoundedPhysicalFile(path, 'physical account claim');
  if (!bytes) return undefined;
  try {
    return decodePhysicalAccountClaimV1(bytes);
  } catch {
    throw discoveryError(
      'physical-account-claim-invalid',
      'physical account claim could not be validated',
      path,
    );
  }
}

/** Read every active/history registry entry and isolate each invalid run as a normalized item. */
export async function readPineliveStatusList(
  options: PineliveStatusDiscoveryOptions = {},
): Promise<PineliveStatusListV1> {
  const context = discoveryContext(options);
  const registry = options.registry ?? new NodeRunRegistry(registryOptions(options));
  const enumeration = await registry.enumerate();
  const prepared = await mapBounded(enumeration.entries, STATUS_DISCOVERY_CONCURRENCY, (entry) =>
    prepareEntry(entry, context),
  );
  const conflicts = conflictEvidence(enumeration.entries, prepared);
  const items: PineliveStatusListItemV1[] = enumeration.errors.map((error) => {
    const path = safeOptionalBoundedString(error.path, MAX_PATH_LENGTH);
    const message = safeOptionalBoundedString(error.message, 1_024);
    const instanceIdHint =
      typeof error.instanceIdHint === 'string' && /^[a-f0-9]{32,128}$/.test(error.instanceIdHint)
        ? error.instanceIdHint
        : undefined;
    return {
      ok: false,
      ...(instanceIdHint ? { instanceIdHint } : {}),
      ...(path ? { path } : {}),
      error: {
        code: error.code,
        message: message ?? 'registry entry contained unsafe discovery evidence',
      },
    };
  });
  for (const result of prepared) {
    if (!result.ok) {
      items.push(result.item);
      continue;
    }
    if (result.prepared.kind === 'terminal') {
      const duplicate = conflicts.terminalWarnings.get(result.prepared.value.instanceId) ?? [];
      items.push({
        ok: true,
        value: {
          ...result.prepared.value,
          warnings: mergeWarnings(result.prepared.value.warnings, duplicate),
        },
      });
      continue;
    }
    const activeConflict = conflicts.active.get(result.prepared.registration.instanceId);
    items.push({
      ok: true,
      value: activeValue(result.prepared, context, activeConflict),
    });
  }
  items.sort(compareListItems);
  return { statusListVersion: 1, generatedAt: context.generatedAt, items };
}

/** Read one exact instance from the active/history union; unrelated corrupt entries stay isolated. */
export async function readPineliveInstanceStatus(
  instanceId: string,
  options: PineliveStatusDiscoveryOptions = {},
): Promise<DiscoveredRunStatusV1> {
  if (!/^[a-f0-9]{32,128}$/.test(instanceId))
    throw discoveryError(
      'invalid-instance-id',
      'instanceId must be 128-bit-or-stronger lowercase hexadecimal',
    );
  const list = await readPineliveStatusList(options);
  const incompleteEnumeration = list.items.find(
    (item): item is Extract<PineliveStatusListItemV1, { readonly ok: false }> =>
      !item.ok && item.error.code === 'entry-limit-exceeded',
  );
  if (incompleteEnumeration)
    throw new StatusDiscoveryError(
      'entry-limit-exceeded',
      'registry entry limit prevented a conclusive exact-instance lookup',
      incompleteEnumeration.path,
    );
  const failure = list.items.find(
    (item): item is Extract<PineliveStatusListItemV1, { readonly ok: false }> =>
      !item.ok && item.instanceIdHint === instanceId,
  );
  if (failure)
    throw new StatusDiscoveryError(
      failure.error.code as StatusDiscoveryErrorCode,
      failure.error.message,
      failure.path,
    );
  const value = list.items.find(
    (item): item is Extract<PineliveStatusListItemV1, { readonly ok: true }> =>
      item.ok && item.value.instanceId === instanceId,
  );
  if (value) return value.value;
  throw discoveryError('not-found', 'discovered Pinelive instance was not found');
}

export const readAllPineliveStatuses = readPineliveStatusList;
export const readDiscoveredRunStatus = readPineliveInstanceStatus;

async function prepareEntry(
  entry: RunRegistryEnumerationEntry,
  context: DiscoveryContext,
): Promise<PreparedResult> {
  try {
    if (entry.history) {
      return {
        ok: true,
        prepared: {
          kind: 'terminal',
          value: await terminalValue(entry, context),
        },
      };
    }
    if (!entry.active)
      throw discoveryError('not-found', 'registry union entry has no readable record');
    return { ok: true, prepared: await prepareActive(entry.active, context) };
  } catch (error) {
    const partial = error instanceof PartialPreparationError ? error : undefined;
    return {
      ok: false,
      item: failureItem(partial?.failure ?? error, entry.instanceId, entryPath(entry)),
      ...(entry.active && !entry.history ? { activeInstanceId: entry.instanceId } : {}),
      accountResources: partial?.accountResources ?? [],
    };
  }
}

async function prepareActive(
  registration: ActiveRunRegistrationV1,
  context: DiscoveryContext,
): Promise<PreparedActive> {
  const [durableResult, processResult, executionLeaseResult, accountClaimResult] =
    await Promise.allSettled([
      readDurable(registration.paths.ledger, context),
      readProcess(registration, context),
      registration.paths.executionLease
        ? readPhysicalExecutionLeaseV2(registration.paths.executionLease)
        : Promise.resolve(undefined),
      registration.paths.accountClaim
        ? readPhysicalAccountClaimV1(registration.paths.accountClaim)
        : Promise.resolve(undefined),
    ]);
  const accountResources = new Set<string>();
  if (accountClaimResult.status === 'fulfilled' && accountClaimResult.value)
    accountResources.add(accountClaimResult.value.resourceDigest);
  if (durableResult.status === 'fulfilled') {
    const durableClaim = durableResult.value.ownership.durableAccountClaim;
    if (durableClaim.availability === 'known')
      accountResources.add(durableClaim.value.resourceDigest);
  }
  const partialFailure = (failure: unknown): PartialPreparationError =>
    new PartialPreparationError(failure, [...accountResources].sort());
  if (durableResult.status === 'rejected') throw partialFailure(durableResult.reason);
  if (processResult.status === 'rejected') throw partialFailure(processResult.reason);
  if (executionLeaseResult.status === 'rejected') throw partialFailure(executionLeaseResult.reason);
  if (accountClaimResult.status === 'rejected') throw partialFailure(accountClaimResult.reason);

  const durable = durableResult.value;
  const process = processResult.value;
  const executionLease = executionLeaseResult.value;
  const accountClaim = accountClaimResult.value;
  try {
    assertDurableIdentity(registration, durable);
    const physicalExecutionLease = compareExecutionLease(
      registration,
      registration.paths.executionLease,
      executionLease,
      durable.ownership.durableLedgerLease,
    );
    const physicalAccountClaim = compareAccountClaim(
      registration,
      registration.paths.accountClaim,
      accountClaim,
      durable.ownership.durableAccountClaim,
    );
    const rawHeartbeatAgeMs = context.nowMs - Date.parse(registration.heartbeatAt);
    return {
      kind: 'active',
      registration,
      durable,
      process,
      ...(executionLease ? { executionLease } : {}),
      ...(accountClaim ? { accountClaim } : {}),
      physicalExecutionLease,
      physicalAccountClaim,
      heartbeatAgeMs: Math.max(0, rawHeartbeatAgeMs),
      heartbeatStale: rawHeartbeatAgeMs > context.heartbeatStaleAfterMs,
      heartbeatFuture: rawHeartbeatAgeMs < 0,
      warnings: [],
    };
  } catch (error) {
    throw partialFailure(error);
  }
}

async function terminalValue(
  entry: RunRegistryEnumerationEntry,
  context: DiscoveryContext,
): Promise<TerminalDiscoveredRunStatusV1> {
  const history = entry.history!;
  if (entry.active) assertHistoryActiveCompatibility(history, entry.active);
  let durable: DiscoveryEvidence<PineliveStatus>;
  if (!history.finalLedgerPath) {
    durable = {
      availability: 'not-recorded',
      reason: 'failed startup completed before a ledger was opened',
    };
  } else {
    const status = await readDurable(history.finalLedgerPath, context, history.finalLedgerSequence);
    assertDurableIdentity(history, status);
    const durableSequence = status.ledger.lastSequence ?? 0;
    if (
      history.finalLedgerSequence !== undefined &&
      history.finalLedgerSequence !== durableSequence
    )
      throw discoveryError(
        'history-watermark-mismatch',
        'terminal history durable sequence does not match the requested ledger prefix',
        history.finalLedgerPath,
      );
    durable = { availability: 'known', value: status };
  }
  return {
    discoveryVersion: 1,
    kind: 'terminal',
    generatedAt: context.generatedAt,
    instanceId: history.instanceId,
    history,
    ...(entry.active ? { leftoverRegistration: entry.active } : {}),
    durable,
    lifecycle: { state: 'stopped', reasons: [] },
    warnings: entry.active
      ? [
          {
            code: 'active-cleanup-incomplete',
            message: 'terminal history supersedes a compatible leftover active registration',
          },
        ]
      : [],
  };
}

function activeValue(
  prepared: PreparedActive,
  context: DiscoveryContext,
  conflict?: ActiveConflictEvidence,
): ActiveDiscoveredRunStatusV1 {
  return {
    discoveryVersion: 1,
    kind: 'active',
    generatedAt: context.generatedAt,
    instanceId: prepared.registration.instanceId,
    registration: prepared.registration,
    durable: prepared.durable,
    lifecycle: deriveLifecycle(prepared, conflict?.reasons ?? []),
    warnings: mergeWarnings(prepared.warnings, conflict?.warnings ?? []),
  };
}

function deriveLifecycle(
  prepared: PreparedActive,
  conflictReasons: readonly string[],
): ActiveLifecycleStatusV1 {
  const reasons: string[] = [];
  if (prepared.process.state !== 'matching') reasons.push(prepared.process.reason);
  if (prepared.heartbeatStale)
    reasons.push('registration heartbeat is older than the discovery stale threshold');
  if (prepared.heartbeatFuture)
    reasons.push('registration heartbeat is later than the observer clock');
  claimReason(
    reasons,
    'execution lease',
    prepared.registration.paths.executionLease !== undefined,
    prepared.physicalExecutionLease,
    prepared.durable.ownership.durableLedgerLease,
  );
  claimReason(
    reasons,
    'account claim',
    prepared.registration.paths.accountClaim !== undefined,
    prepared.physicalAccountClaim,
    prepared.durable.ownership.durableAccountClaim,
  );
  reasons.push(...conflictReasons);

  const hasActiveClaim =
    comparisonIsSameOwner(prepared.physicalExecutionLease) ||
    comparisonIsSameOwner(prepared.physicalAccountClaim) ||
    prepared.durable.ownership.durableLedgerLease.availability === 'known' ||
    prepared.durable.ownership.durableAccountClaim.availability === 'known';
  const claimsConsistent =
    claimConsistent(
      prepared.registration.paths.executionLease !== undefined,
      prepared.physicalExecutionLease,
      prepared.durable.ownership.durableLedgerLease,
    ) &&
    claimConsistent(
      prepared.registration.paths.accountClaim !== undefined,
      prepared.physicalAccountClaim,
      prepared.durable.ownership.durableAccountClaim,
    );
  const noActiveClaimsProven =
    prepared.durable.ledger.ledgerSchemaVersion === 3 &&
    prepared.durable.ownership.durableLedgerLease.availability !== 'known' &&
    prepared.durable.ownership.durableAccountClaim.availability !== 'known' &&
    physicalAbsent(prepared.physicalExecutionLease) &&
    physicalAbsent(prepared.physicalAccountClaim);

  let state: ActiveLifecycleStatusV1['state'];
  if (conflictReasons.length > 0) state = 'conflict';
  else if (prepared.process.state === 'dead' && hasActiveClaim) state = 'blocked-stale-claim';
  else if (prepared.process.state === 'matching' && prepared.registration.lifecycle === 'stopping')
    state = 'stopping';
  else if (prepared.process.state === 'matching' && prepared.registration.lifecycle === 'starting')
    state = 'starting';
  else if (
    prepared.process.state === 'matching' &&
    prepared.registration.lifecycle === 'running' &&
    claimsConsistent &&
    !prepared.heartbeatStale &&
    !prepared.heartbeatFuture
  )
    state = 'running';
  else if (prepared.process.state === 'dead' && noActiveClaimsProven) state = 'crashed';
  else state = 'unknown';

  if (state === 'unknown' && prepared.process.state === 'dead' && !noActiveClaimsProven)
    reasons.push('available evidence does not prove that all execution claims are inactive');
  return {
    state,
    process: prepared.process,
    heartbeatAgeMs: prepared.heartbeatAgeMs,
    heartbeatStale: prepared.heartbeatStale,
    physicalExecutionLease: prepared.physicalExecutionLease,
    physicalAccountClaim: prepared.physicalAccountClaim,
    reasons: uniqueSorted(reasons),
  };
}

function conflictEvidence(
  entries: readonly RunRegistryEnumerationEntry[],
  results: readonly PreparedResult[],
): {
  active: ReadonlyMap<string, ActiveConflictEvidence>;
  terminalWarnings: ReadonlyMap<string, readonly StatusDiscoveryWarning[]>;
} {
  const activePrepared = results.flatMap((result) =>
    result.ok && result.prepared.kind === 'active' ? [result.prepared] : [],
  );
  const preparedByInstance = new Map(
    results.flatMap((result) =>
      result.ok
        ? [
            [
              result.prepared.kind === 'active'
                ? result.prepared.registration.instanceId
                : result.prepared.value.instanceId,
              result.prepared,
            ] as const,
          ]
        : [],
    ),
  );
  const activeReasons = new Map<string, string[]>();
  const activeWarnings = new Map<string, StatusDiscoveryWarning[]>();
  const terminalWarnings = new Map<string, StatusDiscoveryWarning[]>();
  const executionIds = new Map<
    string,
    Array<{ readonly instanceId: string; readonly active: boolean }>
  >();
  for (const entry of entries) {
    const identity = entry.history ?? entry.active;
    if (!identity?.executionId) continue;
    const matches = executionIds.get(identity.executionId) ?? [];
    matches.push({
      instanceId: entry.instanceId,
      active: entry.active !== undefined && entry.history === undefined,
    });
    executionIds.set(identity.executionId, matches);
  }
  for (const matches of executionIds.values()) {
    if (matches.length < 2) continue;
    const activeMatches = matches.filter((match) => match.active);
    for (const match of matches) {
      const prepared = preparedByInstance.get(match.instanceId);
      if (!prepared) continue;
      const warning = {
        code: 'duplicate-execution-id',
        message: 'multiple discovered records report the same execution identity',
      } as const;
      if (prepared.kind === 'active') pushMap(activeWarnings, match.instanceId, warning);
      else pushMap(terminalWarnings, match.instanceId, warning);
    }
    if (activeMatches.length > 1) {
      for (const match of activeMatches) {
        const prepared = preparedByInstance.get(match.instanceId);
        if (prepared?.kind !== 'active') continue;
        pushMap(
          activeReasons,
          match.instanceId,
          'another active registration reports the same execution identity',
        );
      }
    }
  }

  const resources = new Map<string, Set<string>>();
  for (const result of results) {
    const evidence = result.ok
      ? result.prepared.kind === 'active'
        ? {
            instanceId: result.prepared.registration.instanceId,
            resources: accountResources(result.prepared),
          }
        : undefined
      : result.activeInstanceId
        ? { instanceId: result.activeInstanceId, resources: result.accountResources }
        : undefined;
    if (!evidence) continue;
    for (const resource of evidence.resources) {
      const matches = resources.get(resource) ?? new Set<string>();
      matches.add(evidence.instanceId);
      resources.set(resource, matches);
    }
  }
  for (const matches of resources.values()) {
    if (matches.size < 2) continue;
    for (const instanceId of matches) {
      const prepared = preparedByInstance.get(instanceId);
      if (prepared?.kind !== 'active') continue;
      pushMap(
        activeReasons,
        instanceId,
        'another active registration has ownership evidence for the same account resource',
      );
      pushMap(activeWarnings, instanceId, {
        code: 'active-account-claim-conflict',
        message: 'multiple active records have ownership evidence for one account resource',
      });
    }
  }

  const active = new Map<string, ActiveConflictEvidence>();
  for (const prepared of activePrepared) {
    const instanceId = prepared.registration.instanceId;
    const reasons = uniqueSorted(activeReasons.get(instanceId) ?? []);
    const warnings = mergeWarnings(activeWarnings.get(instanceId) ?? []);
    if (reasons.length > 0 || warnings.length > 0) active.set(instanceId, { reasons, warnings });
  }
  return { active, terminalWarnings };
}

function accountResources(prepared: PreparedActive): readonly string[] {
  const resources = new Set<string>();
  if (prepared.accountClaim) resources.add(prepared.accountClaim.resourceDigest);
  const durable = prepared.durable.ownership.durableAccountClaim;
  if (durable.availability === 'known') resources.add(durable.value.resourceDigest);
  return [...resources].sort();
}

async function readDurable(
  path: string,
  context: DiscoveryContext,
  throughSequence?: number,
): Promise<PineliveStatus> {
  try {
    return await context.statusReader({
      ledgerPath: path,
      ...(context.recent === undefined ? {} : { recent: context.recent }),
      now: new Date(context.nowMs),
      ...(throughSequence === undefined ? {} : { throughSequence }),
    });
  } catch (error) {
    if (
      throughSequence !== undefined &&
      error instanceof RangeError &&
      error.message.startsWith('status throughSequence')
    )
      throw discoveryError(
        'history-watermark-mismatch',
        'terminal history watermark is outside the validated durable ledger',
        path,
      );
    throw discoveryError(
      'durable-status-error',
      'durable ledger status could not be read or validated',
      path,
    );
  }
}

async function readProcess(
  registration: ActiveRunRegistrationV1,
  context: DiscoveryContext,
): Promise<ProcessOwnerProbe> {
  if (process.platform === 'win32')
    return { state: 'unsupported', reason: 'process identity probing is unsupported on Windows' };
  try {
    const result = await context.processProbe({
      pid: registration.pid,
      ...(registration.processIdentity ? { processIdentity: registration.processIdentity } : {}),
    });
    if ('reason' in result && TERMINAL_CONTROL.test(result.reason))
      return { state: 'alive-unverified', reason: 'process probe returned unsafe evidence' };
    return result;
  } catch {
    return { state: 'alive-unverified', reason: 'process probe failed' };
  }
}

function compareExecutionLease(
  registration: ActiveRunRegistrationV1,
  path: string | undefined,
  physical: PhysicalExecutionLeaseV2 | undefined,
  durable: PineliveStatus['ownership']['durableLedgerLease'],
): DiscoveryEvidence<PhysicalClaimComparison> {
  if (!path) return known('not-applicable');
  if (!physical) return known('absent');
  if (
    durable.availability === 'known' &&
    physical.resource === durable.value.resource &&
    physical.leaseId === durable.value.leaseId &&
    physical.ownerId === durable.value.ownerId &&
    physicalProcessMatchesRegistration(physical, registration)
  )
    return known('same-owner');
  return known('different-owner');
}

function compareAccountClaim(
  registration: ActiveRunRegistrationV1,
  path: string | undefined,
  physical: PhysicalAccountClaimV1 | undefined,
  durable: PineliveStatus['ownership']['durableAccountClaim'],
): DiscoveryEvidence<PhysicalClaimComparison> {
  if (!path) return known('not-applicable');
  if (!physical) return known('absent');
  if (
    durable.availability === 'known' &&
    physical.resourceDigest === durable.value.resourceDigest &&
    physical.claimId === durable.value.claimId &&
    physical.ownerId === durable.value.ownerId &&
    physicalProcessMatchesRegistration(physical, registration)
  )
    return known('same-owner');
  return known('different-owner');
}

function physicalProcessMatchesRegistration(
  physical: Readonly<{ pid: number; processIdentity?: BootBoundProcessIdentity }>,
  registration: ActiveRunRegistrationV1,
): boolean {
  if (physical.pid !== registration.pid) return false;
  if (!physical.processIdentity && !registration.processIdentity) return true;
  if (!physical.processIdentity || !registration.processIdentity) return false;
  return (
    physical.processIdentity.kind === registration.processIdentity.kind &&
    physical.processIdentity.value === registration.processIdentity.value &&
    physical.processIdentity.bootIdentityHash === registration.processIdentity.bootIdentityHash
  );
}

function claimReason<T>(
  reasons: string[],
  label: string,
  pathSupplied: boolean,
  physical: DiscoveryEvidence<PhysicalClaimComparison>,
  durable: StatusEvidence<T>,
): void {
  if (physical.availability !== 'known') {
    reasons.push(`${label} evidence is ${physical.availability}`);
    return;
  }
  if (physical.value === 'different-owner')
    reasons.push(`physical ${label} does not match durable ownership`);
  else if (pathSupplied && physical.value === 'absent')
    reasons.push(`registered physical ${label} is absent`);
  else if (!pathSupplied && durable.availability === 'known')
    reasons.push(`durable ${label} is active but no physical path was registered`);
}

function claimConsistent<T>(
  pathSupplied: boolean,
  physical: DiscoveryEvidence<PhysicalClaimComparison>,
  durable: StatusEvidence<T>,
): boolean {
  if (physical.availability !== 'known') return false;
  if (pathSupplied) return physical.value === 'same-owner';
  return physical.value === 'not-applicable' && durable.availability !== 'known';
}

function comparisonIsSameOwner(evidence: DiscoveryEvidence<PhysicalClaimComparison>): boolean {
  return evidence.availability === 'known' && evidence.value === 'same-owner';
}

function physicalAbsent(evidence: DiscoveryEvidence<PhysicalClaimComparison>): boolean {
  return (
    evidence.availability === 'known' &&
    (evidence.value === 'absent' || evidence.value === 'not-applicable')
  );
}

function assertHistoryActiveCompatibility(
  history: RunHistoryRecordV1,
  active: ActiveRunRegistrationV1,
): void {
  if (
    history.instanceId !== active.instanceId ||
    history.startedAt !== active.startedAt ||
    history.runId !== active.runId ||
    history.executionId !== active.executionId ||
    history.brokerId !== active.brokerId ||
    history.posture !== active.posture ||
    (history.finalLedgerPath !== undefined && history.finalLedgerPath !== active.paths.ledger)
  )
    throw discoveryError(
      'history-active-mismatch',
      'terminal history does not match the active registration',
    );
}

function assertDurableIdentity(
  record: Pick<ActiveRunRegistrationV1, 'runId' | 'executionId'>,
  durable: PineliveStatus,
): void {
  if (
    (record.runId !== undefined &&
      durable.identity.runId !== undefined &&
      record.runId !== durable.identity.runId) ||
    (record.executionId !== undefined &&
      durable.identity.executionId !== undefined &&
      record.executionId !== durable.identity.executionId)
  )
    throw discoveryError(
      'durable-identity-mismatch',
      'registry identity does not match durable ledger identity',
      durable.ledger.path,
    );
}

function compareListItems(left: PineliveStatusListItemV1, right: PineliveStatusListItemV1): number {
  const leftKey = listItemKey(left);
  const rightKey = listItemKey(right);
  for (let index = 0; index < Math.max(leftKey.length, rightKey.length); index++) {
    const comparison = (leftKey[index] ?? '').localeCompare(rightKey[index] ?? '');
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function listItemKey(item: PineliveStatusListItemV1): readonly string[] {
  if (!item.ok)
    return ['3', item.path ?? '', item.instanceIdHint ?? '', item.error.code, item.error.message];
  const identity = item.value.kind === 'active' ? item.value.registration : item.value.history;
  if (identity.executionId)
    return ['0', identity.executionId, identity.runId ?? '', item.value.instanceId];
  if (identity.runId) return ['1', identity.runId, item.value.instanceId];
  return ['2', item.value.instanceId];
}

function failureItem(
  error: unknown,
  instanceIdHint?: string,
  fallbackPath?: string,
): PineliveStatusListItemV1 {
  if (error instanceof StatusDiscoveryError)
    return {
      ok: false,
      ...(instanceIdHint ? { instanceIdHint } : {}),
      ...((error.path ?? fallbackPath) ? { path: error.path ?? fallbackPath } : {}),
      error: { code: error.code, message: error.message },
    };
  if (error instanceof RunRegistryError)
    return {
      ok: false,
      ...(instanceIdHint ? { instanceIdHint } : {}),
      ...((error.path ?? fallbackPath) ? { path: error.path ?? fallbackPath } : {}),
      error: { code: error.code, message: error.message },
    };
  return {
    ok: false,
    ...(instanceIdHint ? { instanceIdHint } : {}),
    ...(fallbackPath ? { path: fallbackPath } : {}),
    error: { code: 'artifact-unreadable', message: 'discovery evidence could not be inspected' },
  };
}

function entryPath(entry: RunRegistryEnumerationEntry): string | undefined {
  return entry.history?.finalLedgerPath ?? entry.active?.paths.ledger;
}

function discoveryContext(options: PineliveStatusDiscoveryOptions): DiscoveryContext {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError('discovery now must be a valid date');
  const recent = options.recent;
  if (
    recent !== undefined &&
    (!Number.isSafeInteger(recent) || recent < 0 || recent > STATUS_DISCOVERY_MAX_RECENT)
  )
    throw new RangeError(
      `status recent must be an integer between 0 and ${STATUS_DISCOVERY_MAX_RECENT}`,
    );
  const heartbeatStaleAfterMs =
    options.heartbeatStaleAfterMs ?? STATUS_DISCOVERY_HEARTBEAT_STALE_MS;
  if (!Number.isSafeInteger(heartbeatStaleAfterMs) || heartbeatStaleAfterMs < 0)
    throw new RangeError('heartbeatStaleAfterMs must be a nonnegative safe integer');
  return {
    generatedAt: now.toISOString(),
    nowMs: now.getTime(),
    ...(recent === undefined ? {} : { recent }),
    heartbeatStaleAfterMs,
    processProbe: options.processProbe ?? probeProcessOwner,
    statusReader: options.statusReader ?? readPineliveStatus,
  };
}

function registryOptions(options: PineliveStatusDiscoveryOptions): NodeRunRegistryOptions {
  return {
    ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
}

function physicalObject(input: string | Uint8Array, label: string): Record<string, unknown> {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.byteLength > PHYSICAL_CLAIM_RECORD_MAX_BYTES)
    throw invalidPhysical(`${label} exceeds 64 KiB`);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw invalidPhysical(`${label} is not valid JSON`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidPhysical(`${label} must be an object`);
  return value as Record<string, unknown>;
}

async function readBoundedPhysicalFile(
  path: string,
  label: string,
): Promise<Uint8Array | undefined> {
  if (!path) throw new RangeError(`${label} path must not be empty`);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (nodeError(error, 'ENOENT')) return undefined;
    throw discoveryError('artifact-unreadable', `${label} could not be inspected`, path);
  }
  if (metadata.isSymbolicLink() || !metadata.isFile())
    throw discoveryError('artifact-unreadable', `${label} is not a regular file`, path);
  if (metadata.size > PHYSICAL_CLAIM_RECORD_MAX_BYTES)
    throw discoveryError('artifact-unreadable', `${label} exceeds 64 KiB`, path);
  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    if (!(await handle.stat()).isFile())
      throw discoveryError('artifact-unreadable', `${label} is not a regular file`, path);
    const bytes = Buffer.alloc(PHYSICAL_CLAIM_RECORD_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const result = await handle.read(bytes, length, bytes.byteLength - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > PHYSICAL_CLAIM_RECORD_MAX_BYTES)
      throw discoveryError('artifact-unreadable', `${label} exceeds 64 KiB`, path);
    return bytes.subarray(0, length);
  } catch (error) {
    if (error instanceof StatusDiscoveryError) throw error;
    throw discoveryError('artifact-unreadable', `${label} could not be inspected`, path);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key)))
    throw invalidPhysical(`${label} contains an unsupported field`);
}

function processIdentity(value: unknown): BootBoundProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidPhysical('physical process identity must be an object');
  const record = value as Record<string, unknown>;
  exactKeys(record, ['kind', 'value', 'bootIdentityHash'], 'physical process identity');
  if (record.kind !== 'darwin-start-time' && record.kind !== 'linux-start-ticks')
    throw invalidPhysical('physical process identity kind is invalid');
  const identityValue = boundedString(
    record.value,
    'physical process identity value',
    MAX_PROCESS_IDENTITY_LENGTH,
  );
  const bootIdentityHash = boundedString(
    record.bootIdentityHash,
    'physical process identity bootIdentityHash',
    64,
  );
  if (!/^[a-f0-9]{64}$/.test(bootIdentityHash))
    throw invalidPhysical('physical process identity bootIdentityHash is invalid');
  return { kind: record.kind, value: identityValue, bootIdentityHash };
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    TERMINAL_CONTROL.test(value)
  )
    throw invalidPhysical(`${label} must be a nonempty bounded string without terminal controls`);
  return value;
}

function safeOptionalBoundedString(value: unknown, maximum: number): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !TERMINAL_CONTROL.test(value)
    ? value
    : undefined;
}

function timestamp(value: unknown, label: string): string {
  const result = boundedString(value, label, 64);
  const date = new Date(result);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== result)
    throw invalidPhysical(`${label} must be a canonical ISO-8601 timestamp`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw invalidPhysical(`${label} must be a positive safe integer`);
  return value as number;
}

function known<T>(value: T): DiscoveryEvidence<T> {
  return { availability: 'known', value };
}

function invalidPhysical(message: string): Error {
  return new Error(message);
}

function discoveryError(
  code: StatusDiscoveryErrorCode,
  message: string,
  path?: string,
): StatusDiscoveryError {
  return new StatusDiscoveryError(code, message, path);
}

function nodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

function mergeWarnings(
  ...groups: readonly (readonly StatusDiscoveryWarning[])[]
): readonly StatusDiscoveryWarning[] {
  const warnings = new Map<string, StatusDiscoveryWarning>();
  for (const warning of groups.flat()) warnings.set(`${warning.code}\0${warning.message}`, warning);
  return [...warnings.values()].sort(
    (left, right) =>
      left.code.localeCompare(right.code) || left.message.localeCompare(right.message),
  );
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function pushMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        results[index] = await map(values[index]!);
      }
    }),
  );
  return results;
}
