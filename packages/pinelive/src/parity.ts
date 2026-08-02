import type { EvaluationCompletedEventV3, LedgerEventV3 } from './core/ledger.js';
import { assertLedgerEvent } from './core/recovery.js';

export interface ExpectedPositionRecord {
  barTime: number;
  target: number;
}

export interface ParityDifference {
  barTime?: number;
  liveTarget?: number;
  expectedTarget?: number;
  actualAfter?: number | null;
  error?: string;
  kind:
    | 'missing-live'
    | 'missing-expected'
    | 'target-mismatch'
    | 'execution-drift'
    | 'rejected'
    | 'duplicate-live'
    | 'duplicate-expected'
    | 'mixed-live-scope';
}

/**
 * Pure comparator for durable evaluation completions. One invocation compares exactly one
 * run/strategy/binding/timeframe scope; duplicate completions are reported rather than overwritten.
 * Expected rows can come from piner/pinerun.
 */
export function compareLedgerParity(
  live: readonly unknown[],
  expected: readonly ExpectedPositionRecord[],
  epsilon = 1e-9,
): ParityDifference[] {
  if (!Number.isFinite(epsilon) || epsilon < 0)
    throw new RangeError('epsilon must be a non-negative finite number');

  const events = live.map((event, index): LedgerEventV3 => {
    assertLedgerEvent(event, index);
    return event;
  });
  const completed = events.filter(
    (event): event is EvaluationCompletedEventV3 => event.recordType === 'evaluation.completed',
  );
  const differences: ParityDifference[] = [];
  const scopes = new Set(
    completed.map(
      (event) =>
        `${event.runId}\u0000${event.strategyId}\u0000${event.bindingId}\u0000${event.timeframe}`,
    ),
  );
  if (scopes.size > 1) {
    differences.push({
      kind: 'mixed-live-scope',
      error: `live ledger contains ${scopes.size} run/strategy/binding/timeframe scopes`,
    });
    return differences;
  }

  const liveByTime = new Map<number, EvaluationCompletedEventV3>();
  for (const event of completed) {
    const prior = liveByTime.get(event.barTime);
    if (prior) {
      differences.push({
        barTime: event.barTime,
        liveTarget: event.target,
        actualAfter: event.actualAfter,
        error: `duplicate live evaluations ${prior.decisionId} and ${event.decisionId}`,
        kind: 'duplicate-live',
      });
    } else liveByTime.set(event.barTime, event);
  }

  const expectedByTime = new Map<number, ExpectedPositionRecord>();
  for (const row of expected) {
    if (expectedByTime.has(row.barTime)) {
      differences.push({
        barTime: row.barTime,
        expectedTarget: row.target,
        error: 'duplicate expected bar',
        kind: 'duplicate-expected',
      });
    } else expectedByTime.set(row.barTime, row);
  }

  const times = new Set([...liveByTime.keys(), ...expectedByTime.keys()]);
  for (const barTime of [...times].sort((a, b) => a - b)) {
    const actual = liveByTime.get(barTime);
    const wanted = expectedByTime.get(barTime);
    if (!actual)
      differences.push({ barTime, expectedTarget: wanted!.target, kind: 'missing-live' });
    else if (!wanted)
      differences.push({
        barTime,
        liveTarget: actual.target,
        actualAfter: actual.actualAfter,
        kind: 'missing-expected',
      });
    else if (Math.abs(actual.target - wanted.target) > epsilon) {
      differences.push({
        barTime,
        liveTarget: actual.target,
        expectedTarget: wanted.target,
        actualAfter: actual.actualAfter,
        kind: 'target-mismatch',
      });
    } else if (actual.outcome === 'reject') {
      differences.push({
        barTime,
        liveTarget: actual.target,
        expectedTarget: wanted.target,
        actualAfter: actual.actualAfter,
        error: actual.error?.message,
        kind: 'rejected',
      });
    } else if (
      actual.actualAfter == null ||
      Math.abs(actual.actualAfter - wanted.target) > epsilon
    ) {
      differences.push({
        barTime,
        liveTarget: actual.target,
        expectedTarget: wanted.target,
        actualAfter: actual.actualAfter,
        error: actual.error?.message,
        kind: 'execution-drift',
      });
    }
  }
  return differences;
}
