import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlLedger, readJsonl } from '../src/node.js';
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

test('JSONL ledger serializes concurrent append calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinelive-'));
  try {
    const path = join(dir, 'nested', 'ledger.jsonl');
    const ledger = new JsonlLedger(path);
    await Promise.all([
      ledger.append(record(1)),
      ledger.append(record(2)),
      ledger.append(record(3)),
    ]);
    await ledger.close();
    expect((await readJsonl<ForwardRecord>(path)).map((row) => row.sequence)).toEqual([1, 2, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
