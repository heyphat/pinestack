import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NodeRunRegistry,
  PHYSICAL_CLAIM_RECORD_MAX_BYTES,
  StatusDiscoveryError,
  decodePhysicalAccountClaimV1,
  decodePhysicalExecutionLeaseV2,
  readPineliveInstanceStatus,
  readPineliveStatusList,
  type ActiveRunRegistrationV1,
  type PineliveStatus,
  type ProcessOwnerProbe,
  type RunHistoryRecordV1,
  type RunRegistryEnumeration,
} from '../src/node.js';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');
const NOW = new Date(BASE_TIME + 10_000);
const PROCESS_IDENTITY = {
  kind: 'linux-start-ticks' as const,
  value: '1234',
  bootIdentityHash: 'a'.repeat(64),
};

function instanceId(index: number): string {
  return index.toString(16).padStart(32, '0');
}

function active(
  root: string,
  index: number,
  overrides: Partial<ActiveRunRegistrationV1> = {},
): ActiveRunRegistrationV1 {
  const id = instanceId(index);
  return {
    registrationVersion: 1,
    instanceId: id,
    pid: 10_000 + index,
    processIdentity: PROCESS_IDENTITY,
    lifecycle: 'running',
    startedAt: new Date(BASE_TIME).toISOString(),
    heartbeatAt: new Date(BASE_TIME + 5_000).toISOString(),
    updatedAt: new Date(BASE_TIME + 5_000).toISOString(),
    configVersion: 3,
    runId: `run-${index}`,
    executionId: `execution-${index}`,
    brokerId: 'compute-only',
    posture: 'compute-only',
    paths: { ledger: join(root, `${id}.jsonl`) },
    ...overrides,
  };
}

function history(
  root: string,
  index: number,
  overrides: Partial<RunHistoryRecordV1> = {},
): RunHistoryRecordV1 {
  const registration = active(root, index);
  return {
    historyVersion: 1,
    instanceId: registration.instanceId,
    runId: registration.runId,
    executionId: registration.executionId,
    startedAt: registration.startedAt,
    endedAt: new Date(BASE_TIME + 9_000).toISOString(),
    outcome: 'stopped',
    finalLedgerPath: registration.paths.ledger,
    finalLedgerSequence: 1,
    configVersion: 3,
    brokerId: registration.brokerId,
    posture: registration.posture,
    ...overrides,
  };
}

function durable(
  ledgerPath: string,
  identity: { runId?: string; executionId?: string } = {},
  overrides: Partial<PineliveStatus> = {},
): PineliveStatus {
  return {
    statusVersion: 1,
    generatedAt: NOW.toISOString(),
    identity,
    posture: { availability: 'not-recorded', reason: 'not recorded' },
    executionEligibility: { availability: 'not-recorded', reason: 'not recorded' },
    ownership: {
      durableLedgerLease: { availability: 'not-recorded', reason: 'no active durable lease' },
      durableAccountClaim: { availability: 'not-recorded', reason: 'no active durable claim' },
    },
    breaker: { availability: 'known', value: { latched: false, consecutiveErrors: 0 } },
    unresolvedEffects: { availability: 'known', value: [] },
    latestObservation: { availability: 'not-recorded', reason: 'not recorded' },
    counters: { availability: 'not-recorded', reason: 'not recorded' },
    recent: [],
    ledger: {
      path: ledgerPath,
      bytes: 1,
      validBytes: 1,
      partialTail: false,
      ledgerSchemaVersion: 3,
      lastSequence: 1,
    },
    warnings: [],
    ...overrides,
  };
}

function registry(enumeration: RunRegistryEnumeration): {
  enumerate(): Promise<RunRegistryEnumeration>;
} {
  return { enumerate: async () => enumeration };
}

function statusReader(statuses: ReadonlyMap<string, PineliveStatus>) {
  return async ({ ledgerPath }: { ledgerPath: string }): Promise<PineliveStatus> => {
    const status = statuses.get(ledgerPath);
    if (!status) throw new Error('unmapped durable status');
    return status;
  };
}

const matchingProbe = async (): Promise<ProcessOwnerProbe> => ({
  state: 'matching',
  identity: PROCESS_IDENTITY,
});

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pinelive-status-discovery-'));
}

function successfulValues(list: Awaited<ReturnType<typeof readPineliveStatusList>>) {
  return list.items.flatMap((item) => (item.ok ? [item.value] : []));
}

test('active aggregate and exact-instance reads preserve durable V1 and derive fresh running state', async () => {
  const root = '/tmp/pinelive-discovery-active';
  const registration = active(root, 1);
  const status = durable(registration.paths.ledger, {
    runId: registration.runId,
    executionId: registration.executionId,
  });
  const options = {
    registry: registry({
      entries: [{ instanceId: registration.instanceId, active: registration }],
      errors: [],
    }),
    now: NOW,
    processProbe: matchingProbe,
    statusReader: statusReader(new Map([[registration.paths.ledger, status]])),
  };

  const list = await readPineliveStatusList(options);
  expect(list).toMatchObject({ statusListVersion: 1, generatedAt: NOW.toISOString() });
  expect(list.items).toHaveLength(1);
  expect(list.items[0]).toMatchObject({
    ok: true,
    value: {
      discoveryVersion: 1,
      kind: 'active',
      durable: { statusVersion: 1 },
      lifecycle: {
        state: 'running',
        heartbeatAgeMs: 5_000,
        heartbeatStale: false,
        physicalExecutionLease: { availability: 'known', value: 'not-applicable' },
        physicalAccountClaim: { availability: 'known', value: 'not-applicable' },
        reasons: [],
      },
    },
  });
  expect(await readPineliveInstanceStatus(registration.instanceId, options)).toEqual(
    successfulValues(list)[0],
  );
  await expect(readPineliveInstanceStatus('invalid', options)).rejects.toMatchObject({
    code: 'invalid-instance-id',
  });
});

test('terminal history supports no-ledger failed startup and compatible history precedence', async () => {
  const root = '/tmp/pinelive-discovery-terminal';
  const failed = history(root, 1, {
    outcome: 'failed-startup',
    finalLedgerPath: undefined,
    finalLedgerSequence: undefined,
    finalReasonCode: 'storage-open-failed',
  });
  const leftover = active(root, 2);
  const completed = history(root, 2);
  const completedStatus = durable(completed.finalLedgerPath!, {
    runId: completed.runId,
    executionId: completed.executionId,
  });
  let reads = 0;
  const list = await readPineliveStatusList({
    registry: registry({
      entries: [
        { instanceId: failed.instanceId, history: failed },
        { instanceId: completed.instanceId, active: leftover, history: completed },
      ],
      errors: [],
    }),
    now: NOW,
    statusReader: async (options) => {
      reads++;
      return statusReader(new Map([[completed.finalLedgerPath!, completedStatus]]))(options);
    },
  });

  const values = successfulValues(list);
  const failedValue = values.find((value) => value.instanceId === failed.instanceId)!;
  const completedValue = values.find((value) => value.instanceId === completed.instanceId)!;
  expect(failedValue).toMatchObject({
    kind: 'terminal',
    durable: { availability: 'not-recorded' },
    lifecycle: { state: 'stopped' },
  });
  expect(completedValue).toMatchObject({
    kind: 'terminal',
    leftoverRegistration: { instanceId: leftover.instanceId },
    durable: { availability: 'known', value: { statusVersion: 1 } },
    warnings: [{ code: 'active-cleanup-incomplete' }],
  });
  expect(reads).toBe(1);
});

test('history identity and watermark mismatches are isolated normalized entry errors', async () => {
  const root = '/tmp/pinelive-discovery-mismatch';
  const mismatchedIdentityActive = active(root, 1);
  const mismatchedIdentityHistory = history(root, 1, { runId: 'different-run' });
  const mismatchedWatermark = history(root, 2, { finalLedgerSequence: 9 });
  const status = durable(mismatchedWatermark.finalLedgerPath!, {
    runId: mismatchedWatermark.runId,
    executionId: mismatchedWatermark.executionId,
  });
  const list = await readPineliveStatusList({
    registry: registry({
      entries: [
        {
          instanceId: mismatchedIdentityActive.instanceId,
          active: mismatchedIdentityActive,
          history: mismatchedIdentityHistory,
        },
        { instanceId: mismatchedWatermark.instanceId, history: mismatchedWatermark },
      ],
      errors: [],
    }),
    now: NOW,
    statusReader: statusReader(new Map([[mismatchedWatermark.finalLedgerPath!, status]])),
  });

  expect(list.items).toEqual([
    expect.objectContaining({
      ok: false,
      instanceIdHint: mismatchedIdentityActive.instanceId,
      error: { code: 'history-active-mismatch', message: expect.any(String) },
    }),
    expect.objectContaining({
      ok: false,
      instanceIdHint: mismatchedWatermark.instanceId,
      error: { code: 'history-watermark-mismatch', message: expect.any(String) },
    }),
  ]);
  await expect(
    readPineliveInstanceStatus(mismatchedWatermark.instanceId, {
      registry: registry({
        entries: [{ instanceId: mismatchedWatermark.instanceId, history: mismatchedWatermark }],
        errors: [],
      }),
      now: NOW,
      statusReader: statusReader(new Map([[mismatchedWatermark.finalLedgerPath!, status]])),
    }),
  ).rejects.toBeInstanceOf(StatusDiscoveryError);
});

test('strict physical codecs compare same/different/absent ownership and preserve process evidence', async () => {
  const temporary = await temporaryDirectory();
  try {
    const leasePath = join(temporary, 'execution.lock');
    const claimPath = join(temporary, 'account.lock');
    const registration = active(temporary, 1, {
      paths: {
        ledger: join(temporary, 'ledger.jsonl'),
        executionLease: leasePath,
        accountClaim: claimPath,
      },
    });
    const resourceDigest = `sha256-${'b'.repeat(64)}`;
    const acquiredAt = new Date(BASE_TIME).toISOString();
    const lease = {
      leaseVersion: 2 as const,
      resource: registration.paths.ledger,
      leaseId: 'lease-1',
      ownerId: 'owner-1',
      acquiredAt,
      pid: registration.pid,
      processIdentity: PROCESS_IDENTITY,
    };
    const claim = {
      claimVersion: 1 as const,
      kind: 'account-instrument' as const,
      resourceDigest,
      accountDigest: 'c'.repeat(64),
      instrumentDigest: 'd'.repeat(64),
      claimId: 'claim-1',
      ownerId: 'owner-1',
      acquiredAt,
      pid: registration.pid,
      processIdentity: PROCESS_IDENTITY,
    };
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`, 'utf8');
    await writeFile(claimPath, `${JSON.stringify(claim)}\n`, 'utf8');
    expect(decodePhysicalExecutionLeaseV2(JSON.stringify(lease))).toEqual(lease);
    expect(decodePhysicalAccountClaimV1(JSON.stringify(claim))).toEqual(claim);
    expect(() =>
      decodePhysicalExecutionLeaseV2(
        JSON.stringify({ ...lease, credentialCanaryMustNotLeak: 'secret-value' }),
      ),
    ).toThrow('unsupported field');
    expect(() =>
      decodePhysicalExecutionLeaseV2(' '.repeat(PHYSICAL_CLAIM_RECORD_MAX_BYTES + 1)),
    ).toThrow('64 KiB');

    const status = durable(
      registration.paths.ledger,
      { runId: registration.runId, executionId: registration.executionId },
      {
        ownership: {
          durableLedgerLease: {
            availability: 'known',
            value: {
              resource: lease.resource,
              leaseId: lease.leaseId,
              ownerId: lease.ownerId,
              acquiredAt,
            },
          },
          durableAccountClaim: {
            availability: 'known',
            value: {
              resourceDigest,
              claimId: claim.claimId,
              ownerId: claim.ownerId,
              acquiredAt,
            },
          },
        },
      },
    );
    const same = await readPineliveStatusList({
      registry: registry({
        entries: [{ instanceId: registration.instanceId, active: registration }],
        errors: [],
      }),
      now: NOW,
      processProbe: matchingProbe,
      statusReader: statusReader(new Map([[registration.paths.ledger, status]])),
    });
    expect(same.items[0]).toMatchObject({
      ok: true,
      value: {
        lifecycle: {
          state: 'running',
          process: { state: 'matching' },
          physicalExecutionLease: { availability: 'known', value: 'same-owner' },
          physicalAccountClaim: { availability: 'known', value: 'same-owner' },
        },
      },
    });

    const differentStatus = {
      ...status,
      ownership: {
        ...status.ownership,
        durableAccountClaim: {
          availability: 'known' as const,
          value: { ...status.ownership.durableAccountClaim.value!, ownerId: 'different-owner' },
        },
      },
    };
    const different = await readPineliveStatusList({
      registry: registry({
        entries: [{ instanceId: registration.instanceId, active: registration }],
        errors: [],
      }),
      now: NOW,
      processProbe: matchingProbe,
      statusReader: statusReader(new Map([[registration.paths.ledger, differentStatus]])),
    });
    expect(different.items[0]).toMatchObject({
      ok: true,
      value: {
        lifecycle: {
          state: 'unknown',
          physicalAccountClaim: { availability: 'known', value: 'different-owner' },
        },
      },
    });

    await rm(leasePath);
    const absent = await readPineliveStatusList({
      registry: registry({
        entries: [{ instanceId: registration.instanceId, active: registration }],
        errors: [],
      }),
      now: NOW,
      processProbe: matchingProbe,
      statusReader: statusReader(new Map([[registration.paths.ledger, status]])),
    });
    expect(absent.items[0]).toMatchObject({
      ok: true,
      value: {
        lifecycle: {
          state: 'unknown',
          physicalExecutionLease: { availability: 'known', value: 'absent' },
        },
      },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('lifecycle priority covers starting, stopping, stale, stale-claim, crashed, and unsupported evidence', async () => {
  const root = '/tmp/pinelive-discovery-lifecycle';
  const registrations = [
    active(root, 1, { lifecycle: 'starting' }),
    active(root, 2, {
      lifecycle: 'stopping',
      heartbeatAt: new Date(BASE_TIME).toISOString(),
      updatedAt: new Date(BASE_TIME).toISOString(),
    }),
    active(root, 3, {
      heartbeatAt: new Date(BASE_TIME - 20_000).toISOString(),
      updatedAt: new Date(BASE_TIME).toISOString(),
    }),
    active(root, 4),
    active(root, 5),
    active(root, 6),
  ];
  const statuses = new Map(
    registrations.map((registration) => [
      registration.paths.ledger,
      durable(registration.paths.ledger, {
        runId: registration.runId,
        executionId: registration.executionId,
      }),
    ]),
  );
  const blocked = registrations[3]!;
  statuses.set(
    blocked.paths.ledger,
    durable(
      blocked.paths.ledger,
      { runId: blocked.runId, executionId: blocked.executionId },
      {
        ownership: {
          durableLedgerLease: {
            availability: 'known',
            value: {
              resource: blocked.paths.ledger,
              leaseId: 'stale-lease',
              ownerId: 'stale-owner',
              acquiredAt: new Date(BASE_TIME).toISOString(),
            },
          },
          durableAccountClaim: { availability: 'not-recorded', reason: 'none' },
        },
      },
    ),
  );
  const states = new Map<number, ProcessOwnerProbe>([
    [registrations[0]!.pid, { state: 'matching', identity: PROCESS_IDENTITY }],
    [registrations[1]!.pid, { state: 'matching', identity: PROCESS_IDENTITY }],
    [registrations[2]!.pid, { state: 'matching', identity: PROCESS_IDENTITY }],
    [registrations[3]!.pid, { state: 'dead', reason: 'recorded process is dead' }],
    [registrations[4]!.pid, { state: 'dead', reason: 'recorded process is dead' }],
    [registrations[5]!.pid, { state: 'unsupported', reason: 'process probe unsupported' }],
  ]);
  const list = await readPineliveStatusList({
    registry: registry({
      entries: registrations.map((registration) => ({
        instanceId: registration.instanceId,
        active: registration,
      })),
      errors: [],
    }),
    now: NOW,
    processProbe: async ({ pid }) => states.get(pid)!,
    statusReader: statusReader(statuses),
  });
  expect(
    successfulValues(list).map((value) => [
      value.instanceId,
      value.kind === 'active' ? value.lifecycle.state : 'terminal',
    ]),
  ).toEqual([
    [registrations[0]!.instanceId, 'starting'],
    [registrations[1]!.instanceId, 'stopping'],
    [registrations[2]!.instanceId, 'unknown'],
    [registrations[3]!.instanceId, 'blocked-stale-claim'],
    [registrations[4]!.instanceId, 'crashed'],
    [registrations[5]!.instanceId, 'unknown'],
  ]);
});

test('duplicate execution IDs and active account resources conflict without deriving eligibility', async () => {
  const temporary = await temporaryDirectory();
  try {
    const sharedResource = `sha256-${'e'.repeat(64)}`;
    const registrations = [1, 2].map((index) =>
      active(temporary, index, {
        executionId: 'duplicate-execution',
        paths: {
          ledger: join(temporary, `${instanceId(index)}.jsonl`),
          accountClaim: join(temporary, `account-${index}.lock`),
        },
      }),
    );
    const statuses = new Map<string, PineliveStatus>();
    for (const [offset, registration] of registrations.entries()) {
      const index = offset + 1;
      const ownerId = `owner-${index}`;
      const claimId = `claim-${index}`;
      await writeFile(
        registration.paths.accountClaim!,
        `${JSON.stringify({
          claimVersion: 1,
          kind: 'account-instrument',
          resourceDigest: sharedResource,
          accountDigest: 'a'.repeat(64),
          instrumentDigest: 'b'.repeat(64),
          claimId,
          ownerId,
          acquiredAt: new Date(BASE_TIME).toISOString(),
          pid: registration.pid,
          processIdentity: PROCESS_IDENTITY,
        })}\n`,
        'utf8',
      );
      statuses.set(
        registration.paths.ledger,
        durable(
          registration.paths.ledger,
          { runId: registration.runId, executionId: registration.executionId },
          {
            executionEligibility: {
              availability: 'known',
              value: { state: 'disabled-by-posture', reasons: ['compute-only posture'] },
            },
            ownership: {
              durableLedgerLease: { availability: 'not-recorded', reason: 'none' },
              durableAccountClaim: {
                availability: 'known',
                value: {
                  resourceDigest: sharedResource,
                  claimId,
                  ownerId,
                  acquiredAt: new Date(BASE_TIME).toISOString(),
                },
              },
            },
          },
        ),
      );
    }
    const list = await readPineliveStatusList({
      registry: registry({
        entries: [...registrations]
          .reverse()
          .map((registration) => ({ instanceId: registration.instanceId, active: registration })),
        errors: [],
      }),
      now: NOW,
      processProbe: matchingProbe,
      statusReader: statusReader(statuses),
    });
    for (const value of successfulValues(list)) {
      expect(value).toMatchObject({
        kind: 'active',
        durable: {
          executionEligibility: {
            availability: 'known',
            value: { state: 'disabled-by-posture' },
          },
        },
        lifecycle: { state: 'conflict' },
      });
      expect(value.warnings.map((warning) => warning.code)).toEqual([
        'active-account-claim-conflict',
        'duplicate-execution-id',
      ]);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('deterministic ordering and corrupt-entry isolation redact a canary secret', async () => {
  const temporary = await temporaryDirectory();
  const canary = 'credential-canary-must-never-appear';
  try {
    const root = join(temporary, 'runs');
    const nodeRegistry = new NodeRunRegistry({ rootDir: root });
    const byExecution = active(temporary, 3, { executionId: 'a-execution', runId: 'z-run' });
    const byRun = active(temporary, 1, { executionId: undefined, runId: 'a-run' });
    const byInstance = active(temporary, 2, { executionId: undefined, runId: undefined });
    for (const registration of [byInstance, byExecution, byRun])
      await nodeRegistry.writeActive(registration);
    const corruptId = instanceId(9);
    await writeFile(
      join(nodeRegistry.activeDir, `${corruptId}.json`),
      JSON.stringify({ registrationVersion: 1, instanceId: corruptId, [canary]: 'secret-value' }),
      'utf8',
    );
    const statuses = new Map(
      [byExecution, byRun, byInstance].map((registration) => [
        registration.paths.ledger,
        durable(registration.paths.ledger, {
          runId: registration.runId,
          executionId: registration.executionId,
        }),
      ]),
    );
    const first = await readPineliveStatusList({
      registry: nodeRegistry,
      now: NOW,
      processProbe: matchingProbe,
      statusReader: statusReader(statuses),
    });
    const second = await readPineliveStatusList({
      registry: nodeRegistry,
      now: NOW,
      processProbe: matchingProbe,
      statusReader: statusReader(statuses),
    });
    expect(first).toEqual(second);
    expect(
      first.items.map((item) => (item.ok ? item.value.instanceId : item.instanceIdHint)),
    ).toEqual([byExecution.instanceId, byRun.instanceId, byInstance.instanceId, corruptId]);
    expect(first.items.at(-1)).toMatchObject({ ok: false, error: { code: 'corrupt-record' } });
    expect(JSON.stringify(first)).not.toContain(canary);
    expect(JSON.stringify(first)).not.toContain('secret-value');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('physical ownership must bind to the registered process before running or stale-claim attribution', async () => {
  const temporary = await temporaryDirectory();
  try {
    const claimPath = join(temporary, 'foreign-account.lock');
    const registration = active(temporary, 1, {
      paths: { ledger: join(temporary, 'ledger.jsonl'), accountClaim: claimPath },
    });
    const resourceDigest = `sha256-${'f'.repeat(64)}`;
    const acquiredAt = new Date(BASE_TIME).toISOString();
    await writeFile(
      claimPath,
      `${JSON.stringify({
        claimVersion: 1,
        kind: 'account-instrument',
        resourceDigest,
        accountDigest: 'a'.repeat(64),
        instrumentDigest: 'b'.repeat(64),
        claimId: 'claim-foreign-process',
        ownerId: 'owner-foreign-process',
        acquiredAt,
        pid: registration.pid + 1,
        processIdentity: PROCESS_IDENTITY,
      })}\n`,
      'utf8',
    );
    const owned = durable(
      registration.paths.ledger,
      { runId: registration.runId, executionId: registration.executionId },
      {
        ownership: {
          durableLedgerLease: { availability: 'not-recorded', reason: 'none' },
          durableAccountClaim: {
            availability: 'known',
            value: {
              resourceDigest,
              claimId: 'claim-foreign-process',
              ownerId: 'owner-foreign-process',
              acquiredAt,
            },
          },
        },
      },
    );
    const matching = await readPineliveStatusList({
      registry: registry({
        entries: [{ instanceId: registration.instanceId, active: registration }],
        errors: [],
      }),
      now: NOW,
      processProbe: matchingProbe,
      statusReader: statusReader(new Map([[registration.paths.ledger, owned]])),
    });
    expect(matching.items[0]).toMatchObject({
      ok: true,
      value: {
        lifecycle: {
          state: 'unknown',
          physicalAccountClaim: { availability: 'known', value: 'different-owner' },
        },
      },
    });

    const foreign = await readPineliveStatusList({
      registry: registry({
        entries: [{ instanceId: registration.instanceId, active: registration }],
        errors: [],
      }),
      now: NOW,
      processProbe: async () => ({ state: 'dead', reason: 'registered process is dead' }),
      statusReader: statusReader(
        new Map([
          [
            registration.paths.ledger,
            durable(registration.paths.ledger, {
              runId: registration.runId,
              executionId: registration.executionId,
            }),
          ],
        ]),
      ),
    });
    expect(foreign.items[0]).toMatchObject({
      ok: true,
      value: { lifecycle: { state: 'unknown' } },
    });
    expect(JSON.stringify(foreign)).not.toContain('blocked-stale-claim');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('duplicate and account-resource conflicts survive an independently failing entry', async () => {
  const temporary = await temporaryDirectory();
  try {
    const resourceDigest = `sha256-${'1'.repeat(64)}`;
    const acquiredAt = new Date(BASE_TIME).toISOString();
    const registrations = [1, 2].map((index) =>
      active(temporary, index, {
        executionId: 'duplicate-with-failure',
        paths: {
          ledger: join(temporary, `${instanceId(index)}.jsonl`),
          accountClaim: join(temporary, `partial-account-${index}.lock`),
        },
      }),
    );
    for (const [offset, registration] of registrations.entries()) {
      await writeFile(
        registration.paths.accountClaim!,
        `${JSON.stringify({
          claimVersion: 1,
          kind: 'account-instrument',
          resourceDigest,
          accountDigest: '2'.repeat(64),
          instrumentDigest: '3'.repeat(64),
          claimId: `partial-claim-${offset + 1}`,
          ownerId: `partial-owner-${offset + 1}`,
          acquiredAt,
          pid: registration.pid,
          processIdentity: PROCESS_IDENTITY,
        })}\n`,
        'utf8',
      );
    }
    const healthy = registrations[0]!;
    const healthyStatus = durable(
      healthy.paths.ledger,
      { runId: healthy.runId, executionId: healthy.executionId },
      {
        ownership: {
          durableLedgerLease: { availability: 'not-recorded', reason: 'none' },
          durableAccountClaim: {
            availability: 'known',
            value: {
              resourceDigest,
              claimId: 'partial-claim-1',
              ownerId: 'partial-owner-1',
              acquiredAt,
            },
          },
        },
      },
    );
    const list = await readPineliveStatusList({
      registry: registry({
        entries: registrations.map((registration) => ({
          instanceId: registration.instanceId,
          active: registration,
        })),
        errors: [],
      }),
      now: NOW,
      processProbe: matchingProbe,
      statusReader: async ({ ledgerPath }) => {
        if (ledgerPath === healthy.paths.ledger) return healthyStatus;
        throw new Error('credential-canary-from-bad-ledger');
      },
    });
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toMatchObject({
      ok: true,
      value: {
        instanceId: healthy.instanceId,
        lifecycle: { state: 'conflict' },
        warnings: [{ code: 'active-account-claim-conflict' }, { code: 'duplicate-execution-id' }],
      },
    });
    expect(list.items[1]).toMatchObject({
      ok: false,
      instanceIdHint: registrations[1]!.instanceId,
      error: { code: 'durable-status-error' },
    });
    expect(JSON.stringify(list)).not.toContain('credential-canary-from-bad-ledger');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('error items sort by path and exact lookup preserves registry error codes', async () => {
  const lowerHint = instanceId(1);
  const higherHint = instanceId(2);
  const errors = [
    {
      code: 'unsupported-version' as const,
      message: 'unsupported registrationVersion; expected 1',
      path: '/z/active.json',
      instanceIdHint: lowerHint,
    },
    {
      code: 'corrupt-record' as const,
      message: 'active registration could not be validated',
      path: '/a/active.json',
      instanceIdHint: higherHint,
    },
  ];
  const source = registry({ entries: [], errors });
  const list = await readPineliveStatusList({ registry: source, now: NOW });
  expect(list.items.map((item) => (!item.ok ? item.path : undefined))).toEqual([
    '/a/active.json',
    '/z/active.json',
  ]);
  await expect(
    readPineliveInstanceStatus(lowerHint, { registry: source, now: NOW }),
  ).rejects.toMatchObject({
    code: 'unsupported-version',
  });

  const root = '/tmp/pinelive-discovery-exact-corrupt-sibling';
  const registration = active(root, 1);
  const mixed = registry({
    entries: [{ instanceId: registration.instanceId, active: registration }],
    errors: [
      {
        code: 'corrupt-record',
        message: 'history record could not be validated',
        path: '/a/history.json',
        instanceIdHint: registration.instanceId,
      },
    ],
  });
  await expect(
    readPineliveInstanceStatus(registration.instanceId, {
      registry: mixed,
      now: NOW,
      processProbe: matchingProbe,
      statusReader: statusReader(
        new Map([
          [
            registration.paths.ledger,
            durable(registration.paths.ledger, {
              runId: registration.runId,
              executionId: registration.executionId,
            }),
          ],
        ]),
      ),
    }),
  ).rejects.toMatchObject({ code: 'corrupt-record' });
});

test('terminal histories remain readable after a shared append-only ledger grows', async () => {
  const temporary = await temporaryDirectory();
  try {
    const ledgerPath = join(temporary, 'shared-history.jsonl');
    const acquired = {
      schemaVersion: 3,
      sequence: 1,
      recordType: 'lease',
      runId: 'shared-history-run',
      executionId: 'shared-history-execution',
      action: 'acquired',
      resource: ledgerPath,
      leaseId: 'shared-history-lease',
      ownerId: 'shared-history-owner',
      recordedAt: new Date(1).toISOString(),
    } as const;
    const released = {
      ...acquired,
      sequence: 2,
      action: 'released',
      recordedAt: new Date(2).toISOString(),
    } as const;
    await writeFile(
      ledgerPath,
      `${JSON.stringify(acquired)}\n${JSON.stringify(released)}\n`,
      'utf8',
    );
    const first = history(temporary, 1, {
      runId: 'shared-history-run',
      executionId: 'shared-history-execution',
      finalLedgerPath: ledgerPath,
      finalLedgerSequence: 1,
    });
    const second = history(temporary, 2, {
      runId: 'shared-history-run',
      executionId: 'shared-history-execution',
      finalLedgerPath: ledgerPath,
      finalLedgerSequence: 2,
    });

    const list = await readPineliveStatusList({
      registry: registry({
        entries: [
          { instanceId: first.instanceId, history: first },
          { instanceId: second.instanceId, history: second },
        ],
        errors: [],
      }),
      now: NOW,
    });
    const values = successfulValues(list);
    expect(values).toHaveLength(2);
    const firstValue = values.find((value) => value.instanceId === first.instanceId)!;
    const secondValue = values.find((value) => value.instanceId === second.instanceId)!;
    expect(firstValue).toMatchObject({
      kind: 'terminal',
      durable: {
        availability: 'known',
        value: {
          ledger: { lastSequence: 1 },
          ownership: {
            durableLedgerLease: {
              availability: 'known',
              value: { leaseId: 'shared-history-lease' },
            },
          },
        },
      },
    });
    expect(secondValue).toMatchObject({
      kind: 'terminal',
      durable: { availability: 'known', value: { ledger: { lastSequence: 2 } } },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// Every CLI registration carries an executionLease path, including compute-only,
// whose posture journals no durable lease row at all. The fixtures above omit that
// path, which is why a healthy compute-only run reporting `lifecycle: unknown` was
// invisible to this suite. These cases model the real registration shape.
test('a compute-only run owning its physical state lock reports running, not unknown', async () => {
  const temporary = await temporaryDirectory();
  try {
    const leasePath = join(temporary, 'compute.lock');
    const registration = active(temporary, 1, {
      posture: 'compute-only',
      brokerId: 'compute-only',
      paths: { ledger: join(temporary, 'ledger.jsonl'), executionLease: leasePath },
    });
    const lease = {
      leaseVersion: 2 as const,
      resource: registration.paths.ledger,
      leaseId: 'compute-lease-1',
      ownerId: 'pinelive-runtime:compute',
      acquiredAt: new Date(BASE_TIME).toISOString(),
      pid: registration.pid,
      processIdentity: PROCESS_IDENTITY,
    };
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`, 'utf8');

    // A compute-only ledger durably records its posture and blocked eligibility, and
    // deliberately never records a lease row.
    const status = durable(
      registration.paths.ledger,
      { runId: registration.runId, executionId: registration.executionId },
      {
        posture: { availability: 'known', value: 'compute-only' },
        executionEligibility: {
          availability: 'known',
          value: {
            state: 'disabled-by-posture',
            reasons: ['compute-only posture does not permit broker execution'],
          },
        },
      },
    );

    const [value] = successfulValues(
      await readPineliveStatusList({
        registry: registry({
          entries: [{ instanceId: registration.instanceId, active: registration }],
          errors: [],
        }),
        now: NOW,
        processProbe: matchingProbe,
        statusReader: statusReader(new Map([[registration.paths.ledger, status]])),
      }),
    );

    expect(value).toMatchObject({
      kind: 'active',
      lifecycle: {
        state: 'running',
        physicalExecutionLease: { availability: 'known', value: 'same-owner' },
        physicalAccountClaim: { availability: 'known', value: 'not-applicable' },
        reasons: [],
      },
    });
    // The relaxation must not misrepresent durable evidence.
    expect(value.kind === 'active' && value.durable.ownership.durableLedgerLease).toMatchObject({
      availability: 'not-recorded',
    });
    expect(value.kind === 'active' && value.durable.executionEligibility).toMatchObject({
      availability: 'known',
      value: { state: 'disabled-by-posture' },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('the compute-only relaxation still requires exact physical process ownership', async () => {
  const temporary = await temporaryDirectory();
  try {
    const leasePath = join(temporary, 'compute.lock');
    const registration = active(temporary, 1, {
      posture: 'compute-only',
      paths: { ledger: join(temporary, 'ledger.jsonl'), executionLease: leasePath },
    });
    // Lock held by a different process than the registration claims.
    const lease = {
      leaseVersion: 2 as const,
      resource: registration.paths.ledger,
      leaseId: 'compute-lease-1',
      ownerId: 'pinelive-runtime:compute',
      acquiredAt: new Date(BASE_TIME).toISOString(),
      pid: registration.pid + 1,
      processIdentity: PROCESS_IDENTITY,
    };
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`, 'utf8');
    const status = durable(
      registration.paths.ledger,
      { runId: registration.runId, executionId: registration.executionId },
      { posture: { availability: 'known', value: 'compute-only' } },
    );

    const [value] = successfulValues(
      await readPineliveStatusList({
        registry: registry({
          entries: [{ instanceId: registration.instanceId, active: registration }],
          errors: [],
        }),
        now: NOW,
        processProbe: matchingProbe,
        statusReader: statusReader(new Map([[registration.paths.ledger, status]])),
      }),
    );

    expect(value).toMatchObject({
      kind: 'active',
      lifecycle: {
        state: 'unknown',
        physicalExecutionLease: { availability: 'known', value: 'different-owner' },
      },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a mirrored posture never gets the compute-only lease relaxation', async () => {
  const temporary = await temporaryDirectory();
  try {
    const leasePath = join(temporary, 'execution.lock');
    const registration = active(temporary, 1, {
      posture: 'live',
      brokerId: 'paper',
      paths: { ledger: join(temporary, 'ledger.jsonl'), executionLease: leasePath },
    });
    const lease = {
      leaseVersion: 2 as const,
      resource: registration.paths.ledger,
      leaseId: 'lease-1',
      ownerId: 'owner-1',
      acquiredAt: new Date(BASE_TIME).toISOString(),
      pid: registration.pid,
      processIdentity: PROCESS_IDENTITY,
    };
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`, 'utf8');
    // A live posture with a physical lock but NO durable lease row must stay a
    // mismatch: a mirrored run that lost its journaled ownership is not healthy.
    const status = durable(
      registration.paths.ledger,
      { runId: registration.runId, executionId: registration.executionId },
      { posture: { availability: 'known', value: 'live' } },
    );

    const [value] = successfulValues(
      await readPineliveStatusList({
        registry: registry({
          entries: [{ instanceId: registration.instanceId, active: registration }],
          errors: [],
        }),
        now: NOW,
        processProbe: matchingProbe,
        statusReader: statusReader(new Map([[registration.paths.ledger, status]])),
      }),
    );

    expect(value).toMatchObject({
      kind: 'active',
      lifecycle: {
        state: 'unknown',
        physicalExecutionLease: { availability: 'known', value: 'different-owner' },
        reasons: ['physical execution lease does not match durable ownership'],
      },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('a compute-only registration disagreeing with durable posture stays conservative', async () => {
  const temporary = await temporaryDirectory();
  try {
    const leasePath = join(temporary, 'compute.lock');
    // Registration claims compute-only; the durable ledger says live.
    const registration = active(temporary, 1, {
      posture: 'compute-only',
      paths: { ledger: join(temporary, 'ledger.jsonl'), executionLease: leasePath },
    });
    const lease = {
      leaseVersion: 2 as const,
      resource: registration.paths.ledger,
      leaseId: 'compute-lease-1',
      ownerId: 'pinelive-runtime:compute',
      acquiredAt: new Date(BASE_TIME).toISOString(),
      pid: registration.pid,
      processIdentity: PROCESS_IDENTITY,
    };
    await writeFile(leasePath, `${JSON.stringify(lease)}\n`, 'utf8');
    const status = durable(
      registration.paths.ledger,
      { runId: registration.runId, executionId: registration.executionId },
      { posture: { availability: 'known', value: 'live' } },
    );

    const [value] = successfulValues(
      await readPineliveStatusList({
        registry: registry({
          entries: [{ instanceId: registration.instanceId, active: registration }],
          errors: [],
        }),
        now: NOW,
        processProbe: matchingProbe,
        statusReader: statusReader(new Map([[registration.paths.ledger, status]])),
      }),
    );

    expect(value).toMatchObject({
      kind: 'active',
      lifecycle: {
        state: 'unknown',
        physicalExecutionLease: { availability: 'known', value: 'different-owner' },
      },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
