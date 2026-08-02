import { expect, test } from 'bun:test';
import { ReplayProvider, StaticProvider, type Bar, type MarketDataProvider } from '@heyphat/pinery';
import {
  TigerBroker,
  type TigerTradingInstrument,
  type TigerTradingTransport,
} from '../src/brokers/tiger.js';
import type { AccountSynchronizationSession } from '../src/core/broker.js';
import { InMemoryExecutionLease } from '../src/core/lease.js';
import { MemoryLedger } from '../src/core/ledger.js';
import { recoverLedger } from '../src/core/recovery.js';
import { prepareIntrabarRun, runIntrabarServer } from '../src/core/intrabar-server.js';
import type { Account, Instrument } from '../src/core/types.js';
import { createOfficialTigerTradingTransport } from '../src/node.js';

const credentialed = process.env.PINELIVE_TIGER_CREDENTIAL_TESTS === '1' ? test : test.skip;
const native = Object.freeze({ kind: 'native' as const });
const strategy = `//@version=6
strategy("credentialed-restart", process_orders_on_close=true, default_qty_type=strategy.fixed, default_qty_value=1)
if close > open
    strategy.entry("L", strategy.long)
plot(strategy.position_size)`;

function bar(time: number, close = 9, open = 10): Bar {
  return {
    time,
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 1,
  };
}

function config(symbol: string) {
  return {
    configVersion: 3,
    strategy: 'credentialed-restart.pine',
    symbol,
    timeframe: '1m',
    warmupBars: 2,
    data: {
      provider: 'csv',
      dataDir: '/credentialed-test-must-not-read',
      cutoverTime: 120,
    },
    execution: {
      kind: 'mirrored',
      mirrorOn: 'bar-close',
      broker: { id: 'tiger' },
      armed: true,
      order: { type: 'market' },
      reconcileOnStart: false,
      ledger: { path: '/unused/credentialed-ledger.jsonl', durability: 'sync' },
      lease: { path: '/unused/credentialed-ledger.lock' },
    },
  } as const;
}

function provider(
  symbol: string,
  instrument: Instrument,
  liveBars: readonly Bar[],
): MarketDataProvider {
  const qtyStep = instrument.qtyStep ?? instrument.minQty;
  const minOrderQty = instrument.minOrderQty ?? qtyStep;
  const source = new StaticProvider(
    { [`${symbol}|1m`]: [bar(0), bar(60)] },
    {
      alignment: 'utc-24x7',
      timeframes: ['1m'],
      cacheIdentity: 'credentialed-ambiguity-restart',
    },
  ).setInstrument(symbol, { minQty: qtyStep, mintick: instrument.mintick });
  const replay = new ReplayProvider(source, {
    cutoverTime: 120,
    instrument: { minOrderQty },
  });
  return {
    id: replay.id,
    assetClass: replay.assetClass,
    resolve: replay.resolve.bind(replay),
    history: replay.history.bind(replay),
    historyResolved: replay.historyResolved.bind(replay),
    async *closedBars() {
      for (const value of liveBars) yield structuredClone(value);
    },
    liveBars: replay.liveBars.bind(replay),
    disconnect: replay.disconnect.bind(replay),
  };
}

function transportInstrument(instrument: Instrument): TigerTradingInstrument {
  const qtyStep = instrument.qtyStep ?? instrument.minQty;
  return {
    symbol: instrument.brokerSymbol ?? instrument.symbol,
    mintick: instrument.mintick,
    qtyStep,
    minOrderQty: instrument.minOrderQty ?? qtyStep,
    ...(instrument.pointValue == null ? {} : { pointValue: instrument.pointValue }),
    ...(instrument.exchange == null ? {} : { exchange: instrument.exchange }),
    ...(instrument.expiry == null ? {} : { expiry: instrument.expiry }),
  };
}

function ambiguitySeedTransport(
  account: Account,
  instrument: Instrument,
  onSubmit: () => void,
): TigerTradingTransport {
  const exactInstrument = transportInstrument(instrument);
  const environment = 'credentialed-offline-seed';
  return {
    accountId: account.id,
    accountEnvironment: environment,
    async account() {
      return structuredClone(account);
    },
    async instrument(symbol) {
      if (symbol !== exactInstrument.symbol) throw new Error('seed transport symbol mismatch');
      return structuredClone(exactInstrument);
    },
    async position(_accountId, symbol) {
      return { symbol, qty: 0 };
    },
    async findOrderByClientId() {
      return undefined;
    },
    async lookupOrderExact() {
      return { status: 'not-found' };
    },
    async synchronizeAccount(_accountId, symbol) {
      const session: AccountSynchronizationSession = {
        snapshot: {
          synchronizationVersion: 1,
          accountIdentity: {
            identityVersion: 1,
            brokerId: 'tiger',
            opaqueAccountId: account.id,
            environment,
          },
          account: structuredClone(account),
          position: { symbol, qty: 0 },
          openOrders: [],
          inventoryComplete: true,
          exactOrderLookup: 'authoritative',
          snapshotToken: 'credentialed-offline-snapshot',
          resumeFrom: 'credentialed-offline-sequence',
          observedAt: new Date(0).toISOString(),
        },
        assertSynchronized() {},
        assertSafeToExecute() {},
        close() {},
      };
      return session;
    },
    async submitMarket() {
      onSubmit();
      throw new Error('offline seed timed out after transmission may have started');
    },
  };
}

function credentials() {
  return {
    tigerId: process.env.TIGEROPEN_TIGER_ID ?? process.env.TIGER_ID,
    privateKey: process.env.TIGEROPEN_PRIVATE_KEY ?? process.env.TIGER_PRIVATE_KEY,
    account: process.env.TIGEROPEN_ACCOUNT ?? process.env.TIGER_ACCOUNT,
    secretKey: process.env.TIGEROPEN_SECRET_KEY,
    license: process.env.TIGEROPEN_LICENSE,
    token: process.env.TIGEROPEN_TOKEN,
    propertiesFilePath: process.env.TIGEROPEN_CONFIG_PATH,
  };
}

/**
 * Opt-in only: normal CI never needs Tiger secrets. The unresolved prefix is created entirely
 * against an injected offline transport. The credentialed phase is read-only and wraps every
 * broker and transport mutation method with a test failure.
 */
credentialed(
  'credentialed official Tiger restart keeps ambiguity unresolved without mutation',
  async () => {
    const symbol = process.env.PINELIVE_TIGER_TEST_SYMBOL;
    if (!symbol)
      throw new Error('PINELIVE_TIGER_TEST_SYMBOL is required for credentialed Tiger tests');

    const preflightBroker = new TigerBroker({
      transport: createOfficialTigerTradingTransport(credentials()),
      armed: true,
      requireExecutionSafety: true,
    });
    let instrument: Instrument;
    let account: Account;
    try {
      await preflightBroker.connect();
      instrument = await preflightBroker.instrument(symbol);
      account = await preflightBroker.getAccount();
      await expect(preflightBroker.getPosition(symbol)).resolves.toMatchObject({ symbol });
      await expect(preflightBroker.synchronizeAccount(symbol)).resolves.toMatchObject({
        status: 'blocked',
      });
      await expect(
        preflightBroker.lookupOrder({
          symbol,
          side: 'buy',
          qty: instrument.minOrderQty ?? instrument.qtyStep ?? instrument.minQty,
          type: 'market',
          clientId: 'credentialed-read-only-probe',
        }),
      ).resolves.toMatchObject({ status: 'unsupported' });
    } finally {
      await preflightBroker.disconnect();
    }

    const prepared = prepareIntrabarRun(config(symbol), strategy);
    const ledger = new MemoryLedger();
    let offlineSubmitCalls = 0;
    const seeded = await runIntrabarServer({
      prepared,
      dataFactory: () => provider(symbol, instrument, [bar(120, 11)]),
      ledger,
      lease: new InMemoryExecutionLease('credentialed-offline-ledger', {
        ownerId: 'credentialed-offline-owner',
        leaseId: 'credentialed-offline-lease',
      }),
      brokerFactory: () =>
        new TigerBroker({
          transport: ambiguitySeedTransport(account, instrument, () => offlineSubmitCalls++),
          armed: true,
          requireExecutionSafety: true,
        }),
      accountClaimFactory: ({ ownerId }) =>
        new InMemoryExecutionLease(`sha256-${'c'.repeat(64)}`, {
          ownerId,
          leaseId: 'credentialed-offline-claim',
        }),
    });
    expect(seeded).toMatchObject({ mode: 'mirrored', executionSafe: false });
    expect(offlineSubmitCalls).toBe(1);
    const recoveredEvents = structuredClone(ledger.events);
    const seededRecovery = recoverLedger(recoveredEvents);
    expect(seededRecovery.unresolvedIntents.size).toBe(1);
    const attemptsBefore = recoveredEvents.filter(
      (event) => event.recordType === 'order.attempt',
    ).length;

    const transportMutationCalls: string[] = [];
    const rawOfficialTransport = createOfficialTigerTradingTransport(credentials());
    const readOnlyOfficialTransport = new Proxy(rawOfficialTransport, {
      get(target, property) {
        if (
          property === 'submitMarket' ||
          property === 'submitLimit' ||
          property === 'cancelOrder'
        ) {
          return async () => {
            transportMutationCalls.push(String(property));
            throw new Error(`credentialed test forbids ${String(property)}`);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TigerTradingTransport;
    const rawOfficialBroker = new TigerBroker({
      transport: readOnlyOfficialTransport,
      armed: true,
      requireExecutionSafety: true,
    });
    const brokerMutationCalls: string[] = [];
    const readOnlyOfficialBroker = new Proxy(rawOfficialBroker, {
      get(target, property) {
        if (property === 'submit' || property === 'flatten' || property === 'cancel') {
          return async () => {
            brokerMutationCalls.push(String(property));
            throw new Error(`credentialed test forbids broker ${String(property)}`);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const restarted = await runIntrabarServer({
      prepared,
      dataFactory: () => provider(symbol, instrument, []),
      ledger,
      recoveredEvents,
      lease: new InMemoryExecutionLease('credentialed-official-ledger', {
        ownerId: 'credentialed-official-owner',
        leaseId: 'credentialed-official-lease',
      }),
      brokerFactory: () => readOnlyOfficialBroker,
      accountClaimFactory: ({ ownerId }) =>
        new InMemoryExecutionLease(`sha256-${'d'.repeat(64)}`, {
          ownerId,
          leaseId: 'credentialed-official-claim',
        }),
    });

    expect(restarted).toMatchObject({
      mode: 'mirrored',
      executionEligibility: 'blocked',
      executionSafe: false,
    });
    expect(restarted.eligibilityReasons.join(' ')).toContain('complete open-order inventory');
    expect(transportMutationCalls).toEqual([]);
    expect(brokerMutationCalls).toEqual([]);
    const restartedRecovery = recoverLedger(ledger.events);
    expect(restartedRecovery.unresolvedIntents.size).toBe(1);
    expect(ledger.events.filter((event) => event.recordType === 'order.attempt').length).toBe(
      attemptsBefore,
    );
  },
);
