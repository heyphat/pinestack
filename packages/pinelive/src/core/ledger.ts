import type { ReconcileError } from './mirror.js';
import type { SecurityFeedHealth } from './security.js';
import type { Bar, Fill, OrderRequest } from './types.js';
import type { RunInstrumentBinding } from './binding.js';
import type { PreparedIntrabarAuthorityEnvelope } from './intrabar-authority.js';

export type ReconcileAction = 'noop' | 'order' | 'reject';

export interface BindingRecord {
  schemaVersion: 2;
  recordType: 'binding';
  configVersion: 1;
  runId: string;
  binding: RunInstrumentBinding;
  recordedAt: string;
}

/** Current cycle schema. schemaVersion 1 remains readable through optional identity fields. */
export interface ForwardRecord {
  schemaVersion: 1 | 2;
  recordType?: 'cycle';
  runId: string;
  strategyId: string;
  cycleId: string;
  sequence: number;
  /** v1 compatibility alias for strategySymbol. */
  symbol: string;
  strategySymbol?: string;
  executionSymbol?: string;
  bindingId?: string;
  timeframe: string;
  bar: Bar;
  target: number;
  actualBefore: number | null;
  actualAfter: number | null;
  delta: number | null;
  action: ReconcileAction;
  clientId?: string;
  /** Full requested economics for execution audit, including limitPrice when applicable. */
  order?: OrderRequest;
  fill?: Fill;
  error?: ReconcileError;
  /** Health of every injected request.security feed at this decision point. */
  securityFeeds?: SecurityFeedHealth[];
  recordedAt: string;
}

/** Durable feed-health event emitted before a stale feed can stop reconciliation. */
export interface SecurityFeedHealthRecord {
  schemaVersion: 2;
  recordType: 'security';
  runId: string;
  strategyId: string;
  key: string;
  error: string;
  feeds: SecurityFeedHealth[];
  recordedAt: string;
}

export interface StartupRecord extends Omit<ForwardRecord, 'recordType' | 'schemaVersion'> {
  schemaVersion: 2;
  recordType: 'startup';
}

/**
 * An opaque, JSON-safe provider cursor. Pinelive never interprets it; equality is exact during
 * recovery so a final decision cannot be accidentally advanced to a different source update.
 */
export type LedgerCursor =
  string | number | Readonly<Record<string, string | number | boolean | null>>;

export type LedgerError = Readonly<{
  name: string;
  message: string;
  code?: string;
  retryable?: boolean;
  submitFailureCertainty?: 'definitely-not-sent' | 'possibly-sent';
}>;

/** Durable identity of the chart update that produced one target decision. */
export interface ChartUpdateIdentityV3 {
  /** Explicit compatibility mode for callers that only ever schedule authoritative closes. */
  kind: 'intrabar' | 'close-only';
  /** Stable upstream event identity, independent of the derived target value. */
  eventId: string;
  /** Strictly increasing revision within one chart bar. */
  revision: number;
  /** True only for an authoritative chart-bar close. */
  authoritativeFinal: boolean;
  /** The provider synthesized this authoritative final during recovery. */
  recovered: boolean;
  /** Execution is inhibited through this chart bar because continuity was not proven. */
  discontinuity: boolean;
}

export interface LedgerEventBaseV3 {
  schemaVersion: 3;
  sequence: number;
  recordType: LedgerEventTypeV3;
  runId: string;
  /** Stable deployment/account namespace, not a process-local run id. */
  executionId: string;
  recordedAt: string;
}

export interface AuthorityEventV3 extends LedgerEventBaseV3 {
  recordType: 'authority';
  authority: PreparedIntrabarAuthorityEnvelope;
}

export interface BindingEventV3 extends LedgerEventBaseV3 {
  recordType: 'binding';
  binding: RunInstrumentBinding;
}

export interface DecisionEventV3 extends LedgerEventBaseV3 {
  decisionId: string;
  strategyId: string;
  strategySymbol: string;
  executionSymbol: string;
  bindingId: string;
  timeframe: string;
  barTime: number;
  cursor: LedgerCursor;
  /** Revision/finality/provenance identity repeated on every decision and order row. */
  update: ChartUpdateIdentityV3;
  target: number;
  /** Exact closed-bar reference used to derive limit economics, when applicable. */
  referencePrice?: number;
}

export interface EvaluationAcceptedEventV3 extends DecisionEventV3 {
  recordType: 'evaluation.accepted';
  /** One-based count of accepted targets for this binding/bar. */
  targetOrdinal: number;
}

export type EvaluationSkipReasonV3 =
  | 'breaker-open'
  | 'coalesced'
  | 'duplicate'
  | 'lease-unavailable'
  | 'target-limit'
  | 'shutdown'
  | 'invalid'
  | 'compute-only'
  | 'forming'
  | 'recovered-final'
  | 'startup-discontinuity'
  | 'mirror-cadence';

export interface EvaluationSkippedEventV3 extends DecisionEventV3 {
  recordType: 'evaluation.skipped';
  reason: EvaluationSkipReasonV3;
  detail?: string;
  /** Accepted decisions can later be coalesced; otherwise this is the attempted ordinal. */
  targetOrdinal: number;
}

export interface EvaluationCompletedEventV3 extends DecisionEventV3 {
  recordType: 'evaluation.completed';
  outcome: ReconcileAction;
  actualBefore: number | null;
  actualAfter: number | null;
  delta: number | null;
  error?: LedgerError;
}

export interface LogicalOrderEventV3 extends DecisionEventV3 {
  logicalOrderId: string;
  correctionSeq: number;
  clientId: string;
  /** Repeated on every event so each durable row carries exact effect economics. */
  order: OrderRequest;
}

export interface OrderIntentEventV3 extends LogicalOrderEventV3 {
  recordType: 'order.intent';
  actualBefore: number;
  delta: number;
  /** One-based count of durable intents for this binding/bar. */
  intentOrdinal: number;
}

export interface OrderAttemptEventV3 extends LogicalOrderEventV3 {
  recordType: 'order.attempt';
  attempt: number;
  /** Count including this attempt in the event-time rolling 60-second window. */
  attemptsInRollingMinute: number;
}

export interface OrderResultEventV3 extends LogicalOrderEventV3 {
  recordType: 'order.result';
  attempt: number;
  outcome: 'filled' | 'rejected' | 'error';
  fill?: Fill;
  error?: LedgerError;
}

export interface OrderUnknownEventV3 extends LogicalOrderEventV3 {
  recordType: 'order.unknown';
  attempt: number;
  error: LedgerError;
}

/** Read-only exact broker lookup after a possibly-sent attempt; never a second submission. */
export interface OrderResolutionEventV3 extends LogicalOrderEventV3 {
  recordType: 'order.resolution';
  outcome: 'filled' | 'rejected' | 'not-found' | 'ambiguous' | 'unsupported';
  fill?: Fill;
  error?: LedgerError;
  detail?: string;
}

export interface OrderCompletionEventV3 extends LogicalOrderEventV3 {
  recordType: 'order.completion';
  outcome: 'filled' | 'rejected' | 'observed';
  actualAfter: number | null;
  fill?: Fill;
  error?: LedgerError;
}

export type BreakerReasonV3 =
  | 'attempt-limit'
  | 'consecutive-errors'
  | 'intent-limit'
  | 'ledger-failure'
  | 'lease-lost'
  | 'position-unknown'
  | 'submission-unknown'
  | 'recovery-unresolved'
  /** An authoritative final was refused by the per-bar target limit; execution must stop loudly. */
  | 'target-limit'
  | 'operator';

export interface BreakerEventV3 extends LedgerEventBaseV3 {
  recordType: 'breaker';
  state: 'latched' | 'reset';
  reason: BreakerReasonV3;
  consecutiveErrors: number;
  decisionId?: string;
  logicalOrderId?: string;
  detail?: string;
}

export interface RecoveryEventV3 extends LedgerEventBaseV3 {
  recordType: 'recovery';
  action: 'loaded' | 'partial-tail-discarded' | 'resumed';
  sourceLastSequence: number;
  lastFinalCursor?: LedgerCursor;
  unresolvedLogicalOrderIds: string[];
  detail?: string;
}

export interface LeaseEventV3 extends LedgerEventBaseV3 {
  recordType: 'lease';
  action: 'acquired' | 'released' | 'contended' | 'lost';
  resource: string;
  leaseId: string;
  ownerId: string;
  detail?: string;
}

export type LedgerEventV3 =
  | AuthorityEventV3
  | BindingEventV3
  | EvaluationAcceptedEventV3
  | EvaluationSkippedEventV3
  | EvaluationCompletedEventV3
  | OrderIntentEventV3
  | OrderAttemptEventV3
  | OrderResultEventV3
  | OrderUnknownEventV3
  | OrderResolutionEventV3
  | OrderCompletionEventV3
  | BreakerEventV3
  | RecoveryEventV3
  | LeaseEventV3;

export type SchemaV3Event = LedgerEventV3;
export type LedgerEventTypeV3 = LedgerEventV3['recordType'];

export type LedgerRecord =
  BindingRecord | ForwardRecord | StartupRecord | SecurityFeedHealthRecord | LedgerEventV3;

export interface LedgerSink {
  append(record: LedgerRecord): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

type ManagedEventFields = 'schemaVersion' | 'sequence' | 'runId' | 'executionId' | 'recordedAt';

export type LedgerEventV3Input = LedgerEventV3 extends infer Event
  ? Event extends LedgerEventV3
    ? Omit<Event, ManagedEventFields>
    : never
  : never;

export interface SequencedLedgerOptions {
  runId: string;
  executionId: string;
  /** First unused sequence, normally recovery.nextSequence. Defaults to 1. */
  nextSequence?: number;
  /** Timestamp of the final recovered event, used to reject clock rollback after restart. */
  lastTimestamp?: number;
  now?: () => number;
}

/**
 * Assigns one strict sequence and serializes durable appends. A failed append permanently poisons
 * the writer: reusing a possibly-written sequence would make recovery ambiguous.
 */
export class SequencedLedger {
  private nextValue: number;
  private lastTimestamp: number;
  private tail: Promise<void> = Promise.resolve();
  private failureValue: unknown;
  private readonly now: () => number;

  constructor(
    private readonly sink: LedgerSink,
    private readonly options: SequencedLedgerOptions,
  ) {
    if (!options.runId) throw new RangeError('sequenced ledger runId must not be empty');
    if (!options.executionId)
      throw new RangeError('sequenced ledger executionId must not be empty');
    this.nextValue = options.nextSequence ?? 1;
    if (!Number.isSafeInteger(this.nextValue) || this.nextValue < 1)
      throw new RangeError('sequenced ledger nextSequence must be a positive safe integer');
    this.lastTimestamp = options.lastTimestamp ?? -Infinity;
    if (options.lastTimestamp != null && !Number.isFinite(options.lastTimestamp))
      throw new RangeError('sequenced ledger lastTimestamp must be finite');
    this.now = options.now ?? Date.now;
  }

  get nextSequence(): number {
    return this.nextValue;
  }

  get runId(): string {
    return this.options.runId;
  }

  get executionId(): string {
    return this.options.executionId;
  }

  get failure(): unknown {
    return this.failureValue;
  }

  append(input: LedgerEventV3Input): Promise<LedgerEventV3> {
    let timestamp: number;
    try {
      timestamp = this.now();
    } catch (error) {
      this.failureValue = error;
      return Promise.reject(error);
    }
    return this.appendAt(input, timestamp);
  }

  /** Append with an explicit event time, used when a counter window must share that exact time. */
  appendAt(input: LedgerEventV3Input, timestamp: number): Promise<LedgerEventV3> {
    if (this.failureValue !== undefined) return Promise.reject(this.failureValue);
    if (this.nextValue >= Number.MAX_SAFE_INTEGER) {
      const error = new RangeError('ledger sequence is exhausted');
      this.failureValue = error;
      return Promise.reject(error);
    }
    if (!Number.isFinite(timestamp)) {
      const error = new Error('ledger clock is not finite');
      this.failureValue = error;
      return Promise.reject(error);
    }
    if (timestamp < this.lastTimestamp) {
      const error = new Error('ledger clock moved backwards');
      this.failureValue = error;
      return Promise.reject(error);
    }
    const sequence = this.nextValue++;
    this.lastTimestamp = timestamp;
    const event = {
      ...input,
      schemaVersion: 3,
      sequence,
      runId: this.options.runId,
      executionId: this.options.executionId,
      recordedAt: new Date(timestamp).toISOString(),
    } as LedgerEventV3;
    const operation = this.tail.then(async () => {
      if (this.failureValue !== undefined) throw this.failureValue;
      try {
        await this.sink.append(event);
        return event;
      } catch (error) {
        this.failureValue = error;
        throw error;
      }
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.failureValue !== undefined) throw this.failureValue;
    await this.sink.flush?.();
  }
}

export class MemoryLedger implements LedgerSink {
  readonly records: ForwardRecord[] = [];
  readonly bindings: BindingRecord[] = [];
  readonly startups: StartupRecord[] = [];
  readonly security: SecurityFeedHealthRecord[] = [];
  readonly events: LedgerEventV3[] = [];

  async append(record: LedgerRecord): Promise<void> {
    const cloned = structuredClone(record);
    if (cloned.schemaVersion === 3) this.events.push(cloned);
    else if (cloned.recordType === 'binding') this.bindings.push(cloned);
    else if (cloned.recordType === 'startup') this.startups.push(cloned);
    else if (cloned.recordType === 'security') this.security.push(cloned);
    else this.records.push(cloned);
  }
}
