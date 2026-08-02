import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { ReplayProvider, StaticProvider, type Bar } from '@heyphat/pinery';
import {
  InMemoryExecutionLease,
  MemoryLedger,
  PaperBroker,
  prepareIntrabarRun,
  runIntrabarServer,
  type IntrabarBrokerFactory,
  type LedgerEventV3,
} from '../src/index.js';

const bars: readonly Bar[] = [
  { time: 0, open: 2, high: 2, low: 1, close: 1, volume: 1 },
  { time: 60, open: 2, high: 2, low: 1, close: 1, volume: 1 },
  { time: 120, open: 1, high: 2, low: 1, close: 2, volume: 1 },
  { time: 180, open: 1, high: 2, low: 1, close: 2, volume: 1 },
];

function replay(): ReplayProvider {
  const history = new StaticProvider(
    { 'ROOT|1m': bars },
    {
      alignment: 'utc-24x7',
      timeframes: ['1m'],
      cacheIdentity: 'pinelive-offline-e2e-v3',
    },
  ).setInstrument('ROOT', { minQty: 1, mintick: 0.01 });
  return new ReplayProvider(history, {
    cutoverTime: 120,
    instrument: {
      venueSymbol: 'EXACT',
      minOrderQty: 1,
      pointValue: 1,
    },
  });
}

const config = {
  configVersion: 3,
  strategy: 'position-toggle.pine',
  symbol: 'ROOT',
  timeframe: '1m',
  warmupBars: 2,
  data: {
    provider: 'csv',
    dataDir: '/unused/offline-e2e',
    cutoverTime: 120,
  },
  live: { cadence: 'bar-close' },
  execution: {
    kind: 'mirrored',
    mirrorOn: 'bar-close',
    broker: { id: 'paper', initialBalance: 10_000, commissionPerUnit: 0.1 },
    ledger: { path: '/unused/offline-e2e.jsonl', durability: 'sync' },
    lease: { path: '/unused/offline-e2e.lock' },
  },
} as const;

const paperFactory: IntrabarBrokerFactory = ({ config: brokerConfig, resolved }) =>
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
    initialBalance: brokerConfig.initialBalance,
    slippageBps: brokerConfig.slippageBps,
    commissionPerUnit: brokerConfig.commissionPerUnit,
  });

function completionSignature(events: readonly LedgerEventV3[]) {
  return events.map((event) => ({
    sequence: event.sequence,
    recordType: event.recordType,
    decisionId: 'decisionId' in event ? event.decisionId : undefined,
    bindingId: 'bindingId' in event ? event.bindingId : undefined,
    leaseAction: event.recordType === 'lease' ? event.action : undefined,
  }));
}

test('Replay → intrabar runtime → Paper emits only schema-v3 events and completes deterministically', async () => {
  const source = await readFile(
    new URL('./strategies/position-toggle.pine', import.meta.url),
    'utf8',
  );
  const prepared = prepareIntrabarRun(config, source);

  const execute = async () => {
    const ledger = new MemoryLedger();
    const result = await runIntrabarServer({
      prepared,
      dataFactory: replay,
      ledger,
      lease: new InMemoryExecutionLease('/unused/offline-e2e-runtime', {
        ownerId: 'offline-e2e-owner',
        leaseId: 'offline-e2e-lease',
        now: () => 0,
      }),
      brokerFactory: paperFactory,
    });
    return { ledger, result };
  };

  const first = await execute();
  const second = await execute();

  expect(first.ledger.events.length).toBeGreaterThan(0);
  expect(first.ledger.events.every((event) => event.schemaVersion === 3)).toBe(true);
  expect(new Set(first.ledger.events.map((event) => event.schemaVersion))).toEqual(new Set([3]));

  expect(first.result).toMatchObject({
    mode: 'mirrored',
    executionSafe: true,
    evaluations: 2,
    lastFinalCursor: 180,
  });
  if (!first.result.executionSafe || !second.result.executionSafe) {
    throw new Error('offline Paper completion unexpectedly became unsafe');
  }
  expect(first.result.finalPosition).toEqual(second.result.finalPosition);
  expect(first.result.finalAccount).toEqual(second.result.finalAccount);

  const bindingEvents = first.ledger.events.filter(
    (event): event is Extract<LedgerEventV3, { recordType: 'binding' }> =>
      event.recordType === 'binding',
  );
  expect(bindingEvents).toHaveLength(1);
  expect(bindingEvents[0]!.binding).toEqual(first.result.binding);
  expect(first.result.binding).toMatchObject({
    strategySymbol: 'ROOT',
    executionSymbol: 'EXACT',
    brokerId: 'paper',
    qtyStep: 1,
    minOrderQty: 1,
    mintick: 0.01,
    pointValue: 1,
  });
  expect(second.result.binding).toEqual(first.result.binding);
  expect(second.result.authority).toEqual(first.result.authority);

  const accepted = first.ledger.events.filter(
    (event): event is Extract<LedgerEventV3, { recordType: 'evaluation.accepted' }> =>
      event.recordType === 'evaluation.accepted',
  );
  const completed = first.ledger.events.filter(
    (event): event is Extract<LedgerEventV3, { recordType: 'evaluation.completed' }> =>
      event.recordType === 'evaluation.completed',
  );
  expect(accepted).toHaveLength(first.result.evaluations);
  expect(completed.map((event) => event.decisionId)).toEqual(
    accepted.map((event) => event.decisionId),
  );
  expect(
    first.ledger.events.some(
      (event) => event.recordType === 'lease' && event.action === 'released',
    ),
  ).toBe(true);
  expect(completionSignature(second.ledger.events)).toEqual(
    completionSignature(first.ledger.events),
  );
});
