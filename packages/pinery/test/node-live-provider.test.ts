import { expect, test } from 'bun:test';
import {
  createNodeMarketDataProvider,
  registerTigerMarketDataTransport,
  supportsLiveBars,
} from '../src/node.js';

test('Tiger market-data registry receives only provider credential fields', () => {
  let receivedCredentials: unknown;
  registerTigerMarketDataTransport((_config, credentials) => {
    receivedCredentials = credentials;
    return {
      async resolveFuture(root) {
        return {
          root,
          contract: 'MGCZ24',
          mintick: 0.1,
          qtyStep: 1,
          minOrderQty: 1,
        };
      },
      async bars() {
        return { bars: [], serverTime: 1 };
      },
    };
  });
  createNodeMarketDataProvider(
    { provider: 'tiger', assetClass: 'futures' },
    {
      tigerCredentials: {
        tigerId: 'id',
        privateKey: 'key',
        account: 'paper',
        license: 'license',
        token: 'token',
        PATH: 'secret',
      } as never,
    },
  );
  expect(receivedCredentials).toEqual({
    tigerId: 'id',
    privateKey: 'key',
    account: 'paper',
    license: 'license',
    token: 'token',
  });
});

test('Node Tiger factory preserves an injected push capability', () => {
  registerTigerMarketDataTransport(() => ({
    async resolveFuture(root) {
      return {
        root,
        contract: 'MGCZ24',
        mintick: 0.1,
        qtyStep: 1,
        minOrderQty: 1,
      };
    },
    async bars() {
      return { bars: [], finality: [] };
    },
    openKlineStream() {
      return {
        async *[Symbol.asyncIterator]() {},
      };
    },
  }));
  const provider = createNodeMarketDataProvider(
    { provider: 'tiger', assetClass: 'futures' },
    { tigerCredentials: {} },
  );
  expect(supportsLiveBars(provider)).toBe(true);
});
