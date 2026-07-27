import type { ForwardRecord } from './core/ledger.js';

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
 * Pure ledger comparator. One invocation compares exactly one live
 * run/strategy/symbol/timeframe scope; duplicate cycles are reported rather
 * than silently overwritten. Expected rows can come from piner/pinerun.
 */
export function compareLedgerParity(
  live: readonly ForwardRecord[],
  expected: readonly ExpectedPositionRecord[],
  epsilon = 1e-9,
): ParityDifference[] {
  if (!Number.isFinite(epsilon) || epsilon < 0)
    throw new RangeError('epsilon must be a non-negative finite number');

  const differences: ParityDifference[] = [];
  const scopes = new Set(
    live.map(
      (row) => `${row.runId}\u0000${row.strategyId}\u0000${row.symbol}\u0000${row.timeframe}`,
    ),
  );
  if (scopes.size > 1) {
    differences.push({
      kind: 'mixed-live-scope',
      error: `live ledger contains ${scopes.size} run/strategy/symbol/timeframe scopes`,
    });
    return differences;
  }

  const liveByTime = new Map<number, ForwardRecord>();
  for (const row of live) {
    const prior = liveByTime.get(row.bar.time);
    if (prior) {
      differences.push({
        barTime: row.bar.time,
        liveTarget: row.target,
        actualAfter: row.actualAfter,
        error: `duplicate live cycles ${prior.cycleId} and ${row.cycleId}`,
        kind: 'duplicate-live',
      });
    } else liveByTime.set(row.bar.time, row);
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
    } else if (actual.action === 'reject') {
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
