/*
 * OKX provider — SPOT and SWAP (USDⓈ-margined perpetuals) candles via the keyless
 * OKX v5 REST API. Pages newest→oldest using the `after` cursor, falling through
 * from /market/candles (recent, 300/page) to /market/history-candles (deep, 100/page).
 */
import type {
  Bar,
  HistoryAcquisition,
  HistoryProvider,
  HistoryRange,
  HistoryRequest,
  HistoryTruncation,
  InstrumentInfo,
  ResolvedHistorySource,
} from '../provider.js';
import {
  applyExactQueryRange,
  applyRange,
  boundedHistoryRangeToHalfOpenMs,
  dropUnclosedBars,
  historyRequestRange,
  unixSecond,
} from '../provider.js';
import { parseTimeframe, type Timeframe } from '../timeframe.js';
import { fetchJson } from '../http.js';
import { normalizeOkxSpot, normalizeOkxSwap } from '../symbols.js';
import type { AssetClass } from '../asset-class.js';
import {
  createHistoryCacheIdentity,
  historyAcquisitionFromBars,
  nonSecretBaseUrl,
  snapshotHistoryCapabilities,
  snapshotResolvedHistorySource,
} from '../coverage.js';

const CANDLE_LIMIT = 300;
const HISTORY_CANDLE_LIMIT = 100;
const MAX_PAGES = 200;
const DEFAULT_MAX_BARS = 50_000;
const MAX_PAGE_CAPACITY = MAX_PAGES * CANDLE_LIMIT;
/** OKX 1Wutc candles open Monday 00:00 UTC. */
const OKX_WEEK_ANCHOR_SEC = unixSecond(4 * 86_400);
const OKX_EXACT_TIMEFRAMES = [
  '1s',
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '12h',
  '1d',
  '2d',
  '3d',
  '1w',
] as const;

export type OkxMarket = 'spot' | 'swap';

export interface OkxProviderOptions {
  /** 'spot' (default) or 'swap' (perpetual futures). */
  market?: OkxMarket;
  /** Override the REST base. Default https://www.okx.com */
  baseUrl?: string;
  /** Safety cap across all pages. Default 50_000. */
  maxBars?: number;
  fetchImpl?: typeof fetch;
}

// OKX candle row: [ts(ms), o, h, l, c, vol, volCcy, volCcyQuote, confirm].
// `ts` is a string of epoch millis; `confirm` is "0" while the candle is still forming.
type OkxCandle = [string, string, string, string, string, string, ...unknown[]];

interface LoadedHistory {
  readonly bars: Bar[];
  readonly truncated?: HistoryTruncation;
}

export class OkxProvider implements HistoryProvider {
  readonly id: string;
  readonly assetClass: AssetClass;
  private readonly market: OkxMarket;
  private readonly baseUrl: string;
  private readonly configuredMaxBars: number;
  private readonly maxBars: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: OkxProviderOptions = {}) {
    this.market = opts.market ?? 'spot';
    this.id = this.market === 'swap' ? 'okx-swap' : 'okx';
    this.assetClass = this.market === 'swap' ? 'futures' : 'crypto';
    this.baseUrl = (opts.baseUrl ?? 'https://www.okx.com').replace(/\/$/, '');
    this.configuredMaxBars = positiveLimit(opts.maxBars, DEFAULT_MAX_BARS, 'okx maxBars');
    this.maxBars = Math.min(this.configuredMaxBars, MAX_PAGE_CAPACITY);
    this.fetchImpl = opts.fetchImpl;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const instId = this.normalizeSymbol(symbol);
    const loaded = await this.loadHistory(instId, timeframe, range, false);
    if (loaded.truncated) {
      console.warn(
        `${this.id}: ${instId} ${timeframe} stopped at ${loaded.truncated.reason} before reaching ` +
          'the range start — oldest bars are missing',
      );
    }
    return loaded.bars;
  }

  async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const capabilities = snapshotHistoryCapabilities({
      timeframes: [...OKX_EXACT_TIMEFRAMES],
      maxBarsPerRequest: CANDLE_LIMIT,
      maxBarsPerAcquisition: this.maxBars,
      alignment: 'utc-24x7',
      weekAnchorSec: OKX_WEEK_ANCHOR_SEC,
    });
    const cacheIdentity = createHistoryCacheIdentity(this.id, {
      symbol: normalizedSymbol,
      market: this.market,
      baseUrl: nonSecretBaseUrl(this.baseUrl),
      maxBarsPolicy: {
        configured: this.configuredMaxBars,
        effective: this.maxBars,
        pageCapacity: MAX_PAGE_CAPACITY,
      },
      maxPages: MAX_PAGES,
      recentPageSize: CANDLE_LIMIT,
      historyPageSize: HISTORY_CANDLE_LIMIT,
      pagination: 'newest-first',
      exactUtcBars: true,
      capabilities,
    });

    return snapshotResolvedHistorySource({
      provider: this,
      normalizedSymbol,
      cacheIdentity,
      capabilities,
      history: async (request: HistoryRequest): Promise<HistoryAcquisition> => {
        if (
          capabilities.timeframes !== 'arbitrary' &&
          !capabilities.timeframes.includes(request.timeframe)
        ) {
          throw new Error(`okx: unsupported exact timeframe "${request.timeframe}"`);
        }
        const loaded = await this.loadHistory(
          normalizedSymbol,
          request.timeframe,
          historyRequestRange(request),
          true,
        );
        return historyAcquisitionFromBars({
          bars: loaded.bars,
          request,
          cacheIdentity,
          normalizedSymbol,
          alignment: capabilities.alignment,
          weekAnchorSec: capabilities.weekAnchorSec,
          truncated: loaded.truncated,
        });
      },
    });
  }

  /** lotSz → minQty, tickSz → mintick from /public/instruments. SWAP quantities
   *  are denominated in CONTRACTS; the engine sizes in base units, so the swap
   *  lot step converts via the contract value: minQty = lotSz × ctVal. */
  async instrument(symbol: string): Promise<InstrumentInfo | undefined> {
    const instId = this.normalizeSymbol(symbol);
    const url = new URL('/api/v5/public/instruments', this.baseUrl);
    url.searchParams.set('instType', this.market === 'swap' ? 'SWAP' : 'SPOT');
    url.searchParams.set('instId', instId);
    const payload = await fetchJson<{
      code?: string;
      data?: Array<{ lotSz?: string; tickSz?: string; ctVal?: string }>;
    }>(url.toString(), { label: 'okx /public/instruments', fetchImpl: this.fetchImpl });
    const row = payload?.data?.[0];
    if (!row) return undefined;
    const lotSz = Number(row.lotSz);
    const ctVal = this.market === 'swap' ? Number(row.ctVal) : 1;
    const tickSz = Number(row.tickSz);
    const minQty = lotSz * (Number.isFinite(ctVal) && ctVal > 0 ? ctVal : 1);
    return {
      ...(Number.isFinite(minQty) && minQty > 0 ? { minQty } : {}),
      ...(Number.isFinite(tickSz) && tickSz > 0 ? { mintick: tickSz } : {}),
    };
  }

  private normalizeSymbol(symbol: string): string {
    return this.market === 'swap' ? normalizeOkxSwap(symbol) : normalizeOkxSpot(symbol);
  }

  private async loadHistory(
    instId: string,
    timeframe: string,
    range: HistoryRange | undefined,
    exactUtc: boolean,
  ): Promise<LoadedHistory> {
    const bar = toOkxBar(timeframe, exactUtc);
    const exactRangeMs = exactUtc && range ? boundedHistoryRangeToHalfOpenMs(range) : undefined;
    const startMs = exactRangeMs?.from ?? (range?.from != null ? range.from * 1000 : 0);
    const endMs = range?.to != null ? range.to * 1000 : Date.now();
    const target = Math.min(range?.limit ?? this.maxBars, this.maxBars);
    if (target <= 0) return { bars: [] };

    const rows: OkxCandle[] = [];
    const seen = new Set<number>();
    let after = exactRangeMs?.to ?? endMs + 1; // `after` returns rows strictly older than the value
    let useHistory = false;
    let pages = 0;
    let oldestAccepted: number | undefined;
    let stoppedByMaxBars = false;
    let exhausted = false;

    while (rows.length < target && pages < MAX_PAGES) {
      pages++;
      const perPage = useHistory ? HISTORY_CANDLE_LIMIT : CANDLE_LIMIT;
      // Ask for one spare when possible because the newest row may be unconfirmed.
      const limit = Math.min(perPage, target - rows.length + 1);
      const path = useHistory ? '/api/v5/market/history-candles' : '/api/v5/market/candles';
      const batch = await this.fetchCandles(path, { instId, bar, after, limit });

      if (batch.length === 0) {
        if (!useHistory) {
          useHistory = true;
          continue;
        }
        exhausted = true;
        break;
      }

      for (const row of batch) {
        if (row[8] === '0') continue; // in-progress candle — incomplete OHLCV
        const ts = Number(row[0]);
        if (!Number.isFinite(ts) || seen.has(ts)) continue;
        seen.add(ts);
        if (rows.length < target) {
          rows.push(row);
          oldestAccepted = oldestAccepted == null ? ts : Math.min(oldestAccepted, ts);
        }
      }

      const oldest = Number(batch[batch.length - 1]![0]);
      if (rows.length >= target) {
        const providerSafetyCap = range?.limit == null || range.limit >= this.maxBars;
        const reachedStart = oldestAccepted != null && oldestAccepted <= startMs;
        if (range?.from != null && providerSafetyCap && !reachedStart) {
          stoppedByMaxBars = true;
        } else {
          exhausted = true;
        }
        break;
      }
      if (!Number.isFinite(oldest) || oldest <= startMs) {
        exhausted = true;
        break;
      }
      after = oldest;
      if (batch.length < limit) {
        if (!useHistory) {
          useHistory = true;
          continue;
        }
        exhausted = true;
        break;
      }
    }

    const missingBefore =
      range?.from != null && (oldestAccepted == null || oldestAccepted > startMs);
    const truncated =
      missingBefore && stoppedByMaxBars
        ? ({
            side: 'before',
            reason: 'okx-max-bars',
            limit: this.maxBars,
          } satisfies HistoryTruncation)
        : missingBefore && !exhausted && pages >= MAX_PAGES
          ? ({
              side: 'before',
              reason: 'okx-max-pages',
              limit: MAX_PAGES,
            } satisfies HistoryTruncation)
          : undefined;

    const bars = rows
      .map((row) => toBar(row, exactUtc))
      .filter((value): value is Bar => value !== null)
      .sort((a, b) => a.time - b.time);
    return {
      bars: exactUtc
        ? applyExactQueryRange(dropClosedBars(bars, timeframe), range)
        : applyRange(dropClosedBars(bars, timeframe), range),
      ...(truncated ? { truncated } : {}),
    };
  }

  private async fetchCandles(
    path: string,
    params: { instId: string; bar: string; after: number; limit: number },
  ): Promise<OkxCandle[]> {
    const url = new URL(path, this.baseUrl);
    url.searchParams.set('instId', params.instId);
    url.searchParams.set('bar', params.bar);
    url.searchParams.set('after', String(params.after));
    url.searchParams.set('limit', String(params.limit));
    const payload = await fetchJson<{ code?: string; msg?: string; data?: unknown }>(
      url.toString(),
      {
        label: `okx ${path}`,
        fetchImpl: this.fetchImpl,
      },
    );
    if (payload && payload.code !== undefined && payload.code !== '0') {
      throw new Error(`okx ${path}: (${payload.code}) ${payload.msg ?? 'unknown error'}`);
    }
    return Array.isArray(payload?.data) ? (payload.data as OkxCandle[]) : [];
  }
}

/** Map a canonical timeframe to OKX's `bar` string. Exact loads select UTC variants. */
function toOkxBar(tf: Timeframe, exactUtc = false): string {
  if (tf.trim() === '1s') return '1s';
  const { n, unit } = parseTimeframe(tf);
  switch (unit) {
    case 'm':
      return `${n}m`;
    case 'h':
      return exactUtc && (n === 6 || n === 12) ? `${n}Hutc` : `${n}H`;
    case 'd':
      return `${n}Dutc`;
    case 'w':
      return `${n}Wutc`;
    case 'M':
      return `${n}Mutc`;
    default:
      throw new Error(`okx: unsupported timeframe "${tf}"`);
  }
}

function dropClosedBars(bars: Bar[], timeframe: string): Bar[] {
  if (timeframe !== '1s') return dropUnclosedBars(bars, timeframe);
  const nowSec = Math.floor(Date.now() / 1000);
  let end = bars.length;
  while (end > 0 && bars[end - 1]!.time + 1 > nowSec) end--;
  return end === bars.length ? bars : bars.slice(0, end);
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return limit;
}

function toBar(candle: OkxCandle, exactTimestamps = false): Bar | null {
  const ms = Number(candle[0]);
  if (!Number.isFinite(ms)) return null;
  const bar: Bar = {
    time: exactTimestamps ? ms / 1000 : Math.floor(ms / 1000),
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: Number(candle[5]),
  };
  return [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ? bar : null;
}
