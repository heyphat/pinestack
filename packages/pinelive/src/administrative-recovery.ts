import { randomUUID } from 'node:crypto';
import { link, readFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  probeProcessOwner,
  type BootBoundProcessIdentity,
  type ProcessOwnerProbe,
} from './coordination.js';
import { recoverLedger, type LedgerRecoveryState } from './core/recovery.js';
import { SequencedLedger } from './core/ledger.js';
import { JsonlLedger, NodeExclusiveFileLease, readJsonlPrefix, type JsonlPrefix } from './node.js';

export interface RecoverStaleClaimsOptions {
  readonly ledgerPath: string;
  readonly leasePath: string;
  readonly accountClaimPath?: string;
  readonly administrativeLeasePath?: string;
  /** Must be true; callers are expected to obtain an explicit operator confirmation. */
  readonly confirmed: boolean;
  readonly now?: () => number;
  /** Deterministic concurrency/fault-injection seam used immediately before evidence restoration. */
  readonly beforeAdministrativeEvidenceRestore?: () => void | Promise<void>;
}

export interface RecoverStaleClaimsResult {
  readonly recovered: true;
  readonly ledgerPath: string;
  readonly previousLastSequence: number;
  readonly finalSequence: number;
  readonly quarantinedPaths: readonly string[];
}

interface PhysicalOwnerMetadata {
  readonly ownerId: string;
  readonly pid: number;
  readonly processIdentity?: BootBoundProcessIdentity;
  readonly resource?: string;
  readonly leaseId?: string;
  readonly claimId?: string;
  readonly resourceDigest?: string;
}

/**
 * Explicit local stale-claim recovery. It never uses age/TTL and refuses unless boot-bound process
 * evidence proves the recorded owner is gone. Quarantined artifacts are retained for audit.
 */
export async function recoverStalePineliveClaims(
  options: RecoverStaleClaimsOptions,
): Promise<RecoverStaleClaimsResult> {
  if (options.confirmed !== true)
    throw new Error('stale-claim recovery requires explicit confirmation');
  if (!options.ledgerPath || !options.leasePath)
    throw new RangeError('recovery requires ledgerPath and leasePath');

  const ledgerPath = resolve(options.ledgerPath);
  const leasePath = resolve(options.leasePath);
  const accountClaimPath = options.accountClaimPath ? resolve(options.accountClaimPath) : undefined;
  const administrativeLeasePath = resolve(
    options.administrativeLeasePath ?? `${leasePath}.admin.lock`,
  );
  if (administrativeLeasePath === leasePath || administrativeLeasePath === accountClaimPath)
    throw new RangeError('administrative recovery lease must use a distinct path');

  const administrativeLease = new NodeExclusiveFileLease(administrativeLeasePath, {
    resource: `pinelive-admin:${ledgerPath}`,
  });
  let recoveryLease: NodeExclusiveFileLease | undefined;
  let ledger: JsonlLedger | undefined;
  let ledgerClosed = false;
  let recoveryArtifactsMoved = false;
  let primaryError: unknown;
  let result: RecoverStaleClaimsResult | undefined;
  const quarantineSuffix = `.stale-${new Date(now(options)).toISOString().replaceAll(':', '-')}-${randomUUID()}`;
  const quarantinedPaths: string[] = [];

  const staleAdministrativeOwner = await acquireAdministrativeRecoveryLease(
    administrativeLease,
    administrativeLeasePath,
    quarantineSuffix,
    quarantinedPaths,
  );
  try {
    const initial = await readRecoveryState(ledgerPath, true);
    assertNoUnresolvedEffects(initial.recovery);
    const physicalLease = await readOwnerMetadata(leasePath, 'ledger lease');
    await assertDefinitelyDead(physicalLease, 'ledger lease');
    if (initial.recovery.activeLease) {
      assertDurableLeaseMatches(initial.recovery, physicalLease);
    } else if (latestReleasedLeaseMatches(initial.recovery, physicalLease)) {
      // The durable release can precede physical unlink. A crash in that narrow window leaves an
      // exact dead-owner artifact that is safe to quarantine under the administrative mutex.
    } else {
      assertPreJournalLeaseMatches(
        staleAdministrativeOwner,
        physicalLease,
        ledgerPath,
        administrativeLease.resource,
      );
    }

    let physicalAccountClaim: PhysicalOwnerMetadata | undefined;
    if (initial.recovery.activeAccountClaim) {
      if (!accountClaimPath)
        throw new Error('durable account claim requires --account-claim <path> for recovery');
      physicalAccountClaim = await readOwnerMetadataIfPresent(accountClaimPath, 'account claim');
      if (physicalAccountClaim) {
        await assertDefinitelyDead(physicalAccountClaim, 'account claim');
        assertDurableAccountClaimMatches(initial.recovery, physicalAccountClaim);
      } else if (!initial.recovery.accountClaimReleaseStarted) {
        throw new Error('durable account claim artifact is missing without release-started proof');
      }
    } else if (accountClaimPath) {
      physicalAccountClaim = await readOwnerMetadata(accountClaimPath, 'account claim');
      await assertDefinitelyDead(physicalAccountClaim, 'account claim');
      assertPreJournalAccountClaimMatches(initial.recovery, physicalLease, physicalAccountClaim);
    }

    if (physicalAccountClaim && accountClaimPath) {
      const quarantined = `${accountClaimPath}${quarantineSuffix}`;
      await rename(accountClaimPath, quarantined);
      quarantinedPaths.push(quarantined);
      recoveryArtifactsMoved = true;
    }
    const quarantinedLease = `${leasePath}${quarantineSuffix}`;
    await rename(leasePath, quarantinedLease);
    quarantinedPaths.push(quarantinedLease);
    recoveryArtifactsMoved = true;

    recoveryLease = new NodeExclusiveFileLease(leasePath, {
      resource: ledgerPath,
      ownerId: `recovery:${randomUUID()}`,
      now: options.now,
    });
    const recoverySnapshot = await recoveryLease.acquire();

    const owned = await readRecoveryState(ledgerPath, true);
    assertNoUnresolvedEffects(owned.recovery);
    assertSameDurableOwners(initial.recovery, owned.recovery);

    if (owned.recovery.events.length === 0) {
      await recoveryLease.release();
      result = {
        recovered: true,
        ledgerPath,
        previousLastSequence: 0,
        finalSequence: 0,
        quarantinedPaths,
      };
    } else {
      ledger = new JsonlLedger(ledgerPath, {
        durability: 'sync',
        tailPolicy: 'repair',
        lease: recoveryLease,
      });
      const writer = new SequencedLedger(ledger, {
        runId: requiredNamespace(owned.recovery.runId, 'runId'),
        executionId: requiredNamespace(owned.recovery.executionId, 'executionId'),
        nextSequence: owned.recovery.nextSequence,
        lastTimestamp:
          owned.recovery.events.length > 0
            ? Date.parse(owned.recovery.events.at(-1)!.recordedAt)
            : undefined,
        now: options.now,
      });

      const activeAccountClaim = owned.recovery.activeAccountClaim;
      if (activeAccountClaim) {
        await writer.append({
          recordType: 'account-claim',
          action: 'lost',
          resourceDigest: activeAccountClaim.resourceDigest,
          claimId: activeAccountClaim.claimId,
          ownerId: activeAccountClaim.ownerId,
          detail: 'explicit recovery proved the prior process instance is gone',
        });
      }
      const activeLease = owned.recovery.activeLease;
      if (activeLease) {
        await writer.append({
          recordType: 'lease',
          action: 'lost',
          resource: activeLease.resource,
          leaseId: activeLease.leaseId,
          ownerId: activeLease.ownerId,
          detail: 'explicit recovery proved the prior process instance is gone',
        });
      }
      const previousEligibility = owned.recovery.executionEligibility;
      if (previousEligibility?.state === 'enabled') {
        await writer.append({
          recordType: 'execution-eligibility',
          posture: previousEligibility.posture,
          state: 'blocked',
          reasons: [
            'explicit recovery proved the prior runtime dead and revoked execution capability',
          ],
          accountClaim:
            previousEligibility.accountClaim === 'held'
              ? 'not-held'
              : previousEligibility.accountClaim,
          synchronization:
            previousEligibility.synchronization === 'synchronized'
              ? 'blocked'
              : previousEligibility.synchronization,
        });
      }
      await writer.append({
        recordType: 'lease',
        action: 'acquired',
        resource: recoverySnapshot.resource,
        leaseId: recoverySnapshot.leaseId,
        ownerId: recoverySnapshot.ownerId,
        detail: 'exclusive recovery writer ownership',
      });
      await writer.append({
        recordType: 'recovery',
        action: 'resumed',
        sourceLastSequence: owned.recovery.lastSequence,
        ...(owned.recovery.lastFinalCursor == null
          ? {}
          : { lastFinalCursor: owned.recovery.lastFinalCursor }),
        unresolvedLogicalOrderIds: [],
        detail: 'explicit stale-claim recovery completed without venue reconciliation',
      });
      const released = await writer.append({
        recordType: 'lease',
        action: 'released',
        resource: recoverySnapshot.resource,
        leaseId: recoverySnapshot.leaseId,
        ownerId: recoverySnapshot.ownerId,
        detail: 'explicit recovery writer ownership released',
      });
      await writer.flush();
      await ledger.close();
      ledgerClosed = true;
      result = {
        recovered: true,
        ledgerPath,
        previousLastSequence: owned.recovery.lastSequence,
        finalSequence: released.sequence,
        quarantinedPaths,
      };
    }
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (ledger && !ledgerClosed) {
      try {
        await ledger.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else if (recoveryLease?.snapshot) {
      try {
        await recoveryLease.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (administrativeLease.snapshot) {
      try {
        await administrativeLease.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (
      primaryError !== undefined &&
      staleAdministrativeOwner &&
      !recoveryArtifactsMoved &&
      !administrativeLease.snapshot
    ) {
      try {
        const quarantinedAdministrativeLease = `${administrativeLeasePath}${quarantineSuffix}`;
        await options.beforeAdministrativeEvidenceRestore?.();
        await restoreAdministrativeEvidenceWithoutClobber(
          quarantinedAdministrativeLease,
          administrativeLeasePath,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (primaryError !== undefined) {
      if (cleanupErrors.length > 0)
        throw new AggregateError(
          [primaryError, ...cleanupErrors],
          'stale-claim recovery and cleanup failed',
        );
      throw primaryError;
    }
    if (cleanupErrors.length > 0)
      throw new AggregateError(cleanupErrors, 'stale-claim recovery cleanup failed');
  }
  if (!result) throw new Error('stale-claim recovery completed without a result');
  return result;
}

async function acquireAdministrativeRecoveryLease(
  lease: NodeExclusiveFileLease,
  path: string,
  quarantineSuffix: string,
  quarantinedPaths: string[],
): Promise<PhysicalOwnerMetadata | undefined> {
  try {
    await lease.acquire();
    return undefined;
  } catch (error) {
    if (!isLeaseContention(error)) throw error;
  }

  const first = await readOwnerMetadata(path, 'administrative lease');
  if (!first.leaseId)
    throw new Error('administrative lease owner evidence is missing its lease id');
  if (first.resource !== lease.resource)
    throw new Error('administrative lease resource does not match the requested ledger');
  await assertDefinitelyDead(first, 'administrative lease');
  const second = await readOwnerMetadata(path, 'administrative lease');
  if (!samePhysicalOwner(first, second))
    throw new Error('administrative lease owner changed during stale-owner proof');

  const quarantined = `${path}${quarantineSuffix}`;
  await rename(path, quarantined);
  quarantinedPaths.push(quarantined);
  await lease.acquire();
  return first;
}

async function restoreAdministrativeEvidenceWithoutClobber(
  quarantinedPath: string,
  targetPath: string,
): Promise<void> {
  try {
    await link(quarantinedPath, targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(
        `administrative recovery evidence was retained at ${quarantinedPath} because a new owner acquired ${targetPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  await unlink(quarantinedPath);
}

function samePhysicalOwner(left: PhysicalOwnerMetadata, right: PhysicalOwnerMetadata): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.pid === right.pid &&
    left.resource === right.resource &&
    left.leaseId === right.leaseId &&
    left.claimId === right.claimId &&
    left.resourceDigest === right.resourceDigest &&
    JSON.stringify(left.processIdentity) === JSON.stringify(right.processIdentity)
  );
}

function isLeaseContention(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { readonly code?: string }).code === 'contended'
  );
}

async function readRecoveryState(
  path: string,
  allowEmpty = false,
): Promise<{
  recovery: LedgerRecoveryState;
  partialFinalLine?: string;
}> {
  let prefix: JsonlPrefix<unknown>;
  try {
    prefix = await readJsonlPrefix<unknown>(path, { allowPartialFinalLine: true });
  } catch (error) {
    if (!allowEmpty || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    prefix = { records: [], validBytes: 0, totalBytes: 0 };
  }
  const recovery = recoverLedger(prefix.records);
  if (recovery.events.length === 0 && prefix.records.length > 0)
    throw new Error('explicit recovery requires a schema-v3 ledger namespace');
  if (recovery.events.length === 0 && !allowEmpty)
    throw new Error('explicit recovery requires a schema-v3 ledger namespace');
  return {
    recovery,
    ...(prefix.partialFinalLine == null ? {} : { partialFinalLine: prefix.partialFinalLine }),
  };
}

async function readOwnerMetadata(path: string, kind: string): Promise<PhysicalOwnerMetadata> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`${kind} metadata is unreadable`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${kind} metadata is invalid`);
  const record = value as Record<string, unknown>;
  if (
    typeof record.ownerId !== 'string' ||
    !record.ownerId ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0
  )
    throw new Error(`${kind} owner evidence is incomplete`);
  const processIdentity = parseProcessIdentity(record.processIdentity, kind);
  return {
    ownerId: record.ownerId,
    pid: record.pid as number,
    ...(processIdentity ? { processIdentity } : {}),
    ...(typeof record.resource === 'string' ? { resource: record.resource } : {}),
    ...(typeof record.leaseId === 'string' ? { leaseId: record.leaseId } : {}),
    ...(typeof record.claimId === 'string' ? { claimId: record.claimId } : {}),
    ...(typeof record.resourceDigest === 'string' ? { resourceDigest: record.resourceDigest } : {}),
  };
}

async function readOwnerMetadataIfPresent(
  path: string,
  kind: string,
): Promise<PhysicalOwnerMetadata | undefined> {
  try {
    return await readOwnerMetadata(path, kind);
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function parseProcessIdentity(value: unknown, kind: string): BootBoundProcessIdentity | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${kind} process identity is invalid`);
  const record = value as Record<string, unknown>;
  if (
    (record.kind !== 'darwin-start-time' && record.kind !== 'linux-start-ticks') ||
    typeof record.value !== 'string' ||
    !record.value ||
    typeof record.bootIdentityHash !== 'string' ||
    !record.bootIdentityHash
  )
    throw new Error(`${kind} process identity is invalid`);
  return {
    kind: record.kind,
    value: record.value,
    bootIdentityHash: record.bootIdentityHash,
  };
}

async function assertDefinitelyDead(metadata: PhysicalOwnerMetadata, kind: string): Promise<void> {
  const probe = await probeProcessOwner({
    pid: metadata.pid,
    processIdentity: metadata.processIdentity,
  });
  if (probe.state !== 'dead')
    throw new Error(`${kind} owner is not proven dead: ${probeReason(probe)}`);
}

function probeReason(probe: Exclude<ProcessOwnerProbe, { state: 'dead' }>): string {
  return 'reason' in probe ? probe.reason : probe.state;
}

function sameRequiredProcessIdentity(
  left: PhysicalOwnerMetadata,
  right: PhysicalOwnerMetadata,
): boolean {
  return (
    left.processIdentity != null &&
    right.processIdentity != null &&
    left.processIdentity.kind === right.processIdentity.kind &&
    left.processIdentity.value === right.processIdentity.value &&
    left.processIdentity.bootIdentityHash === right.processIdentity.bootIdentityHash
  );
}

function assertPreJournalLeaseMatches(
  staleAdministrativeOwner: PhysicalOwnerMetadata | undefined,
  physicalLease: PhysicalOwnerMetadata,
  ledgerPath: string,
  administrativeResource: string,
): void {
  if (!staleAdministrativeOwner)
    throw new Error('physical ledger lease has no active durable or stale administrative owner');
  if (
    staleAdministrativeOwner.resource !== administrativeResource ||
    physicalLease.resource !== ledgerPath ||
    !physicalLease.leaseId ||
    staleAdministrativeOwner.ownerId !== physicalLease.ownerId ||
    staleAdministrativeOwner.pid !== physicalLease.pid ||
    !sameRequiredProcessIdentity(staleAdministrativeOwner, physicalLease)
  ) {
    throw new Error('pre-journal ledger lease does not match the stale administrative owner');
  }
}

function assertPreJournalAccountClaimMatches(
  recovery: LedgerRecoveryState,
  physicalLease: PhysicalOwnerMetadata,
  physicalClaim: PhysicalOwnerMetadata,
): void {
  const durableLease = recovery.activeLease;
  if (!durableLease)
    throw new Error('account claim path has no matching durable execution-lease owner');
  if (
    !physicalClaim.claimId ||
    !physicalClaim.resourceDigest ||
    !/^sha256-[a-f0-9]{64}$/.test(physicalClaim.resourceDigest) ||
    physicalClaim.ownerId !== durableLease.ownerId ||
    physicalClaim.ownerId !== physicalLease.ownerId ||
    physicalClaim.pid !== physicalLease.pid ||
    !sameRequiredProcessIdentity(physicalClaim, physicalLease)
  ) {
    throw new Error('pre-journal account claim does not match durable ledger ownership');
  }
}

function latestReleasedLeaseMatches(
  recovery: LedgerRecoveryState,
  physical: PhysicalOwnerMetadata,
): boolean {
  const latest = [...recovery.events].reverse().find((event) => event.recordType === 'lease');
  return Boolean(
    latest?.recordType === 'lease' &&
    latest.action === 'released' &&
    latest.resource === physical.resource &&
    latest.leaseId === physical.leaseId &&
    latest.ownerId === physical.ownerId,
  );
}

function assertDurableLeaseMatches(
  recovery: LedgerRecoveryState,
  physical: PhysicalOwnerMetadata,
): void {
  const durable = recovery.activeLease;
  if (!durable) throw new Error('physical ledger lease has no matching active durable lease');
  if (
    physical.resource !== durable.resource ||
    physical.leaseId !== durable.leaseId ||
    physical.ownerId !== durable.ownerId
  )
    throw new Error('physical ledger lease does not match durable ownership');
}

function assertDurableAccountClaimMatches(
  recovery: LedgerRecoveryState,
  physical: PhysicalOwnerMetadata,
): void {
  const durable = recovery.activeAccountClaim;
  if (!durable) throw new Error('physical account claim has no matching durable claim');
  if (
    physical.claimId !== durable.claimId ||
    physical.ownerId !== durable.ownerId ||
    physical.resourceDigest !== durable.resourceDigest
  )
    throw new Error('physical account claim does not match durable ownership');
}

function assertNoUnresolvedEffects(recovery: LedgerRecoveryState): void {
  if (recovery.unresolvedIntents.size > 0)
    throw new Error(
      'stale-claim recovery refuses unresolved broker effects without complete venue reconciliation',
    );
}

function assertSameDurableOwners(before: LedgerRecoveryState, after: LedgerRecoveryState): void {
  const leaseBefore = before.activeLease;
  const leaseAfter = after.activeLease;
  if (
    leaseBefore?.leaseId !== leaseAfter?.leaseId ||
    leaseBefore?.ownerId !== leaseAfter?.ownerId ||
    leaseBefore?.resource !== leaseAfter?.resource
  )
    throw new Error('durable ledger ownership changed during recovery handoff');
  const claimBefore = before.activeAccountClaim;
  const claimAfter = after.activeAccountClaim;
  if (
    claimBefore?.claimId !== claimAfter?.claimId ||
    claimBefore?.ownerId !== claimAfter?.ownerId ||
    claimBefore?.resourceDigest !== claimAfter?.resourceDigest
  )
    throw new Error('durable account ownership changed during recovery handoff');
  const releaseBefore = before.accountClaimReleaseStarted;
  const releaseAfter = after.accountClaimReleaseStarted;
  if (
    releaseBefore?.sequence !== releaseAfter?.sequence ||
    releaseBefore?.claimId !== releaseAfter?.claimId ||
    releaseBefore?.ownerId !== releaseAfter?.ownerId
  )
    throw new Error('durable account release state changed during recovery handoff');
}

function requiredNamespace(value: string | undefined, name: string): string {
  if (!value) throw new Error(`recovery ledger is missing ${name}`);
  return value;
}

function now(options: RecoverStaleClaimsOptions): number {
  const value = options.now?.() ?? Date.now();
  if (!Number.isFinite(value)) throw new Error('recovery clock is not finite');
  return value;
}
