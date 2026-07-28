import { expect, test } from 'bun:test';
import { BrokerError, PaperBroker, PositionMirror } from '../src/index.js';

const instrument = { symbol: 'X', minQty: 1, mintick: 0.01 };

function context(time = 1) {
  return {
    strategySymbol: 'ROOT',
    executionSymbol: 'X',
    bindingId: 'binding-test',
    barTime: time,
    strategyId: 's',
    timeframe: '1h',
    sequence: time,
  };
}

test('mirror opens, caps and uses restart-stable ids', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.mark('X', 100, 1);
  const mirror = new PositionMirror(broker, instrument, { maxOrderQty: 2 });
  const outcome = await mirror.reconcile(5, context());
  expect(outcome.action).toBe('order');
  if (outcome.action === 'order') {
    expect(outcome.order.qty).toBe(2);
    expect(outcome.order.clientId).toBe('default:s:ROOT:X:binding-test:1h:1:0:5:2:reconcile');
  }
  expect((await broker.getPosition('X')).qty).toBe(2);
});

test('mirror treats sub-step deltas as noop', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.mark('X', 100, 1);
  broker.setPosition('X', 1);
  expect((await new PositionMirror(broker, instrument).reconcile(1.4, context())).action).toBe(
    'noop',
  );
});

test('mirror classifies rejection and leaves position', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument }, reject: () => 'blocked' });
  broker.mark('X', 100, 1);
  const outcome = await new PositionMirror(broker, instrument).reconcile(1, context());
  expect(outcome.action).toBe('reject');
  if (outcome.action === 'reject') expect(outcome.error.code).toBe('reject');
  expect((await broker.getPosition('X')).qty).toBe(0);
});

test('mirror retries transient submissions with the same client id', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.mark('X', 100, 1);
  const submit = broker.submit.bind(broker);
  const clientIds: string[] = [];
  let attempt = 0;
  broker.submit = async (order) => {
    clientIds.push(order.clientId);
    if (attempt++ === 0) throw new BrokerError('connectivity', 'temporary');
    return submit(order);
  };
  const outcome = await new PositionMirror(broker, instrument, {
    transientRetries: 1,
    sleep: async () => {},
  }).reconcile(1, context());
  expect(outcome.action).toBe('order');
  expect(clientIds).toEqual([
    'default:s:ROOT:X:binding-test:1h:1:0:1:1:reconcile',
    'default:s:ROOT:X:binding-test:1h:1:0:1:1:reconcile',
  ]);
});

test('position-read failure is classified as unknown, not flat', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.getPosition = async () => {
    throw new BrokerError('connectivity', 'unavailable');
  };
  const outcome = await new PositionMirror(broker, instrument).reconcile(1, context());
  expect(outcome.action).toBe('reject');
  if (outcome.action === 'reject') {
    expect(outcome.actualBefore).toBeNull();
    expect(outcome.actualAfter).toBeNull();
    expect(outcome.error.stage).toBe('position');
  }
});

test('timeframe and execution namespace prevent client-id collisions', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.mark('X', 100, 1);
  const mirror = new PositionMirror(broker, instrument);
  const first = await mirror.reconcile(1, { ...context(), executionId: 'a' });
  const second = await mirror.reconcile(2, {
    ...context(),
    timeframe: '4h',
    executionId: 'a',
  });
  expect(first.action).toBe('order');
  expect(second.action).toBe('order');
  if (first.action === 'order' && second.action === 'order') {
    expect(first.order.clientId).not.toBe(second.order.clientId);
  }
});

test('ordinary invariant errors are not swallowed', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.mark('X', 100, 1);
  broker.submit = async () => {
    throw new Error('bug');
  };
  await expect(new PositionMirror(broker, instrument).reconcile(1, context())).rejects.toThrow(
    'bug',
  );
  expect(new BrokerError('connectivity', 'x').retryable).toBe(true);
});

test('mirror preserves an acknowledged fill when position refresh fails', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.mark('X', 100, 1);
  const getPosition = broker.getPosition.bind(broker);
  let reads = 0;
  broker.getPosition = async (symbol) => {
    if (++reads === 2) throw new BrokerError('connectivity', 'refresh unavailable');
    return getPosition(symbol);
  };
  const outcome = await new PositionMirror(broker, instrument).reconcile(1, context());
  expect(outcome.action).toBe('order');
  if (outcome.action === 'order') {
    expect(outcome.fill.filledQty).toBe(1);
    expect(outcome.actualAfter).toBeNull();
    expect(outcome.positionError?.stage).toBe('position-refresh');
  }
  expect((await getPosition('X')).qty).toBe(1);
});

test('same-bar restart progresses capped corrections without replaying an old fill', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.mark('X', 100, 1);
  const ids: string[] = [];
  for (let restart = 0; restart < 3; restart++) {
    const outcome = await new PositionMirror(broker, instrument, { maxOrderQty: 2 }).reconcile(
      5,
      context(),
    );
    expect(outcome.action).toBe('order');
    if (outcome.action === 'order') ids.push(outcome.order.clientId);
  }
  expect(new Set(ids).size).toBe(3);
  expect((await broker.getPosition('X')).qty).toBe(5);
});

test('mirror rejects a cap smaller than one quantity step', () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  expect(() => new PositionMirror(broker, instrument, { maxOrderQty: 0.5 })).toThrow(
    'at least one quantity step',
  );
});
