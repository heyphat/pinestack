import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PushClient,
  TigerError,
  type FutureContractInfo,
  type FutureKline,
  type FutureKlineRequest,
} from '@tigeropenapi/tigeropen';
import { MarketDataError } from '../src/index.js';
import {
  createVerifiedTigerTlsSocketFactory,
  type TigerVerifiedTlsSocket,
} from '../src/adapters/tiger-official.js';
import {
  OfficialTigerMarketDataTransport,
  resolveTigerProfilePath,
  type OfficialTigerPushCallbacks,
  type OfficialTigerPushClient,
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

class PushFacade implements OfficialTigerPushClient {
  state = 0;
  callbacks: OfficialTigerPushCallbacks = {};
  subscribed: string[][] = [];
  unsubscribed: Array<string[] | undefined> = [];
  disconnects = 0;

  setCallbacks(callbacks: OfficialTigerPushCallbacks): void {
    this.callbacks = callbacks;
  }

  async connect(): Promise<void> {
    this.state = 2;
    this.callbacks.onConnect?.();
  }

  subscribeKline(symbols: string[]): void {
    this.subscribed.push(symbols);
    this.callbacks.onKline?.({
      symbol: symbols[0]!,
      time: 1_704_067_200_000,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 5,
      serverTimestamp: 1_704_067_201_000,
    });
  }

  unsubscribeKline(symbols?: string[]): void {
    this.unsubscribed.push(symbols);
  }

  disconnect(): void {
    this.disconnects++;
    this.state = 0;
    this.callbacks.onDisconnect?.();
  }
}

test('official Tiger push adapter subscribes K-lines and cleans up a dedicated client', async () => {
  const quote = new QuoteFacade();
  const push = new PushFacade();
  const transport = new OfficialTigerMarketDataTransport(quote, () => push);
  const iterator = transport.openKlineStream!('MGCZ26')[Symbol.asyncIterator]();

  await expect(iterator.next()).resolves.toEqual({
    done: false,
    value: {
      symbol: 'MGCZ26',
      time: 1_704_067_200_000,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 5,
      eventTime: 1_704_067_201_000,
    },
  });
  await iterator.return?.();

  expect(push.subscribed).toEqual([['MGCZ26']]);
  expect(push.unsubscribed).toEqual([['MGCZ26']]);
  expect(push.disconnects).toBe(1);
  expect(push.callbacks).toEqual({});
});

test('official Tiger push adapter keeps the newest same-open callback when coalescing', async () => {
  const push = new PushFacade();
  push.subscribeKline = function (symbols: string[]) {
    this.subscribed.push(symbols);
    const emit = (time: number, close: number, serverTimestamp: number): void =>
      this.callbacks.onKline?.({
        symbol: symbols[0]!,
        time,
        open: 100,
        high: 103,
        low: 99,
        close,
        volume: 5,
        serverTimestamp,
      });
    emit(1_704_067_200_000, 101, 1_704_067_210_000);
    emit(1_704_067_200_000, 102, 1_704_067_230_000);
    emit(1_704_067_200_000, 102.5, 1_704_067_230_000);
    emit(1_704_067_200_000, 100.5, 1_704_067_220_000);
    emit(1_704_067_260_000, 103, 1_704_067_261_000);
  };
  const transport = new OfficialTigerMarketDataTransport(new QuoteFacade(), () => push);
  const iterator = transport.openKlineStream!('MGCZ26')[Symbol.asyncIterator]();

  await expect(iterator.next()).resolves.toMatchObject({
    done: false,
    value: { close: 102.5, eventTime: 1_704_067_230_000 },
  });
  await expect(iterator.next()).resolves.toMatchObject({
    done: false,
    value: { time: 1_704_067_260_000 },
  });
  await iterator.return?.();
});

test('official Tiger push adapter assigns monotonic times to timestamp-less callbacks', async () => {
  const originalNow = Date.now;
  Object.defineProperty(Date, 'now', { configurable: true, value: () => 1_704_067_299_000 });
  try {
    const push = new PushFacade();
    push.subscribeKline = function (symbols: string[]) {
      this.subscribed.push(symbols);
      const emit = (time: number, close: number): void =>
        this.callbacks.onKline?.({
          symbol: symbols[0]!,
          time,
          open: 100,
          high: 103,
          low: 99,
          close,
          volume: 5,
        });
      emit(1_704_067_200_000, 101);
      emit(1_704_067_200_000, 102);
      emit(1_704_067_260_000, 103);
    };
    const transport = new OfficialTigerMarketDataTransport(new QuoteFacade(), () => push);
    const iterator = transport.openKlineStream!('MGCZ26')[Symbol.asyncIterator]();

    const current = await iterator.next();
    const next = await iterator.next();
    expect(current).toMatchObject({
      done: false,
      value: { close: 102, eventTime: 1_704_067_299_001 },
    });
    expect(next).toMatchObject({
      done: false,
      value: { close: 103, eventTime: 1_704_067_299_002 },
    });
    await iterator.return?.();
  } finally {
    Object.defineProperty(Date, 'now', { configurable: true, value: originalNow });
  }
});

test('official Tiger transport disconnect cancels a pending push connection', async () => {
  const push = new PushFacade();
  let connectStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    connectStarted = resolve;
  });
  push.connect = async () => {
    connectStarted();
    return await new Promise<void>(() => {});
  };
  const transport = new OfficialTigerMarketDataTransport(new QuoteFacade(), () => push);
  const iterator = transport.openKlineStream!('MGCZ26')[Symbol.asyncIterator]();
  const pending = iterator.next();
  await started;

  await transport.disconnect();

  await expect(pending).resolves.toMatchObject({ done: true });
  expect(push.disconnects).toBe(1);
  expect(push.callbacks).toEqual({});
});

test('official Tiger push queue overflow fails immediately and detaches callbacks', async () => {
  const push = new PushFacade();
  push.subscribeKline = function (symbols: string[]) {
    this.subscribed.push(symbols);
    for (let index = 0; index <= 256; index++) {
      this.callbacks.onKline?.({
        symbol: symbols[0]!,
        time: 1_704_067_200_000 + index * 60_000,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 5,
        serverTimestamp: 1_704_067_201_000 + index,
      });
    }
  };
  const transport = new OfficialTigerMarketDataTransport(new QuoteFacade(), () => push);
  const iterator = transport.openKlineStream!('MGCZ26')[Symbol.asyncIterator]();

  await expect(iterator.next()).rejects.toMatchObject({
    code: 'live-discontinuity',
    retryable: false,
  });
  expect(push.callbacks).toEqual({});
  expect(push.disconnects).toBe(1);
});

test('official Tiger push adapter fails promptly on a pre-connect authentication callback', async () => {
  const push = new PushFacade();
  push.connect = async function () {
    this.callbacks.onError?.(new Error('authentication failed credential=secret'));
    return await new Promise<void>(() => {});
  };
  const transport = new OfficialTigerMarketDataTransport(new QuoteFacade(), () => push);
  const iterator = transport.openKlineStream!('MGCZ26')[Symbol.asyncIterator]();
  const outcome = await Promise.race([
    iterator.next().then(
      () => ({ kind: 'value' as const }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    ),
    new Promise<{ kind: 'timeout' }>((resolve) =>
      setTimeout(() => resolve({ kind: 'timeout' }), 100),
    ),
  ]);

  expect(outcome).toMatchObject({
    kind: 'error',
    error: { code: 'auth', retryable: false },
  });
  if (outcome.kind === 'error') {
    expect((outcome.error as Error).message).not.toContain('secret');
  }
  expect(push.disconnects).toBe(1);
});

test('official Tiger push adapter classifies subscription permission failures', async () => {
  const push = new PushFacade();
  push.subscribeKline = function (symbols: string[]) {
    this.subscribed.push(symbols);
    this.callbacks.onError?.(new Error('market data permission denied credential=secret'));
  };
  const transport = new OfficialTigerMarketDataTransport(new QuoteFacade(), () => push);
  const iterator = transport.openKlineStream!('MGCZ26')[Symbol.asyncIterator]();
  const error = await iterator.next().catch((value) => value as MarketDataError);
  expect(error).toMatchObject({ code: 'entitlement', retryable: false });
  expect(error.message).not.toContain('secret');
  expect(push.disconnects).toBe(1);
});

test('official Tiger push treats certificate failure as terminal without an unverified retry', async () => {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const socket = {
    write: () => true,
    destroy: () => {},
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners[event] = listener;
      return socket;
    },
  } as TigerVerifiedTlsSocket;
  let connections = 0;
  const factory = createVerifiedTigerTlsSocketFactory((options) => {
    connections++;
    expect(options.rejectUnauthorized).toBe(true);
    return socket;
  });
  const client = new PushClient({ tigerId: 'fixture', privateKey: 'unused' } as never, {
    autoReconnect: false,
    connectTimeout: 1_000,
  });
  client.socketFactory = factory;

  const connecting = client.connect();
  listeners.error?.(
    Object.assign(new Error('self signed certificate'), {
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    }),
  );

  await expect(connecting).rejects.toThrow('TLS connection failed: TLS peer verification failed');
  expect(connections).toBe(1);
});
