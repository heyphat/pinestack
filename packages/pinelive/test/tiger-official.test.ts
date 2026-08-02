import { expect, test } from 'bun:test';
import {
  TigerError,
  type Asset,
  type Contract,
  type Order,
  type OrderRequest as SdkOrderRequest,
  type PlaceOrderResult,
  type Position as SdkPosition,
} from '@tigeropenapi/tigeropen';
import { BrokerError, TigerBroker } from '../src/index.js';
import {
  OfficialTigerTradingTransport,
  tigerUserMark,
  type OfficialTigerTradeClient,
} from '../src/node.js';

class TradeFacade implements OfficialTigerTradeClient {
  assets: Asset[] = [
    {
      account: 'demo',
      currency: 'USD',
      cashValue: 90_000,
      netLiquidation: 100_000,
      buyingPower: 80_000,
    },
  ];
  contracts: Contract[] = [
    {
      symbol: 'MGCZ26',
      secType: 'FUT',
      tradeable: true,
      exchange: 'COMEX',
      expiry: '20261228',
      multiplier: 10,
      tickSizes: [{ tickSize: 0.1 }],
    },
  ];
  positions: SdkPosition[] = [];
  orders: Order[] = [];
  placement: PlaceOrderResult | undefined = { id: '9223372036854775807' };
  placed: SdkOrderRequest[] = [];
  placeError?: Error;

  async cancelOrder(id: number | string) {
    return { id };
  }

  async getAssets() {
    return this.assets;
  }
  async getContract() {
    return this.contracts;
  }
  async getPositions() {
    return this.positions;
  }
  async getOrders() {
    return this.orders;
  }
  async placeOrder(request: SdkOrderRequest) {
    this.placed.push(request);
    if (this.placeError) throw this.placeError;
    return this.placement;
  }
}

function sdkOrder(clientId: string, status: string, filledQuantity: number): Order {
  return {
    id: '9223372036854775807',
    symbol: 'MGCZ26',
    secType: 'FUT',
    action: 'BUY',
    totalQuantity: 2,
    filledQuantity,
    avgFillPrice: filledQuantity > 0 ? 123.4 : undefined,
    status,
    commission: filledQuantity > 0 ? 1.25 : undefined,
    currency: 'USD',
    updateTime: 1_700_000_000_000,
    userMark: tigerUserMark(clientId),
  };
}

test('official Tiger trade adapter maps account, exact contract, and scaled net position', async () => {
  const client = new TradeFacade();
  client.positions = [
    {
      symbol: 'MGCZ26',
      secType: 'FUT',
      position: -20,
      positionScale: 1,
      averageCost: 123,
      unrealizedPnl: 5,
      realizedPnl: 2,
      updateTimestamp: 1_700_000_000_000,
    },
  ];
  const transport = new OfficialTigerTradingTransport(client, 'demo');
  await expect(transport.account()).resolves.toEqual({
    id: 'demo',
    currency: 'USD',
    balance: 90_000,
    equity: 100_000,
    available: 80_000,
  });
  await expect(transport.instrument('MGCZ26')).resolves.toEqual({
    symbol: 'MGCZ26',
    mintick: 0.1,
    qtyStep: 1,
    minOrderQty: 1,
    pointValue: 10,
    exchange: 'COMEX',
    expiry: '2026-12-28',
  });
  await expect(transport.position('demo', 'MGCZ26')).resolves.toEqual({
    symbol: 'MGCZ26',
    qty: -2,
    avgPrice: 123,
    unrealizedPnl: 5,
    realizedPnl: 2,
    updatedAt: 1_700_000_000,
  });
});

test('official Tiger trade adapter hashes userMark and maps every official order state', async () => {
  const client = new TradeFacade();
  const transport = new OfficialTigerTradingTransport(client, 'demo');
  const cases: Array<[string, number, string]> = [
    ['Filled', 2, 'filled'],
    ['Cancelled', 0, 'cancelled'],
    ['Cancelled', 1, 'partially-filled-cancelled'],
    ['Inactive', 0, 'rejected'],
    ['Inactive', 1, 'partially-filled-cancelled'],
    ['Invalid', 0, 'rejected'],
    ['Submitted', 0, 'working'],
    ['Submitted', 1, 'partially-filled'],
    ['PendingSubmit', 0, 'working'],
    ['Initial', 0, 'working'],
    ['PendingCancel', 1, 'partially-filled'],
  ];
  for (const [status, filled, expected] of cases) {
    const clientId = `${status}:${filled}`;
    client.orders = [sdkOrder(clientId, status, filled)];
    await expect(transport.findOrderByClientId('demo', clientId)).resolves.toMatchObject({
      clientId,
      orderId: '9223372036854775807',
      status: expected,
      filledQty: filled,
      time: 1_700_000_000,
    });
  }
  client.orders = [
    {
      ...sdkOrder('scaled', 'Filled', 20),
      totalQuantity: 20,
      totalQuantityScale: 1,
      filledQuantity: 200,
      filledQuantityScale: 2,
      userMark: tigerUserMark('scaled'),
    },
  ];
  await expect(transport.findOrderByClientId('demo', 'scaled')).resolves.toMatchObject({
    requestedQty: 2,
    filledQty: 2,
    status: 'filled',
  });

  client.orders = [sdkOrder('short-filled', 'Filled', 1)];
  await expect(transport.findOrderByClientId('demo', 'short-filled')).rejects.toMatchObject({
    code: 'precondition',
    retryable: false,
  });

  expect(tigerUserMark('stable')).toBe(tigerUserMark('stable'));
  expect(tigerUserMark('stable')).not.toContain('stable');
});

test('official Tiger trade adapter constructs marked market orders and preserves int64 placement ids', async () => {
  const client = new TradeFacade();
  const transport = new OfficialTigerTradingTransport(client, 'demo');
  const result = await transport.submitMarket('demo', {
    symbol: 'MGCZ26',
    side: 'sell',
    qty: 3,
    clientId: 'stable-client-id',
  });
  expect(client.placed[0]).toMatchObject({
    account: 'demo',
    symbol: 'MGCZ26',
    secType: 'FUT',
    action: 'SELL',
    orderType: 'MKT',
    totalQuantity: 3,
    outsideRth: false,
    userMark: tigerUserMark('stable-client-id'),
  });
  expect(result).toMatchObject({
    clientId: 'stable-client-id',
    orderId: '9223372036854775807',
    status: 'working',
  });
});

test('official adapter plus TigerBroker polls placement and never retransmits ambiguity', async () => {
  const client = new TradeFacade();
  const transport = new OfficialTigerTradingTransport(client, 'demo');
  const broker = new TigerBroker({
    transport,
    armed: true,
    accountId: 'demo',
    orderPollIntervalMs: 0,
    sleep: async () => {},
  });
  const order = {
    symbol: 'MGCZ26',
    side: 'buy' as const,
    qty: 2,
    type: 'market' as const,
    clientId: 'eventual',
  };
  let lookups = 0;
  client.getOrders = async () => {
    lookups++;
    return lookups > 1 ? [sdkOrder(order.clientId, 'Filled', 2)] : [];
  };
  await expect(broker.submit(order)).resolves.toMatchObject({ status: 'filled', filledQty: 2 });
  expect(client.placed).toHaveLength(1);

  const ambiguousClient = new TradeFacade();
  ambiguousClient.placeError = new Error('timeout privateKey=secret');
  const ambiguousBroker = new TigerBroker({
    transport: new OfficialTigerTradingTransport(ambiguousClient, 'demo'),
    armed: true,
  });
  const ambiguousOrder = { ...order, clientId: 'ambiguous' };
  await expect(ambiguousBroker.submit(ambiguousOrder)).rejects.toMatchObject({
    code: 'connectivity',
  });
  await expect(ambiguousBroker.submit(ambiguousOrder)).rejects.toMatchObject({ code: 'timeout' });
  expect(ambiguousClient.placed).toHaveLength(1);
});

test('official Tiger trade adapter binds to the exact contract despite root-keyed responses', async () => {
  const client = new TradeFacade();
  // Tiger returns nothing for the exact code and answers only to the product root.
  const rootOnly: Contract[] = [
    {
      symbol: 'MGC',
      identifier: 'MGC2612',
      secType: 'FUT',
      tradeable: true,
      exchange: 'NYMEX',
      expiry: '20261229',
      multiplier: 10,
      tickSizes: [{ tickSize: 0.1 }],
    },
  ];
  const requested: string[] = [];
  client.getContract = async (symbol) => {
    requested.push(symbol);
    return symbol === 'MGC' ? rootOnly : [];
  };
  const transport = new OfficialTigerTradingTransport(client, 'demo');
  await expect(transport.instrument('MGC2612')).resolves.toMatchObject({
    symbol: 'MGC2612',
    mintick: 0.1,
    pointValue: 10,
    exchange: 'NYMEX',
  });
  expect(requested).toEqual(['MGC2612', 'MGC']);

  // Real futures contracts carry a single minTick and no tickSizes ladder.
  client.getContract = async () => [
    { ...rootOnly[0]!, tickSizes: undefined, minTick: 0.25 } as Contract,
  ];
  await expect(transport.instrument('MGC2612')).resolves.toMatchObject({ mintick: 0.25 });

  client.getContract = async () => [
    { ...rootOnly[0]!, tickSizes: undefined, minTick: 0 } as Contract,
  ];
  await expect(transport.instrument('MGC2612')).rejects.toMatchObject({
    code: 'precondition',
    retryable: false,
  });

  // A root response for a different contract must not be accepted.
  client.getContract = async () => [{ ...rootOnly[0]!, identifier: 'MGC2703' }];
  await expect(transport.instrument('MGC2612')).rejects.toMatchObject({
    code: 'unknown-symbol',
    retryable: false,
  });

  // Orders and positions carry the exact contract in identifier, not symbol.
  client.orders = [{ ...sdkOrder('exact', 'Filled', 2), symbol: 'MGC', identifier: 'MGC2612' }];
  await expect(transport.findOrderByClientId('demo', 'exact')).resolves.toMatchObject({
    symbol: 'MGC2612',
  });
  client.positions = [
    { symbol: 'MGC', identifier: 'MGC2612', secType: 'FUT', positionQty: -2, averageCost: 4000 },
  ];
  await expect(transport.position('demo', 'MGC2612')).resolves.toMatchObject({
    symbol: 'MGC2612',
    qty: -2,
  });
});

test('official Tiger trade adapter cancels by int64 order id and reports unknown outcomes', async () => {
  const client = new TradeFacade();
  const cancelled: Array<number | string> = [];
  client.cancelOrder = async (id) => {
    cancelled.push(id);
    return { id };
  };
  const transport = new OfficialTigerTradingTransport(client, 'demo');
  await transport.cancelOrder('demo', '9223372036854775807');
  // The id must survive as a string; Number would round it.
  expect(cancelled).toEqual(['9223372036854775807']);

  client.cancelOrder = async () => undefined;
  await expect(transport.cancelOrder('demo', '1')).rejects.toMatchObject({
    code: 'timeout',
    retryable: true,
  });

  const controller = new AbortController();
  controller.abort();
  await expect(transport.cancelOrder('demo', '1', controller.signal)).rejects.toMatchObject({
    code: 'precondition',
    retryable: false,
  });
});

test('official Tiger trade adapter fails closed on gateway access rejections', async () => {
  const client = new TradeFacade();
  const transport = new OfficialTigerTradingTransport(client, 'demo');
  client.getAssets = async () => {
    throw new TigerError(4, 'access forbidden: request ip 1.2.3.4 is not in ip whitelist');
  };
  const error = await transport.account('demo').catch((value) => value as BrokerError);
  expect({ code: error.code, retryable: error.retryable }).toEqual({
    code: 'auth',
    retryable: false,
  });
  expect(error.message).not.toContain('whitelist');
});

test('official Tiger trade adapter checks cancellation and redacts SDK failures', async () => {
  const client = new TradeFacade();
  const transport = new OfficialTigerTradingTransport(client, 'demo');
  const controller = new AbortController();
  controller.abort();
  await expect(transport.account('demo', controller.signal)).rejects.toMatchObject({
    code: 'precondition',
    retryable: false,
  });

  client.getAssets = async () => {
    throw new Error('credential secret=abc');
  };
  const error = await transport.account('demo').catch((value) => value as BrokerError);
  expect(error.code).toBe('connectivity');
  expect(error.message).not.toContain('secret');
  expect(error.cause).toBeUndefined();
});

test('official Tiger adapter remains production-ineligible without complete synchronization or exact lookup', async () => {
  const broker = new TigerBroker({
    transport: new OfficialTigerTradingTransport(new TradeFacade(), 'demo'),
    armed: true,
    requireExecutionSafety: true,
  });

  const synchronization = await broker.synchronizeAccount('MGCZ26');
  expect(synchronization).toMatchObject({ status: 'blocked' });
  if (synchronization.status !== 'blocked')
    throw new Error('official adapter unexpectedly synchronized');
  expect(synchronization.reasons.join(' ')).toContain('complete open-order inventory');
  await expect(
    broker.lookupOrder({
      symbol: 'MGCZ26',
      side: 'buy',
      qty: 1,
      type: 'market',
      clientId: 'official-read-only-probe',
    }),
  ).resolves.toMatchObject({ status: 'unsupported' });
});
