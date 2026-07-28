import { expect, test } from 'bun:test';
import { parseRunConfig } from '../src/cli.js';
import { createNodeTigerBroker, registerTigerTradingTransport } from '../src/node.js';

const baseConfig = {
  strategy: 'strategy.pine',
  symbol: 'X',
  timeframe: '1m',
  data: { provider: 'csv', dataDir: 'data', cutoverTime: 1 },
  broker: { id: 'paper' },
};

test('run config requires boolean reconcileOnStart and exact broker fields', () => {
  expect(() => parseRunConfig({ ...baseConfig, reconcileOnStart: 'false' })).toThrow(
    'reconcileOnStart must be boolean',
  );
  expect(() => parseRunConfig({ ...baseConfig, broker: { id: 'paper', profile: 'demo' } })).toThrow(
    'config.broker.profile is not allowed',
  );
  expect(() => parseRunConfig({ ...baseConfig, unexpected: true })).toThrow(
    'config.unexpected is not allowed',
  );
  expect(parseRunConfig({ ...baseConfig, reconcileOnStart: false }).reconcileOnStart).toBe(false);
});

test('Tiger trading registry validates config and receives only credential fields', () => {
  expect(() =>
    createNodeTigerBroker({ id: 'tiger', unrelatedSecret: 'nope' } as never, true, {}),
  ).toThrow('does not allow');

  let receivedConfig: unknown;
  let receivedCredentials: unknown;
  registerTigerTradingTransport((config, credentials) => {
    receivedConfig = config;
    receivedCredentials = credentials;
    return {
      async account() {
        return { id: 'demo', currency: 'USD', balance: 1, equity: 1 };
      },
      async instrument(symbol) {
        return { symbol, mintick: 0.1, qtyStep: 1, minOrderQty: 1 };
      },
      async position(_accountId, symbol) {
        return { symbol, qty: 0 };
      },
      async findOrderByClientId() {
        return undefined;
      },
      async submitMarket(_accountId, request) {
        return {
          ...request,
          requestedQty: request.qty,
          filledQty: request.qty,
          price: 1,
          status: 'filled',
        };
      },
    };
  });
  createNodeTigerBroker({ id: 'tiger', profile: 'demo', account: 'paper' }, true, {
    tigerId: 'id',
    privateKey: 'key',
    account: 'paper',
    PATH: 'secret',
  } as never);
  expect(receivedConfig).toEqual({ id: 'tiger', profile: 'demo', account: 'paper' });
  expect(receivedCredentials).toEqual({
    tigerId: 'id',
    privateKey: 'key',
    account: 'paper',
  });
});
