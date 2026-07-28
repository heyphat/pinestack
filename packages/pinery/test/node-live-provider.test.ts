import { expect, test } from 'bun:test';
import { createNodeMarketDataProvider, registerTigerMarketDataTransport } from '../src/node.js';

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
        PATH: 'secret',
      } as never,
    },
  );
  expect(receivedCredentials).toEqual({
    tigerId: 'id',
    privateKey: 'key',
    account: 'paper',
  });
});
