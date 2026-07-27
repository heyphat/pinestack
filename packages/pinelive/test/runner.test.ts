import { expect, test } from 'bun:test';
import {
  CsvReplayFeed,
  ForwardRunner,
  ForwardRunnerError,
  PaperBroker,
  type ForwardRecord,
} from '../src/index.js';

const strategy = `//@version=6
strategy("tick", default_qty_type=strategy.fixed, default_qty_value=1)
if close > open
    strategy.entry("L", strategy.long)
else
    strategy.close("L")`;
const bars = [
  { time: 100, open: 2, high: 2, low: 1, close: 1, volume: 1 },
  { time: 200, open: 1, high: 2, low: 1, close: 2, volume: 1 },
  { time: 300, open: 2, high: 2, low: 1, close: 1, volume: 1 },
  { time: 400, open: 2, high: 2, low: 1, close: 1, volume: 1 },
];

test('runner primes then advances one committed tick and marks paper before reconcile', async () => {
  const instrument = { symbol: 'X', minQty: 1, mintick: 0.01 };
  const broker = new PaperBroker({ instruments: { X: instrument } });
  const feed = new CsvReplayFeed(bars, { warmupBars: 1, nowSec: 1_000 });
  const records: ForwardRecord[] = [];
  const runner = new ForwardRunner(broker, feed, {
    source: strategy,
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 1,
    onRecord: (record) => {
      records.push(record);
    },
  });
  await runner.start();
  expect(records.map((record) => record.bar.time)).toEqual([100, 200, 300, 400]);
  expect(records.some((record) => record.action === 'order')).toBe(true);
  expect(
    records.every((record, index) => index === 0 || record.bar.time > records[index - 1]!.bar.time),
  ).toBe(true);
});

test('runner rejects indicators and request.security explicitly', async () => {
  const instrument = { symbol: 'X', minQty: 1, mintick: 0.01 };
  const broker = new PaperBroker({ instruments: { X: instrument } });
  const feed = new CsvReplayFeed(bars, { warmupBars: 1, nowSec: 1_000 });
  await expect(
    new ForwardRunner(broker, feed, {
      source: '//@version=6\nindicator("x")\nplot(close)',
      symbol: 'X',
      timeframe: '1m',
    }).init(),
  ).rejects.toBeInstanceOf(ForwardRunnerError);
  const security = '//@version=6\nstrategy("x")\nx=request.security("Y", "60", close)\nplot(x)';
  await expect(
    new ForwardRunner(broker, feed, { source: security, symbol: 'X', timeframe: '1m' }).init(),
  ).rejects.toThrow('request.security');
});
