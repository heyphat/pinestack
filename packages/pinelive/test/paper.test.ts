import { expect, test } from 'bun:test';
import { BrokerError, PaperBroker } from '../src/index.js';

const instrument = { symbol: 'X', minQty: 1, mintick: 0.01, pointValue: 10 };

test('PaperBroker requires a mark, deduplicates, and accounts realized PnL', async () => {
  const broker = new PaperBroker({
    instruments: { X: instrument },
    initialBalance: 1_000,
    commissionPerUnit: 1,
  });
  const order = {
    symbol: 'X',
    side: 'buy' as const,
    qty: 2,
    type: 'market' as const,
    clientId: 'a',
  };
  await expect(broker.submit(order)).rejects.toBeInstanceOf(BrokerError);
  broker.mark('X', 100, 1);
  const first = await broker.submit(order);
  const duplicate = await broker.submit(order);
  expect(duplicate.brokerOrderId).toBe(first.brokerOrderId);
  expect((await broker.getPosition('X')).qty).toBe(2);
  broker.mark('X', 105, 2);
  await broker.submit({ symbol: 'X', side: 'sell', qty: 2, type: 'market', clientId: 'b' });
  expect((await broker.getPosition('X')).qty).toBe(0);
  const account = await broker.getAccount();
  expect(account.realizedPnl).toBe(100);
  expect(account.balance).toBe(1_096); // 100 pnl - 4 commissions
});

test('PaperBroker computes weighted price and flip basis', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.mark('X', 100, 1);
  await broker.submit({ symbol: 'X', side: 'buy', qty: 1, type: 'market', clientId: '1' });
  broker.mark('X', 110, 2);
  await broker.submit({ symbol: 'X', side: 'buy', qty: 1, type: 'market', clientId: '2' });
  expect((await broker.getPosition('X')).avgPrice).toBe(105);
  broker.mark('X', 120, 3);
  await broker.submit({ symbol: 'X', side: 'sell', qty: 3, type: 'market', clientId: '3' });
  const position = await broker.getPosition('X');
  expect(position.qty).toBe(-1);
  expect(position.avgPrice).toBe(120);
  expect(position.realizedPnl).toBe(300);
});

test('PaperBroker treats repeated flatten calls at one mark as distinct logical attempts', async () => {
  const broker = new PaperBroker({ instruments: { X: instrument } });
  broker.mark('X', 100, 1);
  broker.setPosition('X', 1, 100);
  await broker.flatten('X');
  broker.setPosition('X', 1, 100);
  await broker.flatten('X');
  expect((await broker.getPosition('X')).qty).toBe(0);
});

test('PaperBroker rejects unsafe economic configuration', () => {
  expect(() => new PaperBroker({ instruments: { X: instrument }, commissionPerUnit: -1 })).toThrow(
    'commissionPerUnit',
  );
  expect(() => new PaperBroker({ instruments: { X: instrument }, slippageBps: 10_000 })).toThrow(
    'slippageBps',
  );
  expect(
    () =>
      new PaperBroker({
        instruments: { X: { ...instrument, pointValue: -1 } },
      }),
  ).toThrow('pointValue');
});
