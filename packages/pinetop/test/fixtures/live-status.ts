import type {
  LiveActiveDiscoveredRunV1,
  LivePineliveStatusV1,
  LiveTerminalDiscoveredRunV1,
  PineliveStatusListItemV1,
  PineliveStatusListV1,
} from '../../src/run/live-status.js';

export const ACTIVE_INSTANCE = 'a'.repeat(32);
export const TERMINAL_INSTANCE = 'b'.repeat(32);
export const OTHER_INSTANCE = 'c'.repeat(32);
export const GENERATED_AT = '2026-08-01T12:00:00.000Z';

export function durableStatus(
  identity: { runId?: string; executionId?: string } = {
    runId: 'run-active',
    executionId: 'execution-active',
  },
): LivePineliveStatusV1 {
  return {
    statusVersion: 1,
    generatedAt: GENERATED_AT,
    identity,
    posture: { availability: 'known', value: 'monitor' },
    executionEligibility: {
      availability: 'known',
      value: { state: 'blocked', reasons: ['official transport is monitor-only'] },
    },
    ownership: {
      durableLedgerLease: {
        availability: 'known',
        value: {
          resource: '/tmp/pinelive-live-test/ledger.jsonl',
          leaseId: 'lease-1',
          ownerId: 'owner-1',
          acquiredAt: GENERATED_AT,
        },
      },
      durableAccountClaim: {
        availability: 'known',
        value: {
          resourceDigest: 'account-resource-digest',
          claimId: 'claim-1',
          ownerId: 'owner-1',
          acquiredAt: GENERATED_AT,
        },
      },
    },
    breaker: {
      availability: 'known',
      value: { latched: false, consecutiveErrors: 0 },
    },
    unresolvedEffects: {
      availability: 'known',
      value: [
        {
          logicalOrderId: 'order-ambiguous-1',
          certainty: 'resolution-required',
          target: 2,
          delta: 1,
        },
      ],
    },
    latestObservation: {
      availability: 'known',
      value: {
        decisionId: 'decision-42',
        target: 2,
        barTime: 1_775_210_400,
        observedAt: GENERATED_AT,
        recordType: 'evaluation.completed',
      },
    },
    recent: [{ recordType: 'evaluation.completed', sequence: 42, recordedAt: GENERATED_AT }],
    ledger: {
      path: '/tmp/pinelive-live-test/ledger.jsonl',
      bytes: 4_200,
      validBytes: 4_100,
      partialTail: true,
      ledgerSchemaVersion: 3,
      lastSequence: 42,
      lastRecordAt: GENERATED_AT,
    },
    warnings: [{ code: 'partial-tail', message: 'incomplete final fragment excluded' }],
  };
}

export function activeRun(instanceId = ACTIVE_INSTANCE): LiveActiveDiscoveredRunV1 {
  return {
    discoveryVersion: 1,
    kind: 'active',
    generatedAt: GENERATED_AT,
    instanceId,
    registration: {
      registrationVersion: 1,
      instanceId,
      pid: 42,
      lifecycle: 'running',
      startedAt: '2026-08-01T11:55:00.000Z',
      heartbeatAt: '2026-08-01T11:59:58.000Z',
      updatedAt: '2026-08-01T11:59:58.000Z',
      configVersion: 3,
      runId: 'run-active',
      executionId: 'execution-active',
      brokerId: 'tiger',
      posture: 'monitor',
      paths: {
        ledger: '/tmp/pinelive-live-test/ledger.jsonl',
        executionLease: '/tmp/pinelive-live-test/ledger.lease',
        accountClaim: '/tmp/pinelive-live-test/account.claim',
      },
      display: {
        strategyId: 'mean-reversion',
        executionSymbol: 'XAUUSD',
        timeframe: '1h',
      },
    },
    durable: durableStatus(),
    lifecycle: {
      state: 'running',
      process: { state: 'matching' },
      heartbeatAgeMs: 2_000,
      heartbeatStale: false,
      physicalExecutionLease: { availability: 'known', value: 'same-owner' },
      physicalAccountClaim: { availability: 'known', value: 'same-owner' },
      reasons: [],
    },
    warnings: [
      {
        code: 'duplicate-execution-id',
        message: 'another record reports this execution identity',
      },
    ],
  };
}

export function terminalRun(instanceId = TERMINAL_INSTANCE): LiveTerminalDiscoveredRunV1 {
  return {
    discoveryVersion: 1,
    kind: 'terminal',
    generatedAt: GENERATED_AT,
    instanceId,
    history: {
      historyVersion: 1,
      instanceId,
      runId: 'run-terminal',
      executionId: 'execution-terminal',
      startedAt: '2026-08-01T10:00:00.000Z',
      endedAt: '2026-08-01T11:00:00.000Z',
      outcome: 'execution-latched',
      finalLedgerPath: '/tmp/pinelive-live-test/terminal.jsonl',
      finalLedgerSequence: 42,
      finalReasonCode: 'execution.breaker-latched',
      configVersion: 3,
      brokerId: 'paper',
      posture: 'live',
    },
    durable: {
      availability: 'known',
      value: durableStatus({ runId: 'run-terminal', executionId: 'execution-terminal' }),
    },
    lifecycle: { state: 'stopped', reasons: [] },
    warnings: [],
  };
}

export function errorItem(path = '/tmp/pinelive-live-test/corrupt.json'): PineliveStatusListItemV1 {
  return {
    ok: false,
    path,
    error: { code: 'corrupt-record', message: 'registry record could not be validated' },
  };
}

export function liveSnapshot(
  items: readonly PineliveStatusListItemV1[] = [
    { ok: true, value: activeRun() },
    { ok: true, value: terminalRun() },
    errorItem(),
  ],
): PineliveStatusListV1 {
  return { statusListVersion: 1, generatedAt: GENERATED_AT, items };
}
