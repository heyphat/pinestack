import { statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect as connectTls } from 'node:tls';
import {
  ConnectionState,
  PushClient,
  QuoteClient,
  TigerError,
  createClientConfig,
  type ClientConfigOptions,
  type FutureContractInfo,
  type FutureKline,
  type FutureKlineRequest,
} from '@tigeropenapi/tigeropen';
import {
  MarketDataError,
  barCloseTime,
  normalizeExpiryDate,
  throwIfAborted,
  type Bar,
  type MarketDataErrorCode,
} from '../provider.js';
import type {
  TigerBarsRequest,
  TigerBarsResult,
  TigerFutureContract,
  TigerKlineUpdate,
  TigerMarketDataTransport,
} from './tiger.js';

/**
 * Intraday futures K-line timestamps are the bar OPEN (verified: a 60min bar stamped
 * 04:00Z carries lastTime 04:46Z, a trade inside its own window). Daily/weekly/monthly
 * timestamps are instead a session-close boundary (a day bar stamped 21:00Z carries
 * lastTime 20:59:35Z), which no fixed offset converts into a session open, so those
 * periods are rejected rather than silently mislabeled.
 */
const PERIODS: Readonly<Record<string, string>> = {
  '1m': '1min',
  '3m': '3min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '60min',
  '2h': '2hour',
  '4h': '4hour',
  '6h': '6hour',
};

const PUSH_STATE_POLL_MS = 100;
const MAX_PENDING_PUSH_KLINES = 256;

export interface TigerVerifiedTlsSocket {
  write(data: Uint8Array): boolean;
  destroy(): void;
  on(event: 'data', listener: (chunk: Buffer) => void): TigerVerifiedTlsSocket;
  on(event: 'error', listener: (error: Error) => void): TigerVerifiedTlsSocket;
  on(event: 'close', listener: () => void): TigerVerifiedTlsSocket;
  on(event: 'connect', listener: () => void): TigerVerifiedTlsSocket;
}

class VerifiedTigerTlsSocket implements TigerVerifiedTlsSocket {
  constructor(private readonly socket: TigerVerifiedTlsSocket) {}

  write(data: Uint8Array): boolean {
    return this.socket.write(data);
  }

  destroy(): void {
    this.socket.destroy();
  }

  on(event: 'data', listener: (chunk: Buffer) => void): TigerVerifiedTlsSocket;
  on(event: 'error', listener: (error: Error) => void): TigerVerifiedTlsSocket;
  on(event: 'close', listener: () => void): TigerVerifiedTlsSocket;
  on(event: 'connect', listener: () => void): TigerVerifiedTlsSocket;
  on(
    event: 'data' | 'error' | 'close' | 'connect',
    listener: ((value: Buffer | Error) => void) | (() => void),
  ): TigerVerifiedTlsSocket {
    if (event === 'error') {
      this.socket.on('error', (error) =>
        (listener as (error: Error) => void)(
          isCertificateFailure(error) ? new Error('TLS peer verification failed') : error,
        ),
      );
    } else if (event === 'data') {
      this.socket.on('data', listener as (chunk: Buffer) => void);
    } else if (event === 'close') {
      this.socket.on('close', listener as () => void);
    } else {
      this.socket.on('connect', listener as () => void);
    }
    return this;
  }
}

export type TigerVerifiedTlsConnector = (options: {
  readonly host: string;
  readonly port: number;
  readonly rejectUnauthorized: true;
}) => TigerVerifiedTlsSocket;

/**
 * The pinned SDK retries certificate failures with verification disabled. Its
 * injectable socket factory is hardened here so certificate errors are terminal
 * and every attempted connection keeps rejectUnauthorized=true.
 */
export function createVerifiedTigerTlsSocketFactory(
  connect: TigerVerifiedTlsConnector = (options) => connectTls(options),
): (host: string, port: number) => TigerVerifiedTlsSocket {
  return (host, port) =>
    new VerifiedTigerTlsSocket(connect({ host, port, rejectUnauthorized: true }));
}

function isCertificateFailure(error: Error & { readonly code?: string }): boolean {
  return (
    error.message.toLowerCase().includes('certificate') ||
    error.message.toLowerCase().includes('self signed') ||
    error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    error.code === 'CERT_HAS_EXPIRED'
  );
}

/** Tiger rejects a page_token request whose other parameters changed, so the cursor carries them. */
interface TigerBarsCursor {
  token: string;
  beginTime: number;
  endTime: number;
  limit?: number;
}

function encodeCursor(cursor: TigerBarsCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): TigerBarsCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new MarketDataError('malformed-data', 'tiger: bars cursor is not decodable', {
      retryable: false,
    });
  }
  const value = parsed as Partial<TigerBarsCursor> | null;
  if (
    !value ||
    typeof value.token !== 'string' ||
    !value.token ||
    !Number.isFinite(value.beginTime) ||
    !Number.isFinite(value.endTime)
  )
    throw new MarketDataError('malformed-data', 'tiger: bars cursor is malformed', {
      retryable: false,
    });
  return value as TigerBarsCursor;
}

/** Minimal official quote-client surface, exported for offline testing/custom facades. */
export interface OfficialTigerQuoteClient {
  getCurrentFutureContract(request: { type?: string }): Promise<FutureContractInfo | undefined>;
  getFutureKline(request: FutureKlineRequest): Promise<FutureKline[]>;
}

/** Structural K-line callback payload used to keep tests independent of generated protobuf types. */
export interface OfficialTigerPushKline {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly symbol: string;
  readonly serverTimestamp?: number;
}

export interface OfficialTigerPushCallbacks {
  readonly onKline?: (data: OfficialTigerPushKline) => void;
  readonly onConnect?: () => void;
  readonly onDisconnect?: () => void;
  readonly onError?: (error: Error) => void;
  readonly onKickout?: (message: string) => void;
}

/** Minimal PushClient surface, exported for deterministic offline tests. */
export interface OfficialTigerPushClient {
  readonly state: number;
  setCallbacks(callbacks: OfficialTigerPushCallbacks): void;
  connect(): Promise<void>;
  subscribeKline(symbols: string[]): void;
  unsubscribeKline(symbols?: string[]): void;
  disconnect(): void;
}

export type OfficialTigerPushClientFactory = () => OfficialTigerPushClient;

export interface OfficialTigerMarketDataOptions {
  tigerId?: string;
  privateKey?: string;
  account?: string;
  license?: string;
  token?: string;
  propertiesFilePath?: string;
  serverUrl?: string;
}

/** Resolve a user-supplied profile path so a wrong path fails clearly, not as "missing credentials". */
export function resolveTigerProfilePath(profile: string): string {
  const expanded = profile.startsWith('~')
    ? join(homedir(), profile.slice(1).replace(/^[/\\]/, ''))
    : profile;
  const absolute = resolve(expanded);
  const candidate = statSafe(absolute)?.isDirectory()
    ? join(absolute, 'tiger_openapi_config.properties')
    : absolute;
  if (!statSafe(candidate)?.isFile())
    throw new MarketDataError(
      'auth',
      `tiger: credential profile not found at ${candidate}; supply an existing tiger_openapi_config.properties path`,
      { retryable: false },
    );
  return candidate;
}

function statSafe(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** Create the official SDK-backed transport without exposing SDK types to pinery core. */
export function createOfficialTigerMarketDataTransport(
  options: OfficialTigerMarketDataOptions = {},
): OfficialTigerMarketDataTransport {
  const configOptions: ClientConfigOptions = {
    tigerId: options.tigerId,
    privateKey: options.privateKey,
    account: options.account,
    license: options.license,
    token: options.token,
    propertiesFilePath:
      options.propertiesFilePath == null
        ? undefined
        : resolveTigerProfilePath(options.propertiesFilePath),
    serverUrl: options.serverUrl,
  };
  const config = createClientConfig(configOptions);
  for (const field of ['tigerId', 'privateKey', 'account', 'license', 'token'] as const) {
    const expected = options[field];
    if (expected != null && config[field] !== expected)
      throw new MarketDataError(
        'auth',
        `tiger: SDK environment overrides explicit ${field} configuration`,
        { retryable: false },
      );
  }
  return new OfficialTigerMarketDataTransport(QuoteClient.fromConfig(config), () => {
    const client = new PushClient(config, { autoReconnect: false });
    client.socketFactory = createVerifiedTigerTlsSocketFactory();
    return client;
  });
}

/** Node-only Tiger OpenAPI v0.5.x futures quote and push adapter. */
export class OfficialTigerMarketDataTransport implements TigerMarketDataTransport {
  private readonly activePushClients = new Map<OfficialTigerPushClient, AbortController>();

  readonly openKlineStream?: (
    contract: string,
    signal?: AbortSignal,
  ) => AsyncIterable<TigerKlineUpdate>;

  constructor(
    private readonly client: OfficialTigerQuoteClient,
    private readonly createPushClient?: OfficialTigerPushClientFactory,
  ) {
    if (createPushClient) {
      this.openKlineStream = (contract, signal) => this.createKlineStream(contract, signal);
    }
  }

  async connect(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
  }

  async resolveFuture(
    root: string,
    _now: Date,
    signal?: AbortSignal,
  ): Promise<TigerFutureContract> {
    return this.request('resolve future', signal, async () => {
      const contract = await this.client.getCurrentFutureContract({ type: root });
      if (
        !contract ||
        contract.type.toUpperCase() !== root.toUpperCase() ||
        !contract.contractCode ||
        contract.trade === false
      )
        throw new MarketDataError('invalid-symbol', 'tiger: current futures contract unavailable', {
          retryable: false,
        });
      if (!Number.isFinite(contract.minTick) || contract.minTick! <= 0)
        throw new MarketDataError('malformed-data', 'tiger: futures contract has invalid minTick', {
          retryable: false,
        });
      if (
        contract.multiplier != null &&
        (!Number.isFinite(contract.multiplier) || contract.multiplier <= 0)
      )
        throw new MarketDataError(
          'malformed-data',
          'tiger: futures contract has invalid multiplier',
          { retryable: false },
        );
      return {
        root,
        contract: contract.contractCode,
        mintick: contract.minTick!,
        qtyStep: 1,
        minOrderQty: 1,
        pointValue: contract.multiplier,
        exchange: contract.exchangeCode ?? contract.exchange,
        expiry: normalizeExpiryDate(contract.lastTradingDate),
      };
    });
  }

  async bars(
    contract: string,
    timeframe: string,
    range: TigerBarsRequest,
    signal?: AbortSignal,
  ): Promise<TigerBarsResult> {
    const period = PERIODS[timeframe];
    if (!period)
      throw new MarketDataError(
        'malformed-data',
        `tiger: unsupported futures timeframe ${timeframe}; supported: ${Object.keys(PERIODS).join(', ')}` +
          ' (daily and longer periods report a session-close boundary, not a bar open, and need exchange-calendar alignment)',
        { retryable: false },
      );
    return this.request('fetch futures bars', signal, async () => {
      const cursor = range.cursor == null ? undefined : decodeCursor(range.cursor);
      const beginTime = cursor?.beginTime ?? (range.from == null ? -1 : range.from * 1_000);
      const endTime = cursor?.endTime ?? (range.to == null ? Date.now() : range.to * 1_000);
      const limit = cursor ? cursor.limit : range.limit;
      const response = await this.client.getFutureKline({
        contractCodes: [contract],
        period,
        beginTime,
        endTime,
        limit,
        pageToken: cursor?.token,
      });
      if (!Array.isArray(response) || response.length > 1)
        throw new MarketDataError('malformed-data', 'tiger: malformed futures K-line response', {
          retryable: false,
        });
      const page = response[0];
      const items = page?.items ?? [];
      if (!Array.isArray(items))
        throw new MarketDataError('malformed-data', 'tiger: malformed futures K-line items', {
          retryable: false,
        });
      const bars = items.map((item): Bar => {
        if (
          ![item.time, item.open, item.high, item.low, item.close, item.volume].every(
            Number.isFinite,
          )
        )
          throw new MarketDataError('malformed-data', 'tiger: invalid futures K-line value', {
            retryable: false,
          });
        return {
          time: Math.floor(item.time / 1_000),
          open: item.open,
          high: item.high,
          low: item.low,
          close: item.close,
          volume: item.volume,
        };
      });
      const newestOpen = items.reduce((latest, item) => Math.max(latest, item.time), -Infinity);
      return {
        bars,
        // A cursor page is strictly older. On the first page, only a row whose
        // minute has demonstrably elapsed is final; otherwise withhold the newest.
        finality: items.map(
          (item) =>
            range.cursor != null ||
            item.time < newestOpen ||
            (range.to != null &&
              item.time <= range.to * 1_000 &&
              barCloseTime(Math.floor(item.time / 1_000), timeframe) * 1_000 <= Date.now()),
        ),
        nextCursor:
          page?.nextPageToken == null
            ? undefined
            : encodeCursor({ token: page.nextPageToken, beginTime, endTime, limit }),
      };
    });
  }

  private createKlineStream(
    contract: string,
    signal?: AbortSignal,
  ): AsyncIterable<TigerKlineUpdate> {
    const createClient = this.createPushClient;
    if (!createClient) {
      throw new MarketDataError('connectivity', 'tiger: official PushClient is unavailable', {
        retryable: false,
      });
    }
    const transport = this;
    return {
      async *[Symbol.asyncIterator]() {
        throwIfAborted(signal);
        const client = createClient();
        const lifecycle = new AbortController();
        const relayAbort = (): void => lifecycle.abort();
        signal?.addEventListener('abort', relayAbort, { once: true });
        if (signal?.aborted) lifecycle.abort();
        transport.activePushClients.set(client, lifecycle);
        const queue: TigerKlineUpdate[] = [];
        let wake: (() => void) | undefined;
        let endStartup!: () => void;
        const startupEnded = new Promise<void>((resolve) => {
          endStartup = resolve;
        });
        let done = false;
        let failure: unknown;
        let subscribed = false;
        let lastAssignedEventTime = 0;
        const notify = (): void => {
          const resolve = wake;
          wake = undefined;
          resolve?.();
        };
        const finish = (error?: unknown): void => {
          if (error !== undefined) failure = error;
          done = true;
          endStartup();
          notify();
        };
        const abort = (): void => finish();
        lifecycle.signal.addEventListener('abort', abort, { once: true });
        const stopClient = (): void => {
          client.setCallbacks({});
          if (transport.activePushClients.delete(client)) client.disconnect();
        };
        client.setCallbacks({
          onKline(data) {
            if (done) return;
            const eventTime =
              data.serverTimestamp == null
                ? Math.max(Date.now(), lastAssignedEventTime + 1)
                : data.serverTimestamp;
            lastAssignedEventTime = Math.max(lastAssignedEventTime, eventTime);
            const update: TigerKlineUpdate = Object.freeze({
              symbol: data.symbol,
              time: data.time,
              open: data.open,
              high: data.high,
              low: data.low,
              close: data.close,
              volume: data.volume,
              eventTime,
            });
            const latest = queue.at(-1);
            if (latest?.symbol === update.symbol && latest.time === update.time) {
              if (update.eventTime >= latest.eventTime) queue[queue.length - 1] = update;
            } else if (queue.length >= MAX_PENDING_PUSH_KLINES) {
              queue.length = 0;
              finish(
                new MarketDataError(
                  'live-discontinuity',
                  'tiger: pending PushClient K-line queue overflowed',
                  { retryable: false, details: { maxPendingKlines: MAX_PENDING_PUSH_KLINES } },
                ),
              );
              stopClient();
              return;
            } else {
              queue.push(update);
            }
            notify();
          },
          onDisconnect: () => finish(),
          onError: (error) => {
            finish(error);
            stopClient();
          },
          onKickout: () => {
            finish(
              new MarketDataError('entitlement', 'tiger: push subscription was rejected', {
                retryable: false,
              }),
            );
            stopClient();
          },
        });

        try {
          const connected = await connectPushClient(client, lifecycle.signal, startupEnded);
          if (!connected) {
            if (failure) throw failure;
            return;
          }
          throwIfAborted(lifecycle.signal);
          client.subscribeKline([contract]);
          subscribed = true;
          while (!done || queue.length > 0) {
            if (lifecycle.signal.aborted) return;
            const update = queue.shift();
            if (update) {
              yield update;
              continue;
            }
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                if (wake === complete) wake = undefined;
                resolve();
              }, PUSH_STATE_POLL_MS);
              const complete = (): void => {
                clearTimeout(timer);
                resolve();
              };
              wake = complete;
              if (done || lifecycle.signal.aborted) notify();
            });
            // The SDK does not invoke onDisconnect for a raw socket close.
            if (client.state === ConnectionState.Disconnected) done = true;
          }
          if (failure) throw failure;
        } catch (error) {
          if (lifecycle.signal.aborted) return;
          if (error instanceof MarketDataError) throw error;
          throw classifyOfficialTigerMarketError(error, 'stream futures K-lines');
        } finally {
          signal?.removeEventListener('abort', relayAbort);
          lifecycle.signal.removeEventListener('abort', abort);
          if (subscribed && client.state === ConnectionState.Connected) {
            try {
              client.unsubscribeKline([contract]);
            } catch {
              // Disconnect still guarantees local cleanup.
            }
          }
          stopClient();
        }
      },
    };
  }

  async disconnect(): Promise<void> {
    for (const [client, controller] of [...this.activePushClients]) {
      controller.abort();
      try {
        client.setCallbacks({});
        client.disconnect();
      } finally {
        this.activePushClients.delete(client);
      }
    }
  }

  private async request<T>(
    operation: string,
    signal: AbortSignal | undefined,
    call: () => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    try {
      const result = await abortableOfficialRequest(call(), signal);
      throwIfAborted(signal);
      return result;
    } catch (error) {
      if (error instanceof MarketDataError) throw error;
      throw classifyOfficialTigerMarketError(error, operation);
    }
  }
}

async function abortableOfficialRequest<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = (): void =>
      finish(() =>
        reject(
          new MarketDataError('connectivity', 'market-data request aborted', {
            retryable: false,
          }),
        ),
      );
    signal.addEventListener('abort', abort, { once: true });
    request.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function connectPushClient(
  client: OfficialTigerPushClient,
  signal: AbortSignal,
  streamEnded: Promise<void>,
): Promise<boolean> {
  if (signal.aborted) throwIfAborted(signal);
  const connecting = client.connect();
  void connecting.catch(() => {
    // The race below observes this unless cancellation or callback termination wins first.
  });
  let abort!: () => void;
  const cancelled = new Promise<'aborted'>((resolve) => {
    abort = () => resolve('aborted');
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([
      connecting.then(() => 'connected' as const),
      cancelled,
      streamEnded.then(() => 'ended' as const),
    ]);
    if (result === 'aborted') throwIfAborted(signal);
    return result === 'connected';
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function classifyOfficialTigerMarketError(error: unknown, operation: string): MarketDataError {
  if (error instanceof MarketDataError) return error;
  if (error instanceof TigerError) {
    const code = marketErrorCode(error);
    return new MarketDataError(code, `tiger: ${operation} failed`, {
      retryable: code === 'rate-limit' || code === 'connectivity',
    });
  }
  if (operation !== 'stream futures K-lines') {
    return new MarketDataError('connectivity', `tiger: ${operation} failed`);
  }
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  const code: MarketDataErrorCode =
    message.includes('permission') || message.includes('entitle')
      ? 'entitlement'
      : message.includes('auth') ||
          message.includes('credential') ||
          message.includes('signature') ||
          message.includes('forbidden')
        ? 'auth'
        : message.includes('rate') || message.includes('429')
          ? 'rate-limit'
          : 'connectivity';
  return new MarketDataError(code, `tiger: ${operation} failed`, {
    retryable: code === 'rate-limit' || code === 'connectivity',
  });
}

function marketErrorCode(error: TigerError): MarketDataErrorCode {
  const message = error.message.toLowerCase();
  if (
    message.includes('whitelist') ||
    message.includes('forbidden') ||
    message.includes('signature')
  )
    return 'auth';
  if (error.category === 'rate_limit') return 'rate-limit';
  if (error.category === 'token_error') return 'auth';
  if (error.category === 'permission_error') return 'entitlement';
  if (message.includes('permission') || message.includes('entitle')) return 'entitlement';
  if (error.category === 'biz_param_error' || error.category === 'quote_future_error')
    return 'invalid-symbol';
  return 'connectivity';
}
