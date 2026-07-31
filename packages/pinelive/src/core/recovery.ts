import type {
  AuthorityEventV3,
  BindingEventV3,
  BreakerEventV3,
  ChartUpdateIdentityV3,
  DecisionEventV3,
  EvaluationAcceptedEventV3,
  EvaluationCompletedEventV3,
  EvaluationSkippedEventV3,
  LedgerCursor,
  LedgerError,
  LedgerEventV3,
  LeaseEventV3,
  OrderAttemptEventV3,
  OrderCompletionEventV3,
  OrderIntentEventV3,
  OrderResolutionEventV3,
  OrderResultEventV3,
  OrderUnknownEventV3,
  RecoveryEventV3,
} from './ledger.js';
import type { Fill, OrderRequest } from './types.js';

export class LedgerRecoveryError extends Error {
  constructor(
    message: string,
    readonly eventIndex?: number,
    options?: ErrorOptions,
  ) {
    super(eventIndex == null ? message : `ledger event ${eventIndex + 1}: ${message}`, options);
    this.name = 'LedgerRecoveryError';
  }
}

export interface RecoveredBarCounters {
  targets: number;
  intents: number;
}

export interface RecoveredIntent {
  intent: OrderIntentEventV3;
  attempts: OrderAttemptEventV3[];
  results: OrderResultEventV3[];
  unknown?: OrderUnknownEventV3;
  /** Read-only lookup observations; a terminal one permanently forbids retransmission. */
  resolutions: OrderResolutionEventV3[];
  /** Durable terminal observation retained even after the intent leaves the unresolved set. */
  completion?: OrderCompletionEventV3;
}

export interface RecoveredChartUpdate extends ChartUpdateIdentityV3 {
  decisionId: string;
  bindingId: string;
  timeframe: string;
  barTime: number;
  cursor: LedgerCursor;
}

export interface RecoveredActiveBar extends RecoveredChartUpdate {
  kind: 'intrabar';
  /** Any active bar in a recovered prefix crossed a process boundary and must be inhibited. */
  interrupted: true;
  inhibitExecution: true;
}

export interface RecoveredDecision {
  accepted?: EvaluationAcceptedEventV3;
  skipped: EvaluationSkippedEventV3[];
  /** True when a skip finalized the accepted/new evaluation rather than a duplicate retry call. */
  terminalSkipped: boolean;
  completed?: EvaluationCompletedEventV3;
  logicalOrderIds: string[];
  /** Most recent completed correction, retained until evaluation.completed makes it final. */
  latestCompletedIntent?: RecoveredIntent;
  /** Most recent filled/rejected correction, retained across later observed corrections. */
  latestEffectfulIntent?: RecoveredIntent;
  /** Newest completion whose position remained unknown and still requires a later reset. */
  latestPositionUncertaintySequence?: number;
}

export interface RecoveredBreaker {
  latched: boolean;
  reason?: BreakerEventV3['reason'];
  event?: BreakerEventV3;
}

export interface LedgerRecoveryState {
  events: LedgerEventV3[];
  runId?: string;
  executionId?: string;
  /** Dedicated prepared authority, persisted before mirrored lease/broker ownership. */
  authority?: AuthorityEventV3;
  binding?: BindingEventV3;
  lastSequence: number;
  nextSequence: number;
  lastFinalCursor?: LedgerCursor;
  lastFinalDecisionId?: string;
  lastFinalUpdate?: RecoveredChartUpdate;
  /** Latest admitted source update per binding/timeframe, including terminal closes. */
  latestChartUpdates: ReadonlyMap<string, RecoveredChartUpdate>;
  /** Forming intrabar state that survived the prefix and must inhibit execution through its bar. */
  activeBars: ReadonlyMap<string, RecoveredActiveBar>;
  /** Accepted decisions interrupted before a terminal skip/completion, with full provenance. */
  interruptedUpdates: readonly RecoveredChartUpdate[];
  perBar: ReadonlyMap<string, RecoveredBarCounters>;
  rollingMinuteAttemptTimes: readonly number[];
  attemptsInLastMinute: number;
  consecutiveErrors: number;
  breaker: RecoveredBreaker;
  /** Newest durable operator reset, used to prove it followed position uncertainty. */
  latestBreakerResetSequence?: number;
  unresolvedIntents: ReadonlyMap<string, RecoveredIntent>;
  /** Durable broker-client-id to logical-order mapping, including completed orders. */
  clientIdToLogicalOrderId: ReadonlyMap<string, string>;
  /** Alias emphasizing that recovery restores the exact mapping. */
  unresolvedMappings: ReadonlyMap<string, string>;
  decisions: ReadonlyMap<string, RecoveredDecision>;
  /** Effect-free accepted decisions superseded by a newer pending target in an older prefix. */
  supersededDecisionIds?: readonly string[];
  /** Conservative pacing anchor from the latest durably completed broker reconciliation. */
  lastCompletedEvaluationAt?: number;
  /** True when restart may be resuming an operation whose exact start time is not durable. */
  hasOpenAcceptedEvaluations?: boolean;
  activeLease?: LeaseEventV3;
}

export interface RecoverLedgerOptions {
  expectedFirstSequence?: number;
  /** Window anchor. Defaults to the final event timestamp for deterministic offline recovery. */
  now?: number;
  requireBinding?: boolean;
}

const decisionTypes = new Set([
  'evaluation.accepted',
  'evaluation.skipped',
  'evaluation.completed',
  'order.intent',
  'order.attempt',
  'order.result',
  'order.unknown',
  'order.resolution',
  'order.completion',
]);

export function ledgerBarKey(bindingId: string, barTime: number): string {
  return `${bindingId}:${barTime}`;
}

export function chartStreamKey(bindingId: string, timeframe: string): string {
  return `${bindingId}\u0000${timeframe}`;
}

export function logicalOrderId(decisionId: string, correctionSeq: number): string {
  return `${decisionId}:${correctionSeq}`;
}

export function logicalClientId(decisionId: string, correctionSeq: number): string {
  return `pl_${decisionId}_${correctionSeq}`;
}

/** Runtime validation used before any event can influence restart behavior. */
export function assertLedgerEventV3(
  value: unknown,
  eventIndex?: number,
): asserts value is LedgerEventV3 {
  const fail = (message: string): never => {
    throw new LedgerRecoveryError(message, eventIndex);
  };
  const event = objectValue(value, 'event', fail);
  if (event.schemaVersion !== 3) fail('schemaVersion must be 3');
  positiveInteger(event.sequence, 'sequence', fail);
  nonEmptyString(event.recordType, 'recordType', fail);
  nonEmptyString(event.runId, 'runId', fail);
  nonEmptyString(event.executionId, 'executionId', fail);
  const recordedAt = nonEmptyString(event.recordedAt, 'recordedAt', fail);
  if (!Number.isFinite(Date.parse(recordedAt))) fail('recordedAt must be an ISO-compatible time');

  switch (event.recordType) {
    case 'authority': {
      assertAuthorityEnvelope(event.authority, 'authority', fail);
      break;
    }
    case 'binding': {
      const binding = objectValue(event.binding, 'binding', fail);
      const id = nonEmptyString(binding.id, 'binding.id', fail);
      const fingerprint = nonEmptyString(binding.fingerprint, 'binding.fingerprint', fail);
      if (binding.bindingVersion === 2) {
        if (!/^binding-v2-[a-f0-9]{64}$/.test(id))
          fail('v2 binding.id must be a SHA-256 binding identity');
        const authority = objectValue(binding.authority, 'binding.authority', fail);
        if (authority.algorithm !== 'sha256') fail('binding authority algorithm must be sha256');
        const authorityIdentity = nonEmptyString(
          authority.identity,
          'binding.authority.identity',
          fail,
        );
        if (!/^sha256-[a-f0-9]{64}$/.test(authorityIdentity))
          fail('binding authority identity must be SHA-256');
        objectValue(authority.prepared, 'binding.authority.prepared', fail);
      } else {
        if (id !== fingerprint) fail('legacy binding.id must match binding.fingerprint');
        if (binding.authority != null) fail('legacy binding cannot contain prepared authority');
      }
      nonEmptyString(binding.strategySymbol, 'binding.strategySymbol', fail);
      nonEmptyString(binding.providerId, 'binding.providerId', fail);
      nonEmptyString(binding.providerHandle, 'binding.providerHandle', fail);
      nonEmptyString(binding.executionSymbol, 'binding.executionSymbol', fail);
      positiveFinite(binding.qtyStep, 'binding.qtyStep', fail);
      positiveFinite(binding.minOrderQty, 'binding.minOrderQty', fail);
      positiveFinite(binding.mintick, 'binding.mintick', fail);
      optionalPositiveFinite(binding.pointValue, 'binding.pointValue', fail);
      optionalString(binding.exchange, 'binding.exchange', fail);
      optionalString(binding.expiry, 'binding.expiry', fail);
      nonEmptyString(binding.brokerId, 'binding.brokerId', fail);
      break;
    }
    case 'evaluation.accepted':
      assertDecision(event, fail);
      positiveInteger(event.targetOrdinal, 'targetOrdinal', fail);
      break;
    case 'evaluation.skipped':
      assertDecision(event, fail);
      positiveInteger(event.targetOrdinal, 'targetOrdinal', fail);
      if (
        ![
          'breaker-open',
          'coalesced',
          'duplicate',
          'lease-unavailable',
          'target-limit',
          'shutdown',
          'invalid',
          'compute-only',
          'forming',
          'recovered-final',
          'startup-discontinuity',
          'mirror-cadence',
        ].includes(String(event.reason))
      )
        fail('invalid evaluation skip reason');
      optionalString(event.detail, 'detail', fail);
      break;
    case 'evaluation.completed':
      assertDecision(event, fail);
      if (!['noop', 'order', 'reject'].includes(String(event.outcome)))
        fail('invalid evaluation outcome');
      nullableFinite(event.actualBefore, 'actualBefore', fail);
      nullableFinite(event.actualAfter, 'actualAfter', fail);
      nullableFinite(event.delta, 'delta', fail);
      if (event.error != null) assertError(event.error, fail);
      break;
    case 'order.intent':
      assertLogicalOrder(event, fail);
      finite(event.actualBefore, 'actualBefore', fail);
      finite(event.delta, 'delta', fail);
      positiveInteger(event.intentOrdinal, 'intentOrdinal', fail);
      break;
    case 'order.attempt':
      assertLogicalOrder(event, fail);
      positiveInteger(event.attempt, 'attempt', fail);
      positiveInteger(event.attemptsInRollingMinute, 'attemptsInRollingMinute', fail);
      break;
    case 'order.result':
      assertLogicalOrder(event, fail);
      positiveInteger(event.attempt, 'attempt', fail);
      if (!['filled', 'rejected', 'error'].includes(String(event.outcome)))
        fail('invalid order result outcome');
      if (event.outcome === 'filled') {
        if (event.fill == null) fail('filled result requires fill');
        assertFill(event.fill, event.order as OrderRequest, fail);
        if (event.error != null) fail('filled result cannot contain error');
      } else {
        if (event.error == null) fail(`${event.outcome} result requires error`);
        assertError(event.error, fail);
        if (
          event.outcome === 'error' &&
          (event.error as LedgerError).submitFailureCertainty !== 'definitely-not-sent'
        )
          fail('retryable order error must prove the submit was definitely not sent');
        if (event.fill != null) fail(`${event.outcome} result cannot contain fill`);
      }
      break;
    case 'order.unknown':
      assertLogicalOrder(event, fail);
      positiveInteger(event.attempt, 'attempt', fail);
      assertError(event.error, fail);
      break;
    case 'order.resolution':
      assertLogicalOrder(event, fail);
      if (
        !['filled', 'rejected', 'not-found', 'ambiguous', 'unsupported'].includes(
          String(event.outcome),
        )
      )
        fail('invalid order resolution outcome');
      if (event.outcome === 'filled') {
        if (event.fill == null) fail('filled resolution requires fill');
        assertFill(event.fill, event.order as OrderRequest, fail);
        if (event.error != null) fail('filled resolution cannot contain error');
      } else if (event.outcome === 'rejected') {
        if (event.error == null) fail('rejected resolution requires error');
        assertError(event.error, fail);
        if (event.fill != null) fail('rejected resolution cannot contain fill');
      } else if (event.fill != null || event.error != null) {
        fail('inconclusive resolution cannot contain fill or error');
      }
      optionalString(event.detail, 'detail', fail);
      break;
    case 'order.completion':
      assertLogicalOrder(event, fail);
      if (!['filled', 'rejected', 'observed'].includes(String(event.outcome)))
        fail('invalid order completion outcome');
      nullableFinite(event.actualAfter, 'actualAfter', fail);
      if (event.fill != null) assertFill(event.fill, event.order as OrderRequest, fail);
      if (event.error != null) assertError(event.error, fail);
      break;
    case 'breaker':
      if (!['latched', 'reset'].includes(String(event.state))) fail('invalid breaker state');
      if (
        ![
          'attempt-limit',
          'consecutive-errors',
          'intent-limit',
          'ledger-failure',
          'lease-lost',
          'position-unknown',
          'submission-unknown',
          'recovery-unresolved',
          'operator',
        ].includes(String(event.reason))
      )
        fail('invalid breaker reason');
      if (event.state === 'reset' && event.reason !== 'operator')
        fail('breaker reset reason must be operator');
      if (event.state === 'latched' && event.reason === 'operator')
        fail('operator reason is only valid for breaker reset');
      nonNegativeInteger(event.consecutiveErrors, 'consecutiveErrors', fail);
      optionalString(event.decisionId, 'decisionId', fail);
      optionalString(event.logicalOrderId, 'logicalOrderId', fail);
      optionalString(event.detail, 'detail', fail);
      break;
    case 'recovery':
      if (!['loaded', 'partial-tail-discarded', 'resumed'].includes(String(event.action)))
        fail('invalid recovery action');
      nonNegativeInteger(event.sourceLastSequence, 'sourceLastSequence', fail);
      if (event.lastFinalCursor != null) assertCursor(event.lastFinalCursor, fail);
      const unresolvedIds = event.unresolvedLogicalOrderIds;
      if (!Array.isArray(unresolvedIds)) fail('unresolvedLogicalOrderIds must be an array');
      for (const id of unresolvedIds as unknown[])
        nonEmptyString(id, 'unresolvedLogicalOrderIds[]', fail);
      optionalString(event.detail, 'detail', fail);
      break;
    case 'lease':
      if (!['acquired', 'released', 'contended', 'lost'].includes(String(event.action)))
        fail('invalid lease action');
      nonEmptyString(event.resource, 'resource', fail);
      nonEmptyString(event.leaseId, 'leaseId', fail);
      nonEmptyString(event.ownerId, 'ownerId', fail);
      optionalString(event.detail, 'detail', fail);
      break;
    default:
      fail(`unknown schema-v3 recordType ${String(event.recordType)}`);
  }
}

/**
 * Replays the valid prefix into restart state. Any semantic mismatch is corruption: no event is
 * skipped and no best-effort state is returned.
 */
export function recoverLedger(
  records: readonly unknown[],
  options: RecoverLedgerOptions = {},
): LedgerRecoveryState {
  const expectedFirst = options.expectedFirstSequence ?? 1;
  if (!Number.isSafeInteger(expectedFirst) || expectedFirst < 1)
    throw new RangeError('expectedFirstSequence must be a positive safe integer');

  const events: LedgerEventV3[] = [];
  let seenV3 = false;
  for (let index = 0; index < records.length; index++) {
    const raw = records[index];
    if (!isObject(raw)) throw new LedgerRecoveryError('record must be an object', index);
    if (raw.schemaVersion === 1 || raw.schemaVersion === 2) {
      if (seenV3)
        throw new LedgerRecoveryError('legacy event cannot follow schema-v3 events', index);
      continue;
    }
    assertLedgerEventV3(raw, index);
    seenV3 = true;
    events.push(raw);
  }

  const perBar = new Map<string, RecoveredBarCounters>();
  const decisions = new Map<string, RecoveredDecision>();
  const unresolved = new Map<string, RecoveredIntent>();
  const allIntents = new Map<string, RecoveredIntent>();
  const clientMappings = new Map<string, string>();
  const attemptTimes: number[] = [];
  const latestChartUpdates = new Map<string, RecoveredChartUpdate>();
  const activeChartUpdates = new Map<string, RecoveredChartUpdate>();
  const restartInterruptedChartStreams = new Set<string>();
  const eventIdToDecisionId = new Map<string, string>();
  let authority: AuthorityEventV3 | undefined;
  let binding: BindingEventV3 | undefined;
  let runId: string | undefined;
  let executionId: string | undefined;
  let expectedSequence = expectedFirst;
  let lastEventTime = -Infinity;
  let lastFinalCursor: LedgerCursor | undefined;
  let lastFinalDecisionId: string | undefined;
  let lastFinalUpdate: RecoveredChartUpdate | undefined;
  let consecutiveErrors = 0;
  let breaker: RecoveredBreaker = { latched: false };
  let latestBreakerResetSequence: number | undefined;
  let activeLease: LeaseEventV3 | undefined;

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const fail = (message: string): never => {
      throw new LedgerRecoveryError(message, index);
    };
    if (event.sequence !== expectedSequence)
      fail(`expected sequence ${expectedSequence}, received ${event.sequence}`);
    expectedSequence++;
    const eventTime = Date.parse(event.recordedAt);
    if (eventTime < lastEventTime) fail('recordedAt moved backwards');
    lastEventTime = eventTime;
    if (runId == null) {
      runId = event.runId;
      executionId = event.executionId;
    } else if (event.runId !== runId || event.executionId !== executionId) {
      fail('runId/executionId changed within one v3 stream');
    }

    if (event.recordType === 'authority') {
      if (authority) fail('authority event appeared more than once');
      if (binding || decisions.size > 0 || activeLease)
        fail('authority event appeared after runtime ownership or evaluation');
      authority = event;
      continue;
    }

    if (event.recordType === 'binding') {
      if (binding) fail('binding event appeared more than once');
      if (decisions.size > 0) fail('binding event appeared after evaluation');
      if (authority) {
        if (event.binding.bindingVersion !== 2 || !event.binding.authority)
          fail('authority event requires a v2 binding authority extension');
        if (canonical(event.binding.authority) !== canonical(authority.authority))
          fail('binding prepared authority does not match authority event');
      }
      binding = event;
      continue;
    }

    if (decisionTypes.has(event.recordType)) {
      const decisionEvent = event as Exclude<
        LedgerEventV3,
        AuthorityEventV3 | BindingEventV3 | BreakerEventV3 | RecoveryEventV3 | LeaseEventV3
      >;
      if (
        binding &&
        (decisionEvent.bindingId !== binding.binding.id ||
          decisionEvent.strategySymbol !== binding.binding.strategySymbol ||
          decisionEvent.executionSymbol !== binding.binding.executionSymbol)
      )
        fail('decision route does not match binding event');
    }

    switch (event.recordType) {
      case 'evaluation.accepted': {
        if (breaker.latched) fail('evaluation accepted while breaker was latched');
        if (decisions.has(event.decisionId)) fail('decisionId was reused');
        assertNewChartUpdate(
          event,
          latestChartUpdates,
          activeChartUpdates,
          restartInterruptedChartStreams,
          eventIdToDecisionId,
          fail,
        );
        const counter = counters(perBar, event.bindingId, event.barTime);
        if (event.targetOrdinal !== counter.targets + 1) fail('targetOrdinal is out of order');
        counter.targets++;
        decisions.set(event.decisionId, {
          accepted: event,
          skipped: [],
          terminalSkipped: false,
          logicalOrderIds: [],
        });
        rememberChartUpdate(
          event,
          latestChartUpdates,
          activeChartUpdates,
          restartInterruptedChartStreams,
          eventIdToDecisionId,
        );
        break;
      }
      case 'evaluation.skipped': {
        const existing = decisions.get(event.decisionId);
        if (existing?.completed) fail('skip followed evaluation completion');
        if (existing?.terminalSkipped) fail('evaluation was skipped more than once');
        if (existing?.accepted) {
          assertDecisionMatches(event, existing.accepted, fail);
          if (event.targetOrdinal !== existing.accepted.targetOrdinal)
            fail('skipped targetOrdinal does not match accepted evaluation');
          existing.skipped.push(event);
          if (
            !existing.logicalOrderIds.some((id) => unresolved.has(id)) &&
            existing.latestCompletedIntent == null
          ) {
            existing.terminalSkipped = true;
            if (event.update.authoritativeFinal && isLaterChartUpdate(event, lastFinalUpdate)) {
              lastFinalUpdate = chartUpdateFromEvent(event);
              lastFinalCursor = event.cursor;
              lastFinalDecisionId = event.decisionId;
            }
          }
        } else {
          if (existing) fail('skipped decisionId was reused');
          assertNewChartUpdate(
            event,
            latestChartUpdates,
            activeChartUpdates,
            restartInterruptedChartStreams,
            eventIdToDecisionId,
            fail,
          );
          const counter = counters(perBar, event.bindingId, event.barTime);
          if (event.targetOrdinal !== counter.targets + 1) fail('skipped targetOrdinal is invalid');
          counter.targets++;
          decisions.set(event.decisionId, {
            skipped: [event],
            terminalSkipped: true,
            logicalOrderIds: [],
          });
          rememberChartUpdate(
            event,
            latestChartUpdates,
            activeChartUpdates,
            restartInterruptedChartStreams,
            eventIdToDecisionId,
          );
          if (event.update.authoritativeFinal && isLaterChartUpdate(event, lastFinalUpdate)) {
            lastFinalUpdate = chartUpdateFromEvent(event);
            lastFinalCursor = event.cursor;
            lastFinalDecisionId = event.decisionId;
          }
        }
        break;
      }
      case 'evaluation.completed': {
        const decision = requiredDecision(decisions, event.decisionId, fail);
        const accepted = decision.accepted;
        if (!accepted) fail('completion has no accepted evaluation');
        if (decision.terminalSkipped) fail('completion followed a terminal evaluation skip');
        if (decision.completed) fail('evaluation completed more than once');
        if (breaker.latched) {
          if (decision.latestPositionUncertaintySequence != null)
            fail('evaluation completed before position uncertainty was reset');
          fail('evaluation completed while breaker was latched');
        }
        assertDecisionMatches(event, accepted!, fail);
        for (const id of decision.logicalOrderIds) {
          if (unresolved.has(id)) fail('evaluation completed with an unresolved intent');
        }
        const uncertaintySequence = decision.latestPositionUncertaintySequence;
        if (
          uncertaintySequence != null &&
          (latestBreakerResetSequence == null || latestBreakerResetSequence <= uncertaintySequence)
        )
          fail('evaluation completed before position uncertainty was reset');
        if (
          uncertaintySequence != null &&
          (event.actualBefore == null || event.actualAfter == null || event.delta == null)
        )
          fail('evaluation completion has no fresh position resolution');
        const expectedEvaluationOutcome = aggregateEvaluationOutcome(decision);
        if (expectedEvaluationOutcome && event.outcome !== expectedEvaluationOutcome)
          fail('order completion does not match evaluation outcome');
        decision.completed = event;
        if (event.update.authoritativeFinal && isLaterChartUpdate(event, lastFinalUpdate)) {
          lastFinalUpdate = chartUpdateFromEvent(event);
          lastFinalCursor = event.cursor;
          lastFinalDecisionId = event.decisionId;
        }
        if (event.outcome === 'reject') consecutiveErrors++;
        else consecutiveErrors = 0;
        break;
      }
      case 'order.intent': {
        if (breaker.latched) fail('order intent while breaker was latched');
        const decision = requiredDecision(decisions, event.decisionId, fail);
        const accepted = decision.accepted;
        if (!accepted) fail('intent has no accepted evaluation');
        if (decision.terminalSkipped) fail('intent followed a terminal evaluation skip');
        if (decision.completed) fail('intent followed evaluation completion');
        const priorCompletionOutcome = decision.latestCompletedIntent?.completion?.outcome;
        if (priorCompletionOutcome === 'rejected' || priorCompletionOutcome === 'observed')
          fail(`correction followed ${priorCompletionOutcome} order completion`);
        if (decision.logicalOrderIds.some((id) => unresolved.has(id)))
          fail('new correction intent overlaps an unresolved logical order');
        assertDecisionMatches(event, accepted!, fail);
        const expectedCorrection = decision.logicalOrderIds.length + 1;
        if (event.correctionSeq !== expectedCorrection) fail('correctionSeq is out of order');
        if (event.logicalOrderId !== logicalOrderId(event.decisionId, event.correctionSeq))
          fail('logicalOrderId does not match decision/correction');
        if (event.clientId !== logicalClientId(event.decisionId, event.correctionSeq))
          fail('clientId does not match decision/correction');
        if (allIntents.has(event.logicalOrderId)) fail('logicalOrderId was reused');
        if (clientMappings.has(event.clientId)) fail('clientId was reused');
        const counter = counters(perBar, event.bindingId, event.barTime);
        if (event.intentOrdinal !== counter.intents + 1) fail('intentOrdinal is out of order');
        counter.intents++;
        const recovered = { intent: event, attempts: [], results: [], resolutions: [] };
        decision.logicalOrderIds.push(event.logicalOrderId);
        allIntents.set(event.logicalOrderId, recovered);
        unresolved.set(event.logicalOrderId, recovered);
        clientMappings.set(event.clientId, event.logicalOrderId);
        break;
      }
      case 'order.attempt': {
        const intent = requiredIntent(allIntents, event.logicalOrderId, fail);
        assertLogicalMatches(event, intent.intent, fail);
        if (!unresolved.has(event.logicalOrderId)) fail('attempt followed order completion');
        if (intent.unknown) fail('attempt followed a possibly-sent submission');
        if (terminalResolution(intent)) fail('attempt followed terminal order resolution');
        if (event.attempt !== intent.attempts.length + 1) fail('attempt number is out of order');
        const priorAttempt = intent.attempts.at(-1);
        const priorResult = priorAttempt
          ? intent.results.find((result) => result.attempt === priorAttempt.attempt)
          : undefined;
        if (priorAttempt && !priorResult)
          fail('attempt followed a result-less possibly-sent submission');
        if (priorResult && priorResult.outcome !== 'error')
          fail('attempt followed a terminal result');
        if (
          priorResult?.outcome === 'error' &&
          priorResult.error?.submitFailureCertainty !== 'definitely-not-sent'
        )
          fail('attempt followed an error without definitely-not-sent proof');
        const time = Date.parse(event.recordedAt);
        const rolling = attemptTimes.filter(
          (value) => value > time - 60_000 && value <= time,
        ).length;
        if (event.attemptsInRollingMinute !== rolling + 1)
          fail('attemptsInRollingMinute does not match event history');
        intent.attempts.push(event);
        attemptTimes.push(time);
        break;
      }
      case 'order.result': {
        const intent = requiredIntent(allIntents, event.logicalOrderId, fail);
        if (!unresolved.has(event.logicalOrderId)) fail('result followed order completion');
        assertLogicalMatches(event, intent.intent, fail);
        const attempt = intent.attempts.at(-1);
        if (!attempt || attempt.attempt !== event.attempt) fail('result has no matching attempt');
        if (intent.results.some((result) => result.attempt === event.attempt))
          fail('attempt has more than one result');
        if (intent.unknown) fail('result followed unknown');
        intent.results.push(event);
        break;
      }
      case 'order.unknown': {
        const intent = requiredIntent(allIntents, event.logicalOrderId, fail);
        if (!unresolved.has(event.logicalOrderId)) fail('unknown followed order completion');
        assertLogicalMatches(event, intent.intent, fail);
        const attempt = intent.attempts.at(-1);
        if (!attempt || attempt.attempt !== event.attempt) fail('unknown has no matching attempt');
        if (intent.results.some((result) => result.attempt === event.attempt))
          fail('unknown conflicts with an existing result');
        if (intent.unknown) fail('logical order became unknown more than once');
        intent.unknown = event;
        consecutiveErrors++;
        breaker = { latched: true, reason: 'submission-unknown' };
        break;
      }
      case 'order.resolution': {
        const intent = requiredIntent(allIntents, event.logicalOrderId, fail);
        if (!unresolved.has(event.logicalOrderId)) fail('resolution followed order completion');
        assertLogicalMatches(event, intent.intent, fail);
        if (intent.attempts.length === 0) fail('resolution has no submitted attempt');
        if (terminalResolution(intent)) fail('logical order resolved more than once');
        if (!intent.unknown) {
          const attempt = intent.attempts.at(-1)!;
          if (intent.results.some((result) => result.attempt === attempt.attempt))
            fail('resolution followed a durable submit result');
        }
        intent.resolutions.push(event);
        break;
      }
      case 'order.completion': {
        const intent = requiredIntent(allIntents, event.logicalOrderId, fail);
        assertLogicalMatches(event, intent.intent, fail);
        if (!unresolved.has(event.logicalOrderId)) fail('logical order completed more than once');
        const terminal = terminalOrderEvidence(intent);
        if (
          terminal &&
          (terminal.outcome === 'filled' || terminal.outcome === 'rejected') &&
          event.outcome !== terminal.outcome
        )
          fail('terminal order result does not match completion outcome');
        if (event.outcome === 'filled' && terminal?.outcome !== 'filled')
          fail('filled completion has no filled result');
        if (event.outcome === 'rejected' && terminal?.outcome !== 'rejected')
          fail('rejected completion has no rejected result');
        if (event.fill && terminal?.fill && canonical(event.fill) !== canonical(terminal.fill))
          fail('completion fill does not match result fill');
        intent.completion = event;
        const decision = requiredDecision(decisions, event.decisionId, fail);
        decision.latestCompletedIntent = intent;
        if (event.outcome !== 'observed') decision.latestEffectfulIntent = intent;
        unresolved.delete(event.logicalOrderId);
        const positionUnknown = completionHasUnknownPosition(event);
        if (positionUnknown) {
          decision.latestPositionUncertaintySequence = event.sequence;
          consecutiveErrors++;
          breaker = { latched: true, reason: 'position-unknown' };
        } else if (event.outcome !== 'rejected') {
          if (event.error != null) consecutiveErrors++;
          else consecutiveErrors = 0;
        }
        break;
      }
      case 'breaker':
        if (event.decisionId && !decisions.has(event.decisionId))
          fail('breaker references an unknown decisionId');
        if (event.logicalOrderId) {
          const intent = allIntents.get(event.logicalOrderId);
          if (!intent) fail('breaker references an unknown logicalOrderId');
          if (event.decisionId && intent!.intent.decisionId !== event.decisionId)
            fail('breaker decision/logical order mapping is mismatched');
        }
        if (event.state === 'latched') {
          if (event.consecutiveErrors !== consecutiveErrors)
            fail('breaker consecutiveErrors does not match recovered counter');
          breaker = { latched: true, reason: event.reason, event };
        } else {
          const attemptedUnresolved = [...unresolved.values()].filter(
            (intent) => intent.attempts.length > 0,
          );
          if (attemptedUnresolved.some((intent) => submissionOutcomeUnresolved(intent)))
            fail('breaker reset cannot clear an unresolved possibly-sent submission');
          if (!breaker.latched && attemptedUnresolved.length > 0)
            breaker = { latched: true, reason: 'recovery-unresolved' };
          if (!breaker.latched) fail('breaker reset while breaker was not latched');
          if (event.consecutiveErrors !== 0) fail('breaker reset must record zero errors');
          consecutiveErrors = 0;
          latestBreakerResetSequence = event.sequence;
          breaker = { latched: false, event };
        }
        break;
      case 'recovery': {
        if (event.sourceLastSequence >= event.sequence)
          fail('recovery sourceLastSequence must precede the recovery event');
        const expectedUnresolved = [...unresolved.keys()].sort();
        if (
          canonical([...event.unresolvedLogicalOrderIds].sort()) !== canonical(expectedUnresolved)
        )
          fail('recovery unresolved intent snapshot is mismatched');
        if (
          event.lastFinalCursor != null &&
          canonical(event.lastFinalCursor) !== canonical(lastFinalCursor)
        )
          fail('recovery lastFinalCursor is mismatched');
        for (const key of activeChartUpdates.keys()) {
          restartInterruptedChartStreams.add(key);
        }
        break;
      }
      case 'lease':
        if (event.action === 'acquired') {
          if (activeLease) fail('lease acquired while another lease is active');
          activeLease = event;
        } else if (event.action === 'released' || event.action === 'lost') {
          if (
            !activeLease ||
            activeLease.resource !== event.resource ||
            activeLease.leaseId !== event.leaseId ||
            activeLease.ownerId !== event.ownerId
          )
            fail(`${event.action} lease does not match active lease`);
          activeLease = undefined;
        }
        break;
    }
  }

  if (options.requireBinding && events.length > 0 && !binding)
    throw new LedgerRecoveryError('schema-v3 stream has no binding event');

  // An attempt without a durable completion could have reached the broker even when the final
  // result row is absent. Recovery therefore always starts latched in that state.
  const hasPossiblySubmittedIntent = [...unresolved.values()].some((intent) =>
    submissionOutcomeUnresolved(intent),
  );
  if (hasPossiblySubmittedIntent && !breaker.latched && breaker.event?.state !== 'reset')
    breaker = { latched: true, reason: 'recovery-unresolved' };

  const anchor =
    options.now ?? (events.length > 0 ? Date.parse(events.at(-1)!.recordedAt) : Date.now());
  if (!Number.isFinite(anchor)) throw new RangeError('recovery now must be finite');
  const rollingMinuteAttemptTimes = attemptTimes.filter(
    (time) => time > anchor - 60_000 && time <= anchor,
  );
  const unresolvedMappings = new Map<string, string>();
  for (const [logicalId, intent] of unresolved)
    unresolvedMappings.set(intent.intent.clientId, logicalId);

  const openAccepted = [...decisions.entries()]
    .filter(([, decision]) =>
      Boolean(decision.accepted && !decision.completed && !decision.terminalSkipped),
    )
    .sort(([, left], [, right]) => left.accepted!.sequence - right.accepted!.sequence);
  const supersededDecisionIds = openAccepted.slice(1, -1).map(([decisionId, decision]) => {
    if (decision.logicalOrderIds.length > 0)
      throw new LedgerRecoveryError(
        'superseded accepted decision has durable logical order history',
      );
    return decisionId;
  });
  const completedEvaluationTimes = [...decisions.values()]
    .map((decision) => decision.completed && Date.parse(decision.completed.recordedAt))
    .filter((value): value is number => value != null);
  const lastCompletedEvaluationAt =
    completedEvaluationTimes.length > 0 ? Math.max(...completedEvaluationTimes) : undefined;
  const activeBars = new Map<string, RecoveredActiveBar>();
  for (const [key, update] of activeChartUpdates) {
    if (update.kind !== 'intrabar') continue;
    activeBars.set(key, { ...update, kind: 'intrabar', interrupted: true, inhibitExecution: true });
  }
  const interruptedUpdates = openAccepted.map(([, decision]) =>
    chartUpdateFromEvent(decision.accepted!),
  );

  return {
    events: [...events],
    runId,
    executionId,
    authority,
    binding,
    lastSequence: expectedSequence - 1,
    nextSequence: expectedSequence,
    lastFinalCursor,
    lastFinalDecisionId,
    lastFinalUpdate,
    latestChartUpdates,
    activeBars,
    interruptedUpdates,
    perBar,
    rollingMinuteAttemptTimes,
    attemptsInLastMinute: rollingMinuteAttemptTimes.length,
    consecutiveErrors,
    breaker,
    latestBreakerResetSequence,
    unresolvedIntents: unresolved,
    clientIdToLogicalOrderId: clientMappings,
    unresolvedMappings,
    decisions,
    supersededDecisionIds,
    lastCompletedEvaluationAt,
    hasOpenAcceptedEvaluations: openAccepted.length > 0,
    activeLease,
  };
}

export const recoverLedgerV3 = recoverLedger;
export const parseRecoveryState = recoverLedger;

function chartUpdateFromEvent(event: DecisionEventV3): RecoveredChartUpdate {
  return {
    decisionId: event.decisionId,
    bindingId: event.bindingId,
    timeframe: event.timeframe,
    barTime: event.barTime,
    cursor: structuredClone(event.cursor),
    ...structuredClone(event.update),
  };
}

function assertNewChartUpdate(
  event: DecisionEventV3,
  latest: ReadonlyMap<string, RecoveredChartUpdate>,
  active: ReadonlyMap<string, RecoveredChartUpdate>,
  restartInterrupted: ReadonlySet<string>,
  eventIds: ReadonlyMap<string, string>,
  fail: (message: string) => never,
): void {
  const priorDecisionId = eventIds.get(event.update.eventId);
  if (priorDecisionId) fail(`chart update eventId was reused by decision ${priorDecisionId}`);
  const key = chartStreamKey(event.bindingId, event.timeframe);
  const interrupted = active.get(key);
  if (event.update.kind === 'close-only') {
    if (interrupted) fail('close-only update cannot bypass an active intrabar bar');
    return;
  }
  if (interrupted) {
    if (event.barTime !== interrupted.barTime)
      fail('chart bar changed before an authoritative final update');
    if (event.update.revision <= interrupted.revision)
      fail('chart update revision did not strictly increase');
    if (
      event.update.discontinuity !== interrupted.discontinuity &&
      !(
        restartInterrupted.has(key) &&
        interrupted.discontinuity === false &&
        event.update.discontinuity === true
      )
    )
      fail('chart discontinuity provenance changed within an active bar');
    return;
  }
  const prior = latest.get(key);
  if (prior && event.barTime <= prior.barTime)
    fail('chart update followed an authoritative final for the same or newer bar');
}

function rememberChartUpdate(
  event: DecisionEventV3,
  latest: Map<string, RecoveredChartUpdate>,
  active: Map<string, RecoveredChartUpdate>,
  restartInterrupted: Set<string>,
  eventIds: Map<string, string>,
): void {
  const update = chartUpdateFromEvent(event);
  const key = chartStreamKey(event.bindingId, event.timeframe);
  latest.set(key, update);
  eventIds.set(event.update.eventId, event.decisionId);
  if (event.update.kind === 'intrabar' && !event.update.authoritativeFinal) {
    active.set(key, update);
  } else {
    active.delete(key);
    restartInterrupted.delete(key);
  }
}

function isLaterChartUpdate(
  event: DecisionEventV3,
  previous: RecoveredChartUpdate | undefined,
): boolean {
  if (!previous) return true;
  if (event.bindingId !== previous.bindingId || event.timeframe !== previous.timeframe) return true;
  return (
    event.barTime > previous.barTime ||
    (event.barTime === previous.barTime && event.update.revision > previous.revision)
  );
}

function terminalResolution(intent: RecoveredIntent): OrderResolutionEventV3 | undefined {
  return intent.resolutions
    .filter((event) => event.outcome === 'filled' || event.outcome === 'rejected')
    .at(-1);
}

function terminalOrderEvidence(
  intent: RecoveredIntent,
): OrderResultEventV3 | OrderResolutionEventV3 | undefined {
  const result = intent.results.at(-1);
  if (result?.outcome === 'filled' || result?.outcome === 'rejected') return result;
  return terminalResolution(intent);
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

function aggregateEvaluationOutcome(
  decision: RecoveredDecision,
): EvaluationCompletedEventV3['outcome'] | undefined {
  const latestOutcome = decision.latestCompletedIntent?.completion?.outcome;
  if (latestOutcome === 'filled') return 'order';
  if (latestOutcome === 'rejected') return 'reject';
  if (latestOutcome !== 'observed') return undefined;

  const effectfulOutcome = decision.latestEffectfulIntent?.completion?.outcome;
  if (effectfulOutcome === 'filled') return 'order';
  if (effectfulOutcome === 'rejected') return 'reject';
  return 'noop';
}

function completionHasUnknownPosition(event: OrderCompletionEventV3): boolean {
  if (event.error?.code === 'position-unknown') return true;
  if (event.outcome === 'filled') return event.actualAfter == null || event.error != null;
  if (event.outcome === 'rejected') return event.actualAfter == null;
  return event.actualAfter == null || event.error != null;
}

function assertDecision(event: Record<string, unknown>, fail: (message: string) => never): void {
  nonEmptyString(event.decisionId, 'decisionId', fail);
  nonEmptyString(event.strategyId, 'strategyId', fail);
  nonEmptyString(event.strategySymbol, 'strategySymbol', fail);
  nonEmptyString(event.executionSymbol, 'executionSymbol', fail);
  nonEmptyString(event.bindingId, 'bindingId', fail);
  nonEmptyString(event.timeframe, 'timeframe', fail);
  finite(event.barTime, 'barTime', fail);
  assertCursor(event.cursor, fail);
  assertChartUpdate(event.update, fail);
  finite(event.target, 'target', fail);
  optionalPositiveFinite(event.referencePrice, 'referencePrice', fail);
}

function assertChartUpdate(value: unknown, fail: (message: string) => never): void {
  const update = objectValue(value, 'update', fail);
  if (update.kind !== 'intrabar' && update.kind !== 'close-only')
    fail('update.kind must be intrabar or close-only');
  nonEmptyString(update.eventId, 'update.eventId', fail);
  positiveInteger(update.revision, 'update.revision', fail);
  if (typeof update.authoritativeFinal !== 'boolean')
    fail('update.authoritativeFinal must be boolean');
  if (typeof update.recovered !== 'boolean') fail('update.recovered must be boolean');
  if (typeof update.discontinuity !== 'boolean') fail('update.discontinuity must be boolean');
  if (update.recovered && !update.authoritativeFinal)
    fail('a recovered update must be authoritative final');
  if (
    update.kind === 'close-only' &&
    (update.revision !== 1 ||
      update.authoritativeFinal !== true ||
      update.recovered !== false ||
      update.discontinuity !== false)
  )
    fail('close-only update identity must be revision 1 authoritative final');
}

function assertLogicalOrder(
  event: Record<string, unknown>,
  fail: (message: string) => never,
): void {
  assertDecision(event, fail);
  nonEmptyString(event.logicalOrderId, 'logicalOrderId', fail);
  positiveInteger(event.correctionSeq, 'correctionSeq', fail);
  nonEmptyString(event.clientId, 'clientId', fail);
  const order = objectValue(event.order, 'order', fail);
  assertOrder(order, fail);
  if (order.clientId !== event.clientId) fail('order.clientId does not match clientId');
  if (order.symbol !== event.executionSymbol)
    fail('order.symbol does not match decision executionSymbol');
}

function assertOrder(order: Record<string, unknown>, fail: (message: string) => never): void {
  nonEmptyString(order.symbol, 'order.symbol', fail);
  if (order.side !== 'buy' && order.side !== 'sell') fail('invalid order.side');
  positiveFinite(order.qty, 'order.qty', fail);
  nonEmptyString(order.clientId, 'order.clientId', fail);
  if (!['market', 'limit', 'stop'].includes(String(order.type))) fail('invalid order.type');
  if (order.type === 'limit') positiveFinite(order.limitPrice, 'order.limitPrice', fail);
  else if (order.limitPrice != null) fail('non-limit order cannot contain limitPrice');
}

function assertFill(value: unknown, order: OrderRequest, fail: (message: string) => never): void {
  const fill = objectValue(value, 'fill', fail);
  if (fill.clientId !== order.clientId) fail('fill.clientId does not match order');
  if (fill.symbol !== order.symbol) fail('fill.symbol does not match order');
  if (fill.side !== order.side) fail('fill.side does not match order');
  if (fill.status !== 'filled' && fill.status !== 'partially-filled') fail('invalid fill.status');
  if (fill.requestedQty !== order.qty) fail('fill.requestedQty does not match order');
  positiveFinite(fill.filledQty, 'fill.filledQty', fail);
  if ((fill.filledQty as number) > order.qty) fail('fill.filledQty exceeds order quantity');
  finite(fill.price, 'fill.price', fail);
  finite(fill.commission, 'fill.commission', fail);
  finite(fill.time, 'fill.time', fail);
}

function assertAuthorityEnvelope(
  value: unknown,
  name: string,
  fail: (message: string) => never,
): void {
  const authority = objectValue(value, name, fail);
  if (authority.algorithm !== 'sha256') fail(`${name}.algorithm must be sha256`);
  const identity = nonEmptyString(authority.identity, `${name}.identity`, fail);
  if (!/^sha256-[a-f0-9]{64}$/.test(identity)) fail(`${name}.identity must be SHA-256`);
  objectValue(authority.prepared, `${name}.prepared`, fail);
}

function assertError(
  value: unknown,
  fail: (message: string) => never,
): asserts value is LedgerError {
  const error = objectValue(value, 'error', fail);
  nonEmptyString(error.name, 'error.name', fail);
  nonEmptyString(error.message, 'error.message', fail);
  optionalString(error.code, 'error.code', fail);
  if (error.retryable != null && typeof error.retryable !== 'boolean')
    fail('error.retryable must be boolean');
  if (
    error.submitFailureCertainty != null &&
    error.submitFailureCertainty !== 'definitely-not-sent' &&
    error.submitFailureCertainty !== 'possibly-sent'
  )
    fail('error.submitFailureCertainty is invalid');
}

function assertCursor(
  value: unknown,
  fail: (message: string) => never,
): asserts value is LedgerCursor {
  if (typeof value === 'string') {
    if (value.length === 0) fail('cursor must not be empty');
    return;
  }
  if (typeof value === 'number') {
    finite(value, 'cursor', fail);
    return;
  }
  const cursor = objectValue(value, 'cursor', fail);
  for (const [key, member] of Object.entries(cursor)) {
    if (!key) fail('cursor key must not be empty');
    if (
      member !== null &&
      typeof member !== 'string' &&
      typeof member !== 'boolean' &&
      !(typeof member === 'number' && Number.isFinite(member))
    )
      fail('cursor values must be scalar JSON values');
  }
}

function assertDecisionMatches(
  event: Pick<
    DecisionEventV3,
    | 'decisionId'
    | 'strategyId'
    | 'strategySymbol'
    | 'executionSymbol'
    | 'bindingId'
    | 'timeframe'
    | 'barTime'
    | 'cursor'
    | 'update'
    | 'target'
    | 'referencePrice'
  >,
  accepted: Pick<
    DecisionEventV3,
    | 'decisionId'
    | 'strategyId'
    | 'strategySymbol'
    | 'executionSymbol'
    | 'bindingId'
    | 'timeframe'
    | 'barTime'
    | 'cursor'
    | 'update'
    | 'target'
    | 'referencePrice'
  >,
  fail: (message: string) => never,
): void {
  for (const key of [
    'decisionId',
    'strategyId',
    'strategySymbol',
    'executionSymbol',
    'bindingId',
    'timeframe',
    'barTime',
    'target',
    'referencePrice',
  ] as const) {
    if (event[key] !== accepted[key]) fail(`${key} does not match accepted evaluation`);
  }
  if (canonical(event.cursor) !== canonical(accepted.cursor))
    fail('cursor does not match accepted evaluation');
  if (canonical(event.update) !== canonical(accepted.update))
    fail('chart update identity does not match accepted evaluation');
}

function assertLogicalMatches(
  event: {
    decisionId: string;
    strategyId: string;
    strategySymbol: string;
    executionSymbol: string;
    bindingId: string;
    timeframe: string;
    barTime: number;
    cursor: LedgerCursor;
    update: ChartUpdateIdentityV3;
    target: number;
    logicalOrderId: string;
    correctionSeq: number;
    clientId: string;
    order: OrderRequest;
  },
  intent: OrderIntentEventV3,
  fail: (message: string) => never,
): void {
  assertDecisionMatches(event, intent, fail);
  if (
    event.decisionId !== intent.decisionId ||
    event.logicalOrderId !== intent.logicalOrderId ||
    event.correctionSeq !== intent.correctionSeq ||
    event.clientId !== intent.clientId
  )
    fail('logical order identity does not match intent');
  if (canonical(event.order) !== canonical(intent.order))
    fail('order economics do not match intent');
}

function requiredDecision(
  decisions: Map<string, RecoveredDecision>,
  decisionId: string,
  fail: (message: string) => never,
): RecoveredDecision {
  const decision = decisions.get(decisionId);
  if (!decision) fail('event references an unknown decisionId');
  return decision;
}

function requiredIntent(
  intents: Map<string, RecoveredIntent>,
  logicalId: string,
  fail: (message: string) => never,
): RecoveredIntent {
  const intent = intents.get(logicalId);
  if (!intent) fail('event references an unknown logicalOrderId');
  return intent;
}

function counters(
  values: Map<string, RecoveredBarCounters>,
  bindingId: string,
  barTime: number,
): RecoveredBarCounters {
  const key = ledgerBarKey(bindingId, barTime);
  const value = values.get(key) ?? { targets: 0, intents: 0 };
  values.set(key, value);
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
    .join(',')}}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function objectValue(
  value: unknown,
  name: string,
  fail: (message: string) => never,
): Record<string, unknown> {
  if (!isObject(value)) fail(`${name} must be an object`);
  return value;
}

function nonEmptyString(value: unknown, name: string, fail: (message: string) => never): string {
  if (typeof value !== 'string' || value.length === 0) fail(`${name} must not be empty`);
  return value;
}

function optionalString(value: unknown, name: string, fail: (message: string) => never): void {
  if (value != null) nonEmptyString(value, name, fail);
}

function finite(value: unknown, name: string, fail: (message: string) => never): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be finite`);
  return value;
}

function positiveFinite(value: unknown, name: string, fail: (message: string) => never): number {
  const number = finite(value, name, fail);
  if (number <= 0) fail(`${name} must be positive`);
  return number;
}

function optionalPositiveFinite(
  value: unknown,
  name: string,
  fail: (message: string) => never,
): void {
  if (value != null) positiveFinite(value, name, fail);
}

function nullableFinite(value: unknown, name: string, fail: (message: string) => never): void {
  if (value !== null) finite(value, name, fail);
}

function positiveInteger(value: unknown, name: string, fail: (message: string) => never): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail(`${name} must be a positive safe integer`);
  return value as number;
}

function nonNegativeInteger(
  value: unknown,
  name: string,
  fail: (message: string) => never,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(`${name} must be a non-negative safe integer`);
  return value as number;
}
