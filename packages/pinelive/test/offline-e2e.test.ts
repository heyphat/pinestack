import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { ReplayProvider, StaticProvider } from '@heyphat/pinery';
import { MemoryLedger, PaperBroker, compareLedgerParity, runForwardServer } from '../src/index.js';

test('pinery replay → piner → paper → versioned ledger is deterministic', async () => {
  const source = await readFile(
    new URL('./strategies/position-toggle.pine', import.meta.url),
    'utf8',
  );
  const bars = [
    { time: 100, open: 2, high: 2, low: 1, close: 1, volume: 1 },
    { time: 200, open: 1, high: 2, low: 1, close: 2, volume: 1 },
    { time: 300, open: 2, high: 2, low: 1, close: 1, volume: 1 },
    { time: 400, open: 2, high: 2, low: 1, close: 1, volume: 1 },
    { time: 500, open: 1, high: 2, low: 1, close: 2, volume: 1 },
  ];
  const history = new StaticProvider({ ROOT: bars }).setInstrument('ROOT', {
    minQty: 1,
    mintick: 0.01,
  });
  const data = new ReplayProvider(history, {
    cutoverTime: 200,
    instrument: { venueSymbol: 'EXACT', minOrderQty: 1, pointValue: 1 },
  });
  const instrument = {
    symbol: 'EXACT',
    minQty: 1,
    qtyStep: 1,
    minOrderQty: 1,
    mintick: 0.01,
    pointValue: 1,
  };
  const broker = new PaperBroker({ instruments: { EXACT: instrument }, commissionPerUnit: 0.1 });
  const ledger = new MemoryLedger();
  const result = await runForwardServer({
    source,
    symbol: 'ROOT',
    timeframe: '1m',
    data,
    broker,
    ledger,
    warmupBars: 1,
    runId: 'offline',
  });
  expect(ledger.records.map((row) => row.bar.time)).toEqual([200, 300, 400, 500]);
  expect(ledger.bindings).toHaveLength(1);
  expect(ledger.bindings[0]?.binding).toEqual(
    expect.objectContaining({ strategySymbol: 'ROOT', executionSymbol: 'EXACT' }),
  );
  expect(result.binding.executionSymbol).toBe('EXACT');
  expect(new Set(ledger.records.map((row) => row.cycleId)).size).toBe(ledger.records.length);
  expect(
    ledger.records
      .filter((row) => row.fill)
      .every((row) => row.fill!.symbol === 'EXACT' && row.fill!.price === row.bar.close),
  ).toBe(true);
  const expected = ledger.records.map((row) => ({ barTime: row.bar.time, target: row.target }));
  expect(compareLedgerParity(ledger.records, expected)).toEqual([]);
});
