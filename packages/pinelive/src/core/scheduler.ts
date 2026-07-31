import { BrokerError, submitFailureCertainty } from './broker.js';
import type { BrokerErrorCode, ExactOrderLookupResult } from './broker.js';
import type { RunInstrumentBinding } from './binding.js';
import type { ExecutionLease } from './lease.js';
import {
  SequencedLedger,
  type BreakerReasonV3,
  type ChartUpdateIdentityV3,
  type DecisionEventV3,
  type EvaluationAcceptedEventV3,
  type EvaluationSkipReasonV3,
  type LedgerCursor,
  type LedgerError,
  type LedgerEventV3Input,
  type LedgerSink,
  type OrderCompletionEventV3,
  type OrderIntentEventV3,
  type OrderResolutionEventV3,
} from './ledger.js';
import {
  PositionMirrorHookError,
  type OrderAttemptHookContext,
  type OrderHookContext,
  type OrderResultHookContext,
  type PositionMirror,
  type PositionMirrorHooks,
  type PositionRefreshHookContext,
  type ReconcileContext,
  type ReconcileOutcome,
} from './mirror.js';
import {
  chartStreamKey,
  ledgerBarKey,
  logicalClientId,
  logicalOrderId,
  type LedgerRecoveryState,
  type RecoveredBarCounters,
  type RecoveredChartUpdate,
  type RecoveredDecision,
  type RecoveredIntent,
} from './recovery.js';
import type { Fill, OrderRequest, Position } from './types.js';

export interface SchedulerLimits {
  /** Minimum start-to-start spacing between complete mirror reconciliations. Default 0. */
  minIntervalMs?: number;
  maxTargetsPerBar?: number;
  maxIntentsPerBar?: number;
  maxAttemptsPerMinute?: number;
  maxConsecutiveErrors?: number;
}

export interface TargetEvaluation {
  target: number;
  context: ReconcileContext;
  /** Defaults to barTime and is advanced only by an authoritative-final skipped/completed event. */
  cursor?: LedgerCursor;
  /** Explicit chart update identity; omission is normalized to close-only revision 1 finality. */
  update?: Readonly<ChartUpdateIdentityV3>;
  /** Supplying this is recommended when the upstream source already owns durable identity. */
  decisionId?: string;
  /** Runs after evaluation.accepted is durable and immediately before the first broker read. */
  beforeBrokerRead?: () => void | Promise<void>;
}

export interface ScheduleTargetOptions {
  cursor?: LedgerCursor;
  update?: Readonly<ChartUpdateIdentityV3>;
  decisionId?: string;
}

export type ScheduledTargetStatus = 'completed' | 'skipped' | 'unknown' | 'failed';

export interface ScheduledTargetResult {
  decisionId: string;
  status: ScheduledTargetStatus;
  reason?: string;
  outcome?: ReconcileOutcome;
}

export interface UnknownOrderResolutionResult {
  logicalOrderId: string;
  status: ExactOrderLookupResult['status'];
  resolved: boolean;
  detail?: string;
}

export interface TargetSchedulerOptions {
  mirror: PositionMirror;
  ledger: LedgerSink | SequencedLedger;
  runId: string;
  executionId?: string;
  binding?: RunInstrumentBinding;
  recovery?: LedgerRecoveryState;
  limits?: SchedulerLimits;
  lease?: ExecutionLease;
  /** The shared writer already contains the active acquired lease row. */
  leaseAlreadyRecorded?: boolean;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  decisionIdFactory?: (evaluation: Readonly<TargetEvaluation>) => string;
}

export interface CircuitBreakerSnapshot {
  latched: boolean;
  consecutiveErrors: number;
  reason?: BreakerReasonV3;
  detail?: string;
}

/** Pure state primitive. It has no broker reference, so reset cannot submit, cancel, or flatten. */
export class CircuitBreaker {
  private latchedValue: boolean;
  private errors: number;
  private reasonValue?: BreakerReasonV3;
  private detailValue?: string;

  constructor(
    readonly maxConsecutiveErrors: number,
    initial: Partial<CircuitBreakerSnapshot> = {},
  ) {
    positiveLimit(maxConsecutiveErrors, 'maxConsecutiveErrors');
    this.latchedValue = initial.latched ?? false;
    this.errors = initial.consecutiveErrors ?? 0;
    this.reasonValue = initial.reason;
    this.detailValue = initial.detail;
  }

  get snapshot(): CircuitBreakerSnapshot {
    return {
      latched: this.latchedValue,
      consecutiveErrors: this.errors,
      reason: this.reasonValue,
      detail: this.detailValue,
    };
  }

  recordSuccess(): void {
    if (!this.latchedValue) this.errors = 0;
  }

  recordError(): boolean {
    this.errors++;
    if (this.errors >= this.maxConsecutiveErrors) {
      this.latch('consecutive-errors');
      return true;
    }
    return false;
  }

  latch(reason: BreakerReasonV3, detail?: string): void {
    this.latchedValue = true;
    this.reasonValue = reason;
    this.detailValue = detail;
  }

  reset(): void {
    this.latchedValue = false;
    this.errors = 0;
    this.reasonValue = undefined;
    this.detailValue = undefined;
  }
}

class SchedulerGateError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SchedulerGateError';
  }
}

class UnknownSubmissionError extends Error {
  constructor(
    readonly logicalId: string,
    options?: ErrorOptions,
  ) {
    super(`submission outcome is unknown for ${logicalId}`, options);
    this.name = 'UnknownSubmissionError';
  }
}

class RecoveredTerminalResultError extends Error {
  constructor(
    readonly outcome: ReconcileOutcome,
    readonly positionConsistent: boolean,
  ) {
    super('recovered terminal result must not be submitted again');
    this.name = 'RecoveredTerminalResultError';
  }
}

interface PendingEvaluation extends Required<
  Pick<TargetEvaluation, 'target' | 'context' | 'update'>
> {
  cursor: LedgerCursor;
  decisionId: string;
  accepted?: EvaluationAcceptedEventV3;
  resume?: RecoveredIntent;
  beforeBrokerRead?: () => void | Promise<void>;
  resolve: (result: ScheduledTargetResult) => void;
  reject: (error: unknown) => void;
}

interface NormalizedLimits {
  minIntervalMs: number;
  maxTargetsPerBar: number;
  maxIntentsPerBar: number;
  maxAttemptsPerMinute: number;
  maxConsecutiveErrors: number;
}

interface OrderCompletionDetails {
  outcome: OrderCompletionEventV3['outcome'];
  actualAfter: number | null;
  fill?: Fill;
  error?: LedgerError;
}

/**
 * One read/plan/submit/refresh transaction at a time. While one runs, only the newest accepted
 * target remains pending; the replaced evaluation receives a durable coalesced event.
 */
export class TargetScheduler {
  private readonly writer: SequencedLedger;
  private readonly mirror: PositionMirror;
  private readonly limits: NormalizedLimits;
  private readonly breaker: CircuitBreaker;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly perBar = new Map<string, RecoveredBarCounters>();
  private readonly decisions = new Map<string, RecoveredDecision>();
  private readonly unresolved = new Map<string, RecoveredIntent>();
  private readonly clientMappings = new Map<string, string>();
  private readonly latestChartUpdates = new Map<string, RecoveredChartUpdate>();
  private readonly activeChartUpdates = new Map<string, RecoveredChartUpdate>();
  private readonly restartInterruptedChartStreams = new Set<string>();
  private readonly eventIdToDecisionId = new Map<string, string>();
  private attemptTimes: number[] = [];
  private intakeTail: Promise<void> = Promise.resolve();
  private lifecycleTail: Promise<void> = Promise.resolve();
  private active?: PendingEvaluation;
  private pending?: PendingEvaluation;
  private drainValue: Promise<void> = Promise.resolve();
  private running = false;
  private stopped = false;
  private bindingRecorded = false;
  private leaseRecorded = false;
  private recoveryRecorded: boolean;
  private recoveredThresholdLatchPending = false;
  private recoveredSupersededDecisionIds: string[] = [];
  private lastOperationAt?: number;
  private latestBreakerResetSequence?: number;

  constructor(private readonly options: TargetSchedulerOptions) {
    if (!options.runId) throw new RangeError('scheduler runId must not be empty');
    this.mirror = options.mirror;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.limits = normalizeLimits(options.limits);
    const recovery = options.recovery;
    if (options.binding && recovery && !recovery.binding && recovery.decisions.size > 0)
      throw new RangeError('scheduler cannot add a binding after recovered unbound evaluations');
    this.recoveryRecorded = recovery == null;
    if (options.leaseAlreadyRecorded === true) {
      const snapshot = options.lease?.snapshot;
      if (!snapshot) throw new RangeError('recorded scheduler lease must already be acquired');
      const recoveredLease = recovery?.activeLease;
      if (
        recoveredLease &&
        (recoveredLease.resource !== snapshot.resource ||
          recoveredLease.leaseId !== snapshot.leaseId ||
          recoveredLease.ownerId !== snapshot.ownerId)
      ) {
        throw new RangeError('recorded scheduler lease does not match recovery');
      }
      this.leaseRecorded = true;
    }
    const executionId = options.executionId ?? recovery?.executionId ?? 'default';
    if (recovery?.runId && recovery.runId !== options.runId)
      throw new RangeError('scheduler runId does not match recovery');
    if (recovery?.executionId && recovery.executionId !== executionId)
      throw new RangeError('scheduler executionId does not match recovery');
    this.writer =
      options.ledger instanceof SequencedLedger
        ? options.ledger
        : new SequencedLedger(options.ledger, {
            runId: options.runId,
            executionId,
            nextSequence: recovery?.nextSequence,
            lastTimestamp:
              recovery && recovery.events.length > 0
                ? Date.parse(recovery.events.at(-1)!.recordedAt)
                : undefined,
            now: this.now,
          });
    const recoveredThresholdReached =
      recovery != null &&
      !recovery.breaker.latched &&
      recovery.consecutiveErrors >= this.limits.maxConsecutiveErrors;
    this.recoveredThresholdLatchPending = recoveredThresholdReached;
    this.breaker = new CircuitBreaker(this.limits.maxConsecutiveErrors, {
      latched: recovery?.breaker.latched || recoveredThresholdReached,
      consecutiveErrors: recovery?.consecutiveErrors,
      reason: recoveredThresholdReached ? 'consecutive-errors' : recovery?.breaker.reason,
    });
    if (recovery) this.restore(recovery);
    if (options.binding && recovery?.binding) {
      if (canonical(options.binding) !== canonical(recovery.binding.binding))
        throw new RangeError('scheduler binding does not match recovery');
      this.bindingRecorded = true;
    }
  }

  get state(): {
    breaker: CircuitBreakerSnapshot;
    pending: number;
    unresolvedLogicalOrderIds: string[];
    activeChartUpdates: RecoveredChartUpdate[];
    nextSequence: number;
  } {
    return {
      breaker: this.breaker.snapshot,
      pending: (this.active ? 1 : 0) + (this.pending ? 1 : 0),
      unresolvedLogicalOrderIds: [...this.unresolved.keys()],
      activeChartUpdates: [...this.activeChartUpdates.values()].map((update) =>
        structuredClone(update),
      ),
      nextSequence: this.writer.nextSequence,
    };
  }

  schedule(evaluation: TargetEvaluation): Promise<ScheduledTargetResult>;
  schedule(
    target: number,
    context: ReconcileContext,
    options?: ScheduleTargetOptions,
  ): Promise<ScheduledTargetResult>;
  schedule(
    evaluationOrTarget: TargetEvaluation | number,
    context?: ReconcileContext,
    scheduleOptions: ScheduleTargetOptions = {},
  ): Promise<ScheduledTargetResult> {
    const evaluation: TargetEvaluation =
      typeof evaluationOrTarget === 'number'
        ? {
            target: evaluationOrTarget,
            context: requiredContext(context),
            ...scheduleOptions,
          }
        : evaluationOrTarget;
    let created: { item: PendingEvaluation; promise: Promise<ScheduledTargetResult> };
    try {
      created = this.createItem(evaluation);
    } catch (error) {
      return Promise.reject(error);
    }
    const { item, promise } = created;
    const intake = this.intakeTail.then(() => this.accept(item));
    this.intakeTail = intake.catch((error) => {
      item.reject(error);
    });
    return promise;
  }

  enqueue(evaluation: TargetEvaluation): Promise<ScheduledTargetResult> {
    return this.schedule(evaluation);
  }

  /** Journal an evaluated update without admitting it to broker scheduling. */
  journalSkipped(
    evaluation: TargetEvaluation,
    reason: Extract<
      EvaluationSkipReasonV3,
      | 'compute-only'
      | 'forming'
      | 'recovered-final'
      | 'startup-discontinuity'
      | 'mirror-cadence'
      | 'invalid'
    >,
    detail?: string,
  ): Promise<ScheduledTargetResult> {
    let created: { item: PendingEvaluation; promise: Promise<ScheduledTargetResult> };
    try {
      created = this.createItem(evaluation);
    } catch (error) {
      return Promise.reject(error);
    }
    const { item, promise } = created;
    const intake = this.intakeTail.then(async () => {
      if (this.stopped) {
        item.resolve({ decisionId: item.decisionId, status: 'skipped', reason: 'shutdown' });
        return;
      }
      this.assertBindingContext(item.context);
      const existingBeforeInitialization = this.decisions.get(item.decisionId);
      if (!existingBeforeInitialization) this.assertCanAdmitChartUpdate(item);
      await this.initialize();
      const existing = this.decisions.get(item.decisionId);
      if (existing) {
        const durableIdentity = existing.accepted ?? existing.skipped[0];
        if (durableIdentity) assertScheduledDecisionMatches(item, durableIdentity);
        item.resolve({ decisionId: item.decisionId, status: 'skipped', reason: 'duplicate' });
        return;
      }
      await this.appendSkipped(item, reason, detail);
      item.resolve({ decisionId: item.decisionId, status: 'skipped', reason });
    });
    this.intakeTail = intake.catch((error) => item.reject(error));
    return promise;
  }

  private createItem(evaluation: TargetEvaluation): {
    item: PendingEvaluation;
    promise: Promise<ScheduledTargetResult>;
  } {
    if (!Number.isFinite(evaluation.target))
      throw new RangeError('scheduled target must be finite');
    if (
      evaluation.context.referencePrice != null &&
      (!Number.isFinite(evaluation.context.referencePrice) ||
        evaluation.context.referencePrice <= 0)
    )
      throw new RangeError('scheduled referencePrice must be positive and finite');
    const cursor = evaluation.cursor ?? evaluation.context.barTime;
    const update = evaluation.update
      ? normalizeChartUpdateIdentity(evaluation.update)
      : legacyCloseOnlyUpdate(evaluation, cursor);
    const normalizedEvaluation = { ...evaluation, cursor, update };
    const decisionId =
      evaluation.decisionId ??
      this.options.decisionIdFactory?.(normalizedEvaluation) ??
      stableDecisionId(normalizedEvaluation);
    if (!decisionId) throw new RangeError('decisionId must not be empty');
    let resolve!: (result: ScheduledTargetResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<ScheduledTargetResult>((resolveValue, rejectValue) => {
      resolve = resolveValue;
      reject = rejectValue;
    });
    return {
      item: {
        target: evaluation.target,
        context: evaluation.context,
        cursor,
        update,
        decisionId,
        beforeBrokerRead: evaluation.beforeBrokerRead,
        resolve,
        reject,
      },
      promise,
    };
  }

  /** Acquire/record the optional lease and append recovery/binding before evaluations. */
  initialize(): Promise<void> {
    return this.runLifecycle(() => this.initializeCore());
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(operation);
    this.lifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async initializeCore(): Promise<void> {
    const lease = this.options.lease;
    const recoveredLease = this.options.recovery?.activeLease;
    if (recoveredLease && !lease)
      throw new Error('recovery has an active execution lease but no lease was supplied');
    let acquiredHere = false;
    try {
      if (lease && !this.leaseRecorded) {
        acquiredHere = lease.snapshot == null;
        const snapshot = await lease.acquire();
        const sameRecoveredLease =
          recoveredLease?.resource === snapshot.resource &&
          recoveredLease.leaseId === snapshot.leaseId &&
          recoveredLease.ownerId === snapshot.ownerId;
        if (recoveredLease && !sameRecoveredLease)
          throw new Error('supplied execution lease does not match the active recovered lease');
        if (!sameRecoveredLease) {
          await this.writer.append({
            recordType: 'lease',
            action: 'acquired',
            resource: snapshot.resource,
            leaseId: snapshot.leaseId,
            ownerId: snapshot.ownerId,
          });
        }
        this.leaseRecorded = true;
      }
      if (this.recoveredThresholdLatchPending) {
        const recovery = this.options.recovery!;
        await this.writer.append({
          recordType: 'breaker',
          state: 'latched',
          reason: 'consecutive-errors',
          consecutiveErrors: this.breaker.snapshot.consecutiveErrors,
          ...(recovery.lastFinalDecisionId ? { decisionId: recovery.lastFinalDecisionId } : {}),
          detail: 'recovered consecutive-error threshold',
        });
        this.recoveredThresholdLatchPending = false;
      }
      if (!this.recoveryRecorded) {
        const recovery = this.options.recovery!;
        await this.writer.append({
          recordType: 'recovery',
          action: 'loaded',
          sourceLastSequence: recovery.lastSequence,
          ...(recovery.lastFinalCursor == null
            ? {}
            : { lastFinalCursor: recovery.lastFinalCursor }),
          unresolvedLogicalOrderIds: [...recovery.unresolvedIntents.keys()].sort(),
        });
        this.recoveryRecorded = true;
      }
      await this.finalizeRecoveredSupersededDecisions();
      if (this.options.binding && !this.bindingRecorded) {
        await this.writer.append({ recordType: 'binding', binding: this.options.binding });
        this.bindingRecorded = true;
      }
    } catch (error) {
      if (!acquiredHere || !lease?.snapshot) throw error;
      this.leaseRecorded = false;
      try {
        await lease.release();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          'scheduler initialization and lease rollback failed',
        );
      }
      throw error;
    }
  }

  /** Explicit journaled reset only; it never invokes a broker method or drains queued work. */
  async resetBreaker(detail = 'operator reset'): Promise<CircuitBreakerSnapshot> {
    // Wait outside lifecycle ownership: accept() may be waiting on initialize().
    await this.intakeTail;
    return this.runLifecycle(async () => {
      await this.initializeCore();
      if (this.running)
        throw new Error('cannot reset breaker while a broker operation is in flight');
      if (!this.breaker.snapshot.latched) return this.breaker.snapshot;
      const unsafe = [...this.unresolved.values()].find((intent) =>
        submissionOutcomeUnresolved(intent),
      );
      if (unsafe)
        throw new Error(
          `cannot reset breaker while ${unsafe.intent.logicalOrderId} may have been submitted`,
        );
      const reset = await this.writer.append({
        recordType: 'breaker',
        state: 'reset',
        reason: 'operator',
        consecutiveErrors: 0,
        detail,
      });
      this.latestBreakerResetSequence = reset.sequence;
      this.breaker.reset();
      return this.breaker.snapshot;
    });
  }

  /**
   * Resolve one possibly-sent logical order using exact read-only broker state. This method never
   * submits, cancels, or flattens. Inconclusive lookup outcomes remain unresolved and latched.
   */
  async resolveUnknownSubmission(
    logicalId: string,
    signal?: AbortSignal,
  ): Promise<UnknownOrderResolutionResult> {
    await this.intakeTail;
    return this.runLifecycle(async () => {
      if (this.running)
        throw new Error('cannot resolve an unknown order while a broker operation is in flight');
      const intent = this.unresolved.get(logicalId);
      if (!intent) throw new Error(`logical order ${logicalId} is not unresolved`);
      if (intent.attempts.length === 0)
        throw new Error(`logical order ${logicalId} has no possibly-sent attempt`);
      if (terminalOrderEvidence(intent))
        throw new Error(`logical order ${logicalId} already has durable terminal evidence`);
      if (!submissionOutcomeUnresolved(intent))
        throw new Error(`logical order ${logicalId} has no unresolved possibly-sent submission`);

      // Validate eligibility before initialization can append recovery metadata. A proven-unsent
      // attempt belongs to the ordinary retry path and must not acquire contradictory resolution.
      await this.initializeCore();
      if (this.breaker.snapshot.latched) {
        await this.writer.append({
          recordType: 'breaker',
          state: 'latched',
          reason: this.breaker.snapshot.reason ?? 'recovery-unresolved',
          consecutiveErrors: this.breaker.snapshot.consecutiveErrors,
          decisionId: intent.intent.decisionId,
          logicalOrderId: logicalId,
          detail: 'read-only exact order resolution required',
        });
      }

      let lookup: ExactOrderLookupResult;
      try {
        lookup = await this.mirror.lookupOrder(cloneOrder(intent.intent.order), signal);
      } catch (error) {
        lookup = { status: 'ambiguous', detail: errorMessage(error) };
      }
      lookup = normalizeExactOrderLookupResult(intent.intent.order, lookup);

      let resolution: OrderResolutionEventV3;
      if (lookup.status === 'filled') {
        resolution = (await this.writer.append({
          recordType: 'order.resolution',
          ...persistedLogicalFields(intent.intent),
          outcome: 'filled',
          fill: structuredClone(lookup.fill),
        })) as OrderResolutionEventV3;
      } else if (lookup.status === 'rejected') {
        resolution = (await this.writer.append({
          recordType: 'order.resolution',
          ...persistedLogicalFields(intent.intent),
          outcome: 'rejected',
          error: {
            name: 'BrokerOrderResolution',
            message: lookup.message,
            code: 'reject',
            retryable: false,
          },
        })) as OrderResolutionEventV3;
      } else {
        resolution = (await this.writer.append({
          recordType: 'order.resolution',
          ...persistedLogicalFields(intent.intent),
          outcome: lookup.status,
          ...('detail' in lookup && lookup.detail ? { detail: lookup.detail } : {}),
        })) as OrderResolutionEventV3;
      }
      intent.resolutions.push(resolution);

      if (lookup.status !== 'filled' && lookup.status !== 'rejected') {
        if (!this.breaker.snapshot.latched)
          await this.latchBreaker(
            'submission-unknown',
            undefined,
            logicalId,
            `exact lookup remained ${lookup.status}`,
          );
        return {
          logicalOrderId: logicalId,
          status: lookup.status,
          resolved: false,
          ...('detail' in lookup && lookup.detail ? { detail: lookup.detail } : {}),
        };
      }

      let position: Position | undefined;
      let observationError: unknown;
      try {
        position = await this.mirror.getPosition(intent.intent.executionSymbol, signal);
        if (!Number.isFinite(position.qty))
          throw new Error('broker returned a non-finite position during order resolution');
      } catch (error) {
        observationError = error;
      }
      const expectedAfter =
        lookup.status === 'filled'
          ? intent.intent.actualBefore +
            (intent.intent.order.side === 'buy' ? lookup.fill.filledQty : -lookup.fill.filledQty)
          : intent.intent.actualBefore;
      const positionConsistent = position != null && nearlyEqual(position.qty, expectedAfter);
      const positionError: LedgerError | undefined = positionConsistent
        ? undefined
        : {
            name: 'RecoveryPositionError',
            message: observationError
              ? `exact order resolution could not read position: ${errorMessage(observationError)}`
              : 'observed position does not reflect the exact terminal order resolution',
            code: 'position-unknown',
            retryable: false,
          };
      if (positionError) this.breaker.latch('position-unknown', positionError.message);
      const completion = (await this.writer.append({
        recordType: 'order.completion',
        ...persistedLogicalFields(intent.intent),
        outcome: lookup.status,
        actualAfter: position?.qty ?? null,
        ...(lookup.status === 'filled' ? { fill: structuredClone(lookup.fill) } : {}),
        ...(positionError
          ? { error: positionError }
          : lookup.status === 'rejected'
            ? { error: resolution.error! }
            : {}),
      })) as OrderCompletionEventV3;
      this.rememberCompletion(intent.intent.decisionId, intent, completion);
      this.unresolved.delete(logicalId);

      if (positionError) {
        this.breaker.recordError();
        await this.writer.append({
          recordType: 'breaker',
          state: 'latched',
          reason: 'position-unknown',
          consecutiveErrors: this.breaker.snapshot.consecutiveErrors,
          decisionId: intent.intent.decisionId,
          logicalOrderId: logicalId,
          detail: positionError.message,
        });
      }
      return { logicalOrderId: logicalId, status: lookup.status, resolved: true };
    });
  }

  async idle(): Promise<void> {
    await this.intakeTail;
    await this.drainValue;
    await this.writer.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.intakeTail;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      await this.appendSkipped(pending, 'shutdown');
      pending.resolve({ decisionId: pending.decisionId, status: 'skipped', reason: 'shutdown' });
    }
    await this.drainValue;
    await this.writer.flush();
  }

  /** Release is separate from breaker reset and never performs a broker operation. */
  async releaseLease(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.idle();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.runLifecycle(async () => {
        const lease = this.options.lease;
        if (!lease?.snapshot) return;
        const snapshot = lease.snapshot;
        try {
          // Journal ownership cessation before the physical effect; a crash remains fail-closed.
          await this.writer.append({
            recordType: 'lease',
            action: 'released',
            resource: snapshot.resource,
            leaseId: snapshot.leaseId,
            ownerId: snapshot.ownerId,
          });
        } catch (error) {
          errors.push(error);
        }
        try {
          await lease.release();
        } catch (error) {
          errors.push(error);
        }
        this.leaseRecorded = false;
      });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, 'execution lease journal/release failed');
  }

  private async accept(item: PendingEvaluation): Promise<void> {
    if (this.stopped) {
      item.resolve({ decisionId: item.decisionId, status: 'skipped', reason: 'shutdown' });
      return;
    }
    this.assertBindingContext(item.context);
    const existingBeforeInitialization = this.decisions.get(item.decisionId);
    if (!existingBeforeInitialization) this.assertCanAdmitChartUpdate(item);
    await this.initialize();
    const existing = this.decisions.get(item.decisionId);
    if (existing) {
      item.accepted = existing.accepted;
      const durableIdentity = existing.accepted ?? existing.skipped[0];
      if (durableIdentity) assertScheduledDecisionMatches(item, durableIdentity);
      if (
        this.active?.decisionId === item.decisionId ||
        this.pending?.decisionId === item.decisionId
      ) {
        item.resolve({ decisionId: item.decisionId, status: 'skipped', reason: 'duplicate' });
        return;
      }
      const unresolvedId = existing.logicalOrderIds.find((id) => this.unresolved.has(id));
      if (unresolvedId) item.resume = this.unresolved.get(unresolvedId);
      const terminal =
        existing.completed != null || existing.accepted == null || existing.terminalSkipped;
      if (terminal) {
        item.resolve({ decisionId: item.decisionId, status: 'skipped', reason: 'duplicate' });
        return;
      }
      const completedIntent = existing.latestCompletedIntent;
      if (!item.resume && completedIntent?.completion) {
        if (completionHasUnknownPosition(completedIntent.completion)) {
          // A reset may authorize a fresh observation, but the completed order must never submit again.
          item.resume = completedIntent;
        } else if (!this.breaker.snapshot.latched) {
          const recoveredOutcome = recoveredDecisionOutcome(item, existing);
          const isFinal =
            completedIntent.completion.outcome === 'observed' ||
            recoveredOutcome.action !== 'order' ||
            (recoveredOutcome.actualAfter != null &&
              nearlyEqual(recoveredOutcome.actualAfter, item.target));
          if (isFinal) {
            await this.completeEvaluation(item, recoveredOutcome);
            if (recoveredOutcome.action === 'reject') {
              if (this.breaker.recordError())
                await this.latchBreaker(
                  'consecutive-errors',
                  item,
                  (existing.latestEffectfulIntent ?? completedIntent).intent.logicalOrderId,
                  recoveredOutcome.error.message,
                );
            } else {
              this.breaker.recordSuccess();
            }
            item.resolve({
              decisionId: item.decisionId,
              status: 'completed',
              outcome: recoveredOutcome,
            });
            return;
          }
        }
      }
    }
    const foreignUnresolved = [...this.unresolved.values()].find(
      (intent) => intent.intent.decisionId !== item.decisionId,
    );
    if (foreignUnresolved) {
      if (!this.breaker.snapshot.latched)
        await this.latchBreaker(
          'recovery-unresolved',
          undefined,
          foreignUnresolved.intent.logicalOrderId,
          `unresolved decision ${foreignUnresolved.intent.decisionId} must be resumed first`,
        );
      await this.appendSkipped(item, 'breaker-open', 'another logical order is unresolved');
      item.resolve({ decisionId: item.decisionId, status: 'skipped', reason: 'breaker-open' });
      return;
    }
    if (this.breaker.snapshot.latched) {
      await this.appendSkipped(item, 'breaker-open');
      item.resolve({ decisionId: item.decisionId, status: 'skipped', reason: 'breaker-open' });
      return;
    }
    if (this.options.lease) {
      try {
        await this.options.lease.assertHeld();
      } catch (error) {
        await this.appendSkipped(item, 'lease-unavailable', errorMessage(error));
        item.resolve({
          decisionId: item.decisionId,
          status: 'skipped',
          reason: 'lease-unavailable',
        });
        return;
      }
    }

    let newCounter: RecoveredBarCounters | undefined;
    if (!existing) {
      newCounter = this.barCounters(item);
      if (newCounter.targets >= this.limits.maxTargetsPerBar) {
        await this.appendSkipped(item, 'target-limit');
        item.resolve({ decisionId: item.decisionId, status: 'skipped', reason: 'target-limit' });
        return;
      }
    }

    if (this.pending) {
      const replaced = this.pending;
      // Detach synchronously so the active drain cannot promote stale work during durability.
      this.pending = undefined;
      try {
        await this.appendSkipped(replaced, 'coalesced');
      } catch (error) {
        replaced.reject(error);
        throw error;
      }
      replaced.resolve({
        decisionId: replaced.decisionId,
        status: 'skipped',
        reason: 'coalesced',
      });
    }

    if (this.breaker.snapshot.latched) {
      await this.appendSkipped(item, 'breaker-open');
      item.resolve({ decisionId: item.decisionId, status: 'skipped', reason: 'breaker-open' });
      return;
    }

    if (!existing) {
      const accepted = (await this.writer.append({
        recordType: 'evaluation.accepted',
        ...decisionFields(item),
        targetOrdinal: newCounter!.targets + 1,
      })) as EvaluationAcceptedEventV3;
      newCounter!.targets++;
      item.accepted = accepted;
      this.decisions.set(item.decisionId, {
        accepted,
        skipped: [],
        terminalSkipped: false,
        logicalOrderIds: [],
      });
      this.rememberAdmittedChartUpdate(accepted);
    } else {
      item.accepted = existing.accepted;
    }

    if (this.running) {
      this.pending = item;
      return;
    }
    this.active = item;
    this.running = true;
    this.drainValue = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.active) {
        const item = this.active;
        try {
          if (this.breaker.snapshot.latched) {
            await this.appendSkipped(item, 'breaker-open');
            item.resolve({
              decisionId: item.decisionId,
              status: 'skipped',
              reason: 'breaker-open',
            });
          } else {
            item.resolve(await this.execute(item));
          }
        } catch (error) {
          item.reject(error);
        }
        this.active = this.pending;
        this.pending = undefined;
      }
    } finally {
      this.running = false;
    }
  }

  private async execute(item: PendingEvaluation): Promise<ScheduledTargetResult> {
    const recoveredDecision = this.decisions.get(item.decisionId);
    let correctionSeq =
      item.resume?.intent.correctionSeq ?? (recoveredDecision?.logicalOrderIds.length ?? 0) + 1;
    let beforeBrokerReadCompleted = false;
    for (;;) {
      await this.waitForInterval();
      await this.assertLeaseBeforeEffect(item);
      if (!beforeBrokerReadCompleted) {
        await item.beforeBrokerRead?.();
        beforeBrokerReadCompleted = true;
      }
      const clientId =
        item.resume?.intent.clientId ?? logicalClientId(item.decisionId, correctionSeq);
      let currentIntent = item.resume;
      let completionWritten = currentIntent?.completion != null;
      let latestFill: Fill | undefined;
      const attemptBase = currentIntent?.attempts.length ?? 0;

      const hooks: PositionMirrorHooks = {
        onOrderIntent: async (event) => {
          await this.assertLeaseBeforeEffect(item);
          const expectedLogicalId = logicalOrderId(item.decisionId, correctionSeq);
          if (event.order.clientId !== clientId)
            throw new SchedulerGateError('mirror did not preserve supplied clientId');
          if (currentIntent) {
            const terminal = terminalOrderEvidence(currentIntent);
            if (
              currentIntent.intent.logicalOrderId !== expectedLogicalId ||
              (!terminal && canonical(currentIntent.intent.order) !== canonical(event.order))
            )
              throw new SchedulerGateError(
                'recovered order economics no longer match broker state',
              );
            return;
          }
          const counter = this.barCounters(item);
          if (counter.intents >= this.limits.maxIntentsPerBar) {
            await this.latchBreaker('intent-limit', item);
            throw new SchedulerGateError('per-bar intent limit reached');
          }
          const intent = (await this.writer.append({
            recordType: 'order.intent',
            ...decisionFields(item),
            logicalOrderId: expectedLogicalId,
            correctionSeq,
            clientId,
            order: cloneOrder(event.order),
            actualBefore: event.actualBefore,
            delta: event.delta,
            intentOrdinal: counter.intents + 1,
          })) as OrderIntentEventV3;
          counter.intents++;
          currentIntent = { intent, attempts: [], results: [], resolutions: [] };
          this.unresolved.set(expectedLogicalId, currentIntent);
          this.clientMappings.set(clientId, expectedLogicalId);
          this.decisions.get(item.decisionId)!.logicalOrderIds.push(expectedLogicalId);
        },
        onOrderAttempt: async (event) => {
          await this.assertLeaseBeforeEffect(item);
          if (!currentIntent) throw new SchedulerGateError('attempt has no durable intent');
          const terminal = terminalOrderEvidence(currentIntent);
          if (terminal) {
            const recovered = recoveredTerminalOutcome(
              item,
              currentIntent,
              terminal,
              event.actualBefore,
            );
            if (!currentIntent.completion) {
              await this.writeCompletion(item, currentIntent, {
                outcome: terminal.outcome as 'filled' | 'rejected',
                actualAfter: event.actualBefore,
                fill: terminal.fill,
                error: !recovered.positionConsistent
                  ? {
                      name: 'RecoveryPositionError',
                      message: 'observed position does not reflect the durable terminal result',
                      code: 'position-unknown',
                      retryable: false,
                    }
                  : terminal.error,
              });
            }
            this.unresolved.delete(currentIntent.intent.logicalOrderId);
            completionWritten = true;
            throw new RecoveredTerminalResultError(recovered.outcome, recovered.positionConsistent);
          }
          if (currentIntent.unknown)
            throw new SchedulerGateError('possibly-sent logical order cannot be retransmitted');
          const priorAttempt = currentIntent.attempts.at(-1);
          if (
            priorAttempt &&
            !currentIntent.results.some((result) => result.attempt === priorAttempt.attempt)
          )
            throw new SchedulerGateError('result-less logical order cannot be retransmitted');
          const priorResult = priorAttempt
            ? currentIntent.results.find((result) => result.attempt === priorAttempt.attempt)
            : undefined;
          if (
            priorResult?.outcome === 'error' &&
            priorResult.error?.submitFailureCertainty !== 'definitely-not-sent'
          )
            throw new SchedulerGateError('submit retry lacks definitely-not-sent proof');
          const timestamp = Math.trunc(this.clock());
          this.attemptTimes = this.attemptTimes.filter((value) => value > timestamp - 60_000);
          if (this.attemptTimes.length >= this.limits.maxAttemptsPerMinute) {
            await this.latchBreaker('attempt-limit', item, currentIntent.intent.logicalOrderId);
            throw new SchedulerGateError('rolling-minute attempt limit reached');
          }
          const durableAttempt = attemptBase + event.attempt;
          const attempt = await this.writer.appendAt(
            {
              recordType: 'order.attempt',
              ...logicalFields(item, currentIntent.intent),
              attempt: durableAttempt,
              attemptsInRollingMinute: this.attemptTimes.length + 1,
            },
            timestamp,
          );
          currentIntent.attempts.push(attempt as never);
          this.attemptTimes.push(Date.parse(attempt.recordedAt));
          // This is the final effect gate: ownership may have changed while durability synced.
          await this.assertLeaseBeforeEffect(item);
        },
        onOrderResult: async (event) => {
          if (!currentIntent) throw new SchedulerGateError('result has no durable intent');
          const durableAttempt = attemptBase + event.attempt;
          if (event.fill) {
            latestFill = event.fill;
            const result = await this.writer.append({
              recordType: 'order.result',
              ...logicalFields(item, currentIntent.intent),
              attempt: durableAttempt,
              outcome: 'filled',
              fill: structuredClone(event.fill),
            });
            currentIntent.results.push(result as never);
            return;
          }
          const error = event.error;
          const serialized = ledgerError(error);
          const authoritativeRejection =
            error instanceof BrokerError && error.code === 'reject' && !error.retryable;
          const definitelyNotSent =
            error instanceof BrokerError && submitFailureCertainty(error) === 'definitely-not-sent';
          if (authoritativeRejection || definitelyNotSent) {
            const outcome =
              definitelyNotSent && error.retryable && event.attempt < event.maxAttempts
                ? 'error'
                : 'rejected';
            const result = await this.writer.append({
              recordType: 'order.result',
              ...logicalFields(item, currentIntent.intent),
              attempt: durableAttempt,
              outcome,
              error: serialized,
            });
            currentIntent.results.push(result as never);
            return;
          }
          // Close intake before durability can expose an inferred breaker to recovery.
          this.breaker.latch('submission-unknown', serialized.message);
          const unknown = await this.writer.append({
            recordType: 'order.unknown',
            ...logicalFields(item, currentIntent.intent),
            attempt: durableAttempt,
            error: serialized,
          });
          currentIntent.unknown = unknown as never;
          this.breaker.recordError();
          await this.latchBreaker(
            'submission-unknown',
            item,
            currentIntent.intent.logicalOrderId,
            serialized.message,
          );
          throw new UnknownSubmissionError(currentIntent.intent.logicalOrderId, { cause: error });
        },
        onPositionRefresh: async (event) => {
          await this.positionRefresh(item, event, currentIntent, latestFill, () => {
            completionWritten = true;
          });
        },
      };

      let outcome: ReconcileOutcome;
      try {
        outcome = await this.mirror.reconcile(
          item.target,
          { ...item.context, logicalClientId: clientId },
          hooks,
        );
      } catch (error) {
        const hookError = error instanceof PositionMirrorHookError ? error : undefined;
        const cause = hookError?.cause;
        if (cause instanceof RecoveredTerminalResultError) {
          const recoveredOutcome = cause.outcome;
          if (!cause.positionConsistent) {
            this.recordUnresetCompletionUncertainty(item);
            await this.latchBreaker(
              'position-unknown',
              item,
              currentIntent?.intent.logicalOrderId,
              'observed position does not reflect the durable terminal result',
            );
            return {
              decisionId: item.decisionId,
              status: 'unknown',
              reason: 'observed position does not reflect the durable terminal result',
              outcome: recoveredOutcome,
            };
          }
          if (recoveredOutcome.action === 'order') {
            if (recoveredOutcome.actualAfter === recoveredOutcome.target) {
              await this.completeEvaluation(item, recoveredOutcome);
              this.breaker.recordSuccess();
              return {
                decisionId: item.decisionId,
                status: 'completed',
                outcome: recoveredOutcome,
              };
            }
            this.breaker.recordSuccess();
            correctionSeq++;
            item.resume = undefined;
            continue;
          }
          if (recoveredOutcome.action !== 'reject')
            throw new Error('recovered terminal result produced an invalid noop outcome');
          await this.completeEvaluation(item, recoveredOutcome);
          if (this.breaker.recordError())
            await this.latchBreaker(
              'consecutive-errors',
              item,
              currentIntent?.intent.logicalOrderId,
              recoveredOutcome.error.message,
            );
          return { decisionId: item.decisionId, status: 'completed', outcome: recoveredOutcome };
        }
        if (hookError?.submitted || cause instanceof UnknownSubmissionError) {
          if (!this.breaker.snapshot.latched)
            await this.latchBreaker(
              'ledger-failure',
              item,
              currentIntent?.intent.logicalOrderId,
              errorMessage(cause ?? error),
              true,
            );
          return {
            decisionId: item.decisionId,
            status: 'unknown',
            reason: errorMessage(cause ?? error),
          };
        }
        if (cause instanceof SchedulerGateError || error instanceof SchedulerGateError) {
          if (!this.breaker.snapshot.latched)
            await this.latchBreaker(
              currentIntent ? 'recovery-unresolved' : 'ledger-failure',
              item,
              currentIntent?.intent.logicalOrderId,
              errorMessage(cause ?? error),
              true,
            );
          return {
            decisionId: item.decisionId,
            status: 'failed',
            reason: errorMessage(cause ?? error),
          };
        }
        if (hookError && !hookError.submitted) {
          this.breaker.latch('ledger-failure', errorMessage(cause ?? hookError));
          return {
            decisionId: item.decisionId,
            status: 'failed',
            reason: errorMessage(cause ?? hookError),
          };
        }
        if (currentIntent && completionWritten) {
          this.recordUnresetCompletionUncertainty(item);
          await this.latchBreaker(
            'position-unknown',
            item,
            currentIntent.intent.logicalOrderId,
            errorMessage(error),
          );
          return {
            decisionId: item.decisionId,
            status: 'unknown',
            reason: errorMessage(error),
          };
        }
        throw error;
      }

      if (outcome.action === 'noop') {
        if (currentIntent) {
          const terminalResult = currentIntent.results.at(-1);
          if (terminalResult?.outcome === 'filled' || terminalResult?.outcome === 'rejected') {
            const recovered = recoveredTerminalOutcome(
              item,
              currentIntent,
              terminalResult,
              outcome.actualAfter,
            );
            if (!currentIntent.completion) {
              await this.writeCompletion(item, currentIntent, {
                outcome: terminalResult.outcome,
                actualAfter: outcome.actualAfter,
                fill: terminalResult.fill,
                error: !recovered.positionConsistent
                  ? {
                      name: 'RecoveryPositionError',
                      message: 'observed position does not reflect the durable terminal result',
                      code: 'position-unknown',
                      retryable: false,
                    }
                  : terminalResult.error,
              });
            }
            this.unresolved.delete(currentIntent.intent.logicalOrderId);
            if (!recovered.positionConsistent) {
              this.recordUnresetCompletionUncertainty(item);
              await this.latchBreaker(
                'position-unknown',
                item,
                currentIntent.intent.logicalOrderId,
                'observed position does not reflect the durable terminal result',
              );
              return {
                decisionId: item.decisionId,
                status: 'unknown',
                reason: 'observed position does not reflect the durable terminal result',
                outcome: recovered.outcome,
              };
            }
            await this.completeEvaluation(item, recovered.outcome);
            if (recovered.outcome.action === 'reject') {
              if (this.breaker.recordError())
                await this.latchBreaker(
                  'consecutive-errors',
                  item,
                  currentIntent.intent.logicalOrderId,
                  recovered.outcome.error.message,
                );
            } else {
              this.breaker.recordSuccess();
            }
            return {
              decisionId: item.decisionId,
              status: 'completed',
              outcome: recovered.outcome,
            };
          }
          if (!currentIntent.completion) {
            const terminalResult = currentIntent.results.at(-1);
            const completionOutcome =
              terminalResult?.outcome === 'filled' || terminalResult?.outcome === 'rejected'
                ? terminalResult.outcome
                : 'observed';
            await this.writeCompletion(item, currentIntent, {
              outcome: completionOutcome,
              actualAfter: outcome.actualAfter,
              fill: terminalResult?.fill,
            });
          }
          this.unresolved.delete(currentIntent.intent.logicalOrderId);
        }
        const aggregateOutcome = recoveredDecision?.latestCompletedIntent?.completion
          ? recoveredDecisionOutcome(item, recoveredDecision, outcome.actualAfter)
          : outcome;
        await this.completeEvaluation(item, aggregateOutcome);
        if (aggregateOutcome.action === 'reject') {
          if (this.breaker.recordError())
            await this.latchBreaker(
              'consecutive-errors',
              item,
              recoveredDecision?.latestEffectfulIntent?.intent.logicalOrderId,
              aggregateOutcome.error.message,
            );
        } else {
          this.breaker.recordSuccess();
        }
        return {
          decisionId: item.decisionId,
          status: 'completed',
          outcome: aggregateOutcome,
        };
      }
      if (outcome.action === 'reject') {
        const affectedIntent = currentIntent ?? recoveredDecision?.latestCompletedIntent;
        if (outcome.error.stage === 'position' && affectedIntent) {
          this.recordUnresetCompletionUncertainty(item);
          await this.latchBreaker(
            'position-unknown',
            item,
            affectedIntent.intent.logicalOrderId,
            outcome.error.message,
          );
          return {
            decisionId: item.decisionId,
            status: 'unknown',
            reason: outcome.error.message,
            outcome,
          };
        }
        if (currentIntent && !completionWritten && outcome.error.stage === 'submit')
          throw new Error('submit rejection returned without durable order completion');
        if (outcome.error.stage === 'submit' && outcome.actualAfter == null) {
          this.recordUnresetCompletionUncertainty(item);
          await this.latchBreaker(
            'position-unknown',
            item,
            currentIntent?.intent.logicalOrderId,
            outcome.error.message,
          );
          return {
            decisionId: item.decisionId,
            status: 'unknown',
            reason: 'position refresh was unknown after submit rejection',
            outcome,
          };
        }
        await this.completeEvaluation(item, outcome);
        if (this.breaker.recordError())
          await this.latchBreaker(
            'consecutive-errors',
            item,
            currentIntent?.intent.logicalOrderId,
            outcome.error.message,
          );
        return { decisionId: item.decisionId, status: 'completed', outcome };
      }
      if (!completionWritten)
        throw new Error('filled order returned without durable order completion');
      if (outcome.actualAfter == null || outcome.positionError) {
        this.recordUnresetCompletionUncertainty(item);
        await this.latchBreaker(
          'position-unknown',
          item,
          currentIntent?.intent.logicalOrderId,
          outcome.positionError?.message,
        );
        return {
          decisionId: item.decisionId,
          status: 'unknown',
          reason: outcome.positionError?.message ?? 'position refresh was unknown',
          outcome,
        };
      }
      if (outcome.actualAfter === outcome.target) {
        await this.completeEvaluation(item, outcome);
        this.breaker.recordSuccess();
        return { decisionId: item.decisionId, status: 'completed', outcome };
      }
      correctionSeq++;
      item.resume = undefined;
    }
  }

  private recordUnresetCompletionUncertainty(item: PendingEvaluation): void {
    const uncertaintySequence = this.decisions.get(
      item.decisionId,
    )?.latestPositionUncertaintySequence;
    if (
      uncertaintySequence != null &&
      (this.latestBreakerResetSequence == null ||
        this.latestBreakerResetSequence <= uncertaintySequence)
    )
      this.breaker.recordError();
  }

  private async writeCompletion(
    item: PendingEvaluation,
    intent: RecoveredIntent,
    details: OrderCompletionDetails,
  ): Promise<OrderCompletionEventV3> {
    const input = {
      recordType: 'order.completion' as const,
      ...logicalFields(item, intent.intent),
      outcome: details.outcome,
      actualAfter: details.actualAfter,
      ...(details.fill ? { fill: structuredClone(details.fill) } : {}),
      ...(details.error ? { error: details.error } : {}),
    };
    if (completionHasUnknownPosition(input))
      // The completion row itself infers a breaker during replay, so intake must close first.
      this.breaker.latch('position-unknown', details.error?.message);
    const completion = (await this.writer.append(input)) as OrderCompletionEventV3;
    this.rememberCompletion(item.decisionId, intent, completion);
    return completion;
  }

  private async positionRefresh(
    item: PendingEvaluation,
    event: PositionRefreshHookContext,
    intent: RecoveredIntent | undefined,
    fill: Fill | undefined,
    markWritten: () => void,
  ): Promise<void> {
    await this.assertLeaseBeforeEffect(item, true);
    if (event.phase === 'before') return;
    if (!intent) throw new SchedulerGateError('position refresh has no durable intent');
    const outcome = event.reason === 'filled' ? 'filled' : 'rejected';
    await this.writeCompletion(item, intent, {
      outcome,
      actualAfter: event.position?.qty ?? null,
      fill,
      ...(event.error || event.submitError
        ? { error: ledgerError(event.error ?? event.submitError) }
        : {}),
    });
    this.unresolved.delete(intent.intent.logicalOrderId);
    markWritten();
  }

  private rememberCompletion(
    decisionId: string,
    intent: RecoveredIntent,
    completion: OrderCompletionEventV3,
  ): void {
    intent.completion = completion;
    const decision = this.decisions.get(decisionId);
    if (decision) {
      decision.latestCompletedIntent = intent;
      if (completion.outcome !== 'observed') decision.latestEffectfulIntent = intent;
      if (completionHasUnknownPosition(completion))
        decision.latestPositionUncertaintySequence = completion.sequence;
    }
  }

  private async finalizeRecoveredSupersededDecisions(): Promise<void> {
    while (this.recoveredSupersededDecisionIds.length > 0) {
      const decisionId = this.recoveredSupersededDecisionIds[0]!;
      const decision = this.decisions.get(decisionId);
      const accepted = decision?.accepted;
      if (!decision || !accepted)
        throw new Error('recovered superseded decision has no accepted evaluation');
      const event = await this.writer.append({
        recordType: 'evaluation.skipped',
        ...persistedDecisionFields(accepted),
        reason: 'coalesced',
        targetOrdinal: accepted.targetOrdinal,
        detail: 'recovered superseded pending target',
      });
      decision.skipped.push(event as never);
      decision.terminalSkipped = true;
      this.recoveredSupersededDecisionIds.shift();
    }
  }

  private async completeEvaluation(
    item: PendingEvaluation,
    outcome: ReconcileOutcome,
  ): Promise<void> {
    const decision = this.decisions.get(item.decisionId);
    if (this.breaker.snapshot.latched)
      throw new SchedulerGateError('cannot complete evaluation while breaker is latched');
    const uncertaintySequence = decision?.latestPositionUncertaintySequence;
    if (
      uncertaintySequence != null &&
      (this.latestBreakerResetSequence == null ||
        this.latestBreakerResetSequence <= uncertaintySequence)
    )
      throw new SchedulerGateError(
        'cannot complete evaluation before position uncertainty is reset',
      );
    if (
      uncertaintySequence != null &&
      (!Number.isFinite(outcome.actualBefore) ||
        !Number.isFinite(outcome.actualAfter) ||
        !Number.isFinite(outcome.delta))
    )
      throw new SchedulerGateError('cannot complete evaluation without a fresh position');
    const event = await this.writer.append({
      recordType: 'evaluation.completed',
      ...decisionFields(item),
      outcome: outcome.action,
      actualBefore: outcome.actualBefore,
      actualAfter: outcome.actualAfter,
      delta: outcome.delta,
      ...(outcome.action === 'reject'
        ? { error: ledgerError(outcome.error) }
        : outcome.action === 'order' && outcome.positionError
          ? { error: ledgerError(outcome.positionError) }
          : {}),
    });
    if (decision) decision.completed = event as never;
  }

  private async appendSkipped(
    item: PendingEvaluation,
    reason: EvaluationSkipReasonV3,
    detail?: string,
  ): Promise<void> {
    const counter = this.barCounters(item);
    const event = await this.writer.append({
      recordType: 'evaluation.skipped',
      ...decisionFields(item),
      reason,
      targetOrdinal: item.accepted?.targetOrdinal ?? counter.targets + 1,
      ...(detail ? { detail } : {}),
    });
    const decision = this.decisions.get(item.decisionId);
    if (decision) {
      decision.skipped.push(event as never);
      if (
        !decision.logicalOrderIds.some((id) => this.unresolved.has(id)) &&
        decision.latestCompletedIntent == null
      )
        decision.terminalSkipped = true;
    } else {
      counter.targets++;
      this.decisions.set(item.decisionId, {
        skipped: [event as never],
        terminalSkipped: true,
        logicalOrderIds: [],
      });
      this.rememberAdmittedChartUpdate(event as DecisionEventV3);
    }
  }

  private async latchBreaker(
    reason: BreakerReasonV3,
    item?: PendingEvaluation,
    logicalId?: string,
    detail?: string,
    bestEffort = false,
  ): Promise<void> {
    this.breaker.latch(reason, detail);
    try {
      await this.writer.append({
        recordType: 'breaker',
        state: 'latched',
        reason,
        consecutiveErrors: this.breaker.snapshot.consecutiveErrors,
        ...(item ? { decisionId: item.decisionId } : {}),
        ...(logicalId ? { logicalOrderId: logicalId } : {}),
        ...(detail ? { detail } : {}),
      });
    } catch (error) {
      if (!bestEffort) throw error;
    }
  }

  private async assertLeaseBeforeEffect(item: PendingEvaluation, submitted = false): Promise<void> {
    if (!this.options.lease) return;
    try {
      await this.options.lease.assertHeld();
    } catch (error) {
      await this.latchBreaker(
        'lease-lost',
        item,
        item.resume?.intent.logicalOrderId,
        errorMessage(error),
        submitted,
      );
      throw new SchedulerGateError('execution lease was lost');
    }
  }

  private async waitForInterval(): Promise<void> {
    const now = this.clock();
    const due =
      this.lastOperationAt == null ? now : this.lastOperationAt + this.limits.minIntervalMs;
    if (now < due) await this.sleep(due - now);
    this.lastOperationAt = Math.max(this.clock(), due);
  }

  private assertBindingContext(context: ReconcileContext): void {
    const binding = this.options.binding ?? this.options.recovery?.binding?.binding;
    if (!binding) return;
    if (
      context.bindingId !== binding.id ||
      context.strategySymbol !== binding.strategySymbol ||
      context.executionSymbol !== binding.executionSymbol
    )
      throw new RangeError('scheduled context does not match the durable instrument binding');
  }

  private assertCanAdmitChartUpdate(item: PendingEvaluation): void {
    const priorDecisionId = this.eventIdToDecisionId.get(item.update.eventId);
    if (priorDecisionId)
      throw new RangeError(`chart update eventId was already used by ${priorDecisionId}`);
    const key = chartStreamKey(item.context.bindingId, item.context.timeframe);
    const interrupted = this.activeChartUpdates.get(key);
    if (item.update.kind === 'close-only') {
      if (interrupted)
        throw new RangeError('close-only update cannot bypass an active intrabar bar');
      return;
    }
    if (interrupted) {
      if (item.context.barTime !== interrupted.barTime)
        throw new RangeError('chart bar changed before an authoritative final update');
      if (item.update.revision <= interrupted.revision)
        throw new RangeError('chart update revision did not strictly increase');
      if (
        item.update.discontinuity !== interrupted.discontinuity &&
        !(
          this.restartInterruptedChartStreams.has(key) &&
          interrupted.discontinuity === false &&
          item.update.discontinuity === true
        )
      )
        throw new RangeError('chart discontinuity provenance changed within an active bar');
      return;
    }
    const prior = this.latestChartUpdates.get(key);
    if (prior && item.context.barTime <= prior.barTime)
      throw new RangeError(
        'chart update followed an authoritative final for the same or newer bar',
      );
  }

  private rememberAdmittedChartUpdate(event: DecisionEventV3): void {
    const update: RecoveredChartUpdate = {
      decisionId: event.decisionId,
      bindingId: event.bindingId,
      timeframe: event.timeframe,
      barTime: event.barTime,
      cursor: structuredClone(event.cursor),
      ...structuredClone(event.update),
    };
    const key = chartStreamKey(event.bindingId, event.timeframe);
    this.latestChartUpdates.set(key, update);
    this.eventIdToDecisionId.set(event.update.eventId, event.decisionId);
    if (event.update.kind === 'intrabar' && !event.update.authoritativeFinal) {
      this.activeChartUpdates.set(key, update);
    } else {
      this.activeChartUpdates.delete(key);
      this.restartInterruptedChartStreams.delete(key);
    }
  }

  private barCounters(item: Pick<PendingEvaluation, 'context'>): RecoveredBarCounters {
    const key = ledgerBarKey(item.context.bindingId, item.context.barTime);
    const value = this.perBar.get(key) ?? { targets: 0, intents: 0 };
    this.perBar.set(key, value);
    return value;
  }

  private clock(): number {
    const value = this.now();
    if (!Number.isFinite(value)) throw new Error('scheduler clock is not finite');
    return value;
  }

  private restore(recovery: LedgerRecoveryState): void {
    for (const [key, value] of recovery.perBar) this.perBar.set(key, { ...value });
    for (const [key, value] of recovery.decisions) {
      const latestCompletedIntent = value.latestCompletedIntent
        ? cloneRecoveredIntent(value.latestCompletedIntent)
        : undefined;
      const latestEffectfulIntent =
        value.latestEffectfulIntent === value.latestCompletedIntent
          ? latestCompletedIntent
          : value.latestEffectfulIntent
            ? cloneRecoveredIntent(value.latestEffectfulIntent)
            : undefined;
      this.decisions.set(key, {
        accepted: value.accepted,
        skipped: [...value.skipped],
        terminalSkipped: value.terminalSkipped,
        completed: value.completed,
        logicalOrderIds: [...value.logicalOrderIds],
        latestCompletedIntent,
        latestEffectfulIntent,
        latestPositionUncertaintySequence: value.latestPositionUncertaintySequence,
      });
    }
    for (const [key, value] of recovery.unresolvedIntents)
      this.unresolved.set(key, cloneRecoveredIntent(value));
    for (const [key, value] of recovery.clientIdToLogicalOrderId)
      this.clientMappings.set(key, value);
    for (const [key, value] of recovery.latestChartUpdates)
      this.latestChartUpdates.set(key, structuredClone(value));
    for (const [key, value] of recovery.activeBars) {
      this.activeChartUpdates.set(key, structuredClone(value));
      this.restartInterruptedChartStreams.add(key);
    }
    for (const [decisionId, decision] of recovery.decisions) {
      const identity = decision.accepted ?? decision.skipped[0];
      if (identity) this.eventIdToDecisionId.set(identity.update.eventId, decisionId);
    }
    this.attemptTimes = [...recovery.rollingMinuteAttemptTimes];
    this.latestBreakerResetSequence = recovery.latestBreakerResetSequence;
    this.recoveredSupersededDecisionIds = [...(recovery.supersededDecisionIds ?? [])];
    const hasOpenAcceptedEvaluations =
      recovery.hasOpenAcceptedEvaluations ??
      [...recovery.decisions.values()].some(
        (decision) => decision.accepted != null && !decision.completed && !decision.terminalSkipped,
      );
    const completedEvaluationTimes = [...recovery.decisions.values()]
      .map((decision) => decision.completed && Date.parse(decision.completed.recordedAt))
      .filter((value): value is number => value != null);
    const derivedCompletedEvaluationAt =
      completedEvaluationTimes.length > 0 ? Math.max(...completedEvaluationTimes) : undefined;
    this.lastOperationAt = hasOpenAcceptedEvaluations
      ? this.clock()
      : (recovery.lastCompletedEvaluationAt ?? derivedCompletedEvaluationAt);
    this.bindingRecorded = recovery.binding != null;
  }
}

export class SerializedTargetScheduler extends TargetScheduler {}

function decisionFields(item: PendingEvaluation) {
  return {
    decisionId: item.decisionId,
    strategyId: item.context.strategyId,
    strategySymbol: item.context.strategySymbol,
    executionSymbol: item.context.executionSymbol,
    bindingId: item.context.bindingId,
    timeframe: item.context.timeframe,
    barTime: item.context.barTime,
    cursor: item.cursor,
    update: structuredClone(item.update),
    target: item.target,
    ...(item.context.referencePrice == null ? {} : { referencePrice: item.context.referencePrice }),
  };
}

function persistedDecisionFields(event: DecisionEventV3) {
  return {
    decisionId: event.decisionId,
    strategyId: event.strategyId,
    strategySymbol: event.strategySymbol,
    executionSymbol: event.executionSymbol,
    bindingId: event.bindingId,
    timeframe: event.timeframe,
    barTime: event.barTime,
    cursor: event.cursor,
    update: structuredClone(event.update),
    target: event.target,
    ...(event.referencePrice == null ? {} : { referencePrice: event.referencePrice }),
  };
}

function logicalFields(item: PendingEvaluation, intent: OrderIntentEventV3) {
  return {
    ...decisionFields(item),
    logicalOrderId: intent.logicalOrderId,
    correctionSeq: intent.correctionSeq,
    clientId: intent.clientId,
    order: cloneOrder(intent.order),
  };
}

function persistedLogicalFields(intent: OrderIntentEventV3) {
  return {
    ...persistedDecisionFields(intent),
    logicalOrderId: intent.logicalOrderId,
    correctionSeq: intent.correctionSeq,
    clientId: intent.clientId,
    order: cloneOrder(intent.order),
  };
}

function assertScheduledDecisionMatches(item: PendingEvaluation, event: DecisionEventV3): void {
  if (
    item.target !== event.target ||
    item.context.strategyId !== event.strategyId ||
    item.context.strategySymbol !== event.strategySymbol ||
    item.context.executionSymbol !== event.executionSymbol ||
    item.context.bindingId !== event.bindingId ||
    item.context.timeframe !== event.timeframe ||
    item.context.barTime !== event.barTime ||
    item.context.referencePrice !== event.referencePrice ||
    canonical(item.cursor) !== canonical(event.cursor) ||
    canonical(item.update) !== canonical(event.update)
  )
    throw new RangeError('duplicate decisionId has different evaluation identity');
}

function completionHasUnknownPosition(
  completion: Pick<OrderCompletionDetails, 'outcome' | 'actualAfter' | 'error'>,
): boolean {
  if (completion.error?.code === 'position-unknown') return true;
  if (completion.outcome === 'filled')
    return completion.actualAfter == null || completion.error != null;
  if (completion.outcome === 'rejected') return completion.actualAfter == null;
  return completion.actualAfter == null || completion.error != null;
}

function recoveredDecisionOutcome(
  item: PendingEvaluation,
  decision: RecoveredDecision,
  observedActualAfter?: number,
): ReconcileOutcome {
  const latestIntent = decision.latestCompletedIntent;
  const latestCompletion = latestIntent?.completion;
  if (!latestIntent || !latestCompletion)
    throw new Error('recovered decision has no completed correction');
  const effectfulIntent =
    decision.latestEffectfulIntent ??
    (latestCompletion.outcome === 'observed' ? undefined : latestIntent);
  const latestActualAfter =
    observedActualAfter ??
    (completionHasUnknownPosition(latestCompletion)
      ? undefined
      : (latestCompletion.actualAfter ?? undefined));
  return recoveredCompletionOutcome(item, effectfulIntent ?? latestIntent, latestActualAfter);
}

function recoveredCompletionOutcome(
  item: PendingEvaluation,
  intent: RecoveredIntent,
  observedActualAfter?: number,
): ReconcileOutcome {
  const completion = intent.completion;
  if (!completion) throw new Error('recovered completed intent is missing its completion');
  if (completionHasUnknownPosition(completion) && observedActualAfter == null)
    throw new Error('position-unknown completion requires a fresh observation');
  const actualAfter = observedActualAfter ?? completion.actualAfter;
  if (completion.outcome === 'filled') {
    const fill = completion.fill ?? intent.results.at(-1)?.fill;
    if (!fill || actualAfter == null) throw new Error('durable filled completion is incomplete');
    return {
      action: 'order',
      target: item.target,
      actualBefore: intent.intent.actualBefore,
      actualAfter,
      delta: intent.intent.delta,
      order: cloneOrder(intent.intent.order),
      fill: structuredClone(fill),
    };
  }
  if (completion.outcome === 'rejected') {
    if (actualAfter == null)
      throw new Error('durable rejected completion has no position observation');
    const error = completion.error ??
      intent.results.at(-1)?.error ?? {
        name: 'Error',
        message: 'broker rejected the order',
      };
    return {
      action: 'reject',
      target: item.target,
      actualBefore: intent.intent.actualBefore,
      actualAfter,
      delta: intent.intent.delta,
      order: cloneOrder(intent.intent.order),
      error: {
        code: brokerErrorCode(error.code),
        message: error.message,
        retryable: error.retryable ?? false,
        stage: 'submit',
      },
    };
  }
  if (actualAfter == null)
    throw new Error('durable observed completion has no position observation');
  return {
    action: 'noop',
    target: item.target,
    actualBefore: actualAfter,
    actualAfter,
    delta: 0,
  };
}

function cloneRecoveredIntent(value: RecoveredIntent): RecoveredIntent {
  return {
    intent: value.intent,
    attempts: [...value.attempts],
    results: [...value.results],
    unknown: value.unknown,
    resolutions: [...value.resolutions],
    completion: value.completion,
  };
}

function terminalOrderEvidence(
  intent: RecoveredIntent,
): RecoveredIntent['results'][number] | RecoveredIntent['resolutions'][number] | undefined {
  const result = intent.results.at(-1);
  if (result?.outcome === 'filled' || result?.outcome === 'rejected') return result;
  return intent.resolutions
    .filter((resolution) => resolution.outcome === 'filled' || resolution.outcome === 'rejected')
    .at(-1);
}

function submissionOutcomeUnresolved(intent: RecoveredIntent): boolean {
  if (terminalOrderEvidence(intent)) return false;
  if (intent.unknown) return true;
  const attempt = intent.attempts.at(-1);
  if (!attempt) return false;
  const result = intent.results.find((candidate) => candidate.attempt === attempt.attempt);
  return !(
    result?.outcome === 'error' && result.error?.submitFailureCertainty === 'definitely-not-sent'
  );
}

function recoveredTerminalOutcome(
  item: PendingEvaluation,
  intent: RecoveredIntent,
  result: RecoveredIntent['results'][number] | RecoveredIntent['resolutions'][number],
  observedPosition: number,
): { outcome: ReconcileOutcome; positionConsistent: boolean } {
  if (result.outcome === 'filled') {
    if (!result.fill) throw new Error('durable filled result is missing its fill');
    const direction = intent.intent.order.side === 'buy' ? 1 : -1;
    const expectedPosition = intent.intent.actualBefore + direction * result.fill.filledQty;
    return {
      outcome: {
        action: 'order',
        target: item.target,
        actualBefore: intent.intent.actualBefore,
        actualAfter: observedPosition,
        delta: intent.intent.delta,
        order: cloneOrder(intent.intent.order),
        fill: structuredClone(result.fill),
      },
      positionConsistent: nearlyEqual(observedPosition, expectedPosition),
    };
  }
  if (result.outcome !== 'rejected')
    throw new Error('recovered terminal outcome requires a filled or rejected result');
  const error = result.error ?? { name: 'Error', message: 'broker rejected the order' };
  return {
    outcome: {
      action: 'reject',
      target: item.target,
      actualBefore: intent.intent.actualBefore,
      actualAfter: observedPosition,
      delta: intent.intent.delta,
      order: cloneOrder(intent.intent.order),
      error: {
        code: brokerErrorCode(error.code),
        message: error.message,
        retryable: error.retryable ?? false,
        stage: 'submit',
      },
    },
    positionConsistent: nearlyEqual(observedPosition, intent.intent.actualBefore),
  };
}

function normalizeExactOrderLookupResult(
  order: OrderRequest,
  lookup: ExactOrderLookupResult,
): ExactOrderLookupResult {
  if (lookup == null || typeof lookup !== 'object')
    return { status: 'ambiguous', detail: 'exact broker lookup returned an invalid response' };
  const candidate = lookup as unknown as Record<string, unknown>;
  switch (candidate.status) {
    case 'filled':
      try {
        assertLookupFill(order, candidate.fill as Fill);
        return { status: 'filled', fill: structuredClone(candidate.fill as Fill) };
      } catch {
        return {
          status: 'ambiguous',
          detail: 'exact broker lookup returned a malformed or mismatched fill',
        };
      }
    case 'rejected':
      return typeof candidate.message === 'string' && candidate.message.trim().length > 0
        ? { status: 'rejected', message: candidate.message }
        : {
            status: 'ambiguous',
            detail: 'exact broker lookup returned a rejection without a message',
          };
    case 'not-found':
      return { status: 'not-found' };
    case 'ambiguous':
    case 'unsupported':
      return typeof candidate.detail === 'string' && candidate.detail.length > 0
        ? { status: candidate.status, detail: candidate.detail }
        : { status: candidate.status };
    default:
      return { status: 'ambiguous', detail: 'exact broker lookup returned an unknown status' };
  }
}

function assertLookupFill(order: OrderRequest, fill: Fill): void {
  if (
    fill.clientId !== order.clientId ||
    fill.symbol !== order.symbol ||
    fill.side !== order.side ||
    fill.requestedQty !== order.qty ||
    (fill.status !== 'filled' && fill.status !== 'partially-filled') ||
    !Number.isFinite(fill.filledQty) ||
    fill.filledQty <= 0 ||
    fill.filledQty > order.qty ||
    !Number.isFinite(fill.price) ||
    !Number.isFinite(fill.commission) ||
    !Number.isFinite(fill.time)
  )
    throw new Error('exact broker lookup returned a malformed or mismatched fill');
}

function brokerErrorCode(value: string | undefined): BrokerErrorCode {
  return [
    'reject',
    'connectivity',
    'timeout',
    'rate-limit',
    'auth',
    'unknown-symbol',
    'precondition',
  ].includes(value ?? '')
    ? (value as BrokerErrorCode)
    : 'precondition';
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(right) * 1e-12);
}

function ledgerError(error: unknown): LedgerError {
  if (error instanceof BrokerError)
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      retryable: error.retryable,
      ...(error.submitFailureCertainty
        ? { submitFailureCertainty: error.submitFailureCertainty }
        : {}),
    };
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: String(error) };
}

function cloneOrder(order: OrderRequest): OrderRequest {
  return { ...order };
}

function normalizeLimits(limits: SchedulerLimits = {}): NormalizedLimits {
  const value = {
    minIntervalMs: limits.minIntervalMs ?? 0,
    maxTargetsPerBar: limits.maxTargetsPerBar ?? Number.MAX_SAFE_INTEGER,
    maxIntentsPerBar: limits.maxIntentsPerBar ?? Number.MAX_SAFE_INTEGER,
    maxAttemptsPerMinute: limits.maxAttemptsPerMinute ?? Number.MAX_SAFE_INTEGER,
    maxConsecutiveErrors: limits.maxConsecutiveErrors ?? Number.MAX_SAFE_INTEGER,
  };
  if (!Number.isFinite(value.minIntervalMs) || value.minIntervalMs < 0)
    throw new RangeError('minIntervalMs must be a non-negative finite number');
  positiveLimit(value.maxTargetsPerBar, 'maxTargetsPerBar');
  positiveLimit(value.maxIntentsPerBar, 'maxIntentsPerBar');
  positiveLimit(value.maxAttemptsPerMinute, 'maxAttemptsPerMinute');
  positiveLimit(value.maxConsecutiveErrors, 'maxConsecutiveErrors');
  return value;
}

function positiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive safe integer`);
}

function requiredContext(value: ReconcileContext | undefined): ReconcileContext {
  if (!value) throw new TypeError('schedule(target, context) requires a context');
  return value;
}

function normalizeChartUpdateIdentity(
  update: Readonly<ChartUpdateIdentityV3>,
): ChartUpdateIdentityV3 {
  if (update.kind !== 'intrabar' && update.kind !== 'close-only')
    throw new RangeError('chart update kind must be intrabar or close-only');
  if (typeof update.eventId !== 'string' || update.eventId.length === 0)
    throw new RangeError('chart update eventId must not be empty');
  if (!Number.isSafeInteger(update.revision) || update.revision <= 0)
    throw new RangeError('chart update revision must be a positive safe integer');
  if (typeof update.authoritativeFinal !== 'boolean')
    throw new RangeError('chart update authoritativeFinal must be boolean');
  if (typeof update.recovered !== 'boolean' || typeof update.discontinuity !== 'boolean')
    throw new RangeError('chart update provenance flags must be boolean');
  if (update.recovered && !update.authoritativeFinal)
    throw new RangeError('a recovered chart update must be authoritative final');
  if (
    update.kind === 'close-only' &&
    (update.revision !== 1 ||
      !update.authoritativeFinal ||
      update.recovered ||
      update.discontinuity)
  )
    throw new RangeError('close-only chart identity must be revision 1 authoritative final');
  return structuredClone(update);
}

function legacyCloseOnlyUpdate(
  evaluation: TargetEvaluation,
  cursor: LedgerCursor,
): ChartUpdateIdentityV3 {
  const stableSource = canonical({
    decisionId: evaluation.decisionId,
    strategyId: evaluation.context.strategyId,
    strategySymbol: evaluation.context.strategySymbol,
    executionSymbol: evaluation.context.executionSymbol,
    bindingId: evaluation.context.bindingId,
    timeframe: evaluation.context.timeframe,
    barTime: evaluation.context.barTime,
    cursor,
  });
  return {
    kind: 'close-only',
    eventId: `close-only:${evaluation.decisionId ?? stableHash(stableSource)}`,
    revision: 1,
    authoritativeFinal: true,
    recovered: false,
    discontinuity: false,
  };
}

function stableDecisionId(
  evaluation: Required<Pick<TargetEvaluation, 'target' | 'context' | 'update'>> & {
    cursor: LedgerCursor;
  },
): string {
  const source = canonical({
    strategyId: evaluation.context.strategyId,
    bindingId: evaluation.context.bindingId,
    timeframe: evaluation.context.timeframe,
    barTime: evaluation.context.barTime,
    cursor: evaluation.cursor,
    update: evaluation.update,
  });
  return stableHash(source);
}

function stableHash(source: string): string {
  let hash = 2166136261;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function canonical(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
    .join(',')}}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
