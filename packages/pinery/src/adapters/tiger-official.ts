import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { statSync, type Stats } from 'node:fs';
import {
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
  normalizeExpiryDate,
  throwIfAborted,
  type Bar,
  type MarketDataErrorCode,
} from '../provider.js';
import type {
  TigerBarsRequest,
  TigerBarsResult,
  TigerFutureContract,
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
  return new OfficialTigerMarketDataTransport(QuoteClient.fromConfig(config));
}

/** Node-only Tiger OpenAPI v0.5.x futures quote adapter. */
export class OfficialTigerMarketDataTransport implements TigerMarketDataTransport {
  constructor(private readonly client: OfficialTigerQuoteClient) {}

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
          {
            retryable: false,
          },
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
      // A cursor replays the first page's parameters verbatim; Tiger rejects any change.
      const cursor = range.cursor == null ? undefined : decodeCursor(range.cursor);
      const beginTime = cursor?.beginTime ?? (range.from == null ? -1 : range.from * 1_000);
      // An explicit end is required: the server resolves -1 to its own clock and then
      // refuses to page, because the token's embedded end no longer matches the request.
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
          // Intraday `time` is already the bar open, in milliseconds.
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
        // The newest bar of the first page is the one still forming (its lastTime falls
        // inside its own window), so withhold it. A cursor page is strictly older than a
        // page already observed, which proves every bar on it closed.
        finality: items.map((item) => range.cursor != null || item.time < newestOpen),
        nextCursor:
          page?.nextPageToken == null
            ? undefined
            : encodeCursor({ token: page.nextPageToken, beginTime, endTime, limit }),
      };
    });
  }

  private async request<T>(
    operation: string,
    signal: AbortSignal | undefined,
    call: () => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    try {
      const result = await call();
      throwIfAborted(signal);
      return result;
    } catch (error) {
      if (error instanceof MarketDataError) throw error;
      throw classifyOfficialTigerMarketError(error, operation);
    }
  }
}

function classifyOfficialTigerMarketError(error: unknown, operation: string): MarketDataError {
  if (error instanceof TigerError) {
    const code = marketErrorCode(error);
    return new MarketDataError(code, `tiger: ${operation} failed`, {
      // Access/permission rejections are configuration failures; retrying cannot fix them.
      retryable: code === 'rate-limit' || code === 'connectivity',
    });
  }
  return new MarketDataError('connectivity', `tiger: ${operation} failed`);
}

function marketErrorCode(error: TigerError): MarketDataErrorCode {
  // Tiger returns some gateway rejections (ip whitelist, forbidden) under a generic
  // code, so the category alone cannot distinguish terminal misconfiguration.
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
