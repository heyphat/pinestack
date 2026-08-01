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
import type { ForwardRecord } from '../src/index.js';

const record = (sequence: number): ForwardRecord => ({
  schemaVersion: 1,
  runId: 'run',
  strategyId: 's',
  cycleId: `c${sequence}`,
  sequence,
  symbol: 'X',
  timeframe: '1m',
  bar: { time: sequence, open: 1, high: 1, low: 1, close: 1, volume: 0 },
  target: 0,
  actualBefore: 0,
  actualAfter: 0,
  delta: 0,
  action: 'noop',
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
    expect((await readJsonl<ForwardRecord>(path)).map((row) => row.sequence)).toEqual([1, 2, 3]);
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
    expect((await readJsonl<ForwardRecord>(path)).map((row) => row.sequence)).toEqual([1]);
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
      expect((await readJsonl<ForwardRecord>(path)).map((row) => row.sequence)).toEqual([1, 2]);
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
