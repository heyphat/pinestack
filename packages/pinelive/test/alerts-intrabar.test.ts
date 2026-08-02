import { expect, test } from 'bun:test';
import {
  MemoryLedger,
  prepareIntrabarRun,
  recoverLedger,
  runIntrabarServer,
  type AlertChannel,
  type IntrabarEvaluation,
  type LedgerEventV3,
  type StrategyAlert,
} from '@heyphat/pinelive';
import { ReplayProvider, StaticProvider, type Bar, type BarUpdate } from '@heyphat/pinery';

const native = Object.freeze({ kind: 'native' as const });

// Every-update compute-only run: forming revisions evaluate (and emit forming
// alerts piner will roll back); only the fresh authoritative final dispatches.
const source = `//@version=6
strategy("alerting", calc_on_every_tick=true, process_orders_on_close=true, default_qty_type=strategy.fixed, default_qty_value=1)
if close > open
    alert("bull final")
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
    eventTime: value.time * 1_000 + revision * 1_000,
    source: native,
  });
}

function replayFixture(updates: readonly BarUpdate[]): ReplayProvider {
  const warmup = [bar(0), bar(3_600)];
  const src = new StaticProvider(
    { 'X|1h': [...warmup, bar(7_200, 11)] },
    { alignment: 'utc-24x7', timeframes: ['1h'], cacheIdentity: 'pinelive-alerts-intrabar-v1' },
  ).setInstrument('X', { minQty: 1, mintick: 0.01 });
  return new ReplayProvider(src, {
    cutoverTime: 7_200,
    updates: { 'X|1h': updates },
    instrument: { minOrderQty: 1 },
  });
}

function config() {
  return {
    configVersion: 2,
    strategy: 'alerting.pine',
    symbol: 'X',
    timeframe: '1h',
    warmupBars: 2,
    data: { provider: 'csv', dataDir: '/must/not/read', cutoverTime: 7_200 },
    historical: { mode: 'standard' },
    live: { cadence: 'every-update', source: native },
    execution: { kind: 'compute-only' },
    alerts: {
      channels: [{ id: 'webhook', name: 'ops', url: 'https://example.com/hook' }],
    },
  } as const;
}

function capture(name: string): { channel: AlertChannel; sent: StrategyAlert[] } {
  const sent: StrategyAlert[] = [];
  return { channel: { name, send: async (alert) => void sent.push(alert) }, sent };
}

function alertEvents(events: readonly LedgerEventV3[]) {
  return events.filter(
    (event): event is Extract<LedgerEventV3, { recordType: 'alert' }> =>
      event.recordType === 'alert',
  );
}

test('v2 dispatches only the fresh authoritative final; forming alerts stay provisional', async () => {
  const prepared = prepareIntrabarRun(config(), source);
  const ledger = new MemoryLedger();
  const { channel, sent } = capture('ops');
  const evaluations: IntrabarEvaluation[] = [];

  const result = await runIntrabarServer({
    prepared,
    dataFactory: () =>
      // Two forming revisions with close > open (both would alert), then the final.
      replayFixture([
        update(bar(7_200, 10.5), 1, false),
        update(bar(7_200, 10.8), 2, false),
        update(bar(7_200, 11), 3, true),
      ]),
    ledger,
    alertChannels: [channel],
    onEvaluation: (evaluation) => void evaluations.push(evaluation),
  });
  expect(result.mode).toBe('compute-only');

  // The forming evaluations carried their provisional alerts on the evaluation…
  const forming = evaluations.filter((evaluation) => !evaluation.finalCommit);
  expect(forming).toHaveLength(2);
  expect(forming.every((evaluation) => evaluation.alerts.includes('bull final'))).toBe(true);

  // …but only the authoritative final delivered and journaled.
  expect(sent.map((alert) => [alert.barTime, alert.message, alert.ordinal])).toEqual([
    [7_200, 'bull final', 1],
  ]);
  expect(sent[0]!.firedAt).toBe(10_800_000);
  const journaled = alertEvents(ledger.events);
  expect(journaled).toHaveLength(1);
  expect(journaled[0]).toMatchObject({
    barTime: 7_200,
    message: 'bull final',
    ordinal: 1,
    source: 'bar-close',
    price: 11,
    deliveries: [{ channel: 'ops', outcome: 'sent' }],
  });
  // The alert row references the final's decision and follows its journal row.
  const finalDecision = evaluations.find((evaluation) => evaluation.finalCommit)!;
  expect(journaled[0]!.decisionId).toBe(finalDecision.decisionId);
  const decisionIndex = ledger.events.findIndex(
    (event) => 'decisionId' in event && event.decisionId === finalDecision.decisionId,
  );
  expect(decisionIndex).toBeGreaterThanOrEqual(0);
  expect(ledger.events.indexOf(journaled[0]!)).toBeGreaterThan(decisionIndex);

  // The stream with alert rows recovers cleanly.
  const recovered = recoverLedger(ledger.events);
  expect(recovered.lastFinalCursor).toBe(7_200);
});

test('v2 recovered finals never re-dispatch after a restart', async () => {
  const prepared = prepareIntrabarRun(config(), source);
  const ledger = new MemoryLedger();
  const first = capture('ops');
  await runIntrabarServer({
    prepared,
    dataFactory: () => replayFixture([update(bar(7_200, 11), 1, true)]),
    ledger,
    alertChannels: [first.channel],
  });
  expect(first.sent).toHaveLength(1);
  expect(alertEvents(ledger.events)).toHaveLength(1);

  // Restart over the same durable prefix; the provider replays the same final.
  const second = capture('ops');
  await runIntrabarServer({
    prepared,
    dataFactory: () => replayFixture([update(bar(7_200, 11), 1, true)]),
    ledger,
    recoveredEvents: structuredClone(ledger.events),
    alertChannels: [second.channel],
  });
  expect(second.sent).toHaveLength(0);
  expect(alertEvents(ledger.events)).toHaveLength(1);
});

test('v2 refuses a config that declares channels when the runtime received none', async () => {
  const prepared = prepareIntrabarRun(config(), source);
  await expect(
    runIntrabarServer({
      prepared,
      dataFactory: () => replayFixture([update(bar(7_200, 11), 1, true)]),
      ledger: new MemoryLedger(),
    }),
  ).rejects.toThrow('no alert channels were supplied');
});
