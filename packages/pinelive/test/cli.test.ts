import { expect, test } from 'bun:test';
import { parseRunConfig } from '../src/cli.js';
import {
  createNodeTigerBroker,
  createOfficialTigerTradingTransport,
  registerTigerTradingTransport,
} from '../src/node.js';

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

test('run config validates request.security safety controls', () => {
  for (const field of [
    'securityWarmupBars',
    'maxSecurityBars',
    'maxSecurityFeeds',
    'securityConcurrency',
    'securityRequestTimeoutMs',
  ] as const) {
    expect(() => parseRunConfig({ ...baseConfig, [field]: 0 })).toThrow(
      `config.${field} must be a positive integer`,
    );
  }
  expect(() => parseRunConfig({ ...baseConfig, maxSecurityStaleRefreshes: -1 })).toThrow(
    'config.maxSecurityStaleRefreshes must be a non-negative integer',
  );
  expect(() =>
    parseRunConfig({ ...baseConfig, securityWarmupBars: 10, maxSecurityBars: 5 }),
  ).toThrow('securityWarmupBars must not exceed config.maxSecurityBars');
  expect(
    parseRunConfig({
      ...baseConfig,
      maxSecurityFeeds: 8,
      securityConcurrency: 2,
      securityRequestTimeoutMs: 1000,
      maxSecurityStaleRefreshes: 1,
    }),
  ).toMatchObject({
    maxSecurityFeeds: 8,
    securityConcurrency: 2,
    securityRequestTimeoutMs: 1000,
    maxSecurityStaleRefreshes: 1,
  });
});

test('one tigerProfile applies to both Tiger data and broker sections', () => {
  const tigerData = { provider: 'tiger', assetClass: 'futures' } as const;
  const applied = parseRunConfig({
    ...baseConfig,
    symbol: 'TG:FU:MGC',
    data: tigerData,
    broker: { id: 'tiger' },
    tigerProfile: '/tmp/tiger_openapi_config.properties',
  });
  expect(applied.data).toMatchObject({ profile: '/tmp/tiger_openapi_config.properties' });
  expect(applied.broker).toMatchObject({ profile: '/tmp/tiger_openapi_config.properties' });

  // An explicit section value still wins over the shared default.
  const explicit = parseRunConfig({
    ...baseConfig,
    symbol: 'TG:FU:MGC',
    data: { ...tigerData, profile: '/data.properties' },
    broker: { id: 'tiger', profile: '/broker.properties' },
    tigerProfile: '/shared.properties',
  });
  expect(explicit.data).toMatchObject({ profile: '/data.properties' });
  expect(explicit.broker).toMatchObject({ profile: '/broker.properties' });

  expect(() => parseRunConfig({ ...baseConfig, tigerProfile: 7 })).toThrow(
    'config.tigerProfile must be a string',
  );
});

test('official Tiger trading transport rejects a missing credential profile path', () => {
  expect(() =>
    createOfficialTigerTradingTransport({ propertiesFilePath: '/nonexistent/tiger.properties' }),
  ).toThrow('credential profile not found');
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
    secretKey: 'secret-key',
    license: 'license',
    token: 'token',
    PATH: 'secret',
  } as never);
  expect(receivedConfig).toEqual({ id: 'tiger', profile: 'demo', account: 'paper' });
  expect(receivedCredentials).toEqual({
    tigerId: 'id',
    privateKey: 'key',
    account: 'paper',
    secretKey: 'secret-key',
    license: 'license',
    token: 'token',
  });
});
