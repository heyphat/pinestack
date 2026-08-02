import { expect, test } from 'bun:test';
import {
  MemoryLedger,
  PaperBroker,
  PositionMirror,
  TargetScheduler,
  recoverLedger,
  type ReconcileContext,
  type RunInstrumentBinding,
} from '../src/index.js';

const instrument = { symbol: 'X', minQty: 1, qtyStep: 1, minOrderQty: 1, mintick: 0.01 };
const bindingId = `binding-v2-${'a'.repeat(64)}`;
const binding: RunInstrumentBinding = {
  bindingVersion: 2,
  id: bindingId,
  fingerprint: bindingId,
  strategySymbol: 'ROOT',
  providerId: 'test',
  providerHandle: 'test:X',
  executionSymbol: 'X',
  qtyStep: 1,
  minOrderQty: 1,
  mintick: 0.01,
  brokerId: 'paper',
  authority: {
    algorithm: 'sha256',
    identity: `sha256-${'b'.repeat(64)}`,
    prepared: {},
  } as never,
};

function context(barTime = 1): ReconcileContext {
  return {
    strategySymbol: 'ROOT',
    executionSymbol: 'X',
    bindingId: binding.id,
    barTime,
    strategyId: 'strategy',
    timeframe: '1m',
    sequence: barTime,
  };
}

function intrabarUpdate(eventId: string, revision: number, authoritativeFinal: boolean) {
  return {
    kind: 'intrabar' as const,
    eventId,
    revision,
    authoritativeFinal,
    recovered: false,
    discontinuity: false,
  };
}

function paper(): PaperBroker {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.mark('X', 100, 1);
  return broker;
}

function scheduler(
  broker: PaperBroker,
  ledger: MemoryLedger,
  options: Partial<ConstructorParameters<typeof TargetScheduler>[0]> = {},
): TargetScheduler {
  return new TargetScheduler({
    mirror: new PositionMirror(broker, instrument),
    ledger,
    runId: 'run',
    executionId: 'execution',
    binding,
    ...options,
  });
}

test('journaled forming skips never consume the per-bar admission budget', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  let submits = 0;
  const submit = broker.submit.bind(broker);
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  const targetScheduler = scheduler(broker, memory, {
    limits: { maxTargetsPerBar: 8, maxIntentsPerBar: 4, maxConsecutiveErrors: 3 },
  });

  // Far more forming revisions than the admission budget, all on one bar, exactly as an
  // every-update cadence produces before the bar closes.
  for (let revision = 1; revision <= 24; revision++) {
    const skipped = await targetScheduler.journalSkipped(
      {
        target: 1,
        context: context(60),
        cursor: 60,
        update: intrabarUpdate(`forming-${revision}`, revision, false),
        decisionId: `forming-${revision}`,
      },
      'forming',
      'mirrorOn=bar-close',
    );
    expect(skipped).toMatchObject({ status: 'skipped', reason: 'forming' });
  }

  // The authoritative close must still be admitted and reach the broker.
  const final = await targetScheduler.schedule({
    target: 1,
    context: context(60),
    cursor: 60,
    update: intrabarUpdate('final-60', 25, true),
    decisionId: 'final-60',
  });
  expect(final.status).toBe('completed');
  expect(submits).toBe(1);
  expect((await broker.getPosition('X')).qty).toBe(1);
  expect(targetScheduler.state.breaker.latched).toBe(false);

  // Ordinal continuity is preserved for recovery: skips advanced the shared counter,
  // admission only counted the accepted evaluation.
  const recovered = recoverLedger(memory.events);
  expect(recovered.perBar.get(`${binding.id}:60`)).toEqual({
    targets: 25,
    intents: 1,
    admitted: 1,
  });
});

test('refusing an authoritative final by target-limit latches the breaker loudly', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const targetScheduler = scheduler(broker, memory, {
    limits: { maxTargetsPerBar: 1 },
  });

  // An ACCEPTED (not journaled) forming evaluation consumes the only admission slot — the
  // every-update mirrored scenario.
  const first = await targetScheduler.schedule({
    target: 1,
    context: context(60),
    cursor: 60,
    update: intrabarUpdate('forming-60-r1', 1, false),
    decisionId: 'first',
  });
  expect(first.status).toBe('completed');

  // The bar's authoritative final then exceeds the budget. Silently dropping it would
  // desynchronize the mirrored position, so the breaker must latch.
  const second = await targetScheduler.schedule({
    target: 2,
    context: { ...context(60), sequence: 61 },
    cursor: 60,
    update: intrabarUpdate('final-60-r2', 2, true),
    decisionId: 'second',
  });
  expect(second).toMatchObject({ status: 'skipped', reason: 'target-limit' });
  expect(targetScheduler.state.breaker).toMatchObject({ latched: true, reason: 'target-limit' });
  expect(
    memory.events.some(
      (event) =>
        event.recordType === 'breaker' &&
        event.state === 'latched' &&
        event.reason === 'target-limit' &&
        event.decisionId === 'second',
    ),
  ).toBe(true);

  // The latched ledger must recover cleanly (schema round-trip for the new reason).
  const recovered = recoverLedger(memory.events);
  expect(recovered.breaker).toMatchObject({ latched: true, reason: 'target-limit' });
});

test('a non-final target-limit refusal stays quiet and the breaker stays open for the final', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const targetScheduler = scheduler(broker, memory, {
    limits: { maxTargetsPerBar: 1 },
  });
  await targetScheduler.schedule({
    target: 1,
    context: context(60),
    cursor: 60,
    update: intrabarUpdate('forming-60-r1', 1, false),
    decisionId: 'first-forming',
  });
  const forming = await targetScheduler.schedule({
    target: 2,
    context: { ...context(60), sequence: 61 },
    cursor: 60,
    update: intrabarUpdate('forming-60-r2', 2, false),
    decisionId: 'second-forming',
  });
  expect(forming).toMatchObject({ status: 'skipped', reason: 'target-limit' });
  expect(targetScheduler.state.breaker.latched).toBe(false);
});

test('finalized bars are pruned to the retention window without touching durable rows', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const targetScheduler = scheduler(broker, memory, { retainBars: 4 });

  for (let barIndex = 1; barIndex <= 12; barIndex++) {
    broker.mark('X', 100 + barIndex, barIndex * 60);
    const result = await targetScheduler.schedule({
      target: barIndex % 2,
      context: { ...context(barIndex * 60), sequence: barIndex },
      cursor: barIndex * 60,
      update: intrabarUpdate(`final-${barIndex}`, 1, true),
      decisionId: `decision-${barIndex}`,
    });
    expect(result.status).toBe('completed');
  }

  // In-memory duplicate-detection state is bounded to the window.
  expect(targetScheduler.state.retainedBars).toBeLessThanOrEqual(4);
  expect(targetScheduler.state.retainedDecisions).toBeLessThanOrEqual(4);

  // The durable ledger keeps every row: 12 accepted + 12 completed evaluations.
  const accepted = memory.events.filter((event) => event.recordType === 'evaluation.accepted');
  const completed = memory.events.filter((event) => event.recordType === 'evaluation.completed');
  expect(accepted).toHaveLength(12);
  expect(completed).toHaveLength(12);
  expect(recoverLedger(memory.events).decisions.size).toBe(12);

  // A stale duplicate of a pruned decision is rejected fail-closed by the admission gate
  // instead of resolving as a silent duplicate.
  await expect(
    targetScheduler.schedule({
      target: 1,
      context: { ...context(60), sequence: 99 },
      cursor: 60,
      update: intrabarUpdate('final-1', 1, true),
      decisionId: 'decision-1',
    }),
  ).rejects.toThrow('authoritative final for the same or newer bar');
});

test('a bar with an unresolved logical order is never pruned', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  // Fail submit with a possibly-sent error so the intent stays unresolved and the breaker latches.
  broker.submit = async () => {
    throw new Error('socket dropped mid-flight');
  };
  const targetScheduler = scheduler(broker, memory, { retainBars: 1 });
  const first = await targetScheduler.schedule({
    target: 1,
    context: context(60),
    cursor: 60,
    update: intrabarUpdate('final-60', 1, true),
    decisionId: 'unresolved-decision',
  });
  expect(first.status).toBe('unknown');
  expect(targetScheduler.state.unresolvedLogicalOrderIds).toHaveLength(1);

  // Later bars are refused while the breaker is latched, but even so the unresolved bar's
  // state must survive pruning pressure.
  for (let barIndex = 2; barIndex <= 5; barIndex++) {
    const skipped = await targetScheduler.schedule({
      target: 0,
      context: { ...context(barIndex * 60), sequence: barIndex },
      cursor: barIndex * 60,
      update: intrabarUpdate(`final-${barIndex}`, 1, true),
      decisionId: `decision-${barIndex}`,
    });
    expect(skipped.status).toBe('skipped');
  }
  expect(targetScheduler.state.unresolvedLogicalOrderIds).toHaveLength(1);
  expect(
    targetScheduler.state.unresolvedLogicalOrderIds[0]!.startsWith('unresolved-decision'),
  ).toBe(true);
  // The protected bar is an explicit exception, not a blocker: only it plus the newest
  // configured retention-window bar remain in memory.
  expect(targetScheduler.state.retainedBars).toBeLessThanOrEqual(2);
  expect(targetScheduler.state.retainedDecisions).toBeLessThanOrEqual(2);
});

test('restart immediately compacts resolved history to the configured retention window', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const first = scheduler(broker, memory, { retainBars: 1 });

  for (let barIndex = 1; barIndex <= 5; barIndex++) {
    broker.mark('X', 100 + barIndex, barIndex * 60);
    const result = await first.schedule({
      target: barIndex % 2,
      context: { ...context(barIndex * 60), sequence: barIndex },
      cursor: barIndex * 60,
      update: intrabarUpdate(`restart-final-${barIndex}`, 1, true),
      decisionId: `restart-decision-${barIndex}`,
    });
    expect(result.status).toBe('completed');
  }

  const recovery = recoverLedger(memory.events);
  expect(recovery.decisions.size).toBe(5); // Durable history remains complete.

  const restarted = scheduler(paper(), new MemoryLedger(), { recovery, retainBars: 1 });
  expect(restarted.state.retainedBars).toBe(1);
  expect(restarted.state.retainedDecisions).toBe(1);

  // Compaction must preserve the latest stream admission gate, so an evicted stale duplicate
  // fails closed rather than being re-journaled with a reused durable identity.
  await expect(
    restarted.schedule({
      target: 1,
      context: { ...context(60), sequence: 99 },
      cursor: 60,
      update: intrabarUpdate('restart-final-1', 1, true),
      decisionId: 'restart-decision-1',
    }),
  ).rejects.toThrow('authoritative final for the same or newer bar');
});
