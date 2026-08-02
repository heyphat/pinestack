import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutionLeaseError,
  JsonlLedger,
  MemoryLedger,
  NodeExclusiveFileLease,
  SequencedLedger,
  readJsonl,
  readJsonlPrefix,
  recoverLedger,
} from '../src/node.js';
import type { LedgerEventV3 } from '../src/index.js';

const record = (sequence: number): LedgerEventV3 => ({
  schemaVersion: 3,
  sequence,
  recordType: 'lease',
  runId: 'run',
  executionId: 'execution',
  action: 'acquired',
  resource: 'ledger',
  leaseId: `lease-${sequence}`,
  ownerId: 'owner',
  recordedAt: new Date(0).toISOString(),
});

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pinelive-'));
}

test('JSONL ledger serializes concurrent file-handle appends and keeps mode 0600', async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'nested', 'ledger.jsonl');
    const ledger = new JsonlLedger(path, { durability: 'sync' });
    await Promise.all([
      ledger.append(record(1)),
      ledger.append(record(2)),
      ledger.append(record(3)),
    ]);
    await ledger.close();
    expect((await readJsonl<LedgerEventV3>(path)).map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sync failure poisons the ledger after the possibly-written row', async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'ledger.jsonl');
    const failure = new Error('disk sync failed');
    const ledger = new JsonlLedger(path, {
      durability: 'sync',
      syncFile: async () => {
        throw failure;
      },
    });
    await expect(ledger.append(record(1))).rejects.toBe(failure);
    await expect(ledger.append(record(2))).rejects.toBe(failure);
    expect((await readJsonl<LedgerEventV3>(path)).map((row) => row.sequence)).toEqual([1]);
    await expect(ledger.close()).rejects.toBe(failure);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('crash-prefix parsing tolerates only an opted-in partial final line', async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'ledger.jsonl');
    await writeFile(path, '{"n":1}\n{"n":', 'utf8');
    await expect(readJsonl(path)).rejects.toThrow(':2: invalid JSON');
    const prefix = await readJsonlPrefix<{ n: number }>(path, { allowPartialFinalLine: true });
    expect(prefix.records).toEqual([{ n: 1 }]);
    expect(prefix.partialFinalLine).toBe('{"n":');
    expect(prefix.validBytes).toBe(Buffer.byteLength('{"n":1}\n'));

    await writeFile(path, '{"n":1}\n{"bad":}\n{"n":2}', 'utf8');
    await expect(readJsonl(path, true)).rejects.toThrow(':2: invalid JSON');

    await writeFile(path, '{"n":1}\n{"n":2}', 'utf8');
    expect(await readJsonl(path, true)).toEqual([{ n: 1 }, { n: 2 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exclusive file lease rejects contention and permits acquisition after release', async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'execution.lock');
    const first = new NodeExclusiveFileLease(path, { ownerId: 'one', leaseId: 'lease-one' });
    const second = new NodeExclusiveFileLease(path, { ownerId: 'two', leaseId: 'lease-two' });
    await first.acquire();
    await expect(second.acquire()).rejects.toBeInstanceOf(ExecutionLeaseError);
    await first.release();
    expect((await second.acquire()).ownerId).toBe('two');
    await second.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sequenced ledger fails closed before safe-integer overflow', async () => {
  const memory = new MemoryLedger();
  const ledger = new SequencedLedger(memory, {
    runId: 'run',
    executionId: 'execution',
    nextSequence: Number.MAX_SAFE_INTEGER,
  });
  await expect(
    ledger.append({
      recordType: 'lease',
      action: 'acquired',
      resource: 'resource',
      leaseId: 'lease',
      ownerId: 'owner',
    }),
  ).rejects.toThrow('sequence is exhausted');
  expect(memory.events).toHaveLength(0);
});

test('crash-prefix mode rejects blank records and syntactically impossible tails', async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'ledger.jsonl');
    await writeFile(path, '{"n":1}\n\n', 'utf8');
    await expect(readJsonl(path, true)).rejects.toThrow(':2: blank JSONL record');

    await writeFile(path, '{"n":1}\n{"x":]', 'utf8');
    await expect(readJsonl(path, true)).rejects.toThrow(':2: invalid JSON');

    await writeFile(path, '{"n":1}\n{"nested":[true,{"value":1e', 'utf8');
    expect((await readJsonlPrefix<{ n: number }>(path, true)).records).toEqual([{ n: 1 }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sequenced ledger rejects clock rollback before allocating or writing a row', async () => {
  const memory = new MemoryLedger();
  const timestamps = [2_000, 1_000];
  const ledger = new SequencedLedger(memory, {
    runId: 'run',
    executionId: 'execution',
    now: () => timestamps.shift()!,
  });
  await ledger.append({
    recordType: 'lease',
    action: 'acquired',
    resource: 'clock-test',
    leaseId: 'lease',
    ownerId: 'owner',
  });
  await expect(
    ledger.append({
      recordType: 'lease',
      action: 'released',
      resource: 'clock-test',
      leaseId: 'lease',
      ownerId: 'owner',
    }),
  ).rejects.toThrow('clock moved backwards');
  expect(ledger.nextSequence).toBe(2);
  expect(memory.events).toHaveLength(1);
  expect(() => recoverLedger(memory.events)).not.toThrow();

  const restarted = new SequencedLedger(memory, {
    runId: 'run',
    executionId: 'execution',
    nextSequence: 2,
    lastTimestamp: 2_000,
    now: () => 1_000,
  });
  await expect(
    restarted.append({
      recordType: 'lease',
      action: 'released',
      resource: 'clock-test',
      leaseId: 'lease',
      ownerId: 'owner',
    }),
  ).rejects.toThrow('clock moved backwards');
  expect(restarted.nextSequence).toBe(2);
  expect(memory.events).toHaveLength(1);
  expect(() => recoverLedger(memory.events)).not.toThrow();
});

test('JSONL ledger repairs partial and unterminated complete tails under its lease', async () => {
  const dir = await temporaryDirectory();
  try {
    const first = JSON.stringify(record(1));
    const second = JSON.stringify(record(2));
    const cases = [
      { name: 'partial', bytes: `${first}\n{"schemaVersion":` },
      { name: 'complete', bytes: first },
    ];
    for (const fixture of cases) {
      const path = join(dir, `${fixture.name}.jsonl`);
      await writeFile(path, fixture.bytes, 'utf8');
      const ledger = new JsonlLedger(path, {
        durability: 'sync',
        lease: true,
        tailPolicy: 'repair',
      });
      await ledger.append(record(2));
      await ledger.close();
      expect(await readFile(path, 'utf8')).toBe(`${first}\n${second}\n`);
      expect((await readJsonl<LedgerEventV3>(path)).map((row) => row.sequence)).toEqual([1, 2]);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('JSONL ledger refuses dirty tails without mutating or an exclusive repair lease', async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'dirty.jsonl');
    const bytes = `${JSON.stringify(record(1))}\n{"schemaVersion":`;
    await writeFile(path, bytes, 'utf8');

    const strict = new JsonlLedger(path);
    await expect(strict.append(record(2))).rejects.toThrow('not newline-terminated');
    expect(await readFile(path, 'utf8')).toBe(bytes);
    await expect(strict.close()).rejects.toThrow('not newline-terminated');

    const unleasedRepair = new JsonlLedger(path, { tailPolicy: 'repair' });
    await expect(unleasedRepair.append(record(2))).rejects.toThrow('requires an exclusive');
    expect(await readFile(path, 'utf8')).toBe(bytes);
    await expect(unleasedRepair.close()).rejects.toThrow('requires an exclusive');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('externally managed JSONL leases survive ledger close until the runtime releases them', async () => {
  const dir = await temporaryDirectory();
  try {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const leasePath = join(dir, 'ledger.lock');
    const lease = new NodeExclusiveFileLease(leasePath, {
      resource: ledgerPath,
      ownerId: 'runtime-owner',
      leaseId: 'runtime-lease',
    });
    await lease.acquire();
    const ledger = new JsonlLedger(ledgerPath, {
      durability: 'sync',
      lease,
      releaseLeaseOnClose: false,
    });
    await ledger.append(record(1));
    await ledger.close();

    await expect(lease.assertHeld()).resolves.toBeUndefined();
    expect((await stat(leasePath)).isFile()).toBe(true);
    await lease.release();
    await expect(stat(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recovery accepts schema 3 and rejects schema 1 and 2 records', () => {
  const current = {
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
  } as const;

  expect(recoverLedger([current])).toMatchObject({ lastSequence: 1, nextSequence: 2 });
  for (const schemaVersion of [1, 2]) {
    expect(() => recoverLedger([{ ...current, schemaVersion }])).toThrow('schemaVersion must be 3');
  }
});

test('recovery requires the strong binding and authority shape', () => {
  const weakBinding = {
    schemaVersion: 3,
    sequence: 1,
    recordType: 'binding',
    runId: 'run',
    executionId: 'execution',
    binding: {
      id: 'binding-incomplete',
      fingerprint: 'binding-incomplete',
      strategySymbol: 'ROOT',
      providerId: 'provider',
      providerHandle: 'provider:ROOT',
      executionSymbol: 'X',
      qtyStep: 1,
      minOrderQty: 1,
      mintick: 0.01,
      brokerId: 'paper',
    },
    recordedAt: new Date(0).toISOString(),
  } as const;
  expect(() => recoverLedger([weakBinding])).toThrow('binding.bindingVersion must be 2');

  const strongBinding = {
    ...weakBinding,
    binding: {
      ...weakBinding.binding,
      bindingVersion: 2,
      id: `binding-v2-${'a'.repeat(64)}`,
      authority: {
        algorithm: 'sha256',
        identity: `sha256-${'b'.repeat(64)}`,
        prepared: {},
      },
    },
  } as const;
  expect(() => recoverLedger([strongBinding])).not.toThrow();
});

test('status rejects schema 1 and 2, reads schema 3, and reports an empty ledger as not-recorded', async () => {
  const dir = await temporaryDirectory();
  try {
    const { readPineliveStatus } = await import('../src/node.js');
    const current = {
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
    } as const;

    for (const schemaVersion of [1, 2]) {
      const path = join(dir, `schema-${schemaVersion}.jsonl`);
      await writeFile(path, `${JSON.stringify({ ...current, schemaVersion })}\n`, 'utf8');
      await expect(readPineliveStatus({ ledgerPath: path })).rejects.toThrow(
        'schemaVersion must be 3',
      );
    }

    const currentPath = join(dir, 'schema-3.jsonl');
    await writeFile(currentPath, `${JSON.stringify(current)}\n`, 'utf8');
    const status = await readPineliveStatus({ ledgerPath: currentPath });
    expect(status.ledger).toMatchObject({ ledgerSchemaVersion: 3, lastSequence: 1 });
    expect(status.ownership.durableLedgerLease).toMatchObject({
      availability: 'known',
      value: { leaseId: 'lease' },
    });

    const emptyPath = join(dir, 'empty.jsonl');
    await writeFile(emptyPath, '', 'utf8');
    const empty = await readPineliveStatus({ ledgerPath: emptyPath });
    expect(empty.ledger.ledgerSchemaVersion).toBeUndefined();
    expect(empty.breaker).toMatchObject({ availability: 'not-recorded' });
    expect(empty.unresolvedEffects).toMatchObject({ availability: 'not-recorded' });
    expect(empty.counters).toMatchObject({ availability: 'not-recorded' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
