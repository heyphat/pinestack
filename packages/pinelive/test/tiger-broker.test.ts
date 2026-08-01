import { expect, test } from 'bun:test';
import {
  BrokerError,
  TigerBroker,
  type TigerOrderResult,
  type TigerTradingTransport,
} from '../src/index.js';
import { runBrokerConformance } from '../src/testing/index.js';

class FixtureTradingTransport implements TigerTradingTransport {
  qty = 0;
  price = 100;
  reject?: string;
  submits = 0;
  readonly orders = new Map<string, TigerOrderResult>();
  async account() {
    return { id: 'demo', currency: 'USD', balance: 100_000, equity: 100_000 };
  }
  async instrument(symbol: string) {
    return {
      symbol,
      mintick: 0.1,
      qtyStep: 1,
      minOrderQty: 1,
      pointValue: 10,
      exchange: 'COMEX',
      expiry: '2024-12-27',
    };
  }
  async position(_account: string, symbol: string) {
    return { symbol, qty: this.qty };
  }
  async findOrderByClientId(_account: string, clientId: string) {
    return this.orders.get(clientId);
  }
  async submitMarket(
    _account: string,
    request: { symbol: string; side: 'buy' | 'sell'; qty: number; clientId: string },
  ) {
    this.submits++;
    const result: TigerOrderResult = this.reject
      ? {
          ...request,
          orderId: `order-${this.submits}`,
          requestedQty: request.qty,
          status: 'rejected',
          message: this.reject,
        }
      : {
          ...request,
          orderId: `order-${this.submits}`,
          requestedQty: request.qty,
          filledQty: request.qty,
          price: this.price,
          commission: 0,
          time: 1_700_000_000,
          status: 'filled',
        };
    this.orders.set(request.clientId, result);
    if (!this.reject) this.qty += request.side === 'buy' ? request.qty : -request.qty;
    return result;
  }
}

test('TigerBroker passes shared conformance over injected execution transport', async () => {
  let transport: FixtureTradingTransport;
  const failures = await runBrokerConformance(() => {
    transport = new FixtureTradingTransport();
    const broker = new TigerBroker({ transport, armed: true, accountId: 'demo' });
    return {
      broker,
      instrument: {
        symbol: 'MGCZ24',
        minQty: 1,
        qtyStep: 1,
        minOrderQty: 1,
        mintick: 0.1,
        pointValue: 10,
      },
      setPosition: (qty: number) => {
        transport.qty = qty;
      },
      rejectNext: (message: string) => {
        transport.reject = message;
      },
      mark: (price: number) => {
        transport.price = price;
      },
    };
  });
  expect(failures).toEqual([]);
});

test('TigerBroker independently gates submit and flatten while unarmed', async () => {
  const transport = new FixtureTradingTransport();
  transport.qty = 1;
  const broker = new TigerBroker({ transport, armed: false });
  await expect(
    broker.submit({ symbol: 'MGCZ24', side: 'buy', qty: 1, type: 'market', clientId: 'x' }),
  ).rejects.toMatchObject({ code: 'precondition' });
  await expect(broker.flatten('MGCZ24')).rejects.toMatchObject({ code: 'precondition' });
  expect(transport.submits).toBe(0);
});

test('TigerBroker uses exact-contract reads and remote client-id idempotency', async () => {
  const transport = new FixtureTradingTransport();
  const broker = new TigerBroker({ transport, armed: true, accountId: 'demo' });
  const request = {
    symbol: 'MGCZ24',
    side: 'buy' as const,
    qty: 1,
    type: 'market' as const,
    clientId: 'stable',
  };
  const first = await broker.submit(request);
  const second = await broker.submit(request);
  expect(first.brokerOrderId).toBe(second.brokerOrderId);
  expect(transport.submits).toBe(1);
  expect((await broker.getPosition('MGCZ24')).qty).toBe(1);
  await expect(broker.submit({ ...request, side: 'sell' })).rejects.toBeInstanceOf(BrokerError);
});

test('TigerBroker maps unknown terminal outcomes to retryable timeout', async () => {
  const transport = new FixtureTradingTransport();
  transport.submitMarket = async (_account, request) => ({
    ...request,
    requestedQty: request.qty,
    status: 'unknown',
  });
  const broker = new TigerBroker({ transport, armed: true });
  await expect(
    broker.submit({ symbol: 'MGCZ24', side: 'buy', qty: 1, type: 'market', clientId: 'unknown' }),
  ).rejects.toMatchObject({
    code: 'timeout',
    retryable: true,
    submitFailureCertainty: 'possibly-sent',
  });
  expect(broker.lookupOrder).toBeUndefined();
});

test('TigerBroker never retransmits an ambiguous client id', async () => {
  const transport = new FixtureTradingTransport();
  transport.submitMarket = async () => {
    transport.submits++;
    throw new Error('timeout after transmission secret=abc');
  };
  const broker = new TigerBroker({ transport, armed: true });
  const order = {
    symbol: 'MGCZ24',
    side: 'buy' as const,
    qty: 1,
    type: 'market' as const,
    clientId: 'ambiguous',
  };
  await expect(broker.submit(order)).rejects.toMatchObject({
    code: 'timeout',
    submitFailureCertainty: 'possibly-sent',
  });
  await expect(broker.submit(order)).rejects.toMatchObject({
    code: 'timeout',
    submitFailureCertainty: 'possibly-sent',
  });
  expect(transport.submits).toBe(1);
});

test('TigerBroker validates direct order identity', async () => {
  const transport = new FixtureTradingTransport();
  transport.submitMarket = async (_account, request) => ({
    ...request,
    symbol: 'WRONG',
    requestedQty: request.qty,
    filledQty: request.qty,
    price: 100,
    status: 'filled',
  });
  const broker = new TigerBroker({ transport, armed: true });
  await expect(
    broker.submit({ symbol: 'MGCZ24', side: 'buy', qty: 1, type: 'market', clientId: 'mismatch' }),
  ).rejects.toMatchObject({ code: 'precondition' });
});

test('TigerBroker flatten handles partial fills and later same-size exposure episodes', async () => {
  const transport = new FixtureTradingTransport();
  transport.qty = 4;
  transport.submitMarket = async (_account, request) => {
    transport.submits++;
    const filledQty = request.qty > 1 ? request.qty / 2 : request.qty;
    transport.qty += request.side === 'buy' ? filledQty : -filledQty;
    const result: TigerOrderResult = {
      ...request,
      requestedQty: request.qty,
      filledQty,
      price: 100,
      status: filledQty === request.qty ? 'filled' : 'partially-filled-cancelled',
    };
    transport.orders.set(request.clientId, result);
    return result;
  };
  const broker = new TigerBroker({ transport, armed: true });
  await broker.flatten('MGCZ24');
  expect(transport.qty).toBe(0);
  const firstEpisodeSubmits = transport.submits;
  transport.qty = 4;
  await broker.flatten('MGCZ24');
  expect(transport.qty).toBe(0);
  expect(transport.submits).toBeGreaterThan(firstEpisodeSubmits);
});

test('TigerBroker propagates cancellation and does not retain secret-bearing causes', async () => {
  const transport = new FixtureTradingTransport();
  let receivedSignal: AbortSignal | undefined;
  transport.submitMarket = async (_account, _request, signal) => {
    receivedSignal = signal;
    if (signal?.aborted) throw new Error('credential secret=abc timeout');
    return new Promise<TigerOrderResult>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('credential secret=abc timeout')), {
        once: true,
      });
    });
  };
  const broker = new TigerBroker({ transport, armed: true });
  const controller = new AbortController();
  const submitting = broker.submit(
    { symbol: 'MGCZ24', side: 'buy', qty: 1, type: 'market', clientId: 'cancel' },
    controller.signal,
  );
  while (!receivedSignal) await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  const error = await submitting.catch((value) => value as BrokerError);
  expect(receivedSignal).toBe(controller.signal);
  expect(error.message).not.toContain('secret');
  expect(error.cause).toBeUndefined();
});

test('TigerBroker polls a working partial fill to terminal before caching it', async () => {
  const transport = new FixtureTradingTransport();
  let working: TigerOrderResult | undefined;
  transport.submitMarket = async (_account, request) => {
    transport.submits++;
    working = {
      ...request,
      requestedQty: request.qty,
      filledQty: 1,
      price: 100,
      status: 'partially-filled',
    };
    return working;
  };
  transport.findOrderByClientId = async () => {
    if (!working) return undefined;
    working = { ...working, filledQty: 2, status: 'filled' };
    return working;
  };
  const broker = new TigerBroker({
    transport,
    armed: true,
    orderPollIntervalMs: 0,
    sleep: async () => {},
  });
  const order = {
    symbol: 'MGCZ24',
    side: 'buy' as const,
    qty: 2,
    type: 'market' as const,
    clientId: 'partial-then-full',
  };
  const first = await broker.submit(order);
  const cached = await broker.submit(order);
  expect(first).toMatchObject({ status: 'filled', filledQty: 2 });
  expect(cached).toEqual(first);
  expect(transport.submits).toBe(1);
});

test('TigerBroker cancels a stuck order only when explicitly enabled and armed', async () => {
  function stuckTransport() {
    const transport = new FixtureTradingTransport();
    let state: TigerOrderResult | undefined;
    transport.submitMarket = async (_account, request) => {
      transport.submits++;
      state = { ...request, orderId: 'order-1', requestedQty: request.qty, status: 'working' };
      return state;
    };
    transport.findOrderByClientId = async () => state;
    return {
      transport,
      cancelled: [] as string[],
      settle: (next: Partial<TigerOrderResult>) => {
        state = { ...state!, ...next } as TigerOrderResult;
      },
    };
  }
  const order = {
    symbol: 'MGCZ24',
    side: 'buy' as const,
    qty: 1,
    type: 'market' as const,
    clientId: 'stuck',
  };

  // Default: no cancel is attempted and the caller sees a retryable timeout.
  const untouched = stuckTransport();
  untouched.transport.cancelOrder = async () => {
    untouched.cancelled.push('called');
  };
  await expect(
    new TigerBroker({
      transport: untouched.transport,
      armed: true,
      maxOrderPolls: 1,
      sleep: async () => {},
    }).submit(order),
  ).rejects.toMatchObject({ code: 'timeout', retryable: true });
  expect(untouched.cancelled).toEqual([]);

  // Enabled: cancel is requested and the re-read decides the outcome.
  const cancelling = stuckTransport();
  cancelling.transport.cancelOrder = async (_account, orderId) => {
    cancelling.cancelled.push(orderId);
    cancelling.settle({ status: 'cancelled', filledQty: 0 });
  };
  await expect(
    new TigerBroker({
      transport: cancelling.transport,
      armed: true,
      maxOrderPolls: 1,
      cancelStuckOrders: true,
      sleep: async () => {},
    }).submit(order),
  ).rejects.toMatchObject({ code: 'reject', retryable: false });
  expect(cancelling.cancelled).toEqual(['order-1']);
});

test('TigerBroker honours a fill that wins the race against its own cancel', async () => {
  const transport = new FixtureTradingTransport();
  let state: TigerOrderResult | undefined;
  transport.submitMarket = async (_account, request) => {
    transport.submits++;
    state = { ...request, orderId: 'order-1', requestedQty: request.qty, status: 'working' };
    return state;
  };
  transport.findOrderByClientId = async () => state;
  transport.cancelOrder = async () => {
    // The venue filled before the cancel landed, then rejected the cancel.
    state = { ...state!, status: 'filled', filledQty: 1, price: 100, time: 1_700_000_000 };
    throw new Error('order already filled');
  };
  const broker = new TigerBroker({
    transport,
    armed: true,
    maxOrderPolls: 1,
    cancelStuckOrders: true,
    sleep: async () => {},
  });
  const order = {
    symbol: 'MGCZ24',
    side: 'buy' as const,
    qty: 1,
    type: 'market' as const,
    clientId: 'cancel-race',
  };
  const fill = await broker.submit(order);
  expect(fill).toMatchObject({ status: 'filled', filledQty: 1, price: 100 });
  // The winning fill is cached, so a retry never resubmits.
  expect(await broker.submit(order)).toEqual(fill);
  expect(transport.submits).toBe(1);
});

test('TigerBroker refuses to cancel while unarmed', async () => {
  const transport = new FixtureTradingTransport();
  let attempted = false;
  transport.submitMarket = async (_account, request) => ({
    ...request,
    orderId: 'order-1',
    requestedQty: request.qty,
    status: 'working',
  });
  transport.findOrderByClientId = async () => undefined;
  transport.cancelOrder = async () => {
    attempted = true;
  };
  const broker = new TigerBroker({
    transport,
    armed: false,
    maxOrderPolls: 1,
    cancelStuckOrders: true,
    sleep: async () => {},
  });
  await expect(
    broker.submit({
      symbol: 'MGCZ24',
      side: 'buy',
      qty: 1,
      type: 'market',
      clientId: 'unarmed-cancel',
    }),
  ).rejects.toMatchObject({ code: 'precondition' });
  expect(attempted).toBe(false);
});

test('TigerBroker exposes protocol cancel only when the transport supports it', async () => {
  const withoutCancel = new FixtureTradingTransport();
  const plain = new TigerBroker({ transport: withoutCancel, armed: true });
  expect(plain.capabilities().supportsCancel).toBe(false);
  expect(plain.cancel).toBeUndefined();

  const transport = new FixtureTradingTransport();
  let state: TigerOrderResult | undefined;
  const cancelled: string[] = [];
  transport.findOrderByClientId = async () => state;
  transport.cancelOrder = async (_account, orderId) => {
    cancelled.push(orderId);
    state = { ...state!, status: 'cancelled', filledQty: 0 };
  };
  const broker = new TigerBroker({ transport, armed: true, accountId: 'demo' });
  expect(broker.capabilities().supportsCancel).toBe(true);

  // Unknown client id is reported, not invented.
  await expect(broker.cancel!('never-sent')).resolves.toEqual({
    clientId: 'never-sent',
    status: 'not-found',
    filledQty: 0,
  });

  state = {
    clientId: 'resting',
    orderId: 'order-9',
    symbol: 'MGCZ24',
    side: 'buy',
    requestedQty: 1,
    status: 'working',
  };
  await expect(broker.cancel!('resting')).resolves.toEqual({
    clientId: 'resting',
    status: 'cancelled',
    filledQty: 0,
  });
  expect(cancelled).toEqual(['order-9']);

  // A fill that beat the cancel is reported as filled, not raised as an error.
  state = { ...state, status: 'working' };
  transport.cancelOrder = async () => {
    state = { ...state!, status: 'filled', filledQty: 1 };
    throw new Error('order already filled');
  };
  await expect(broker.cancel!('resting')).resolves.toEqual({
    clientId: 'resting',
    status: 'filled',
    filledQty: 1,
  });

  // Cancel is armed-gated exactly like submit and flatten.
  const unarmed = new TigerBroker({ transport, armed: false });
  await expect(unarmed.cancel!('resting')).rejects.toMatchObject({ code: 'precondition' });
});

test('TigerBroker flatten operation ids do not collide across broker instances', async () => {
  const firstTransport = new FixtureTradingTransport();
  const secondTransport = new FixtureTradingTransport();
  firstTransport.qty = 1;
  secondTransport.qty = 1;
  await new TigerBroker({ transport: firstTransport, armed: true }).flatten('MGCZ24');
  await new TigerBroker({ transport: secondTransport, armed: true }).flatten('MGCZ24');
  const [firstId] = firstTransport.orders.keys();
  const [secondId] = secondTransport.orders.keys();
  expect(firstId).toStartWith('flatten:MGCZ24:');
  expect(secondId).toStartWith('flatten:MGCZ24:');
  expect(firstId).not.toBe(secondId);
});

test('TigerBroker does not transmit after cancellation during client-id lookup', async () => {
  const transport = new FixtureTradingTransport();
  let releaseLookup!: () => void;
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  transport.findOrderByClientId = async () => {
    lookupStarted();
    await blocked;
    return undefined;
  };
  const broker = new TigerBroker({ transport, armed: true });
  const controller = new AbortController();
  const submitting = broker.submit(
    { symbol: 'MGCZ24', side: 'buy', qty: 1, type: 'market', clientId: 'cancel-lookup' },
    controller.signal,
  );
  await started;
  controller.abort();
  releaseLookup();
  await expect(submitting).rejects.toMatchObject({
    code: 'precondition',
    submitFailureCertainty: 'definitely-not-sent',
  });
  expect(transport.submits).toBe(0);
});

test('TigerBroker rejects and does not cache an unknown runtime order status', async () => {
  const transport = new FixtureTradingTransport();
  transport.submitMarket = async (_account, request) => {
    transport.submits++;
    return {
      ...request,
      requestedQty: request.qty,
      filledQty: request.qty,
      price: 100,
      status: 'not-a-tiger-status',
    } as unknown as TigerOrderResult;
  };
  const broker = new TigerBroker({ transport, armed: true });
  const order = {
    symbol: 'MGCZ24',
    side: 'buy' as const,
    qty: 1,
    type: 'market' as const,
    clientId: 'unknown-runtime-status',
  };
  await expect(broker.submit(order)).rejects.toMatchObject({ code: 'precondition' });
  await expect(broker.submit(order)).rejects.toMatchObject({ code: 'timeout' });
  expect(transport.submits).toBe(1);
});
