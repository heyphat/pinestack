import { expect, test } from 'bun:test';
import {
  BrokerError,
  InMemoryExecutionLease,
  MemoryLedger,
  PaperBroker,
  PositionMirror,
  TargetScheduler,
  recoverLedger,
  type LedgerRecord,
  type LedgerSink,
  type ReconcileContext,
  type RunInstrumentBinding,
} from '../src/index.js';

const instrument = { symbol: 'X', minQty: 1, qtyStep: 1, minOrderQty: 1, mintick: 0.01 };
const binding: RunInstrumentBinding = {
  id: 'binding-test',
  fingerprint: 'binding-test',
  strategySymbol: 'ROOT',
  providerId: 'test',
  providerHandle: 'test:X',
  executionSymbol: 'X',
  qtyStep: 1,
  minOrderQty: 1,
  mintick: 0.01,
  brokerId: 'paper',
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

function intrabarUpdate(
  eventId: string,
  revision: number,
  authoritativeFinal: boolean,
  options: { recovered?: boolean; discontinuity?: boolean } = {},
) {
  return {
    kind: 'intrabar' as const,
    eventId,
    revision,
    authoritativeFinal,
    recovered: options.recovered ?? false,
    discontinuity: options.discontinuity ?? false,
  };
}

function paper(): PaperBroker {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.mark('X', 100, 1);
  return broker;
}

function scheduler(
  broker: PaperBroker,
  ledger: LedgerSink | MemoryLedger,
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

async function ledgerFrom(events: readonly LedgerRecord[]): Promise<MemoryLedger> {
  const ledger = new MemoryLedger();
  for (const event of events) await ledger.append(event);
  return ledger;
}

test('scheduler durably accepts and records exact intent/attempt before broker effects', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const trace: string[] = [];
  const sink: LedgerSink = {
    append: async (record) => {
      trace.push(record.schemaVersion === 3 ? record.recordType : 'legacy');
      await memory.append(record);
    },
  };
  const getPosition = broker.getPosition.bind(broker);
  let reads = 0;
  broker.getPosition = async (symbol, signal) => {
    trace.push(++reads === 1 ? 'broker.read' : 'broker.refresh');
    return getPosition(symbol, signal);
  };
  const submit = broker.submit.bind(broker);
  broker.submit = async (order, signal) => {
    trace.push(`broker.submit:${order.clientId}`);
    return submit(order, signal);
  };

  const result = await scheduler(broker, sink).schedule(1, context(), {
    decisionId: 'decision-a',
    cursor: { bar: 1, revision: 0 },
  });
  expect(result.status).toBe('completed');
  expect(trace.indexOf('evaluation.accepted')).toBeLessThan(trace.indexOf('broker.read'));
  expect(trace.indexOf('order.intent')).toBeLessThan(
    trace.indexOf('broker.submit:pl_decision-a_1'),
  );
  expect(trace.indexOf('order.attempt')).toBeLessThan(
    trace.indexOf('broker.submit:pl_decision-a_1'),
  );
  expect(trace.indexOf('order.result')).toBeLessThan(trace.indexOf('broker.refresh'));
  expect(memory.events.find((event) => event.recordType === 'order.intent')).toMatchObject({
    clientId: 'pl_decision-a_1',
    logicalOrderId: 'decision-a:1',
    order: { symbol: 'X', side: 'buy', qty: 1, type: 'market' },
  });
  const recovered = recoverLedger(memory.events, { requireBinding: true });
  expect(recovered.lastFinalCursor).toEqual({ bar: 1, revision: 0 });
  expect(recovered.unresolvedIntents.size).toBe(0);
});

test('scheduler permits one active operation and coalesces to one newest pending target', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const originalGet = broker.getPosition.bind(broker);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  broker.getPosition = async (symbol, signal) => {
    reads++;
    if (reads === 1) await gate;
    return originalGet(symbol, signal);
  };
  const targetScheduler = scheduler(broker, memory);
  const first = targetScheduler.schedule(1, context(1), { decisionId: 'first' });
  await waitFor(() => reads === 1);
  const second = targetScheduler.schedule(2, context(2), { decisionId: 'second' });
  const third = targetScheduler.schedule(3, context(3), { decisionId: 'third' });
  expect((await second).reason).toBe('coalesced');
  expect(reads).toBe(1);
  release();
  expect((await first).status).toBe('completed');
  expect((await third).status).toBe('completed');
  expect((await broker.getPosition('X')).qty).toBe(3);
  expect(
    memory.events.some(
      (event) =>
        event.recordType === 'evaluation.skipped' &&
        event.decisionId === 'second' &&
        event.reason === 'coalesced',
    ),
  ).toBe(true);
  expect(
    memory.events.findIndex(
      (event) => event.recordType === 'evaluation.skipped' && event.decisionId === 'second',
    ),
  ).toBeLessThan(
    memory.events.findIndex(
      (event) => event.recordType === 'evaluation.accepted' && event.decisionId === 'third',
    ),
  );
});

test('per-bar target and intent caps fail closed without an extra submit', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  let submits = 0;
  const submit = broker.submit.bind(broker);
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  const targetScheduler = scheduler(broker, memory, {
    mirror: new PositionMirror(broker, instrument, { maxOrderQty: 1 }),
    limits: { maxTargetsPerBar: 1, maxIntentsPerBar: 1 },
  });
  const first = await targetScheduler.schedule(3, context(1), { decisionId: 'capped' });
  expect(first.status).toBe('failed');
  expect(submits).toBe(1);
  expect((await broker.getPosition('X')).qty).toBe(1);
  expect(targetScheduler.state.breaker).toMatchObject({ latched: true, reason: 'intent-limit' });

  const second = await targetScheduler.schedule(2, context(1), { decisionId: 'overflow' });
  expect(second.reason).toBe('breaker-open');
  expect(submits).toBe(1);
  expect(() => recoverLedger(memory.events)).not.toThrow();
});

test('rolling interval is deterministic across capped corrections', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  let now = 1_000;
  const sleeps: number[] = [];
  const targetScheduler = scheduler(broker, memory, {
    mirror: new PositionMirror(broker, instrument, { maxOrderQty: 1 }),
    limits: { minIntervalMs: 250 },
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  expect((await targetScheduler.schedule(2, context(1), { decisionId: 'spaced' })).status).toBe(
    'completed',
  );
  expect(sleeps).toEqual([250]);
  expect(
    memory.events
      .filter((event) => event.recordType === 'order.intent')
      .map((event) => event.clientId),
  ).toEqual(['pl_spaced_1', 'pl_spaced_2']);
});

test('possibly-sent first attempt latches immediately and never retransmits after restart', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  let submits = 0;
  broker.submit = async () => {
    submits++;
    throw new BrokerError('timeout', 'outcome unknown');
  };
  const firstScheduler = scheduler(broker, memory, {
    mirror: new PositionMirror(broker, instrument, {
      transientRetries: 3,
      sleep: async () => {},
    }),
  });
  const first = await firstScheduler.schedule(1, context(), { decisionId: 'restart' });
  expect(first.status).toBe('unknown');
  expect(firstScheduler.state.breaker.latched).toBe(true);
  expect(firstScheduler.state.unresolvedLogicalOrderIds).toEqual(['restart:1']);
  expect(submits).toBe(1);
  expect(memory.events.filter((event) => event.recordType === 'order.attempt')).toHaveLength(1);

  const recovered = recoverLedger(memory.events, { requireBinding: true });
  expect(recovered.breaker.latched).toBe(true);
  expect(recovered.unresolvedMappings.get('pl_restart_1')).toBe('restart:1');
  const restarted = scheduler(broker, memory, { recovery: recovered });
  expect(await restarted.resolveUnknownSubmission('restart:1')).toMatchObject({
    status: 'not-found',
    resolved: false,
  });
  await expect(restarted.resetBreaker('journal-only reset')).rejects.toThrow(
    'may have been submitted',
  );
  const resumed = await restarted.schedule(1, context(), { decisionId: 'restart' });
  expect(resumed).toMatchObject({ status: 'skipped', reason: 'breaker-open' });
  expect(submits).toBe(1);
  expect(memory.events.filter((event) => event.recordType === 'order.attempt')).toHaveLength(1);
  expect(recoverLedger(memory.events).unresolvedIntents.size).toBe(1);
});

test('definitely-not-sent submit failure retries the same durable client id', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const submit = broker.submit.bind(broker);
  const clientIds: string[] = [];
  broker.submit = async (order, signal) => {
    clientIds.push(order.clientId);
    if (clientIds.length === 1)
      throw new BrokerError('connectivity', 'pre-transmission failure', {
        submitFailureCertainty: 'definitely-not-sent',
      });
    return submit(order, signal);
  };
  const result = await scheduler(broker, memory, {
    mirror: new PositionMirror(broker, instrument, {
      transientRetries: 1,
      sleep: async () => {},
    }),
  }).schedule(1, context(), { decisionId: 'safe-retry' });
  expect(result.status).toBe('completed');
  expect(clientIds).toEqual(['pl_safe-retry_1', 'pl_safe-retry_1']);
  expect(
    memory.events
      .filter((event) => event.recordType === 'order.result')
      .map((event) => event.outcome),
  ).toEqual(['error', 'filled']);
  expect(memory.events.some((event) => event.recordType === 'order.unknown')).toBe(false);
  expect(() => recoverLedger(memory.events, { requireBinding: true })).not.toThrow();
});

test('pre-submit durability failure sends nothing', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  let submits = 0;
  broker.submit = async () => {
    submits++;
    throw new Error('must not run');
  };
  const sink: LedgerSink = {
    append: async (record) => {
      if (record.schemaVersion === 3 && record.recordType === 'order.intent')
        throw new Error('intent sync failed');
      await memory.append(record);
    },
  };
  const targetScheduler = scheduler(broker, sink);
  const result = await targetScheduler.schedule(1, context(), { decisionId: 'pre-fail' });
  expect(result.status).toBe('failed');
  expect(submits).toBe(0);
  expect(targetScheduler.state.breaker).toMatchObject({ latched: true, reason: 'ledger-failure' });
});

test('post-submit durability failure latches breaker and keeps unresolved identity', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  let submits = 0;
  const submit = broker.submit.bind(broker);
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  const sink: LedgerSink = {
    append: async (record: LedgerRecord) => {
      if (record.schemaVersion === 3 && record.recordType === 'order.result')
        throw new Error('result sync failed');
      await memory.append(record);
    },
  };
  const targetScheduler = scheduler(broker, sink);
  const result = await targetScheduler.schedule(1, context(), { decisionId: 'post-fail' });
  expect(result.status).toBe('unknown');
  expect(submits).toBe(1);
  expect((await broker.getPosition('X')).qty).toBe(1);
  expect(targetScheduler.state.breaker).toMatchObject({ latched: true, reason: 'ledger-failure' });
  expect(targetScheduler.state.unresolvedLogicalOrderIds).toEqual(['post-fail:1']);
});

test('recovery rejects sequence gaps and mismatched order economics', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  await scheduler(broker, memory).schedule(1, context(), { decisionId: 'valid' });
  const sequenceGap = structuredClone(memory.events) as Array<Record<string, unknown>>;
  sequenceGap[1]!.sequence = 99;
  expect(() => recoverLedger(sequenceGap)).toThrow('expected sequence');

  const mismatch = structuredClone(memory.events) as Array<Record<string, unknown>>;
  const attempt = mismatch.find((event) => event.recordType === 'order.attempt')!;
  attempt.order = { ...(attempt.order as object), qty: 2 };
  expect(() => recoverLedger(mismatch)).toThrow('order economics do not match intent');
});

test('target and rolling-minute attempt limits are independent fail-closed caps', async () => {
  const targetBroker = paper();
  const targetLedger = new MemoryLedger();
  const targetLimited = scheduler(targetBroker, targetLedger, {
    limits: { maxTargetsPerBar: 1 },
  });
  expect((await targetLimited.schedule(0, context(1), { decisionId: 'target-one' })).status).toBe(
    'completed',
  );
  const overflow = await targetLimited.schedule(1, context(1), { decisionId: 'target-two' });
  expect(overflow.reason).toBe('target-limit');
  expect((await targetBroker.getPosition('X')).qty).toBe(0);

  const attemptBroker = paper();
  let submits = 0;
  const submit = attemptBroker.submit.bind(attemptBroker);
  attemptBroker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  const attemptLimited = scheduler(attemptBroker, new MemoryLedger(), {
    mirror: new PositionMirror(attemptBroker, instrument, { maxOrderQty: 1 }),
    limits: { maxAttemptsPerMinute: 1 },
    now: () => 1_000,
  });
  const result = await attemptLimited.schedule(2, context(1), { decisionId: 'attempt-cap' });
  expect(result.status).toBe('failed');
  expect(submits).toBe(1);
  expect(attemptLimited.state.breaker).toMatchObject({
    latched: true,
    reason: 'attempt-limit',
  });
});

test('consecutive operational errors latch only at the configured threshold', async () => {
  const broker = new PaperBroker({
    instruments: { X: instrument },
    reject: () => 'blocked',
  });
  broker.mark('X', 100, 1);
  let submits = 0;
  const submit = broker.submit.bind(broker);
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  const memory = new MemoryLedger();
  const targetScheduler = scheduler(broker, memory, {
    limits: { maxConsecutiveErrors: 2 },
  });
  expect((await targetScheduler.schedule(1, context(1), { decisionId: 'error-one' })).status).toBe(
    'completed',
  );
  expect(targetScheduler.state.breaker.latched).toBe(false);
  expect((await targetScheduler.schedule(1, context(2), { decisionId: 'error-two' })).status).toBe(
    'completed',
  );
  expect(targetScheduler.state.breaker).toMatchObject({
    latched: true,
    consecutiveErrors: 2,
    reason: 'consecutive-errors',
  });
  expect(
    (await targetScheduler.schedule(1, context(3), { decisionId: 'error-three' })).reason,
  ).toBe('breaker-open');
  expect(submits).toBe(2);
  expect(recoverLedger(memory.events).consecutiveErrors).toBe(2);
});

test('restart resumes an accepted decision that crashed before its first broker read', async () => {
  const originalBroker = paper();
  const originalLedger = new MemoryLedger();
  const getPosition = originalBroker.getPosition.bind(originalBroker);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  originalBroker.getPosition = async (symbol, signal) => {
    reads++;
    if (reads === 1) await gate;
    return getPosition(symbol, signal);
  };
  const running = scheduler(originalBroker, originalLedger).schedule(1, context(), {
    decisionId: 'accepted-prefix',
  });
  await waitFor(() => reads === 1);
  const prefixEvents = structuredClone(originalLedger.events);
  release();
  await running;

  const prefixLedger = await ledgerFrom(prefixEvents);
  const recovery = recoverLedger(prefixLedger.events, { requireBinding: true });
  const resumedBroker = paper();
  const resumed = scheduler(resumedBroker, prefixLedger, { recovery });
  expect((await resumed.schedule(1, context(), { decisionId: 'accepted-prefix' })).status).toBe(
    'completed',
  );
  expect((await resumedBroker.getPosition('X')).qty).toBe(1);
  expect(
    prefixLedger.events.some(
      (event) =>
        event.recordType === 'evaluation.skipped' &&
        event.decisionId === 'accepted-prefix' &&
        event.reason === 'duplicate',
    ),
  ).toBe(false);
  expect(recoverLedger(prefixLedger.events).lastFinalCursor).toBe(1);
});

test('restart resumes the next correction after a completed capped-order prefix', async () => {
  const originalBroker = paper();
  const originalLedger = new MemoryLedger();
  const getPosition = originalBroker.getPosition.bind(originalBroker);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  originalBroker.getPosition = async (symbol, signal) => {
    reads++;
    if (reads === 3) await gate;
    return getPosition(symbol, signal);
  };
  const original = scheduler(originalBroker, originalLedger, {
    mirror: new PositionMirror(originalBroker, instrument, { maxOrderQty: 1 }),
  });
  const running = original.schedule(3, context(), { decisionId: 'correction-prefix' });
  await waitFor(() => reads === 3);
  const prefixEvents = structuredClone(originalLedger.events);
  expect((await getPosition('X')).qty).toBe(1);
  release();
  await running;

  const prefixLedger = await ledgerFrom(prefixEvents);
  const recovery = recoverLedger(prefixLedger.events, { requireBinding: true });
  const resumedBroker = paper();
  resumedBroker.setPosition('X', 1, 100);
  const clientIds: string[] = [];
  const submit = resumedBroker.submit.bind(resumedBroker);
  resumedBroker.submit = async (order, signal) => {
    clientIds.push(order.clientId);
    return submit(order, signal);
  };
  const resumed = scheduler(resumedBroker, prefixLedger, {
    recovery,
    mirror: new PositionMirror(resumedBroker, instrument, { maxOrderQty: 1 }),
  });
  expect((await resumed.schedule(3, context(), { decisionId: 'correction-prefix' })).status).toBe(
    'completed',
  );
  expect(clientIds).toEqual(['pl_correction-prefix_2', 'pl_correction-prefix_3']);
  expect((await resumedBroker.getPosition('X')).qty).toBe(3);
  expect(recoverLedger(prefixLedger.events).unresolvedIntents.size).toBe(0);
});

test('journal-only reset cannot clear an inferred unresolved submission', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  let submits = 0;
  const submit = broker.submit.bind(broker);
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  const sink: LedgerSink = {
    append: async (record) => {
      if (record.schemaVersion === 3 && record.recordType === 'order.result')
        throw new Error('result durability failed');
      await memory.append(record);
    },
  };
  expect(
    (await scheduler(broker, sink).schedule(1, context(), { decisionId: 'inferred-reset' })).status,
  ).toBe('unknown');
  const recovery = recoverLedger(memory.events);
  expect(recovery.breaker).toMatchObject({ latched: true, reason: 'recovery-unresolved' });
  const restarted = scheduler(broker, memory, { recovery });
  await expect(restarted.resetBreaker('read-only operator reset')).rejects.toThrow(
    'may have been submitted',
  );
  expect(submits).toBe(1);
  expect(recoverLedger(memory.events).breaker.latched).toBe(true);
});

test('all post-submit refresh failures latch position-unknown', async () => {
  for (const failure of ['ordinary-fill', 'non-finite-fill', 'broker-reject'] as const) {
    const broker =
      failure === 'broker-reject'
        ? new PaperBroker({ instruments: { X: instrument }, reject: () => 'blocked' })
        : paper();
    broker.mark('X', 100, 1);
    const getPosition = broker.getPosition.bind(broker);
    let reads = 0;
    broker.getPosition = async (symbol, signal) => {
      reads++;
      if (reads === 2) {
        if (failure === 'ordinary-fill') throw new Error('invalid refresh response');
        if (failure === 'non-finite-fill') return { symbol, qty: Number.NaN };
        throw new BrokerError('connectivity', 'refresh unavailable');
      }
      return getPosition(symbol, signal);
    };
    const memory = new MemoryLedger();
    const targetScheduler = scheduler(broker, memory);
    const result = await targetScheduler.schedule(1, context(), {
      decisionId: `refresh-${failure}`,
    });
    expect(result.status).toBe('unknown');
    expect(targetScheduler.state.breaker).toMatchObject({
      latched: true,
      reason: 'position-unknown',
    });
    expect(recoverLedger(memory.events).breaker).toMatchObject({
      latched: true,
      reason: 'position-unknown',
    });
  }
});

test('recovery preserves terminal results through completion and evaluation', async () => {
  for (const terminal of ['filled', 'rejected'] as const) {
    const broker =
      terminal === 'rejected'
        ? new PaperBroker({ instruments: { X: instrument }, reject: () => 'blocked' })
        : paper();
    broker.mark('X', 100, 1);
    const memory = new MemoryLedger();
    const result = await scheduler(broker, memory).schedule(1, context(), {
      decisionId: `terminal-semantics-${terminal}`,
    });
    expect(result.status).toBe('completed');
    expect(() => recoverLedger(memory.events, { requireBinding: true })).not.toThrow();

    const reclassified = structuredClone(memory.events) as Array<Record<string, unknown>>;
    const reclassifiedCompletion = reclassified.find(
      (event) => event.recordType === 'order.completion',
    );
    const reclassifiedEvaluation = reclassified.find(
      (event) => event.recordType === 'evaluation.completed',
    );
    if (!reclassifiedCompletion || !reclassifiedEvaluation)
      throw new Error('terminal semantics fixture is incomplete');
    reclassifiedCompletion.outcome = 'observed';
    reclassifiedEvaluation.outcome = 'noop';
    expect(() => recoverLedger(reclassified)).toThrow(
      'terminal order result does not match completion outcome',
    );

    const incompatibleEvaluationOutcomes =
      terminal === 'filled' ? (['noop'] as const) : (['noop', 'order'] as const);
    for (const evaluationOutcome of incompatibleEvaluationOutcomes) {
      const incompatible = structuredClone(memory.events) as Array<Record<string, unknown>>;
      const evaluation = incompatible.find((event) => event.recordType === 'evaluation.completed');
      if (!evaluation) throw new Error('evaluation completion fixture is missing');
      evaluation.outcome = evaluationOutcome;
      expect(() => recoverLedger(incompatible)).toThrow(
        'order completion does not match evaluation outcome',
      );
    }
  }
});

test('capped correction preserves aggregate order outcome after a fresh target observation', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const getPosition = broker.getPosition.bind(broker);
  const submit = broker.submit.bind(broker);
  let reads = 0;
  let submits = 0;
  broker.getPosition = async (symbol, signal) => {
    reads++;
    if (reads === 3) broker.setPosition('X', 2, 100);
    return getPosition(symbol, signal);
  };
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };

  const result = await scheduler(broker, memory, {
    mirror: new PositionMirror(broker, instrument, { maxOrderQty: 1 }),
  }).schedule(2, context(), { decisionId: 'fresh-capped-target' });

  expect(result).toMatchObject({
    status: 'completed',
    outcome: { action: 'order', actualAfter: 2 },
  });
  expect(reads).toBe(3);
  expect(submits).toBe(1);
  expect(
    memory.events.filter(
      (event) => event.recordType === 'order.intent' && event.decisionId === 'fresh-capped-target',
    ),
  ).toHaveLength(1);
  expect(
    memory.events.find(
      (event) =>
        event.recordType === 'evaluation.completed' && event.decisionId === 'fresh-capped-target',
    ),
  ).toMatchObject({ outcome: 'order', actualAfter: 2 });
  expect(() => recoverLedger(memory.events, { requireBinding: true })).not.toThrow();
});

test('position failure after a filled correction remains unknown and unfinished', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const getPosition = broker.getPosition.bind(broker);
  const submit = broker.submit.bind(broker);
  let reads = 0;
  let submits = 0;
  broker.getPosition = async (symbol, signal) => {
    reads++;
    if (reads === 3) throw new BrokerError('connectivity', 'position unavailable');
    return getPosition(symbol, signal);
  };
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };

  const targetScheduler = scheduler(broker, memory, {
    mirror: new PositionMirror(broker, instrument, { maxOrderQty: 1 }),
  });
  const result = await targetScheduler.schedule(2, context(), {
    decisionId: 'filled-then-position-failure',
  });

  expect(result.status).toBe('unknown');
  expect(targetScheduler.state.breaker).toMatchObject({
    latched: true,
    reason: 'position-unknown',
  });
  expect(reads).toBe(3);
  expect(submits).toBe(1);
  expect(
    memory.events.filter(
      (event) =>
        event.recordType === 'order.intent' && event.decisionId === 'filled-then-position-failure',
    ),
  ).toHaveLength(1);
  expect(
    memory.events.filter(
      (event) =>
        event.recordType === 'evaluation.completed' &&
        event.decisionId === 'filled-then-position-failure',
    ),
  ).toHaveLength(0);
  expect(() => recoverLedger(memory.events, { requireBinding: true })).not.toThrow();
});

test('scheduler rejects adding a binding after recovered unbound evaluations', async () => {
  const originalBroker = paper();
  const memory = new MemoryLedger();
  expect(
    (
      await scheduler(originalBroker, memory, { binding: undefined }).schedule(1, context(), {
        decisionId: 'unbound-decision',
      })
    ).status,
  ).toBe('completed');
  const recovery = recoverLedger(memory.events);
  expect(recovery.binding).toBeUndefined();
  expect(recovery.decisions.size).toBe(1);
  const eventCount = memory.events.length;
  const lastSequence = memory.events.at(-1)?.sequence;

  const restartedBroker = paper();
  const getPosition = restartedBroker.getPosition.bind(restartedBroker);
  let brokerEffects = 0;
  restartedBroker.getPosition = async (symbol, signal) => {
    brokerEffects++;
    return getPosition(symbol, signal);
  };
  restartedBroker.submit = async () => {
    brokerEffects++;
    throw new Error('late binding restart must not submit');
  };

  expect(() => scheduler(restartedBroker, memory, { recovery, binding })).toThrow(
    'scheduler cannot add a binding after recovered unbound evaluations',
  );
  expect(brokerEffects).toBe(0);
  expect(memory.events).toHaveLength(eventCount);
  expect(memory.events.at(-1)?.sequence).toBe(lastSequence);
  expect(memory.events.some((event) => event.recordType === 'binding')).toBe(false);
  expect(() => recoverLedger(memory.events)).not.toThrow();
});

test('aggregate fill survives exact lookup resolution and evaluation crash', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const submit = broker.submit.bind(broker);
  let submits = 0;
  broker.submit = async (order, signal) => {
    submits++;
    const fill = await submit(order, signal);
    if (submits === 2) throw new BrokerError('timeout', 'second fill acknowledgement lost');
    return fill;
  };
  const firstScheduler = scheduler(broker, memory, {
    mirror: new PositionMirror(broker, instrument, { maxOrderQty: 1 }),
  });
  expect(
    (
      await firstScheduler.schedule(2, context(), {
        decisionId: 'aggregate-observed-retry',
      })
    ).status,
  ).toBe('unknown');
  expect(submits).toBe(2);
  expect((await broker.getPosition('X')).qty).toBe(2);

  const recovery = recoverLedger(memory.events, { requireBinding: true });
  let attemptedEvaluation: LedgerRecord | undefined;
  const failingSink: LedgerSink = {
    append: async (record) => {
      if (record.schemaVersion === 3 && record.recordType === 'evaluation.completed') {
        attemptedEvaluation = record;
        throw new Error('aggregate evaluation durability failed');
      }
      await memory.append(record);
    },
  };
  const resumed = scheduler(broker, failingSink, {
    recovery,
    mirror: new PositionMirror(broker, instrument, { maxOrderQty: 1 }),
  });
  expect(await resumed.resolveUnknownSubmission('aggregate-observed-retry:2')).toMatchObject({
    status: 'filled',
    resolved: true,
  });
  await resumed.resetBreaker('exact second-correction resolution');
  await expect(
    resumed.schedule(2, context(), { decisionId: 'aggregate-observed-retry' }),
  ).rejects.toThrow('aggregate evaluation durability failed');
  expect(attemptedEvaluation).toMatchObject({ outcome: 'order', actualAfter: 2 });
  expect(
    memory.events
      .filter(
        (event) =>
          event.recordType === 'order.completion' &&
          event.decisionId === 'aggregate-observed-retry',
      )
      .map((event) => event.outcome),
  ).toEqual(['filled', 'filled']);

  const crashRecovery = recoverLedger(memory.events, { requireBinding: true });
  expect(
    crashRecovery.decisions.get('aggregate-observed-retry')?.latestEffectfulIntent,
  ).toMatchObject({
    intent: { logicalOrderId: 'aggregate-observed-retry:2' },
    completion: { outcome: 'filled' },
  });
  const getPosition = broker.getPosition.bind(broker);
  let brokerReadsAfterCrash = 0;
  broker.getPosition = async (symbol, signal) => {
    brokerReadsAfterCrash++;
    return getPosition(symbol, signal);
  };
  const restarted = scheduler(broker, memory, {
    recovery: crashRecovery,
    mirror: new PositionMirror(broker, instrument, { maxOrderQty: 1 }),
  });
  const final = await restarted.schedule(2, context(), {
    decisionId: 'aggregate-observed-retry',
  });
  expect(final).toMatchObject({
    status: 'completed',
    outcome: { action: 'order', actualAfter: 2 },
  });
  expect(submits).toBe(2);
  expect(brokerReadsAfterCrash).toBe(0);
  expect(
    memory.events.find(
      (event) =>
        event.recordType === 'evaluation.completed' &&
        event.decisionId === 'aggregate-observed-retry',
    ),
  ).toMatchObject({ outcome: 'order', actualAfter: 2 });
  expect(() => recoverLedger(memory.events, { requireBinding: true })).not.toThrow();

  const incompatibleAggregate = structuredClone(memory.events) as Array<Record<string, unknown>>;
  const incompatibleEvaluation = incompatibleAggregate.find(
    (event) =>
      event.recordType === 'evaluation.completed' &&
      event.decisionId === 'aggregate-observed-retry',
  );
  if (!incompatibleEvaluation) throw new Error('aggregate evaluation fixture is missing');
  incompatibleEvaluation.outcome = 'noop';
  expect(() => recoverLedger(incompatibleAggregate, { requireBinding: true })).toThrow(
    'order completion does not match evaluation outcome',
  );
});

test('recovery requires reset and a fresh position after uncertain completions', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  await scheduler(broker, memory).schedule(1, context(), {
    decisionId: 'uncertain-finalization',
  });

  for (const completionKind of ['filled', 'rejected', 'observed'] as const) {
    const valid = structuredClone(memory.events) as Array<Record<string, unknown>>;
    const result = valid.find((event) => event.recordType === 'order.result');
    const completion = valid.find((event) => event.recordType === 'order.completion');
    const evaluation = valid.find((event) => event.recordType === 'evaluation.completed');
    if (!result || !completion || !evaluation)
      throw new Error('uncertain completion fixture is incomplete');

    if (completionKind === 'rejected') {
      result.outcome = 'rejected';
      result.error = {
        name: 'BrokerError',
        message: 'blocked',
        code: 'reject',
        retryable: false,
      };
      delete result.fill;
      completion.outcome = 'rejected';
      completion.actualAfter = 0;
      completion.error = {
        name: 'BrokerError',
        message: 'blocked',
        code: 'reject',
        retryable: false,
      };
      delete completion.fill;
      evaluation.outcome = 'reject';
      evaluation.actualAfter = 0;
      evaluation.error = {
        name: 'BrokerError',
        message: 'blocked',
        code: 'reject',
        retryable: false,
      };
    } else if (completionKind === 'observed') {
      result.outcome = 'error';
      result.error = {
        name: 'BrokerError',
        message: 'retry later',
        code: 'connectivity',
        retryable: true,
        submitFailureCertainty: 'definitely-not-sent',
      };
      delete result.fill;
      completion.outcome = 'observed';
      completion.actualAfter = 1;
      delete completion.fill;
      delete completion.error;
      evaluation.outcome = 'noop';
      evaluation.actualBefore = 1;
      evaluation.actualAfter = 1;
      evaluation.delta = 0;
      delete evaluation.error;
    }
    expect(() => recoverLedger(valid, { requireBinding: true })).not.toThrow();

    const uncertain = structuredClone(valid) as Array<Record<string, unknown>>;
    const uncertainCompletion = uncertain.find((event) => event.recordType === 'order.completion');
    if (!uncertainCompletion) throw new Error('uncertain completion is missing');
    uncertainCompletion.actualAfter = null;
    uncertainCompletion.error = {
      name: 'PositionError',
      message: 'position unavailable',
      code: 'position-unknown',
      retryable: false,
    };
    expect(() => recoverLedger(uncertain, { requireBinding: true })).toThrow(
      'evaluation completed before position uncertainty was reset',
    );

    if (completionKind === 'filled') {
      const latchedPrefix = uncertain.filter(
        (event) => event.recordType !== 'evaluation.completed',
      );
      const accepted = latchedPrefix.find((event) => event.recordType === 'evaluation.accepted');
      const prior = latchedPrefix.at(-1);
      if (!accepted || !prior) throw new Error('latched acceptance fixture is incomplete');
      const blocked = [
        ...structuredClone(latchedPrefix),
        {
          ...structuredClone(accepted),
          sequence: (prior.sequence as number) + 1,
          recordedAt: prior.recordedAt,
          recordType: 'evaluation.skipped',
          decisionId: 'blocked-while-position-unknown',
          update: {
            ...(accepted.update as Record<string, unknown>),
            eventId: 'close-only:blocked-while-position-unknown',
          },
          reason: 'breaker-open',
          targetOrdinal: 2,
        },
      ];
      expect(() => recoverLedger(blocked, { requireBinding: true })).not.toThrow();

      const illegallyAccepted = [
        ...structuredClone(latchedPrefix),
        {
          ...structuredClone(accepted),
          sequence: (prior.sequence as number) + 1,
          recordedAt: prior.recordedAt,
          decisionId: 'accepted-while-position-unknown',
          update: {
            ...(accepted.update as Record<string, unknown>),
            eventId: 'close-only:accepted-while-position-unknown',
          },
          targetOrdinal: 2,
        },
      ];
      expect(() => recoverLedger(illegallyAccepted, { requireBinding: true })).toThrow(
        'evaluation accepted while breaker was latched',
      );

      const firstIntent = latchedPrefix.find((event) => event.recordType === 'order.intent');
      if (!firstIntent) throw new Error('latched correction fixture is incomplete');
      const secondClientId = 'pl_uncertain-finalization_2';
      const illegalCorrection = [
        ...structuredClone(latchedPrefix),
        {
          ...structuredClone(firstIntent),
          sequence: (prior.sequence as number) + 1,
          recordedAt: prior.recordedAt,
          logicalOrderId: 'uncertain-finalization:2',
          correctionSeq: 2,
          clientId: secondClientId,
          order: { ...(firstIntent.order as object), clientId: secondClientId },
          intentOrdinal: 2,
        },
      ];
      expect(() => recoverLedger(illegalCorrection, { requireBinding: true })).toThrow(
        'order intent while breaker was latched',
      );
    }

    const resolved = structuredClone(uncertain) as Array<Record<string, unknown>>;
    const evaluationIndex = resolved.findIndex(
      (event) => event.recordType === 'evaluation.completed',
    );
    const prior = resolved[evaluationIndex - 1];
    if (evaluationIndex < 1 || !prior) throw new Error('evaluation insertion point is missing');
    resolved.splice(evaluationIndex, 0, {
      schemaVersion: 3,
      sequence: 0,
      recordType: 'breaker',
      runId: prior.runId,
      executionId: prior.executionId,
      recordedAt: prior.recordedAt,
      state: 'reset',
      reason: 'operator',
      consecutiveErrors: 0,
    });
    resolved.forEach((event, index) => {
      event.sequence = index + 1;
    });
    expect(() => recoverLedger(resolved, { requireBinding: true })).not.toThrow();

    const nonOperatorReset = structuredClone(resolved) as Array<Record<string, unknown>>;
    const reset = nonOperatorReset.find(
      (event) => event.recordType === 'breaker' && event.state === 'reset',
    );
    if (!reset) throw new Error('reset fixture is missing');
    reset.reason = 'position-unknown';
    expect(() => recoverLedger(nonOperatorReset, { requireBinding: true })).toThrow(
      'breaker reset reason must be operator',
    );

    for (const field of ['actualBefore', 'actualAfter', 'delta'] as const) {
      const resetWithoutObservation = structuredClone(resolved) as Array<Record<string, unknown>>;
      const staleEvaluation = resetWithoutObservation.find(
        (event) => event.recordType === 'evaluation.completed',
      );
      if (!staleEvaluation) throw new Error('stale evaluation fixture is missing');
      staleEvaluation[field] = null;
      expect(() => recoverLedger(resetWithoutObservation, { requireBinding: true })).toThrow(
        'evaluation completion has no fresh position resolution',
      );
    }
  }
});

test('operator reset plus a fresh read resolves an uncertain completion', async () => {
  const broker = paper();
  const submit = broker.submit.bind(broker);
  const getPosition = broker.getPosition.bind(broker);
  let submits = 0;
  let reads = 0;
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  broker.getPosition = async (symbol, signal) => {
    reads++;
    if (reads === 2) throw new BrokerError('connectivity', 'refresh unavailable');
    return getPosition(symbol, signal);
  };
  const original = new MemoryLedger();
  let completionAppendStarted = false;
  let releaseCompletion!: () => void;
  const completionGate = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const gatedSink: LedgerSink = {
    append: async (record) => {
      await original.append(record);
      if (
        record.schemaVersion === 3 &&
        record.recordType === 'order.completion' &&
        record.actualAfter == null
      ) {
        completionAppendStarted = true;
        await completionGate;
      }
    },
  };
  const originalScheduler = scheduler(broker, gatedSink);
  const originalRun = originalScheduler.schedule(1, context(), {
    decisionId: 'uncertain-reset-resolution',
  });
  await waitFor(() => completionAppendStarted);
  const blockedRun = originalScheduler.schedule(2, context(2), {
    decisionId: 'blocked-during-uncertainty',
  });
  releaseCompletion();
  expect((await originalRun).status).toBe('unknown');
  expect(await blockedRun).toMatchObject({ status: 'skipped', reason: 'breaker-open' });
  expect(
    original.events.some(
      (event) =>
        event.recordType === 'evaluation.accepted' &&
        event.decisionId === 'blocked-during-uncertainty',
    ),
  ).toBe(false);
  expect(() => recoverLedger(original.events, { requireBinding: true })).not.toThrow();

  const breakerIndex = original.events.findIndex(
    (event) => event.recordType === 'breaker' && event.reason === 'position-unknown',
  );
  const prefixLedger = await ledgerFrom(original.events.slice(0, breakerIndex));
  const recovery = recoverLedger(prefixLedger.events, { requireBinding: true });
  const restarted = scheduler(broker, prefixLedger, { recovery });
  await restarted.resetBreaker('authorize a fresh position read');
  const resumed = await restarted.schedule(1, context(), {
    decisionId: 'uncertain-reset-resolution',
  });
  expect(resumed).toMatchObject({
    status: 'completed',
    outcome: { action: 'order', actualAfter: 1 },
  });
  expect(submits).toBe(1);
  expect(reads).toBe(3);
  const completionSequence = prefixLedger.events.find(
    (event) =>
      event.recordType === 'order.completion' && event.decisionId === 'uncertain-reset-resolution',
  )?.sequence;
  const resetSequence = prefixLedger.events.find(
    (event) => event.recordType === 'breaker' && event.state === 'reset',
  )?.sequence;
  const evaluationSequence = prefixLedger.events.find(
    (event) =>
      event.recordType === 'evaluation.completed' &&
      event.decisionId === 'uncertain-reset-resolution',
  )?.sequence;
  expect(completionSequence).toBeLessThan(resetSequence!);
  expect(resetSequence).toBeLessThan(evaluationSequence!);
  const finalRecovery = recoverLedger(prefixLedger.events, { requireBinding: true });
  expect(finalRecovery.lastFinalDecisionId).toBe('blocked-during-uncertainty');
  expect(finalRecovery.latestBreakerResetSequence).toBe(resetSequence);
  expect(
    finalRecovery.decisions.get('uncertain-reset-resolution')?.latestPositionUncertaintySequence,
  ).toBe(completionSequence);
  expect(finalRecovery.breaker.latched).toBe(false);
});

test('runtime recovery rejects incomplete bindings, unknown breaker reasons, and late results', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  await scheduler(broker, memory).schedule(1, context(), { decisionId: 'schema-check' });

  const incompleteBinding = structuredClone(memory.events) as Array<Record<string, unknown>>;
  delete (incompleteBinding[0]!.binding as Record<string, unknown>).providerId;
  expect(() => recoverLedger(incompleteBinding)).toThrow('binding.providerId');

  const badBreaker = structuredClone(memory.events) as Array<Record<string, unknown>>;
  const completed = badBreaker.at(-1)!;
  badBreaker.push({
    schemaVersion: 3,
    sequence: (completed.sequence as number) + 1,
    recordType: 'breaker',
    runId: completed.runId,
    executionId: completed.executionId,
    recordedAt: completed.recordedAt,
    state: 'latched',
    reason: 'not-a-reason',
    consecutiveErrors: 0,
  });
  expect(() => recoverLedger(badBreaker)).toThrow('invalid breaker reason');

  const lateResult = structuredClone(memory.events) as Array<Record<string, unknown>>;
  const result = lateResult.find((event) => event.recordType === 'order.result')!;
  const last = lateResult.at(-1)!;
  lateResult.push({
    ...result,
    sequence: (last.sequence as number) + 1,
    recordedAt: last.recordedAt,
  });
  expect(() => recoverLedger(lateResult)).toThrow('result followed order completion');
});

test('breaker reset cannot admit a different decision while an old submit is unresolved', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const submit = broker.submit.bind(broker);
  let submits = 0;
  broker.submit = async () => {
    submits++;
    throw new BrokerError('timeout', 'old outcome unknown');
  };
  const targetScheduler = scheduler(broker, memory);
  expect(
    (await targetScheduler.schedule(1, context(1), { decisionId: 'old-decision' })).status,
  ).toBe('unknown');
  await expect(targetScheduler.resetBreaker('venue lookup required')).rejects.toThrow(
    'may have been submitted',
  );
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  const unrelated = await targetScheduler.schedule(2, context(2), {
    decisionId: 'new-decision',
  });
  expect(unrelated.reason).toBe('breaker-open');
  expect(submits).toBe(1);
  expect(targetScheduler.state.unresolvedLogicalOrderIds).toEqual(['old-decision:1']);
  expect(recoverLedger(memory.events).breaker).toMatchObject({
    latched: true,
    reason: 'submission-unknown',
  });
});

test('repeating a pre-accept skipped decision is read-only and replayable', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const targetScheduler = scheduler(broker, memory, {
    limits: { maxTargetsPerBar: 1 },
  });
  await targetScheduler.schedule(0, context(1), { decisionId: 'accepted' });
  expect(
    (await targetScheduler.schedule(1, context(1), { decisionId: 'pre-skipped' })).reason,
  ).toBe('target-limit');
  const sequenceAfterSkip = memory.events.at(-1)!.sequence;
  expect(
    (await targetScheduler.schedule(1, context(1), { decisionId: 'pre-skipped' })).reason,
  ).toBe('duplicate');
  expect(memory.events.at(-1)!.sequence).toBe(sequenceAfterSkip);
  expect(() => recoverLedger(memory.events)).not.toThrow();
});

test('scheduler and recovery reject a broker route that diverges from the durable binding', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  let submits = 0;
  broker.submit = async () => {
    submits++;
    throw new Error('must not submit');
  };
  await expect(
    scheduler(broker, memory).schedule(1, {
      ...context(),
      strategySymbol: 'OTHER',
      executionSymbol: 'Y',
    }),
  ).rejects.toThrow('durable instrument binding');
  expect(submits).toBe(0);
  expect(memory.events).toHaveLength(0);

  const validBroker = paper();
  const validLedger = new MemoryLedger();
  await scheduler(validBroker, validLedger).schedule(1, context(), { decisionId: 'route' });
  const mismatched = structuredClone(validLedger.events) as Array<Record<string, unknown>>;
  const accepted = mismatched.find((event) => event.recordType === 'evaluation.accepted')!;
  accepted.executionSymbol = 'Y';
  expect(() => recoverLedger(mismatched)).toThrow('decision route does not match binding');
});

test('lease is rechecked after attempt durability and before submit', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const lease = new InMemoryExecutionLease('attempt-window', {
    ownerId: 'owner',
    leaseId: 'attempt-window-lease',
  });
  let submits = 0;
  broker.submit = async () => {
    submits++;
    throw new Error('must not submit after lease loss');
  };
  const sink: LedgerSink = {
    append: async (record) => {
      await memory.append(record);
      if (record.schemaVersion === 3 && record.recordType === 'order.attempt')
        await lease.release();
    },
  };
  const result = await scheduler(broker, sink, { lease }).schedule(1, context(), {
    decisionId: 'lease-window',
  });
  expect(result.status).toBe('failed');
  expect(submits).toBe(0);
  expect(
    memory.events.some((event) => event.recordType === 'breaker' && event.reason === 'lease-lost'),
  ).toBe(true);
});

test('initialization durability failure releases only the lease acquired by the scheduler', async () => {
  const broker = paper();
  const lease = new InMemoryExecutionLease('initialization-failure', {
    ownerId: 'scheduler',
    leaseId: 'scheduler-lease',
  });
  const sink: LedgerSink = {
    append: async () => {
      throw new Error('lease event sync failed');
    },
  };
  const targetScheduler = scheduler(broker, sink, { lease });
  await expect(targetScheduler.initialize()).rejects.toThrow('lease event sync failed');
  expect(lease.snapshot).toBeUndefined();

  const successor = new InMemoryExecutionLease('initialization-failure', {
    ownerId: 'successor',
    leaseId: 'successor-lease',
  });
  expect((await successor.acquire()).ownerId).toBe('successor');
  await successor.release();
});

test('concurrent duplicate decision is read-only and cannot finalize twice', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const getPosition = broker.getPosition.bind(broker);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  broker.getPosition = async (symbol, signal) => {
    reads++;
    if (reads === 1) await gate;
    return getPosition(symbol, signal);
  };
  const targetScheduler = scheduler(broker, memory);
  const first = targetScheduler.schedule(1, context(), { decisionId: 'same-active' });
  await waitFor(() => reads === 1);
  const duplicate = await targetScheduler.schedule(1, context(), { decisionId: 'same-active' });
  expect(duplicate).toMatchObject({ status: 'skipped', reason: 'duplicate' });
  release();
  expect((await first).status).toBe('completed');
  expect(
    memory.events.filter(
      (event) => event.recordType === 'evaluation.completed' && event.decisionId === 'same-active',
    ),
  ).toHaveLength(1);
  expect(() => recoverLedger(memory.events)).not.toThrow();
});

test('pre-accept skipped decision IDs still enforce exact evaluation identity', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const targetScheduler = scheduler(broker, memory, {
    limits: { maxTargetsPerBar: 1 },
  });
  await targetScheduler.schedule(0, context(1), { decisionId: 'takes-cap' });
  await targetScheduler.schedule(1, context(1), {
    decisionId: 'skipped-identity',
    cursor: { revision: 1 },
  });
  const lastSequence = memory.events.at(-1)!.sequence;
  await expect(
    targetScheduler.schedule(2, context(1), {
      decisionId: 'skipped-identity',
      cursor: { revision: 2 },
    }),
  ).rejects.toThrow('different evaluation identity');
  expect(memory.events.at(-1)!.sequence).toBe(lastSequence);
  expect(() => recoverLedger(memory.events)).not.toThrow();
});

test('restart never resubmits a durable terminal result missing only completion', async () => {
  for (const terminal of ['filled', 'rejected'] as const) {
    const broker =
      terminal === 'rejected'
        ? new PaperBroker({ instruments: { X: instrument }, reject: () => 'blocked' })
        : paper();
    broker.mark('X', 100, 1);
    const memory = new MemoryLedger();
    let submits = 0;
    const submit = broker.submit.bind(broker);
    broker.submit = async (order, signal) => {
      submits++;
      return submit(order, signal);
    };
    const failingSink: LedgerSink = {
      append: async (record) => {
        if (record.schemaVersion === 3 && record.recordType === 'order.completion')
          throw new Error('completion durability failed');
        await memory.append(record);
      },
    };
    expect(
      (
        await scheduler(broker, failingSink).schedule(1, context(), {
          decisionId: `terminal-${terminal}`,
        })
      ).status,
    ).toBe('unknown');
    expect(submits).toBe(1);

    const recovery = recoverLedger(memory.events);
    const restarted = scheduler(broker, memory, { recovery });
    await restarted.resetBreaker('resume durable terminal result');
    if (terminal === 'filled') {
      const getPosition = broker.getPosition.bind(broker);
      let stale = true;
      broker.getPosition = async (symbol, signal) => {
        if (stale) {
          stale = false;
          return { symbol, qty: 0 };
        }
        return getPosition(symbol, signal);
      };
    }
    const resumed = await restarted.schedule(1, context(), {
      decisionId: `terminal-${terminal}`,
    });
    expect(submits).toBe(1);
    if (terminal === 'filled') {
      expect(resumed.status).toBe('unknown');
      expect(restarted.state.breaker).toMatchObject({
        latched: true,
        reason: 'position-unknown',
      });
    } else {
      expect(resumed.status).toBe('completed');
    }
    const finalRecovery = recoverLedger(memory.events);
    expect(finalRecovery.unresolvedIntents.size).toBe(0);
  }
});

test('recovery rejects skips after completion and overlapping correction intents', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  await scheduler(broker, memory).schedule(1, context(), { decisionId: 'transition-check' });

  const lateSkip = structuredClone(memory.events) as Array<Record<string, unknown>>;
  const accepted = lateSkip.find((event) => event.recordType === 'evaluation.accepted')!;
  const last = lateSkip.at(-1)!;
  lateSkip.push({
    ...accepted,
    sequence: (last.sequence as number) + 1,
    recordedAt: last.recordedAt,
    recordType: 'evaluation.skipped',
    reason: 'duplicate',
  });
  expect(() => recoverLedger(lateSkip)).toThrow('skip followed evaluation completion');

  const overlapping = structuredClone(memory.events) as Array<Record<string, unknown>>;
  const intentIndex = overlapping.findIndex((event) => event.recordType === 'order.intent');
  const firstIntent = overlapping[intentIndex]!;
  const secondClientId = 'pl_transition-check_2';
  overlapping.splice(intentIndex + 1, 0, {
    ...firstIntent,
    correctionSeq: 2,
    logicalOrderId: 'transition-check:2',
    clientId: secondClientId,
    order: { ...(firstIntent.order as object), clientId: secondClientId },
    intentOrdinal: 2,
  });
  overlapping.forEach((event, index) => {
    event.sequence = index + 1;
  });
  expect(() => recoverLedger(overlapping)).toThrow('overlaps an unresolved logical order');
});

test('restart finalizes a durable rejected completion without another broker effect', async () => {
  const broker = new PaperBroker({
    instruments: { X: instrument },
    reject: () => 'blocked',
  });
  broker.mark('X', 100, 1);
  const memory = new MemoryLedger();
  const submit = broker.submit.bind(broker);
  const getPosition = broker.getPosition.bind(broker);
  let submits = 0;
  let reads = 0;
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  broker.getPosition = async (symbol, signal) => {
    reads++;
    return getPosition(symbol, signal);
  };
  const sink: LedgerSink = {
    append: async (record) => {
      if (record.schemaVersion === 3 && record.recordType === 'evaluation.completed')
        throw new Error('evaluation completion durability failed');
      await memory.append(record);
    },
  };

  await expect(
    scheduler(broker, sink).schedule(1, context(), {
      decisionId: 'rejected-completion-prefix',
    }),
  ).rejects.toThrow('evaluation completion durability failed');
  expect(submits).toBe(1);
  const readsBeforeRestart = reads;
  const recovery = recoverLedger(memory.events, { requireBinding: true });
  expect(
    recovery.decisions.get('rejected-completion-prefix')?.latestCompletedIntent?.completion,
  ).toMatchObject({ outcome: 'rejected', actualAfter: 0 });

  const restarted = scheduler(broker, memory, { recovery });
  const resumed = await restarted.schedule(1, context(), {
    decisionId: 'rejected-completion-prefix',
  });
  expect(resumed).toMatchObject({ status: 'completed', outcome: { action: 'reject' } });
  expect(submits).toBe(1);
  expect(reads).toBe(readsBeforeRestart);
  expect(
    memory.events.filter(
      (event) =>
        event.recordType === 'order.intent' && event.decisionId === 'rejected-completion-prefix',
    ),
  ).toHaveLength(1);
  expect(
    memory.events.filter(
      (event) =>
        event.recordType === 'evaluation.completed' &&
        event.decisionId === 'rejected-completion-prefix',
    ),
  ).toHaveLength(1);
  expect(recoverLedger(memory.events).consecutiveErrors).toBe(1);
});

test('uncertain completion prefix infers position-unknown without a breaker row', async () => {
  const broker = paper();
  const getPosition = broker.getPosition.bind(broker);
  let reads = 0;
  broker.getPosition = async (symbol, signal) => {
    reads++;
    if (reads === 2) throw new BrokerError('connectivity', 'refresh unavailable');
    return getPosition(symbol, signal);
  };
  const memory = new MemoryLedger();
  const result = await scheduler(broker, memory).schedule(1, context(), {
    decisionId: 'completion-only-breaker',
  });
  expect(result.status).toBe('unknown');
  const breakerIndex = memory.events.findIndex(
    (event) => event.recordType === 'breaker' && event.reason === 'position-unknown',
  );
  expect(breakerIndex).toBeGreaterThan(0);
  const prefix = memory.events.slice(0, breakerIndex);
  expect(prefix.at(-1)).toMatchObject({
    recordType: 'order.completion',
    outcome: 'filled',
    actualAfter: null,
  });

  const recovery = recoverLedger(prefix, { requireBinding: true });
  expect(recovery.unresolvedIntents.size).toBe(0);
  expect(recovery.consecutiveErrors).toBe(1);
  expect(recovery.breaker).toMatchObject({
    latched: true,
    reason: 'position-unknown',
  });
});

test('accepted limit decision rejects reference drift before broker access', async () => {
  const originalBroker = paper();
  const originalLedger = new MemoryLedger();
  const getPosition = originalBroker.getPosition.bind(originalBroker);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  originalBroker.getPosition = async (symbol, signal) => {
    reads++;
    if (reads === 1) await gate;
    return getPosition(symbol, signal);
  };
  const original = scheduler(originalBroker, originalLedger, {
    mirror: new PositionMirror(originalBroker, instrument, { orderType: 'limit' }),
  });
  const running = original.schedule(
    1,
    { ...context(), referencePrice: 100 },
    {
      decisionId: 'reference-identity',
    },
  );
  await waitFor(() => reads === 1);
  const prefixEvents = structuredClone(originalLedger.events);
  expect(prefixEvents.at(-1)).toMatchObject({
    recordType: 'evaluation.accepted',
    referencePrice: 100,
  });
  release();
  await running;

  const prefixLedger = await ledgerFrom(prefixEvents);
  const recovery = recoverLedger(prefixLedger.events, { requireBinding: true });
  const restartedBroker = paper();
  const restartedGetPosition = restartedBroker.getPosition.bind(restartedBroker);
  const restartedSubmit = restartedBroker.submit.bind(restartedBroker);
  let brokerReads = 0;
  let brokerSubmits = 0;
  restartedBroker.getPosition = async (symbol, signal) => {
    brokerReads++;
    return restartedGetPosition(symbol, signal);
  };
  restartedBroker.submit = async (order, signal) => {
    brokerSubmits++;
    return restartedSubmit(order, signal);
  };
  const restarted = scheduler(restartedBroker, prefixLedger, {
    recovery,
    mirror: new PositionMirror(restartedBroker, instrument, { orderType: 'limit' }),
  });
  await restarted.initialize();
  const lastSequence = prefixLedger.events.at(-1)!.sequence;
  await expect(
    restarted.schedule(
      1,
      { ...context(), referencePrice: 200 },
      {
        decisionId: 'reference-identity',
      },
    ),
  ).rejects.toThrow('different evaluation identity');
  expect(brokerReads).toBe(0);
  expect(brokerSubmits).toBe(0);
  expect(prefixLedger.events.at(-1)!.sequence).toBe(lastSequence);
});

test('active recovered lease requires a supplied matching lease before broker access', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const lease = new InMemoryExecutionLease('active-recovery', {
    ownerId: 'owner',
    leaseId: 'active-recovery-lease',
  });
  const owner = scheduler(broker, memory, { lease });
  await owner.initialize();
  try {
    const recovery = recoverLedger(memory.events, { requireBinding: true });
    expect(recovery.activeLease).toMatchObject({
      resource: 'active-recovery',
      ownerId: 'owner',
      leaseId: 'active-recovery-lease',
    });
    let brokerReads = 0;
    let brokerSubmits = 0;
    broker.getPosition = async () => {
      brokerReads++;
      throw new Error('broker read must not occur');
    };
    broker.submit = async () => {
      brokerSubmits++;
      throw new Error('broker submit must not occur');
    };
    const restarted = scheduler(broker, memory, { recovery });
    const eventCount = memory.events.length;
    await expect(
      restarted.schedule(0, context(), { decisionId: 'lease-downgrade' }),
    ).rejects.toThrow('active execution lease');
    expect(brokerReads).toBe(0);
    expect(brokerSubmits).toBe(0);
    expect(memory.events).toHaveLength(eventCount);
  } finally {
    await owner.releaseLease();
  }
});

test('restart journals a recovered consecutive-error threshold before broker access', async () => {
  const broker = new PaperBroker({
    instruments: { X: instrument },
    reject: () => 'blocked',
  });
  broker.mark('X', 100, 1);
  const memory = new MemoryLedger();
  const getPosition = broker.getPosition.bind(broker);
  const submit = broker.submit.bind(broker);
  let reads = 0;
  let submits = 0;
  broker.getPosition = async (symbol, signal) => {
    reads++;
    return getPosition(symbol, signal);
  };
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  const sink: LedgerSink = {
    append: async (record) => {
      if (
        record.schemaVersion === 3 &&
        record.recordType === 'breaker' &&
        record.reason === 'consecutive-errors'
      )
        throw new Error('breaker durability failed');
      await memory.append(record);
    },
  };
  await expect(
    scheduler(broker, sink, {
      limits: { maxConsecutiveErrors: 1 },
    }).schedule(1, context(1), { decisionId: 'threshold-prefix' }),
  ).rejects.toThrow('breaker durability failed');
  expect(memory.events.at(-1)).toMatchObject({
    recordType: 'evaluation.completed',
    outcome: 'reject',
  });
  const recovery = recoverLedger(memory.events, { requireBinding: true });
  expect(recovery).toMatchObject({ consecutiveErrors: 1, breaker: { latched: false } });
  const readsBeforeRestart = reads;

  const restarted = scheduler(broker, memory, {
    recovery,
    limits: { maxConsecutiveErrors: 1 },
  });
  const blocked = await restarted.schedule(2, context(2), {
    decisionId: 'threshold-blocked',
  });
  expect(blocked).toMatchObject({ status: 'skipped', reason: 'breaker-open' });
  expect(reads).toBe(readsBeforeRestart);
  expect(submits).toBe(1);
  expect(recoverLedger(memory.events).breaker).toMatchObject({
    latched: true,
    reason: 'consecutive-errors',
  });
});

test('replacement durability failure leaves the old pending target terminal', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const getPosition = broker.getPosition.bind(broker);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  broker.getPosition = async (symbol, signal) => {
    reads++;
    if (reads === 1) await gate;
    return getPosition(symbol, signal);
  };
  const sink: LedgerSink = {
    append: async (record) => {
      if (
        record.schemaVersion === 3 &&
        record.recordType === 'evaluation.accepted' &&
        record.decisionId === 'replacement-fails'
      )
        throw new Error('replacement acceptance failed');
      await memory.append(record);
    },
  };
  const targetScheduler = scheduler(broker, sink);
  const active = targetScheduler.schedule(1, context(1), { decisionId: 'replacement-active' });
  await waitFor(() => reads === 1);
  const pending = targetScheduler.schedule(2, context(2), { decisionId: 'replacement-old' });
  await waitFor(() =>
    memory.events.some(
      (event) =>
        event.recordType === 'evaluation.accepted' && event.decisionId === 'replacement-old',
    ),
  );
  await expect(
    targetScheduler.schedule(3, context(3), { decisionId: 'replacement-fails' }),
  ).rejects.toThrow('replacement acceptance failed');
  expect((await pending).reason).toBe('coalesced');
  const prefixEvents = structuredClone(memory.events);
  expect(
    prefixEvents.some(
      (event) =>
        event.recordType === 'evaluation.skipped' &&
        event.decisionId === 'replacement-old' &&
        event.reason === 'coalesced',
    ),
  ).toBe(true);
  expect(
    prefixEvents.some(
      (event) =>
        event.recordType === 'evaluation.accepted' && event.decisionId === 'replacement-fails',
    ),
  ).toBe(false);
  release();
  await active;

  const prefixLedger = await ledgerFrom(prefixEvents);
  const recovery = recoverLedger(prefixLedger.events, { requireBinding: true });
  const restartedBroker = paper();
  let restartedReads = 0;
  restartedBroker.getPosition = async () => {
    restartedReads++;
    throw new Error('coalesced target must not reach broker');
  };
  const duplicate = await scheduler(restartedBroker, prefixLedger, { recovery }).schedule(
    2,
    context(2),
    { decisionId: 'replacement-old' },
  );
  expect(duplicate).toMatchObject({ status: 'skipped', reason: 'duplicate' });
  expect(restartedReads).toBe(0);
});

test('recovery durably coalesces legacy middle accepted targets before broker access', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const getPosition = broker.getPosition.bind(broker);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  broker.getPosition = async (symbol, signal) => {
    reads++;
    if (reads === 1) await gate;
    return getPosition(symbol, signal);
  };
  const original = scheduler(broker, memory);
  const active = original.schedule(1, context(1), { decisionId: 'legacy-active' });
  await waitFor(() => reads === 1);
  const pending = original.schedule(2, context(2), { decisionId: 'legacy-stale' });
  await waitFor(() =>
    memory.events.some(
      (event) => event.recordType === 'evaluation.accepted' && event.decisionId === 'legacy-stale',
    ),
  );
  const legacyPrefix = structuredClone(memory.events);
  const stale = legacyPrefix.find(
    (event) => event.recordType === 'evaluation.accepted' && event.decisionId === 'legacy-stale',
  )!;
  legacyPrefix.push({
    ...stale,
    sequence: stale.sequence + 1,
    recordedAt: stale.recordedAt,
    decisionId: 'legacy-newest',
    barTime: 3,
    cursor: 3,
    update: {
      ...stale.update,
      eventId: 'close-only:legacy-newest',
    },
    target: 3,
  });
  release();
  await active;
  await pending;

  const prefixLedger = await ledgerFrom(legacyPrefix);
  const recovery = recoverLedger(prefixLedger.events, { requireBinding: true });
  expect(recovery.supersededDecisionIds).toEqual(['legacy-stale']);
  const restartedBroker = paper();
  let brokerReads = 0;
  restartedBroker.getPosition = async () => {
    brokerReads++;
    throw new Error('superseded target must not reach broker');
  };
  const restarted = scheduler(restartedBroker, prefixLedger, { recovery });
  await restarted.initialize();
  expect(brokerReads).toBe(0);
  expect(
    prefixLedger.events.some(
      (event) =>
        event.recordType === 'evaluation.skipped' &&
        event.decisionId === 'legacy-stale' &&
        event.reason === 'coalesced',
    ),
  ).toBe(true);
  const duplicate = await restarted.schedule(2, context(2), {
    decisionId: 'legacy-stale',
  });
  expect(duplicate).toMatchObject({ status: 'skipped', reason: 'duplicate' });
  expect(brokerReads).toBe(0);
  expect(recoverLedger(prefixLedger.events).supersededDecisionIds).toEqual([]);
});

test('fresh target observation cannot reclassify a recovered broker rejection as noop', async () => {
  const broker = new PaperBroker({
    instruments: { X: instrument },
    reject: () => 'blocked',
  });
  broker.mark('X', 100, 1);
  const memory = new MemoryLedger();
  const submit = broker.submit.bind(broker);
  let submits = 0;
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  const sink: LedgerSink = {
    append: async (record) => {
      if (record.schemaVersion === 3 && record.recordType === 'order.completion')
        throw new Error('completion durability failed');
      await memory.append(record);
    },
  };
  expect(
    (
      await scheduler(broker, sink).schedule(1, context(), {
        decisionId: 'rejected-noop-prefix',
      })
    ).status,
  ).toBe('unknown');
  expect(submits).toBe(1);

  const recovery = recoverLedger(memory.events, { requireBinding: true });
  const restarted = scheduler(broker, memory, { recovery });
  await restarted.resetBreaker('resolve terminal rejection');
  broker.setPosition('X', 1, 100);
  const resumed = await restarted.schedule(1, context(), {
    decisionId: 'rejected-noop-prefix',
  });
  expect(resumed).toMatchObject({ status: 'unknown', outcome: { action: 'reject' } });
  expect(submits).toBe(1);
  expect(
    memory.events.some(
      (event) =>
        event.recordType === 'evaluation.completed' &&
        event.decisionId === 'rejected-noop-prefix' &&
        event.outcome === 'noop',
    ),
  ).toBe(false);
  expect(
    memory.events.find(
      (event) =>
        event.recordType === 'order.completion' && event.decisionId === 'rejected-noop-prefix',
    ),
  ).toMatchObject({ outcome: 'rejected', error: { code: 'position-unknown' } });
  expect(recoverLedger(memory.events).breaker).toMatchObject({
    latched: true,
    reason: 'position-unknown',
  });
});

test('restart conservatively preserves minimum reconciliation spacing', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  let now = 1_000;
  await scheduler(broker, memory, {
    limits: { minIntervalMs: 250 },
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
  }).schedule(1, context(1), { decisionId: 'paced-before-restart' });

  const recovery = recoverLedger(memory.events, { requireBinding: true });
  expect(recovery.lastCompletedEvaluationAt).toBe(1_000);
  const sleeps: number[] = [];
  const readTimes: number[] = [];
  const getPosition = broker.getPosition.bind(broker);
  broker.getPosition = async (symbol, signal) => {
    readTimes.push(now);
    return getPosition(symbol, signal);
  };
  const restarted = scheduler(broker, memory, {
    recovery,
    limits: { minIntervalMs: 250 },
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  expect(
    (await restarted.schedule(2, context(2), { decisionId: 'paced-after-restart' })).status,
  ).toBe('completed');
  expect(sleeps).toEqual([250]);
  expect(readTimes[0]).toBe(1_250);
});

test('concurrent initialization writes each one-shot transition exactly once', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  let entered!: () => void;
  let release!: () => void;
  const appendEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let bindingAppends = 0;
  const sink: LedgerSink = {
    append: async (record) => {
      if (record.schemaVersion === 3 && record.recordType === 'binding') {
        bindingAppends++;
        entered();
        await gate;
      }
      await memory.append(record);
    },
  };
  const targetScheduler = scheduler(broker, sink);
  const first = targetScheduler.initialize();
  await appendEntered;
  const second = targetScheduler.initialize();
  release();
  await Promise.all([first, second]);
  expect(bindingAppends).toBe(1);
  expect(memory.events.filter((event) => event.recordType === 'binding')).toHaveLength(1);
  expect(() => recoverLedger(memory.events, { requireBinding: true })).not.toThrow();
});

test('concurrent breaker resets serialize behind intake and remain replayable', async () => {
  const broker = new PaperBroker({
    instruments: { X: instrument },
    reject: () => 'blocked',
  });
  broker.mark('X', 100, 1);
  const memory = new MemoryLedger();
  const targetScheduler = scheduler(broker, memory, {
    limits: { maxConsecutiveErrors: 1 },
  });
  await targetScheduler.schedule(1, context(1), { decisionId: 'reset-latch' });
  expect(targetScheduler.state.breaker.latched).toBe(true);

  const blocked = targetScheduler.schedule(2, context(2), { decisionId: 'reset-blocked' });
  const resets = Promise.all([
    targetScheduler.resetBreaker('concurrent reset one'),
    targetScheduler.resetBreaker('concurrent reset two'),
  ]);
  expect(await blocked).toMatchObject({ status: 'skipped', reason: 'breaker-open' });
  const snapshots = await resets;
  expect(snapshots[0]?.latched).toBe(false);
  expect(snapshots[1]?.latched).toBe(false);
  expect(
    memory.events.filter((event) => event.recordType === 'breaker' && event.state === 'reset'),
  ).toHaveLength(1);
  expect(() => recoverLedger(memory.events, { requireBinding: true })).not.toThrow();
});

test('exact resolution rejects definitely-not-sent history without lookup or journal mutation', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const submit = broker.submit.bind(broker);
  let attempts = 0;
  broker.submit = async (order, signal) => {
    attempts++;
    if (attempts === 1)
      throw new BrokerError('connectivity', 'pre-transmission failure', {
        submitFailureCertainty: 'definitely-not-sent',
      });
    return submit(order, signal);
  };
  await scheduler(broker, memory, {
    mirror: new PositionMirror(broker, instrument, {
      transientRetries: 1,
      sleep: async () => {},
    }),
  }).schedule(1, context(), { decisionId: 'proven-unsent-resolution' });

  const firstErrorIndex = memory.events.findIndex(
    (event) => event.recordType === 'order.result' && event.outcome === 'error',
  );
  expect(firstErrorIndex).toBeGreaterThanOrEqual(0);
  const prefixLedger = await ledgerFrom(memory.events.slice(0, firstErrorIndex + 1));
  const recovery = recoverLedger(prefixLedger.events, { requireBinding: true });
  expect(recovery.breaker.latched).toBe(false);
  expect(recovery.unresolvedIntents.has('proven-unsent-resolution:1')).toBe(true);

  const lookup = broker.lookupOrder.bind(broker);
  let lookups = 0;
  broker.lookupOrder = async (order, signal) => {
    lookups++;
    return lookup(order, signal);
  };
  const restarted = scheduler(broker, prefixLedger, { recovery });
  const eventCount = prefixLedger.events.length;
  await expect(restarted.resolveUnknownSubmission('proven-unsent-resolution:1')).rejects.toThrow(
    'no unresolved possibly-sent submission',
  );
  expect(lookups).toBe(0);
  expect(prefixLedger.events).toHaveLength(eventCount);
  expect(() => recoverLedger(prefixLedger.events, { requireBinding: true })).not.toThrow();
});

test('malformed exact rejection remains ambiguous, latched, and replayable', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  let submits = 0;
  broker.submit = async () => {
    submits++;
    throw new BrokerError('timeout', 'possibly sent');
  };
  broker.lookupOrder = async () => ({ status: 'rejected', message: '' });
  const targetScheduler = scheduler(broker, memory);
  expect(
    (await targetScheduler.schedule(1, context(), { decisionId: 'malformed-rejection' })).status,
  ).toBe('unknown');

  expect(await targetScheduler.resolveUnknownSubmission('malformed-rejection:1')).toMatchObject({
    status: 'ambiguous',
    resolved: false,
  });
  expect(submits).toBe(1);
  expect(targetScheduler.state.breaker.latched).toBe(true);
  expect(memory.events.findLast((event) => event.recordType === 'order.resolution')).toMatchObject({
    outcome: 'ambiguous',
    detail: 'exact broker lookup returned a rejection without a message',
  });
  const recovery = recoverLedger(memory.events, { requireBinding: true });
  expect(recovery.breaker.latched).toBe(true);
  expect(recovery.unresolvedIntents.has('malformed-rejection:1')).toBe(true);
});

test('legacy close-only event identity is independent of target economics', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const targetScheduler = scheduler(broker, memory);
  expect((await targetScheduler.schedule(0, context(30))).status).toBe('completed');
  const accepted = memory.events.find((event) => event.recordType === 'evaluation.accepted');
  if (accepted?.recordType !== 'evaluation.accepted') throw new Error('acceptance is missing');
  const eventCount = memory.events.length;

  await expect(targetScheduler.schedule(1, context(30))).rejects.toThrow(
    'duplicate decisionId has different evaluation identity',
  );
  expect(memory.events).toHaveLength(eventCount);
  expect(accepted.update.eventId).toStartWith('close-only:');
});

test('exact lookup completion preserves terminal fill and stays unlatched after restart', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const submit = broker.submit.bind(broker);
  let submits = 0;
  broker.submit = async (order, signal) => {
    submits++;
    return submit(order, signal);
  };
  await scheduler(broker, memory).schedule(1, context(), {
    decisionId: 'observed-retry',
  });
  expect(submits).toBe(1);

  const attemptIndex = memory.events.findIndex(
    (event) => event.recordType === 'order.attempt' && event.decisionId === 'observed-retry',
  );
  const prefixEvents = structuredClone(memory.events.slice(0, attemptIndex + 1));

  const prefixLedger = await ledgerFrom(prefixEvents);
  const recovery = recoverLedger(prefixLedger.events, { requireBinding: true });
  expect(recovery.breaker).toMatchObject({
    latched: true,
    reason: 'recovery-unresolved',
  });
  const restarted = scheduler(broker, prefixLedger, { recovery });
  expect(await restarted.resolveUnknownSubmission('observed-retry:1')).toMatchObject({
    status: 'filled',
    resolved: true,
  });
  await restarted.resetBreaker('exact terminal fill resolution');
  const resumed = await restarted.schedule(1, context(), {
    decisionId: 'observed-retry',
  });
  expect(resumed).toMatchObject({ status: 'completed', outcome: { action: 'order' } });
  expect(submits).toBe(1);
  const completion = prefixLedger.events.find(
    (event) => event.recordType === 'order.completion' && event.decisionId === 'observed-retry',
  );
  expect(completion).toMatchObject({ outcome: 'filled', actualAfter: 1 });
  expect(completion && 'error' in completion).toBe(false);

  const secondRecovery = recoverLedger(prefixLedger.events, { requireBinding: true });
  expect(secondRecovery.unresolvedIntents.size).toBe(0);
  expect(secondRecovery.consecutiveErrors).toBe(0);
  expect(secondRecovery.breaker.latched).toBe(false);
});

test('exact filled and rejected lookup resolution never retransmits the client id', async () => {
  for (const terminal of ['filled', 'rejected'] as const) {
    const broker = new PaperBroker({
      instruments: { X: instrument },
      ...(terminal === 'rejected' ? { reject: () => 'venue rejected' } : {}),
    });
    broker.mark('X', 100, 1);
    const actualSubmit = broker.submit.bind(broker);
    let submits = 0;
    broker.submit = async (order, signal) => {
      submits++;
      try {
        await actualSubmit(order, signal);
      } catch (error) {
        if (terminal !== 'rejected') throw error;
      }
      throw new BrokerError('timeout', `${terminal} acknowledgement lost`);
    };
    const memory = new MemoryLedger();
    const targetScheduler = scheduler(broker, memory);
    expect(
      (await targetScheduler.schedule(1, context(), { decisionId: `lookup-${terminal}` })).status,
    ).toBe('unknown');
    expect(submits).toBe(1);

    const resolution = await targetScheduler.resolveUnknownSubmission(`lookup-${terminal}:1`);
    expect(resolution).toMatchObject({ status: terminal, resolved: true });
    expect(submits).toBe(1);
    await targetScheduler.resetBreaker(`resolved ${terminal}`);
    const resumed = await targetScheduler.schedule(1, context(), {
      decisionId: `lookup-${terminal}`,
    });
    expect(resumed).toMatchObject({
      status: 'completed',
      outcome: { action: terminal === 'filled' ? 'order' : 'reject' },
    });
    expect(submits).toBe(1);
    expect(memory.events.filter((event) => event.recordType === 'order.attempt')).toHaveLength(1);
    expect(memory.events.find((event) => event.recordType === 'order.resolution')).toMatchObject({
      outcome: terminal,
    });
    expect(() => recoverLedger(memory.events, { requireBinding: true })).not.toThrow();
  }
});

test('unsupported, ambiguous, and not-found exact lookup remain latched without retransmission', async () => {
  for (const lookupStatus of ['unsupported', 'ambiguous', 'not-found'] as const) {
    const broker = paper();
    let submits = 0;
    broker.submit = async () => {
      submits++;
      throw new BrokerError('timeout', 'possibly sent');
    };
    if (lookupStatus === 'unsupported') {
      (broker as unknown as { lookupOrder?: undefined }).lookupOrder = undefined;
    } else if (lookupStatus === 'ambiguous') {
      broker.lookupOrder = async () => ({ status: 'ambiguous', detail: 'multiple matches' });
    }
    const memory = new MemoryLedger();
    const targetScheduler = scheduler(broker, memory);
    await targetScheduler.schedule(1, context(), { decisionId: `lookup-${lookupStatus}` });
    expect(
      await targetScheduler.resolveUnknownSubmission(`lookup-${lookupStatus}:1`),
    ).toMatchObject({ status: lookupStatus, resolved: false });
    await expect(targetScheduler.resetBreaker('must remain blocked')).rejects.toThrow(
      'may have been submitted',
    );
    expect(submits).toBe(1);
    expect(targetScheduler.state.breaker.latched).toBe(true);
    expect(memory.events.filter((event) => event.recordType === 'order.attempt')).toHaveLength(1);
    expect(recoverLedger(memory.events).unresolvedIntents.size).toBe(1);
  }
});

test('forming completion and skip never advance the authoritative final cursor', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const targetScheduler = scheduler(broker, memory, {
    limits: { maxTargetsPerBar: 1 },
  });
  expect(
    (
      await targetScheduler.schedule({
        target: 0,
        context: context(10),
        cursor: { bar: 10, revision: 1 },
        decisionId: 'forming-complete',
        update: intrabarUpdate('bar-10-r1', 1, false),
      })
    ).status,
  ).toBe('completed');
  expect(
    (
      await targetScheduler.schedule({
        target: 1,
        context: context(10),
        cursor: { bar: 10, revision: 2 },
        decisionId: 'forming-skip',
        update: intrabarUpdate('bar-10-r2', 2, false),
      })
    ).reason,
  ).toBe('target-limit');
  let recovery = recoverLedger(memory.events, { requireBinding: true });
  expect(recovery.lastFinalCursor).toBeUndefined();
  expect([...recovery.activeBars.values()]).toEqual([
    expect.objectContaining({
      barTime: 10,
      revision: 2,
      discontinuity: false,
      interrupted: true,
      inhibitExecution: true,
    }),
  ]);

  expect(
    (
      await targetScheduler.schedule({
        target: 0,
        context: context(10),
        cursor: { bar: 10, revision: 3 },
        decisionId: 'forming-final',
        update: intrabarUpdate('bar-10-r3', 3, true),
      })
    ).reason,
  ).toBe('target-limit');
  recovery = recoverLedger(memory.events, { requireBinding: true });
  expect(recovery.lastFinalCursor).toEqual({ bar: 10, revision: 3 });
  expect(recovery.lastFinalUpdate).toMatchObject({
    eventId: 'bar-10-r3',
    revision: 3,
    authoritativeFinal: true,
  });
  expect(recovery.activeBars.size).toBe(0);
});

test('recovery exposes interrupted discontinuity state and rejects impossible transitions first', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const targetScheduler = scheduler(broker, memory);
  await targetScheduler.schedule({
    target: 0,
    context: context(20),
    cursor: { bar: 20, revision: 2 },
    decisionId: 'interrupted-forming',
    update: intrabarUpdate('bar-20-r2', 2, false, { discontinuity: true }),
  });
  const recovery = recoverLedger(memory.events, { requireBinding: true });
  expect([...recovery.activeBars.values()]).toEqual([
    expect.objectContaining({
      eventId: 'bar-20-r2',
      revision: 2,
      discontinuity: true,
      interrupted: true,
      inhibitExecution: true,
    }),
  ]);

  const restarted = scheduler(broker, memory, { recovery });
  const eventCount = memory.events.length;
  await expect(
    restarted.schedule({
      target: 0,
      context: context(20),
      decisionId: 'regressed-revision',
      update: intrabarUpdate('bar-20-r1', 1, false, { discontinuity: true }),
    }),
  ).rejects.toThrow('revision did not strictly increase');
  await expect(
    restarted.schedule({
      target: 0,
      context: context(21),
      decisionId: 'bar-changed-before-final',
      update: intrabarUpdate('bar-21-r1', 1, false, { discontinuity: true }),
    }),
  ).rejects.toThrow('bar changed before an authoritative final');
  expect(memory.events).toHaveLength(eventCount);
  expect(recoverLedger(memory.events).perBar.get(`${binding.id}:20`)).toEqual({
    targets: 1,
    intents: 0,
  });
});

test('recovery rejects an unmarked same-process discontinuity provenance change', async () => {
  const memory = new MemoryLedger();
  const targetScheduler = scheduler(paper(), memory);
  await targetScheduler.schedule({
    target: 0,
    context: context(25),
    decisionId: 'same-process-r1',
    update: intrabarUpdate('bar-25-r1', 1, false),
  });
  await targetScheduler.schedule({
    target: 0,
    context: context(25),
    decisionId: 'same-process-r2',
    update: intrabarUpdate('bar-25-r2', 2, false),
  });

  const changed = structuredClone(memory.events) as Array<Record<string, unknown>>;
  const secondAcceptance = changed.find(
    (event) => event.recordType === 'evaluation.accepted' && event.decisionId === 'same-process-r2',
  );
  if (!secondAcceptance) throw new Error('second acceptance is missing');
  (secondAcceptance.update as Record<string, unknown>).discontinuity = true;

  expect(() => recoverLedger(changed, { requireBinding: true })).toThrow(
    'chart discontinuity provenance changed within an active bar',
  );
});

test('legacy scheduler calls persist explicit close-only final identity', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  const result = await scheduler(broker, memory).schedule(0, context(30));
  expect(result.status).toBe('completed');
  const accepted = memory.events.find((event) => event.recordType === 'evaluation.accepted');
  expect(accepted).toMatchObject({
    update: {
      kind: 'close-only',
      revision: 1,
      authoritativeFinal: true,
      recovered: false,
      discontinuity: false,
    },
  });
  if (accepted?.recordType !== 'evaluation.accepted') throw new Error('acceptance is missing');
  expect(accepted.update.eventId).toStartWith('close-only:');
  const recovery = recoverLedger(memory.events, { requireBinding: true });
  expect(recovery.lastFinalCursor).toBe(30);
  expect(recovery.lastFinalUpdate?.kind).toBe('close-only');
});

test('recovered authoritative final provenance is durable and final', async () => {
  const broker = paper();
  const memory = new MemoryLedger();
  await scheduler(broker, memory).schedule({
    target: 0,
    context: context(40),
    cursor: { bar: 40, recovered: true },
    decisionId: 'recovered-final',
    update: intrabarUpdate('bar-40-recovered', 1, true, { recovered: true }),
  });
  const decisionRows = memory.events.filter(
    (event) => 'decisionId' in event && event.decisionId === 'recovered-final',
  );
  expect(decisionRows.length).toBeGreaterThan(1);
  for (const event of decisionRows) {
    if (!('update' in event)) throw new Error('decision row lost chart update identity');
    expect(event.update).toEqual({
      kind: 'intrabar',
      eventId: 'bar-40-recovered',
      revision: 1,
      authoritativeFinal: true,
      recovered: true,
      discontinuity: false,
    });
  }
  expect(recoverLedger(memory.events).lastFinalCursor).toEqual({ bar: 40, recovered: true });
});
