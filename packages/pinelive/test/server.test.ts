import { expect, test } from 'bun:test';
import { ReplayProvider, StaticProvider, type Bar, type MarketDataProvider } from '@heyphat/pinery';
import {
  MemoryLedger,
  PaperBroker,
  runForwardServer,
  type LedgerRecord,
  type LedgerSink,
} from '../src/index.js';

const source = `//@version=6
strategy("server", default_qty_type=strategy.fixed, default_qty_value=1)
strategy.entry("L", strategy.long)`;
const instrument = { symbol: 'X', minQty: 1, qtyStep: 1, minOrderQty: 1, mintick: 0.01 };

function replay(bars: Bar[] = []): MarketDataProvider {
  const history = new StaticProvider({ X: bars }).setInstrument('X', { minQty: 1, mintick: 0.01 });
  return new ReplayProvider(history, { cutoverTime: 200, instrument: { minOrderQty: 1 } });
}

test('pre-aborted server refuses startup without reconciling', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  const ledger = new MemoryLedger();
  const controller = new AbortController();
  controller.abort();
  await expect(
    runForwardServer({
      source,
      symbol: 'X',
      timeframe: '1m',
      broker,
      data: replay(),
      ledger,
      signal: controller.signal,
    }),
  ).rejects.toThrow('aborted');
  expect(ledger.records).toHaveLength(0);
});

test('server records only yielded cycles and exits without flattening', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  const bars = [1, 2, 3].map((value) => ({
    time: value * 100,
    open: 1,
    high: 2,
    low: 1,
    close: 2,
    volume: 1,
  }));
  const ledger = new MemoryLedger();
  const result = await runForwardServer({
    source,
    symbol: 'X',
    timeframe: '1m',
    broker,
    data: replay(bars),
    ledger,
    warmupBars: 1,
  });
  expect(ledger.records).toHaveLength(2);
  expect(ledger.bindings).toHaveLength(1);
  expect(result.finalPosition).toBe(1);
  expect((await broker.getPosition('X')).qty).toBe(1);
});

test('abort during delayed warmup prevents any order', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  let releaseHistory!: (bars: Bar[]) => void;
  let historyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    historyStarted = resolve;
  });
  const data: MarketDataProvider = {
    id: 'delayed',
    history: async () => [],
    resolve: async () => ({
      strategySymbol: 'X',
      providerHandle: 'delayed:X',
      venueSymbol: 'X',
      mintick: 0.01,
      qtyStep: 1,
      minOrderQty: 1,
    }),
    historyResolved: async () => {
      historyStarted();
      return new Promise<Bar[]>((resolve) => {
        releaseHistory = resolve;
      });
    },
    closedBars: async function* () {},
  };
  const ledger = new MemoryLedger();
  const controller = new AbortController();
  const running = runForwardServer({
    source,
    symbol: 'X',
    timeframe: '1m',
    broker,
    data,
    ledger,
    signal: controller.signal,
  });
  await started;
  controller.abort();
  releaseHistory([{ time: 100, open: 1, high: 2, low: 1, close: 2, volume: 1 }]);
  await expect(running).rejects.toThrow('aborted');
  expect(ledger.records).toHaveLength(0);
  expect((await broker.getPosition('X')).qty).toBe(0);
});

test('server attempts every cleanup operation after cleanup failures', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  let disconnected = false;
  broker.disconnect = async () => {
    disconnected = true;
  };
  const data: MarketDataProvider = {
    id: 'cleanup',
    history: async () => [],
    resolve: async () => ({
      strategySymbol: 'X',
      providerHandle: 'cleanup:X',
      venueSymbol: 'X',
      mintick: 0.01,
      qtyStep: 1,
      minOrderQty: 1,
    }),
    historyResolved: async () => [],
    closedBars: async function* () {},
    disconnect: async () => {
      throw new Error('stop failed');
    },
  };
  let flushed = false;
  let closed = false;
  const ledger: LedgerSink = {
    append: async (_record: LedgerRecord) => {},
    flush: async () => {
      flushed = true;
      throw new Error('flush failed');
    },
    close: async () => {
      closed = true;
    },
  };
  await expect(
    runForwardServer({ source, symbol: 'X', timeframe: '1m', broker, data, ledger }),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(flushed).toBe(true);
  expect(disconnected).toBe(true);
  expect(closed).toBe(true);
});
