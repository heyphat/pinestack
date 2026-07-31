import { expect, test } from 'bun:test';
import { TigerBroker, type TigerOrderResult, type TigerTradingTransport } from '../src/index.js';

class ReplaySafetyTransport implements TigerTradingTransport {
  submits = 0;
  forgetOrders = false;
  terminal: TigerOrderResult | undefined;
  response: 'rejected' | 'malformed-fill' = 'rejected';

  async account() {
    return { id: 'demo', currency: 'USD', balance: 100_000, equity: 100_000 };
  }

  async instrument(symbol: string) {
    return { symbol, mintick: 0.1, qtyStep: 1, minOrderQty: 1 };
  }

  async position(_accountId: string, symbol: string) {
    return { symbol, qty: 0 };
  }

  async findOrderByClientId() {
    return this.forgetOrders ? undefined : this.terminal;
  }

  async submitMarket(
    _accountId: string,
    request: { symbol: string; side: 'buy' | 'sell'; qty: number; clientId: string },
  ) {
    this.submits++;
    this.terminal =
      this.response === 'rejected'
        ? {
            ...request,
            orderId: `order-${this.submits}`,
            requestedQty: request.qty,
            status: 'rejected',
            message: 'venue rejected',
          }
        : {
            ...request,
            orderId: `order-${this.submits}`,
            requestedQty: request.qty,
            status: 'filled',
            // A terminal label without fill economics is not authoritative enough to retire
            // the unresolved transmission guard.
          };
    return this.terminal;
  }
}

const order = {
  symbol: 'MGCZ24',
  side: 'buy' as const,
  qty: 1,
  type: 'market' as const,
  clientId: 'stable-client-id',
};

test('TigerBroker retires a rejected client id after bounded venue history forgets it', async () => {
  const transport = new ReplaySafetyTransport();
  const broker = new TigerBroker({ transport, armed: true, accountId: 'demo' });

  await expect(broker.submit(order)).rejects.toMatchObject({ code: 'reject', retryable: false });
  transport.forgetOrders = true;
  await expect(broker.submit(order)).rejects.toMatchObject({
    code: 'reject',
    retryable: false,
    submitFailureCertainty: 'definitely-not-sent',
  });
  await expect(broker.submit({ ...order, side: 'sell' })).rejects.toMatchObject({
    code: 'precondition',
  });
  expect(transport.submits).toBe(1);
});

test('TigerBroker retains ambiguity when a terminal fill response is malformed', async () => {
  const transport = new ReplaySafetyTransport();
  transport.response = 'malformed-fill';
  const broker = new TigerBroker({ transport, armed: true, accountId: 'demo' });

  await expect(broker.submit(order)).rejects.toMatchObject({
    code: 'precondition',
    submitFailureCertainty: 'possibly-sent',
  });
  transport.forgetOrders = true;
  await expect(broker.submit(order)).rejects.toMatchObject({
    code: 'timeout',
    submitFailureCertainty: 'possibly-sent',
  });
  expect(transport.submits).toBe(1);
});
