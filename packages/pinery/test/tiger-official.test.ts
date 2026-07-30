import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TigerError,
  type FutureContractInfo,
  type FutureKline,
  type FutureKlineRequest,
} from '@tigeropenapi/tigeropen';
import { MarketDataError } from '../src/index.js';
import {
  OfficialTigerMarketDataTransport,
  resolveTigerProfilePath,
  type OfficialTigerQuoteClient,
} from '../src/node.js';

class QuoteFacade implements OfficialTigerQuoteClient {
  contract: FutureContractInfo | undefined = {
    type: 'MGC',
    contractCode: 'MGCZ26',
    trade: true,
    minTick: 0.1,
    multiplier: 10,
    exchangeCode: 'COMEX',
    lastTradingDate: '2026-12-28',
  };
  pages: FutureKline[] = [];
  readonly requests: FutureKlineRequest[] = [];
  resolveCalls = 0;

  async getCurrentFutureContract() {
    this.resolveCalls++;
    return this.contract;
  }

  async getFutureKline(request: FutureKlineRequest) {
    this.requests.push(request);
    return this.pages.length ? [this.pages.shift()!] : [];
  }
}

const item = (time: number) => ({
  time,
  open: 1,
  high: 3,
  low: 0.5,
  close: 2,
  volume: 4,
});

test('official Tiger quote adapter resolves exact futures metadata', async () => {
  const client = new QuoteFacade();
  const transport = new OfficialTigerMarketDataTransport(client);
  await expect(transport.resolveFuture('MGC', new Date(0))).resolves.toEqual({
    root: 'MGC',
    contract: 'MGCZ26',
    mintick: 0.1,
    qtyStep: 1,
    minOrderQty: 1,
    pointValue: 10,
    exchange: 'COMEX',
    expiry: '2026-12-28',
  });
  client.contract = { ...client.contract!, contractCode: 'MGCZ26', minTick: 0 };
  await expect(transport.resolveFuture('MGC', new Date(0))).rejects.toMatchObject({
    code: 'malformed-data',
    retryable: false,
  });
});

test('official Tiger quote adapter treats bar time as the open and replays cursor parameters', async () => {
  const client = new QuoteFacade();
  client.pages.push(
    { items: [item(120_000), item(180_000)], nextPageToken: 'older' },
    { items: [item(60_000)] },
  );
  const transport = new OfficialTigerMarketDataTransport(client);
  const newest = await transport.bars('MGCZ26', '1m', { from: 60, to: 120, limit: 2 });
  expect(client.requests[0]).toEqual({
    contractCodes: ['MGCZ26'],
    period: '1min',
    beginTime: 60_000,
    endTime: 120_000,
    limit: 2,
    pageToken: undefined,
  });
  // Intraday timestamps are already bar opens; no duration arithmetic.
  expect(newest.bars.map((bar) => bar.time)).toEqual([120, 180]);
  expect(newest.finality).toEqual([true, false]);
  expect(newest.nextCursor).toBeString();
  expect(newest.nextCursor).not.toBe('older');

  const older = await transport.bars('MGCZ26', '1m', { cursor: newest.nextCursor! });
  expect(older.bars.map((bar) => bar.time)).toEqual([60]);
  expect(older.finality).toEqual([true]);
  // Tiger rejects a paged request whose other parameters changed, so they are replayed verbatim.
  expect(client.requests[1]).toEqual({
    contractCodes: ['MGCZ26'],
    period: '1min',
    beginTime: 60_000,
    endTime: 120_000,
    limit: 2,
    pageToken: 'older',
  });

  await expect(transport.bars('MGCZ26', '1m', { cursor: 'not-a-cursor' })).rejects.toMatchObject({
    code: 'malformed-data',
    retryable: false,
  });
});

test('official Tiger quote adapter sends an explicit end time so pages remain replayable', async () => {
  const client = new QuoteFacade();
  const transport = new OfficialTigerMarketDataTransport(client);
  const before = Date.now();
  await transport.bars('MGCZ26', '1h', {});
  const request = client.requests.at(-1)!;
  // -1 would let the server substitute its own clock, which then breaks pagination.
  expect(request.endTime).toBeGreaterThanOrEqual(before);
  expect(request.beginTime).toBe(-1);
});

test('official Tiger quote adapter supports only documented futures periods', async () => {
  const client = new QuoteFacade();
  const transport = new OfficialTigerMarketDataTransport(client);
  const expected = new Map([
    ['1m', '1min'],
    ['3m', '3min'],
    ['5m', '5min'],
    ['15m', '15min'],
    ['30m', '30min'],
    ['1h', '60min'],
    ['2h', '2hour'],
    ['4h', '4hour'],
    ['6h', '6hour'],
  ]);
  for (const [timeframe, period] of expected) {
    await transport.bars('MGCZ26', timeframe, {});
    expect(client.requests.at(-1)?.period).toBe(period);
  }
  // The venue rejects these outright.
  for (const timeframe of ['8h', '12h', '3d']) {
    await expect(transport.bars('MGCZ26', timeframe, {})).rejects.toMatchObject({
      code: 'malformed-data',
      retryable: false,
    });
  }
  // These are legal at the venue but stamp a session-close boundary rather than a bar
  // open, so accepting them would mislabel every bar.
  for (const timeframe of ['1d', '1w', '1M']) {
    await expect(transport.bars('MGCZ26', timeframe, {})).rejects.toMatchObject({
      code: 'malformed-data',
      retryable: false,
    });
  }
});

test('official Tiger quote adapter fails closed on access rejections and stays retryable on server faults', async () => {
  const client = new QuoteFacade();
  const transport = new OfficialTigerMarketDataTransport(client);
  const cases: Array<[TigerError, string, boolean]> = [
    // Tiger reports an ip-whitelist miss under a generic code; retrying cannot fix it.
    [
      new TigerError(4, 'access forbidden: request ip 1.2.3.4 is not in ip whitelist'),
      'auth',
      false,
    ],
    [new TigerError(4, 'signature verification failed'), 'auth', false],
    [new TigerError(4, 'no market data permission for this symbol'), 'entitlement', false],
    [new TigerError(1, 'internal server error'), 'connectivity', true],
  ];
  for (const [thrown, code, retryable] of cases) {
    client.getCurrentFutureContract = async () => {
      throw thrown;
    };
    const error = await transport
      .resolveFuture('MGC', new Date(0))
      .catch((value) => value as MarketDataError);
    expect({ code: error.code, retryable: error.retryable }).toEqual({ code, retryable });
    expect(error.message).not.toContain('whitelist');
    expect(error.message).not.toContain('1.2.3.4');
  }
});

test('official Tiger quote adapter resolves and validates credential profile paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tiger-profile-'));
  const file = join(dir, 'tiger_openapi_config.properties');
  writeFileSync(file, 'tiger_id=1\naccount=2\n');

  // A directory resolves to the SDK's well-known file name inside it.
  expect(resolveTigerProfilePath(dir)).toBe(file);
  expect(resolveTigerProfilePath(file)).toBe(file);

  expect(() => resolveTigerProfilePath(join(dir, 'missing.properties'))).toThrow(
    'credential profile not found',
  );
  const error = (() => {
    try {
      resolveTigerProfilePath(join(dir, 'nested'));
      return undefined;
    } catch (value) {
      return value as MarketDataError;
    }
  })();
  expect(error?.code).toBe('auth');
  expect(error?.retryable).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test('official Tiger quote adapter checks cancellation and redacts SDK failures', async () => {
  const client = new QuoteFacade();
  const transport = new OfficialTigerMarketDataTransport(client);
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(transport.resolveFuture('MGC', new Date(0), cancelled.signal)).rejects.toMatchObject(
    {
      retryable: false,
    },
  );
  expect(client.resolveCalls).toBe(0);

  client.getCurrentFutureContract = async () => {
    throw new Error('credential privateKey=secret');
  };
  const error = await transport
    .resolveFuture('MGC', new Date(0))
    .catch((value) => value as MarketDataError);
  expect(error.code).toBe('connectivity');
  expect(error.message).not.toContain('secret');
  expect(error.cause).toBeUndefined();
});
