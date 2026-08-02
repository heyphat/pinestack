import { expect, test } from 'bun:test';
import {
  InMemoryExecutionLease,
  MemoryLedger,
  PaperBroker,
  prepareIntrabarRun,
  runIntrabarServer,
  type IntrabarBrokerFactory,
} from '@heyphat/pinelive';
import { ReplayProvider, StaticProvider, type Bar, type BarUpdate } from '@heyphat/pinery';

const native = Object.freeze({ kind: 'native' as const });
const dataConfig = {
  provider: 'csv',
  dataDir: '/path/must/not/be-read',
  cutoverTime: 7_200,
} as const;

const source = `//@version=6
strategy("audit repro", use_bar_magnifier=true, calc_on_every_tick=true, process_orders_on_close=true, default_qty_type=strategy.fixed, default_qty_value=1)
if close > open
    strategy.entry("L", strategy.long)
else
    strategy.close("L")
plot(strategy.position_size)`;

function bar(time: number, close = 9, open = 10): Bar {
  return {
    time,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 1,
  };
}

function update(value: Bar, revision: number, isClose: boolean): BarUpdate {
  return Object.freeze({
    bar: Object.freeze({ ...value }),
    revision,
    isClose,
    // Space events past the 250 ms default forming throttle so each one is really emitted,
    // exactly as a live feed spread across a multi-minute bar would be.
    eventTime: value.time * 1_000 + revision * 1_000,
    source: native,
  });
}

function replayFixture(updates: readonly BarUpdate[]): ReplayProvider {
  const warmup = [bar(0), bar(3_600)];
  const children = Array.from({ length: 12 }, (_, index) => bar(index * 600, 10 + index / 100));
  const src = new StaticProvider(
    { 'X|1h': [...warmup, bar(7_200, 11)], 'X|10m': children },
    {
      alignment: 'utc-24x7',
      timeframes: ['10m', '1h'],
      cacheIdentity: 'pinelive-audit-repro-v1',
    },
  ).setInstrument('X', { minQty: 1, mintick: 0.01 });
  return new ReplayProvider(src, {
    cutoverTime: 7_200,
    updates: { 'X|1h': updates },
    instrument: { minOrderQty: 1 },
  });
}

function everyUpdatePaperConfig() {
  return {
    configVersion: 2,
    strategy: 'audit-repro.pine',
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 2,
    data: dataConfig,
    historical: { mode: 'bar-magnifier', maxMagnifierTargetBars: 12, maxMagnifierRawBars: 12 },
    live: { cadence: 'every-update', source: native },
    execution: {
      kind: 'mirrored',
      mirrorOn: 'bar-close',
      intrabarExecutionArmed: true,
      broker: { id: 'paper', initialBalance: 10_000 },
      ledger: { path: '/unused/audit-repro.jsonl', durability: 'sync' },
      lease: { path: '/unused/audit-repro.lock' },
    },
  } as const;
}

function paperFactory(): IntrabarBrokerFactory {
  return ({ resolved }) =>
    new PaperBroker({
      instruments: {
        [resolved.venueSymbol]: {
          symbol: resolved.venueSymbol,
          dataSymbol: resolved.venueSymbol,
          brokerSymbol: resolved.venueSymbol,
          minQty: resolved.qtyStep,
          qtyStep: resolved.qtyStep,
          minOrderQty: resolved.minOrderQty,
          mintick: resolved.mintick,
          pointValue: resolved.pointValue,
          exchange: resolved.exchange,
          expiry: resolved.expiry,
        },
      },
      initialBalance: 10_000,
    });
}

// End-to-end regression for the feat-pinelive audit's F-1: every-update cadence + Paper +
// mirrorOn "bar-close" is the documented supported combination ("forming revisions are durably
// skipped and only the authoritative final can reach Paper"). The bar's forming revisions must
// never starve its authoritative close of admission, for ANY revision count.
test('an authoritative close is admitted and executed after arbitrarily many forming revisions', async () => {
  const forming = Array.from({ length: 24 }, (_, index) =>
    update(bar(7_200, 10.5 + index / 100), index + 1, false),
  );
  const updates = [...forming, update(bar(7_200, 11), 25, true)];

  const ledger = new MemoryLedger();
  const lease = new InMemoryExecutionLease('/unused/forming-budget-e2e.jsonl', {
    ownerId: 'forming-budget-owner',
    leaseId: 'forming-budget-lease',
  });

  const result = await runIntrabarServer({
    prepared: prepareIntrabarRun(everyUpdatePaperConfig(), source),
    dataFactory: () => replayFixture(updates),
    ledger,
    lease,
    brokerFactory: paperFactory(),
  });

  const skips = ledger.events.filter((event) => event.recordType === 'evaluation.skipped');
  // Every emitted forming revision was durably journaled as 'forming'; none was ever
  // reclassified, and none reached the broker.
  expect(skips.length).toBeGreaterThan(1);
  expect(skips.every((event) => event.reason === 'forming')).toBe(true);
  expect(skips.every((event) => event.update.authoritativeFinal === false)).toBe(true);

  // The authoritative close was accepted, produced exactly one order, and the mirrored
  // position reached the strategy's target (close 11 > open 10 → long 1).
  const accepted = ledger.events.filter((event) => event.recordType === 'evaluation.accepted');
  const intents = ledger.events.filter((event) => event.recordType === 'order.intent');
  expect(accepted).toHaveLength(1);
  expect(accepted[0]!.update.authoritativeFinal).toBe(true);
  expect(intents).toHaveLength(1);
  expect(result.executionSafe).toBe(true);
  expect(result.finalPosition).toMatchObject({ symbol: 'X', qty: 1 });
});
