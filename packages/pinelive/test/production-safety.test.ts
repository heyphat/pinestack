import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryLedger,
  NodeExclusiveFileLease,
  SequencedLedger,
  createNodeAccountInstrumentClaim,
  readJsonl,
  readPineliveStatus,
  recoverLedger,
  recoverStalePineliveClaims,
  type LedgerEventV3,
} from '../src/node.js';

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pinelive-safety-'));
}

async function writeEvents(path: string, events: readonly LedgerEventV3[]): Promise<void> {
  await writeFile(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

async function staleOwnerFile(
  path: string,
  metadata: Readonly<Record<string, unknown>>,
): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({
      ...metadata,
      pid: 2_147_483_647,
      processIdentity: {
        kind: 'darwin-start-time',
        value: 'definitely-not-current',
        bootIdentityHash: 'sha256-dead-process',
      },
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

test('read-only status reports v3 ownership and partial-tail evidence without inventing posture', async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'ledger.jsonl');
    const memory = new MemoryLedger();
    const writer = new SequencedLedger(memory, {
      runId: 'status-run',
      executionId: 'status-execution',
      now: () => 1_000,
    });
    await writer.append({
      recordType: 'lease',
      action: 'acquired',
      resource: path,
      leaseId: 'lease-status',
      ownerId: 'owner-status',
    });
    await writer.append({
      recordType: 'account-claim',
      action: 'acquired',
      resourceDigest: `sha256-${'a'.repeat(64)}`,
      claimId: 'claim-status',
      ownerId: 'owner-status',
    });
    await writer.flush();
    await writeFile(
      path,
      `${memory.events.map((event) => JSON.stringify(event)).join('\n')}\n{"schemaVersion":`,
      'utf8',
    );

    const status = await readPineliveStatus({ ledgerPath: path, now: new Date(2_000) });
    expect(status).toMatchObject({
      statusVersion: 1,
      generatedAt: new Date(2_000).toISOString(),
      identity: { runId: 'status-run', executionId: 'status-execution' },
      posture: { availability: 'not-recorded' },
      ledger: {
        path,
        ledgerSchemaVersion: 3,
        lastSequence: 2,
        partialTail: true,
      },
    });
    expect(status.ownership.durableLedgerLease).toMatchObject({
      availability: 'known',
      value: { leaseId: 'lease-status' },
    });
    expect(status.ownership.durableAccountClaim).toMatchObject({
      availability: 'known',
      value: { claimId: 'claim-status' },
    });
    expect(status.breaker).toEqual({
      availability: 'known',
      value: { latched: false, consecutiveErrors: 0 },
    });
    expect(status.warnings).toContainEqual({
      code: 'partial-tail',
      message: 'the final incomplete JSONL fragment was excluded from status',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('read-only status rejects schema 1 and 2 ledgers', async () => {
  const dir = await temporaryDirectory();
  try {
    for (const schemaVersion of [1, 2]) {
      const path = join(dir, `schema-${schemaVersion}.jsonl`);
      await writeFile(
        path,
        `${JSON.stringify({
          schemaVersion,
          sequence: 1,
          recordType: 'lease',
          runId: 'status-rejection',
          executionId: 'status-rejection-execution',
          action: 'acquired',
          resource: 'ledger',
          leaseId: 'lease',
          ownerId: 'owner',
          recordedAt: new Date(0).toISOString(),
        })}\n`,
        'utf8',
      );
      await expect(readPineliveStatus({ ledgerPath: path })).rejects.toThrow(
        'schemaVersion must be 3',
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit recovery quarantines only definitely-dead matching claims and journals exact loss', async () => {
  const dir = await temporaryDirectory();
  try {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const leasePath = join(dir, 'ledger.lock');
    const administrativeLeasePath = `${leasePath}.admin.lock`;
    const accountClaimPath = join(dir, 'account.lock');
    const memory = new MemoryLedger();
    let timestamp = 1_000;
    const writer = new SequencedLedger(memory, {
      runId: 'recovery-run',
      executionId: 'recovery-execution',
      now: () => timestamp++,
    });
    await writer.append({
      recordType: 'binding',
      binding: {
        bindingVersion: 2,
        id: `binding-v2-${'e'.repeat(64)}`,
        fingerprint: `binding-v2-${'e'.repeat(64)}`,
        strategySymbol: 'X',
        providerId: 'recovery-provider',
        providerHandle: 'recovery-handle',
        executionSymbol: 'X',
        qtyStep: 1,
        minOrderQty: 1,
        mintick: 0.01,
        brokerId: 'tiger',
        authority: {
          algorithm: 'sha256',
          identity: `sha256-${'f'.repeat(64)}`,
          prepared: {},
        } as never,
      },
    });
    await writer.append({
      recordType: 'lease',
      action: 'acquired',
      resource: ledgerPath,
      leaseId: 'old-lease',
      ownerId: 'old-owner',
    });
    await writer.append({
      recordType: 'account-claim',
      action: 'acquired',
      resourceDigest: `sha256-${'b'.repeat(64)}`,
      claimId: 'old-claim',
      ownerId: 'old-owner',
    });
    await writer.append({
      recordType: 'execution-eligibility',
      posture: 'live',
      state: 'enabled',
      reasons: [],
      accountClaim: 'held',
      synchronization: 'synchronized',
    });
    await writer.flush();
    await writeEvents(ledgerPath, memory.events);
    await staleOwnerFile(leasePath, {
      leaseVersion: 2,
      resource: ledgerPath,
      leaseId: 'old-lease',
      ownerId: 'old-owner',
    });
    await staleOwnerFile(accountClaimPath, {
      claimVersion: 1,
      kind: 'account-instrument',
      resourceDigest: `sha256-${'b'.repeat(64)}`,
      claimId: 'old-claim',
      ownerId: 'old-owner',
    });
    await staleOwnerFile(administrativeLeasePath, {
      leaseVersion: 2,
      resource: `pinelive-admin:${ledgerPath}`,
      leaseId: 'old-admin-lease',
      ownerId: 'old-admin-owner',
    });

    await expect(
      recoverStalePineliveClaims({
        ledgerPath,
        leasePath,
        accountClaimPath,
        confirmed: false,
      }),
    ).rejects.toThrow('explicit confirmation');

    const recovered = await recoverStalePineliveClaims({
      ledgerPath,
      leasePath,
      accountClaimPath,
      confirmed: true,
    });
    expect(recovered.recovered).toBe(true);
    expect(recovered.quarantinedPaths).toHaveLength(3);
    for (const quarantined of recovered.quarantinedPaths)
      expect((await stat(quarantined)).isFile()).toBe(true);
    await expect(stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(administrativeLeasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(accountClaimPath)).rejects.toMatchObject({ code: 'ENOENT' });

    const records = await readJsonl<LedgerEventV3>(ledgerPath);
    const state = recoverLedger(records);
    expect(state.activeLease).toBeUndefined();
    expect(state.activeAccountClaim).toBeUndefined();
    expect(state.executionEligibility).toMatchObject({
      posture: 'live',
      state: 'blocked',
      reasons: ['explicit recovery proved the prior runtime dead and revoked execution capability'],
      accountClaim: 'not-held',
      synchronization: 'blocked',
    });
    const status = await readPineliveStatus({ ledgerPath });
    expect(status.executionEligibility).toEqual({
      availability: 'known',
      value: {
        state: 'blocked',
        reasons: [
          'explicit recovery proved the prior runtime dead and revoked execution capability',
        ],
      },
    });
    expect(
      records.some(
        (event) =>
          event.recordType === 'account-claim' &&
          event.action === 'lost' &&
          event.claimId === 'old-claim' &&
          event.ownerId === 'old-owner',
      ),
    ).toBe(true);
    expect(
      records.some(
        (event) =>
          event.recordType === 'lease' &&
          event.action === 'lost' &&
          event.leaseId === 'old-lease' &&
          event.ownerId === 'old-owner',
      ),
    ).toBe(true);
    expect((await readFile(ledgerPath, 'utf8')).endsWith('\n')).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit recovery refuses a claim owned by the current process instance', async () => {
  const dir = await temporaryDirectory();
  try {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const leasePath = join(dir, 'ledger.lock');
    const memory = new MemoryLedger();
    const writer = new SequencedLedger(memory, {
      runId: 'live-run',
      executionId: 'live-execution',
    });
    await writer.append({
      recordType: 'lease',
      action: 'acquired',
      resource: ledgerPath,
      leaseId: 'live-lease',
      ownerId: 'live-owner',
    });
    await writer.flush();
    await writeEvents(ledgerPath, memory.events);
    await writeFile(
      leasePath,
      `${JSON.stringify({
        leaseVersion: 2,
        resource: ledgerPath,
        leaseId: 'live-lease',
        ownerId: 'live-owner',
        pid: process.pid,
      })}\n`,
      'utf8',
    );

    await expect(
      recoverStalePineliveClaims({
        ledgerPath,
        leasePath,
        confirmed: true,
      }),
    ).rejects.toThrow('not proven dead');
    expect((await stat(leasePath)).isFile()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('account/instrument claims contend without automatic stale-owner takeover', async () => {
  const dir = await temporaryDirectory();
  const resource = {
    identity: {
      identityVersion: 1 as const,
      brokerId: 'tiger',
      opaqueAccountId: 'demo-account',
      environment: 'test',
    },
    executionSymbol: 'MGCZ26',
  };
  const existing = createNodeAccountInstrumentClaim(resource, {
    root: dir,
    ownerId: 'stale-owner',
    claimId: 'stale-claim',
  });
  try {
    await existing.acquire();
    const staleBody = `${JSON.stringify({
      claimVersion: 1,
      kind: 'account-instrument',
      resourceDigest: existing.resourceDigest,
      accountDigest: existing.accountDigest,
      instrumentDigest: existing.instrumentDigest,
      claimId: 'stale-claim',
      ownerId: 'stale-owner',
      acquiredAt: new Date(0).toISOString(),
      pid: 2_147_483_647,
      processIdentity: {
        kind: 'darwin-start-time',
        value: 'definitely-not-current',
        bootIdentityHash: 'sha256-dead-process',
      },
    })}\n`;
    await writeFile(existing.path, staleBody, 'utf8');

    const contender = createNodeAccountInstrumentClaim(resource, {
      root: dir,
      ownerId: 'new-owner',
      claimId: 'new-claim',
    });
    await expect(contender.acquire()).rejects.toMatchObject({ code: 'contended' });
    expect(contender.snapshot).toBeUndefined();
    expect(await readFile(existing.path, 'utf8')).toBe(staleBody);
  } finally {
    if (existing.snapshot) await existing.release();
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit recovery refuses an account claim not owned by the target ledger', async () => {
  const dir = await temporaryDirectory();
  try {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const leasePath = join(dir, 'ledger.lock');
    const unrelatedClaimPath = join(dir, 'unrelated-account.lock');
    const memory = new MemoryLedger();
    const writer = new SequencedLedger(memory, {
      runId: 'unmatched-claim-run',
      executionId: 'unmatched-claim-execution',
      now: () => 1_000,
    });
    await writer.append({
      recordType: 'lease',
      action: 'acquired',
      resource: ledgerPath,
      leaseId: 'matching-lease',
      ownerId: 'matching-owner',
    });
    await writer.flush();
    await writeEvents(ledgerPath, memory.events);
    await staleOwnerFile(leasePath, {
      leaseVersion: 2,
      resource: ledgerPath,
      leaseId: 'matching-lease',
      ownerId: 'matching-owner',
    });
    await staleOwnerFile(unrelatedClaimPath, {
      claimVersion: 1,
      kind: 'account-instrument',
      resourceDigest: `sha256-${'c'.repeat(64)}`,
      claimId: 'unrelated-claim',
      ownerId: 'unrelated-owner',
    });

    await expect(
      recoverStalePineliveClaims({
        ledgerPath,
        leasePath,
        accountClaimPath: unrelatedClaimPath,
        confirmed: true,
      }),
    ).rejects.toThrow('does not match durable ledger ownership');
    expect((await stat(leasePath)).isFile()).toBe(true);
    expect((await stat(unrelatedClaimPath)).isFile()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('pre-journal account recovery requires matching boot-bound identities', async () => {
  const dir = await temporaryDirectory();
  try {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const leasePath = join(dir, 'ledger.lock');
    const accountClaimPath = join(dir, 'pre-journal-account.lock');
    const ownerId = 'missing-identity-owner';
    const memory = new MemoryLedger();
    const writer = new SequencedLedger(memory, {
      runId: 'missing-identity-run',
      executionId: 'missing-identity-execution',
      now: () => 1_000,
    });
    await writer.append({
      recordType: 'lease',
      action: 'acquired',
      resource: ledgerPath,
      leaseId: 'missing-identity-lease',
      ownerId,
    });
    await writer.flush();
    await writeEvents(ledgerPath, memory.events);
    await writeFile(
      leasePath,
      `${JSON.stringify({
        leaseVersion: 2,
        resource: ledgerPath,
        leaseId: 'missing-identity-lease',
        ownerId,
        pid: 2_147_483_647,
      })}\n`,
      'utf8',
    );
    await staleOwnerFile(accountClaimPath, {
      claimVersion: 1,
      kind: 'account-instrument',
      resourceDigest: `sha256-${'8'.repeat(64)}`,
      claimId: 'missing-identity-claim',
      ownerId,
    });

    await expect(
      recoverStalePineliveClaims({
        ledgerPath,
        leasePath,
        accountClaimPath,
        confirmed: true,
      }),
    ).rejects.toThrow('does not match durable ledger ownership');
    expect((await stat(leasePath)).isFile()).toBe(true);
    expect((await stat(accountClaimPath)).isFile()).toBe(true);

    await staleOwnerFile(leasePath, {
      leaseVersion: 2,
      resource: ledgerPath,
      leaseId: 'missing-identity-lease',
      ownerId,
    });
    await writeFile(
      accountClaimPath,
      `${JSON.stringify({
        claimVersion: 1,
        kind: 'account-instrument',
        resourceDigest: `sha256-${'8'.repeat(64)}`,
        claimId: 'missing-identity-claim',
        ownerId,
        pid: 2_147_483_647,
      })}\n`,
      'utf8',
    );
    await expect(
      recoverStalePineliveClaims({
        ledgerPath,
        leasePath,
        accountClaimPath,
        confirmed: true,
      }),
    ).rejects.toThrow('does not match durable ledger ownership');
    expect((await stat(leasePath)).isFile()).toBe(true);
    expect((await stat(accountClaimPath)).isFile()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit recovery accepts only an exact same-process pre-journal account claim', async () => {
  const dir = await temporaryDirectory();
  try {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const leasePath = join(dir, 'ledger.lock');
    const accountClaimPath = join(dir, 'pre-journal-account.lock');
    const ownerId = 'uncertain-account-owner';
    const memory = new MemoryLedger();
    const writer = new SequencedLedger(memory, {
      runId: 'uncertain-account-run',
      executionId: 'uncertain-account-execution',
      now: () => 1_000,
    });
    await writer.append({
      recordType: 'lease',
      action: 'acquired',
      resource: ledgerPath,
      leaseId: 'uncertain-account-lease',
      ownerId,
    });
    await writer.flush();
    await writeEvents(ledgerPath, memory.events);
    await staleOwnerFile(leasePath, {
      leaseVersion: 2,
      resource: ledgerPath,
      leaseId: 'uncertain-account-lease',
      ownerId,
    });
    await staleOwnerFile(accountClaimPath, {
      claimVersion: 1,
      kind: 'account-instrument',
      resourceDigest: `sha256-${'9'.repeat(64)}`,
      claimId: 'uncertain-account-claim',
      ownerId,
    });

    const recovered = await recoverStalePineliveClaims({
      ledgerPath,
      leasePath,
      accountClaimPath,
      confirmed: true,
    });
    expect(recovered.quarantinedPaths).toHaveLength(2);
    expect(recoverLedger(await readJsonl<LedgerEventV3>(ledgerPath)).activeLease).toBeUndefined();
    await expect(stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(accountClaimPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit recovery clears a release-started claim whose physical artifact is already absent', async () => {
  const dir = await temporaryDirectory();
  try {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const leasePath = join(dir, 'ledger.lock');
    const absentClaimPath = join(dir, 'already-released-account.lock');
    const resourceDigest = `sha256-${'d'.repeat(64)}`;
    const memory = new MemoryLedger();
    const writer = new SequencedLedger(memory, {
      runId: 'release-started-run',
      executionId: 'release-started-execution',
      now: () => 1_000,
    });
    await writer.append({
      recordType: 'lease',
      action: 'acquired',
      resource: ledgerPath,
      leaseId: 'release-started-lease',
      ownerId: 'release-started-owner',
    });
    await writer.append({
      recordType: 'account-claim',
      action: 'acquired',
      resourceDigest,
      claimId: 'release-started-claim',
      ownerId: 'release-started-owner',
    });
    await writer.append({
      recordType: 'account-claim',
      action: 'release-started',
      resourceDigest,
      claimId: 'release-started-claim',
      ownerId: 'release-started-owner',
    });
    await writer.flush();
    await writeEvents(ledgerPath, memory.events);
    await staleOwnerFile(leasePath, {
      leaseVersion: 2,
      resource: ledgerPath,
      leaseId: 'release-started-lease',
      ownerId: 'release-started-owner',
    });

    const recovered = await recoverStalePineliveClaims({
      ledgerPath,
      leasePath,
      accountClaimPath: absentClaimPath,
      confirmed: true,
    });
    expect(recovered.quarantinedPaths).toHaveLength(1);
    const state = recoverLedger(await readJsonl<LedgerEventV3>(ledgerPath));
    expect(state.activeLease).toBeUndefined();
    expect(state.activeAccountClaim).toBeUndefined();
    expect(state.accountClaimReleaseStarted).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit recovery quarantines a dead physical lease left after durable release', async () => {
  const dir = await temporaryDirectory();
  try {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const leasePath = join(dir, 'ledger.lock');
    const ownerId = 'released-residual-owner';
    const leaseId = 'released-residual-lease';
    const memory = new MemoryLedger();
    const writer = new SequencedLedger(memory, {
      runId: 'released-residual-run',
      executionId: 'released-residual-execution',
      now: () => 1_000,
    });
    await writer.append({
      recordType: 'lease',
      action: 'acquired',
      resource: ledgerPath,
      leaseId,
      ownerId,
    });
    await writer.append({
      recordType: 'lease',
      action: 'released',
      resource: ledgerPath,
      leaseId,
      ownerId,
    });
    await writer.flush();
    await writeEvents(ledgerPath, memory.events);
    await staleOwnerFile(leasePath, {
      leaseVersion: 2,
      resource: ledgerPath,
      leaseId,
      ownerId,
    });

    const recovered = await recoverStalePineliveClaims({
      ledgerPath,
      leasePath,
      confirmed: true,
    });
    expect(recovered.quarantinedPaths).toHaveLength(1);
    expect(recoverLedger(await readJsonl<LedgerEventV3>(ledgerPath)).activeLease).toBeUndefined();
    await expect(stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicit recovery quarantines an exact pre-journal lease only with its stale administrative owner', async () => {
  const dir = await temporaryDirectory();
  try {
    const ledgerPath = join(dir, 'never-created-ledger.jsonl');
    const leasePath = join(dir, 'pre-journal.lock');
    const administrativeLeasePath = `${leasePath}.admin.lock`;
    const ownerId = 'pre-journal-owner';
    await staleOwnerFile(administrativeLeasePath, {
      leaseVersion: 2,
      resource: `pinelive-admin:${ledgerPath}`,
      leaseId: 'pre-journal-admin-lease',
      ownerId,
    });
    await staleOwnerFile(leasePath, {
      leaseVersion: 2,
      resource: ledgerPath,
      leaseId: 'pre-journal-execution-lease',
      ownerId: 'different-pre-journal-owner',
    });

    await expect(
      recoverStalePineliveClaims({ ledgerPath, leasePath, confirmed: true }),
    ).rejects.toThrow('does not match the stale administrative owner');
    expect((await stat(leasePath)).isFile()).toBe(true);
    expect((await stat(administrativeLeasePath)).isFile()).toBe(true);

    // Correcting only the mismatched execution evidence must permit an immediate retry. The failed
    // attempt restores the exact stale administrative metadata instead of stranding it in quarantine.
    await staleOwnerFile(leasePath, {
      leaseVersion: 2,
      resource: ledgerPath,
      leaseId: 'pre-journal-execution-lease',
      ownerId,
    });

    const recovered = await recoverStalePineliveClaims({
      ledgerPath,
      leasePath,
      confirmed: true,
    });
    expect(recovered).toMatchObject({
      recovered: true,
      previousLastSequence: 0,
      finalSequence: 0,
    });
    expect(recovered.quarantinedPaths).toHaveLength(2);
    await expect(stat(administrativeLeasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(ledgerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed pre-journal evidence restoration never clobbers a concurrent administrative owner', async () => {
  const dir = await temporaryDirectory();
  let contender: NodeExclusiveFileLease | undefined;
  try {
    const ledgerPath = join(dir, 'never-created-ledger.jsonl');
    const leasePath = join(dir, 'pre-journal.lock');
    const administrativeLeasePath = `${leasePath}.admin.lock`;
    await staleOwnerFile(administrativeLeasePath, {
      leaseVersion: 2,
      resource: `pinelive-admin:${ledgerPath}`,
      leaseId: 'stale-admin-lease',
      ownerId: 'stale-admin-owner',
    });
    await staleOwnerFile(leasePath, {
      leaseVersion: 2,
      resource: ledgerPath,
      leaseId: 'mismatched-execution-lease',
      ownerId: 'different-execution-owner',
    });

    await expect(
      recoverStalePineliveClaims({
        ledgerPath,
        leasePath,
        confirmed: true,
        beforeAdministrativeEvidenceRestore: async () => {
          contender = new NodeExclusiveFileLease(administrativeLeasePath, {
            resource: `pinelive-admin:${ledgerPath}`,
            ownerId: 'concurrent-owner',
            leaseId: 'concurrent-admin-lease',
          });
          await contender.acquire();
        },
      }),
    ).rejects.toThrow('stale-claim recovery and cleanup failed');

    await contender!.assertHeld();
    expect(JSON.parse(await readFile(administrativeLeasePath, 'utf8'))).toMatchObject({
      ownerId: 'concurrent-owner',
      leaseId: 'concurrent-admin-lease',
    });
    const retainedEvidence = (await readdir(dir)).filter((name) =>
      name.startsWith('pre-journal.lock.admin.lock.stale-'),
    );
    expect(retainedEvidence).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, retainedEvidence[0]!), 'utf8'))).toMatchObject({
      ownerId: 'stale-admin-owner',
      leaseId: 'stale-admin-lease',
    });
    expect((await stat(leasePath)).isFile()).toBe(true);
  } finally {
    if (contender?.snapshot) await contender.release();
    await rm(dir, { recursive: true, force: true });
  }
});
