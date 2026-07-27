import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  CsvReplayFeed,
  MemoryLedger,
  PaperBroker,
  compareLedgerParity,
  runForwardServer,
} from '../src/index.js';

test('offline CSV → piner → paper → ledger pipeline is deterministic and sane', async () => {
  const source = await readFile(
    new URL('./strategies/position-toggle.pine', import.meta.url),
    'utf8',
  );
  const csv = `time,open,high,low,close,volume\n100,2,2,1,1,1\n200,1,2,1,2,1\n300,2,2,1,1,1\n400,2,2,1,1,1\n500,1,2,1,2,1`;
  const instrument = { symbol: 'X', minQty: 1, mintick: 0.01, pointValue: 1 };
  const broker = new PaperBroker({ instruments: { X: instrument }, commissionPerUnit: 0.1 });
  const ledger = new MemoryLedger();
  await runForwardServer({
    source,
    symbol: 'X',
    timeframe: '1m',
    broker,
    feed: new CsvReplayFeed(csv, { warmupBars: 1, nowSec: 1_000 }),
    ledger,
    warmupBars: 1,
    runId: 'offline',
  });
  expect(ledger.records.map((row) => row.bar.time)).toEqual([100, 200, 300, 400, 500]);
  expect(new Set(ledger.records.map((row) => row.cycleId)).size).toBe(ledger.records.length);
  expect(
    ledger.records.filter((row) => row.fill).every((row) => row.fill!.price === row.bar.close),
  ).toBe(true);
  const expected = ledger.records.map((row) => ({ barTime: row.bar.time, target: row.target }));
  expect(compareLedgerParity(ledger.records, expected)).toEqual([]);
});
