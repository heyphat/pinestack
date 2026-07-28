import { expect, test } from 'bun:test';
import { ReplayProvider, StaticProvider, type MarketDataProvider } from '@heyphat/pinery';
import {
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

function data(): MarketDataProvider {
  const source = new StaticProvider({ X: bars }).setInstrument('X', { minQty: 1, mintick: 0.01 });
  return new ReplayProvider(source, { cutoverTime: 200, instrument: { minOrderQty: 1 } });
}

test('runner warms without ordering then advances exactly one cycle per pinery yield', async () => {
  const instrument = { symbol: 'X', minQty: 1, qtyStep: 1, minOrderQty: 1, mintick: 0.01 };
  const broker = new PaperBroker({ instruments: { X: instrument } });
  const records: ForwardRecord[] = [];
  const runner = new ForwardRunner(data(), broker, {
    source: strategy,
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 1,
    onRecord: (record) => {
      records.push(record);
    },
  });
  await runner.start();
  expect(records.map((record) => record.bar.time)).toEqual([200, 300, 400]);
  expect(
    records.every(
      (record) =>
        record.bindingId && record.strategySymbol === 'X' && record.executionSymbol === 'X',
    ),
  ).toBe(true);
});

test('runner emits startup reconciliation only when explicitly enabled', async () => {
  const instrument = { symbol: 'X', minQty: 1, qtyStep: 1, minOrderQty: 1, mintick: 0.01 };
  const broker = new PaperBroker({ instruments: { X: instrument } });
  const startup: unknown[] = [];
  await new ForwardRunner(data(), broker, {
    source: strategy,
    symbol: 'X',
    timeframe: '1m',
    warmupBars: 1,
    reconcileOnStart: true,
    onStartupRecord: (record) => {
      startup.push(record);
    },
  }).start();
  expect(startup).toHaveLength(1);
  expect(startup[0]).toEqual(expect.objectContaining({ recordType: 'startup' }));
});

test('runner fails closed on binding metadata mismatch before any order', async () => {
  const broker = new PaperBroker({ instruments: { X: { symbol: 'X', minQty: 2, mintick: 0.01 } } });
  await expect(
    new ForwardRunner(data(), broker, { source: strategy, symbol: 'X', timeframe: '1m' }).init(),
  ).rejects.toThrow('qtyStep');
  expect((await broker.getPosition('X')).qty).toBe(0);
});

test('runner rejects indicators and request.security explicitly', async () => {
  const instrument = { symbol: 'X', minQty: 1, mintick: 0.01 };
  const broker = new PaperBroker({ instruments: { X: instrument } });
  await expect(
    new ForwardRunner(data(), broker, {
      source: '//@version=6\nindicator("x")\nplot(close)',
      symbol: 'X',
      timeframe: '1m',
    }).init(),
  ).rejects.toBeInstanceOf(ForwardRunnerError);
  const security = '//@version=6\nstrategy("x")\nx=request.security("Y", "60", close)\nplot(x)';
  await expect(
    new ForwardRunner(data(), broker, { source: security, symbol: 'X', timeframe: '1m' }).init(),
  ).rejects.toThrow('request.security');
});
