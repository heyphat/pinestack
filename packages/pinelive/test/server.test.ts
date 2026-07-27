import { expect, test } from 'bun:test';
import {
  CsvReplayFeed,
  MemoryLedger,
  PaperBroker,
  runForwardServer,
  type Bar,
  type ForwardRecord,
  type LedgerSink,
  type LiveFeed,
} from '../src/index.js';

const source = `//@version=6
strategy("server", default_qty_type=strategy.fixed, default_qty_value=1)
strategy.entry("L", strategy.long)`;

test('pre-aborted server refuses startup without reconciling', async () => {
  const instrument = { symbol: 'X', minQty: 1, mintick: 0.01 };
  const broker = new PaperBroker({ instruments: { X: instrument } });
  const feed = new CsvReplayFeed([], { nowSec: 1_000 });
  const ledger = new MemoryLedger();
  const controller = new AbortController();
  controller.abort();
  await expect(
    runForwardServer({
      source,
      symbol: 'X',
      timeframe: '1m',
      broker,
      feed,
      ledger,
      signal: controller.signal,
    }),
  ).rejects.toThrow('aborted');
  expect(ledger.records).toHaveLength(0);
});

test('server records cycles and exits without flattening', async () => {
  const instrument = { symbol: 'X', minQty: 1, mintick: 0.01 };
  const broker = new PaperBroker({ instruments: { X: instrument } });
  const bars = [1, 2, 3].map((time) => ({
    time: time * 100,
    open: 1,
    high: 2,
    low: 1,
    close: 2,
    volume: 1,
  }));
  const feed = new CsvReplayFeed(bars, { warmupBars: 1, nowSec: 1_000 });
  const ledger = new MemoryLedger();
  const result = await runForwardServer({
    source,
    symbol: 'X',
    timeframe: '1m',
    broker,
    feed,
    ledger,
    warmupBars: 1,
  });
  expect(ledger.records).toHaveLength(3);
  expect(result.finalPosition).toBe(1);
  expect((await broker.getPosition('X')).qty).toBe(1);
});

test('abort during delayed warmup prevents any order', async () => {
  const instrument = { symbol: 'X', minQty: 1, mintick: 0.01 };
  const broker = new PaperBroker({ instruments: { X: instrument } });
  let releaseHistory!: (bars: Bar[]) => void;
  let historyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    historyStarted = resolve;
  });
  const feed: LiveFeed = {
    id: 'delayed',
    history: async () => {
      historyStarted();
      return new Promise<Bar[]>((resolve) => {
        releaseHistory = resolve;
      });
    },
    closedBars: async function* () {},
    stop: async () => {},
  };
  const ledger = new MemoryLedger();
  const controller = new AbortController();
  const running = runForwardServer({
    source,
    symbol: 'X',
    timeframe: '1m',
    broker,
    feed,
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
  const instrument = { symbol: 'X', minQty: 1, mintick: 0.01 };
  const broker = new PaperBroker({ instruments: { X: instrument } });
  let disconnected = false;
  broker.disconnect = async () => {
    disconnected = true;
  };
  const feed: LiveFeed = {
    id: 'cleanup',
    history: async () => [],
    closedBars: async function* () {},
    stop: async () => {
      throw new Error('stop failed');
    },
  };
  let flushed = false;
  let closed = false;
  const ledger: LedgerSink = {
    append: async (_record: ForwardRecord) => {},
    flush: async () => {
      flushed = true;
      throw new Error('flush failed');
    },
    close: async () => {
      closed = true;
    },
  };
  await expect(
    runForwardServer({ source, symbol: 'X', timeframe: '1m', broker, feed, ledger }),
  ).rejects.toBeInstanceOf(AggregateError);
  expect(flushed).toBe(true);
  expect(disconnected).toBe(true);
  expect(closed).toBe(true);
});
