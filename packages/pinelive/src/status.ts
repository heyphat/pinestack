import { resolve } from 'node:path';
import { recoverLedger, type LedgerRecoveryState, type RecoveredIntent } from './core/recovery.js';
import type {
  EffectiveRunPosture,
  ExecutionEligibilityState,
  LedgerEventV3,
} from './core/ledger.js';
import { readJsonlPrefix } from './node.js';

type DurableDecisionEvent = Extract<
  LedgerEventV3,
  { readonly decisionId: string; readonly target: number; readonly barTime: number }
>;

export type StatusEvidence<T> =
  | { readonly availability: 'known'; readonly value: T }
  | {
      readonly availability: 'not-recorded' | 'not-inspected' | 'unknown';
      readonly reason: string;
    };

export interface PineliveStatusOptions {
  readonly ledgerPath: string;
  readonly recent?: number;
  readonly now?: Date;
}

export interface PineliveStatus {
  readonly statusVersion: 1;
  readonly generatedAt: string;
  readonly identity: {
    readonly runId?: string;
    readonly executionId?: string;
  };
  readonly posture: StatusEvidence<EffectiveRunPosture>;
  readonly executionEligibility: StatusEvidence<{
    readonly state: ExecutionEligibilityState;
    readonly reasons: readonly string[];
  }>;
  readonly ownership: {
    readonly durableLedgerLease: StatusEvidence<{
      readonly resource: string;
      readonly leaseId: string;
      readonly ownerId: string;
      readonly acquiredAt: string;
    }>;
    readonly durableAccountClaim: StatusEvidence<{
      readonly resourceDigest: string;
      readonly claimId: string;
      readonly ownerId: string;
      readonly acquiredAt: string;
    }>;
  };
  readonly breaker: StatusEvidence<{
    readonly latched: boolean;
    readonly reason?: string;
    readonly consecutiveErrors: number;
  }>;
  readonly unresolvedEffects: StatusEvidence<
    readonly {
      readonly logicalOrderId: string;
      readonly certainty: 'intent-only' | 'attempted' | 'unknown' | 'resolution-required';
      readonly target: number;
      readonly delta: number;
    }[]
  >;
  readonly latestObservation: StatusEvidence<{
    readonly decisionId: string;
    readonly target: number;
    readonly barTime: number;
    readonly observedAt: string;
    readonly recordType: DurableDecisionEvent['recordType'];
  }>;
  readonly counters: StatusEvidence<{
    readonly evaluations: {
      readonly accepted: number;
      readonly skipped: number;
      readonly completed: number;
    };
    readonly orders: {
      readonly intents: number;
      readonly attempts: number;
      readonly unknown: number;
    };
    readonly alerts: number;
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
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

const DEFAULT_RECENT = 5;
const MAX_RECENT = 100;

/** Read-only explicit-ledger status. It never constructs a provider, broker, channel, or claim. */
export async function readPineliveStatus(options: PineliveStatusOptions): Promise<PineliveStatus> {
  if (!options.ledgerPath) throw new RangeError('status ledgerPath must not be empty');
  const recent = options.recent ?? DEFAULT_RECENT;
  if (!Number.isSafeInteger(recent) || recent < 0 || recent > MAX_RECENT)
    throw new RangeError(`status recent must be an integer between 0 and ${MAX_RECENT}`);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError('status now must be a valid date');

  const path = resolve(options.ledgerPath);
  const prefix = await readJsonlPrefix<unknown>(path, { allowPartialFinalLine: true });
  const warnings: Array<{ code: string; message: string }> = [];
  if (prefix.partialFinalLine != null) {
    warnings.push({
      code: 'partial-tail',
      message: 'the final incomplete JSONL fragment was excluded from status',
    });
  }

  // An empty ledger has no durable evidence. Every nonempty ledger must be the active schema.
  const recovery = prefix.records.length > 0 ? recoverLedger(prefix.records) : undefined;
  const events = recovery?.events ?? [];
  const lastRecord = prefix.records.at(-1) as Record<string, unknown> | undefined;

  return {
    statusVersion: 1,
    generatedAt: now.toISOString(),
    identity: {
      ...(recovery?.runId ? { runId: recovery.runId } : {}),
      ...(recovery?.executionId ? { executionId: recovery.executionId } : {}),
    },
    posture: postureEvidence(recovery),
    executionEligibility: eligibilityEvidence(recovery),
    ownership: {
      durableLedgerLease: recovery?.activeLease
        ? {
            availability: 'known',
            value: {
              resource: recovery.activeLease.resource,
              leaseId: recovery.activeLease.leaseId,
              ownerId: recovery.activeLease.ownerId,
              acquiredAt: recovery.activeLease.recordedAt,
            },
          }
        : notRecorded(
            recovery
              ? 'no active durable ledger lease'
              : 'empty ledger has no ledger lease evidence',
          ),
      durableAccountClaim: recovery?.activeAccountClaim
        ? {
            availability: 'known',
            value: {
              resourceDigest: recovery.activeAccountClaim.resourceDigest,
              claimId: recovery.activeAccountClaim.claimId,
              ownerId: recovery.activeAccountClaim.ownerId,
              acquiredAt: recovery.activeAccountClaim.recordedAt,
            },
          }
        : notRecorded(
            recovery
              ? 'no active durable account claim'
              : 'empty ledger has no account claim evidence',
          ),
    },
    breaker: recovery
      ? {
          availability: 'known',
          value: {
            latched: recovery.breaker.latched,
            ...(recovery.breaker.reason ? { reason: recovery.breaker.reason } : {}),
            consecutiveErrors: recovery.consecutiveErrors,
          },
        }
      : notRecorded('empty ledger has no breaker state'),
    unresolvedEffects: recovery
      ? {
          availability: 'known',
          value: [...recovery.unresolvedIntents.values()]
            .map(unresolvedEffect)
            .sort((left, right) => left.logicalOrderId.localeCompare(right.logicalOrderId)),
        }
      : notRecorded('empty ledger has no unresolved effect evidence'),
    latestObservation: latestObservation(events),
    counters: recovery
      ? { availability: 'known', value: countEvents(events) }
      : notRecorded('empty ledger has no durable counters'),
    recent: events.slice(-recent).map((event) => ({
      recordType: event.recordType,
      sequence: event.sequence,
      recordedAt: event.recordedAt,
    })),
    ledger: {
      path,
      bytes: prefix.totalBytes,
      validBytes: prefix.validBytes,
      partialTail: prefix.partialFinalLine != null,
      ...(recovery ? { ledgerSchemaVersion: 3 as const } : {}),
      ...(recovery && recovery.lastSequence > 0 ? { lastSequence: recovery.lastSequence } : {}),
      ...(typeof lastRecord?.recordedAt === 'string'
        ? { lastRecordAt: lastRecord.recordedAt }
        : {}),
    },
    warnings,
  };
}

function postureEvidence(
  recovery: LedgerRecoveryState | undefined,
): StatusEvidence<EffectiveRunPosture> {
  if (recovery?.executionEligibility)
    return { availability: 'known', value: recovery.executionEligibility.posture };
  return notRecorded(
    recovery
      ? 'execution posture was not recorded'
      : 'empty ledger has no execution posture evidence',
  );
}

function eligibilityEvidence(
  recovery: LedgerRecoveryState | undefined,
): PineliveStatus['executionEligibility'] {
  const event = recovery?.executionEligibility;
  if (event)
    return {
      availability: 'known',
      value: { state: event.state, reasons: [...event.reasons] },
    };
  return notRecorded(
    recovery
      ? 'execution eligibility was not recorded'
      : 'empty ledger has no execution eligibility evidence',
  );
}

function notRecorded<T>(reason: string): StatusEvidence<T> {
  return { availability: 'not-recorded', reason };
}

function unresolvedEffect(intent: RecoveredIntent): {
  logicalOrderId: string;
  certainty: 'intent-only' | 'attempted' | 'unknown' | 'resolution-required';
  target: number;
  delta: number;
} {
  const certainty = intent.unknown
    ? 'unknown'
    : intent.resolutions.some(
          (resolution) =>
            resolution.outcome === 'ambiguous' ||
            resolution.outcome === 'unsupported' ||
            resolution.outcome === 'not-found',
        )
      ? 'resolution-required'
      : intent.attempts.length > 0
        ? 'attempted'
        : 'intent-only';
  return {
    logicalOrderId: intent.intent.logicalOrderId,
    certainty,
    target: intent.intent.target,
    delta: intent.intent.delta,
  };
}

function latestObservation(events: readonly LedgerEventV3[]): PineliveStatus['latestObservation'] {
  const event = [...events]
    .reverse()
    .find(
      (candidate): candidate is DurableDecisionEvent =>
        'decisionId' in candidate && 'target' in candidate && 'barTime' in candidate,
    );
  return event
    ? {
        availability: 'known',
        value: {
          decisionId: event.decisionId,
          target: event.target,
          barTime: event.barTime,
          observedAt: event.recordedAt,
          recordType: event.recordType,
        },
      }
    : notRecorded('no durable evaluation observation');
}

function countEvents(events: readonly LedgerEventV3[]): {
  evaluations: { accepted: number; skipped: number; completed: number };
  orders: { intents: number; attempts: number; unknown: number };
  alerts: number;
} {
  const counts = {
    evaluations: { accepted: 0, skipped: 0, completed: 0 },
    orders: { intents: 0, attempts: 0, unknown: 0 },
    alerts: 0,
  };
  for (const event of events) {
    if (event.recordType === 'evaluation.accepted') counts.evaluations.accepted++;
    else if (event.recordType === 'evaluation.skipped') counts.evaluations.skipped++;
    else if (event.recordType === 'evaluation.completed') counts.evaluations.completed++;
    else if (event.recordType === 'order.intent') counts.orders.intents++;
    else if (event.recordType === 'order.attempt') counts.orders.attempts++;
    else if (event.recordType === 'order.unknown') counts.orders.unknown++;
    else if (event.recordType === 'alert') counts.alerts++;
  }
  return counts;
}
