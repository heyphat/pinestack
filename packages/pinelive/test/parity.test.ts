import { expect, test } from 'bun:test';
import { compareLedgerParity, type ForwardRecord } from '../src/index.js';

function record(overrides: Partial<ForwardRecord> = {}): ForwardRecord {
  return {
    schemaVersion: 1,
    runId: 'run',
    strategyId: 'strategy',
    cycleId: 'cycle',
    sequence: 0,
    symbol: 'X',
    timeframe: '1m',
    bar: { time: 100, open: 1, high: 1, low: 1, close: 1, volume: 0 },
    target: 1,
    actualBefore: 0,
    actualAfter: 0,
    delta: 1,
    action: 'reject',
    error: {
      code: 'reject',
      message: 'blocked',
      retryable: false,
      stage: 'submit',
    },
    recordedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

test('parity reports rejected execution even when strategy targets match', () => {
  expect(compareLedgerParity([record()], [{ barTime: 100, target: 1 }])).toEqual([
    expect.objectContaining({ kind: 'rejected', error: 'blocked' }),
  ]);
});

test('parity reports unknown and material actual drift', () => {
  expect(
    compareLedgerParity(
      [record({ action: 'noop', error: undefined, actualAfter: null })],
      [{ barTime: 100, target: 1 }],
    )[0]?.kind,
  ).toBe('execution-drift');
  expect(
    compareLedgerParity(
      [record({ action: 'order', error: undefined, actualAfter: 1 })],
      [{ barTime: 100, target: 1 }],
    ),
  ).toEqual([]);
});

test('parity reports duplicate cycles instead of overwriting them', () => {
  const duplicate = record({ cycleId: 'cycle-2' });
  expect(compareLedgerParity([record(), duplicate], [{ barTime: 100, target: 1 }])).toContainEqual(
    expect.objectContaining({ kind: 'duplicate-live', barTime: 100 }),
  );
});

test('parity refuses to mix runs in one comparison', () => {
  expect(
    compareLedgerParity(
      [record(), record({ runId: 'other', cycleId: 'other', bar: { ...record().bar, time: 200 } })],
      [],
    ),
  ).toEqual([expect.objectContaining({ kind: 'mixed-live-scope' })]);
});
