import { expect, test } from 'bun:test';
import { compareLedgerParity } from '../src/parity.js';
import type { EvaluationCompletedEventV3, LedgerEventV3 } from '../src/core/ledger.js';

function record(overrides: Partial<EvaluationCompletedEventV3> = {}): EvaluationCompletedEventV3 {
  return {
    schemaVersion: 3,
    sequence: 1,
    recordType: 'evaluation.completed',
    runId: 'run',
    executionId: 'execution',
    decisionId: 'decision',
    strategyId: 'strategy',
    strategySymbol: 'ROOT',
    executionSymbol: 'X',
    bindingId: 'binding',
    timeframe: '1m',
    barTime: 100,
    cursor: 'cursor',
    update: {
      kind: 'close-only',
      eventId: 'event',
      revision: 1,
      authoritativeFinal: true,
      recovered: false,
      discontinuity: false,
    },
    target: 1,
    actualBefore: 0,
    actualAfter: 0,
    delta: 1,
    outcome: 'reject',
    error: { name: 'BrokerError', code: 'reject', message: 'blocked', retryable: false },
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
      [record({ outcome: 'noop', error: undefined, actualAfter: null })],
      [{ barTime: 100, target: 1 }],
    )[0]?.kind,
  ).toBe('execution-drift');
  expect(
    compareLedgerParity(
      [record({ outcome: 'order', error: undefined, actualAfter: 1 })],
      [{ barTime: 100, target: 1 }],
    ),
  ).toEqual([]);
});

test('parity reports duplicate durable completions instead of overwriting them', () => {
  const duplicate = record({
    sequence: 2,
    decisionId: 'decision-2',
    update: {
      kind: 'intrabar',
      eventId: 'event-2',
      revision: 2,
      authoritativeFinal: true,
      recovered: false,
      discontinuity: false,
    },
  });
  expect(compareLedgerParity([record(), duplicate], [{ barTime: 100, target: 1 }])).toContainEqual(
    expect.objectContaining({ kind: 'duplicate-live', barTime: 100 }),
  );
});

test('parity refuses to mix durable scopes in one comparison', () => {
  expect(
    compareLedgerParity(
      [record(), record({ runId: 'other', decisionId: 'other', barTime: 200 })],
      [],
    ),
  ).toEqual([expect.objectContaining({ kind: 'mixed-live-scope' })]);
});

test('parity ignores non-completion events and rejects old schemas', () => {
  const lease: LedgerEventV3 = {
    schemaVersion: 3,
    sequence: 1,
    recordType: 'lease',
    runId: 'run',
    executionId: 'execution',
    action: 'acquired',
    resource: 'ledger',
    leaseId: 'lease',
    ownerId: 'owner',
    recordedAt: new Date(0).toISOString(),
  };
  expect(compareLedgerParity([lease], [])).toEqual([]);
  expect(() => compareLedgerParity([{ ...lease, schemaVersion: 2 }], [])).toThrow(
    'schemaVersion must be 3',
  );
});
