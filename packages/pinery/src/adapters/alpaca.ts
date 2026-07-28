/*
 * Alpaca provider — US equities bars via the Alpaca Market Data v2 REST API.
 * Requires an API key id + secret (data plan). Pages in descending order via
 * `next_page_token`; hitting the acquisition cap therefore truncates before.
 *
 * Credentials come from constructor options, falling back to the
 * `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` env vars in Node.
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
} from '../provider.js';
import { parseTimeframe, timeframeSeconds, type Timeframe } from '../timeframe.js';
import { fetchJson, envVar } from '../http.js';
import {
  createHistoryCacheIdentity,
  historyAcquisitionFromBars,
  nonSecretBaseUrl,
  snapshotHistoryCapabilities,
  snapshotResolvedHistorySource,
} from '../coverage.js';

const PAGE_LIMIT = 10_000;
const DEFAULT_MAX_BARS = 50_000;
const ALPACA_EXACT_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;

export interface AlpacaProviderOptions {
  /** Alpaca API key id. Falls back to env ALPACA_API_KEY_ID. */
  keyId?: string;
  /** Alpaca secret key. Falls back to env ALPACA_API_SECRET_KEY. */
  secretKey?: string;
  /** Data feed: 'iex' (free) or 'sip' (paid). Default 'iex'. */
  feed?: 'iex' | 'sip';
  /** Corporate-action adjustment. Default 'split' (split-adjusted, matching the
   *  Massive/Polygon adapter's `adjusted: true` default so the same equity gives
   *  the same series across providers). */
  adjustment?: 'raw' | 'split' | 'dividend' | 'all';
  /** Maximum bars across descending pages. Default 50_000. */
  maxBars?: number;
  /** Override the data base. Default https://data.alpaca.markets */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

interface LoadedHistory {
  readonly bars: Bar[];
  readonly truncated?: HistoryTruncation;
}

export class AlpacaProvider implements HistoryProvider {
  readonly id = 'alpaca';
  readonly assetClass = 'equities' as const;
  private readonly keyId: string;
  private readonly secretKey: string;
  private readonly feed: 'iex' | 'sip';
  private readonly adjustment: 'raw' | 'split' | 'dividend' | 'all';
  private readonly maxBars: number;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: AlpacaProviderOptions = {}) {
    this.keyId = opts.keyId ?? envVar('ALPACA_API_KEY_ID') ?? '';
    this.secretKey = opts.secretKey ?? envVar('ALPACA_API_SECRET_KEY') ?? '';
    this.feed = opts.feed ?? 'iex';
    this.adjustment = opts.adjustment ?? 'split';
    this.maxBars = positiveLimit(opts.maxBars, DEFAULT_MAX_BARS, 'alpaca maxBars');
    this.baseUrl = (opts.baseUrl ?? 'https://data.alpaca.markets').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    return (await this.loadHistory(normalizeEquitySymbol(symbol), timeframe, range)).bars;
  }

  async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
    const normalizedSymbol = normalizeEquitySymbol(symbol);
    const capabilities = snapshotHistoryCapabilities({
      timeframes: [...ALPACA_EXACT_TIMEFRAMES],
      maxBarsPerRequest: PAGE_LIMIT,
      maxBarsPerAcquisition: this.maxBars,
      // Without versioned exchange-session metadata, exact coverage must fail closed.
      alignment: 'unknown',
    });
    const cacheIdentity = createHistoryCacheIdentity(this.id, {
      symbol: normalizedSymbol,
      baseUrl: nonSecretBaseUrl(this.baseUrl),
      feed: this.feed,
      adjustment: this.adjustment,
      maxBars: this.maxBars,
      maxBarsPerRequest: PAGE_LIMIT,
      pagination: 'descending-page-token',
      capabilities,
    });

    return snapshotResolvedHistorySource({
      provider: this,
      normalizedSymbol,
      cacheIdentity,
      capabilities,
      history: async (request: HistoryRequest): Promise<HistoryAcquisition> => {
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
          truncated: loaded.truncated,
        });
      },
    });
  }

  /** US equities: whole-share lot step (TV's margin-call step-9 truncates stock
   *  quantities to whole shares — its own TSLA worked example), one-cent tick. */
  async instrument(_symbol: string): Promise<InstrumentInfo | undefined> {
    return { minQty: 1, mintick: 0.01 };
  }

  private async loadHistory(
    symbol: string,
    timeframe: string,
    range?: HistoryRange,
    exactTimestamps = false,
  ): Promise<LoadedHistory> {
    if (!this.keyId || !this.secretKey) {
      throw new Error(
        'alpaca: missing credentials (set keyId/secretKey or ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY)',
      );
    }
    const tf = toAlpacaTimeframe(timeframe);
    const exactRangeMs =
      exactTimestamps && range ? boundedHistoryRangeToHalfOpenMs(range) : undefined;
    const { startSec, endSec } = deriveWindow(range, timeframe);
    const headers = { 'APCA-API-KEY-ID': this.keyId, 'APCA-API-SECRET-KEY': this.secretKey };
    const out: Bar[] = [];
    let pageToken: string | undefined;
    let truncated = false;

    do {
      const remaining = this.maxBars - out.length;
      if (remaining <= 0) {
        truncated = Boolean(pageToken);
        break;
      }
      const url = new URL(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, this.baseUrl);
      url.searchParams.set('timeframe', tf);
      url.searchParams.set('start', new Date(exactRangeMs?.from ?? startSec * 1000).toISOString());
      url.searchParams.set('end', new Date(exactRangeMs?.to ?? endSec * 1000).toISOString());
      url.searchParams.set('limit', String(Math.min(PAGE_LIMIT, remaining)));
      url.searchParams.set('adjustment', this.adjustment);
      url.searchParams.set('feed', this.feed);
      url.searchParams.set('sort', 'desc');
      if (pageToken) url.searchParams.set('page_token', pageToken);

      const data = await fetchJson<{ bars?: AlpacaBar[]; next_page_token?: string | null }>(
        url.toString(),
        {
          label: 'alpaca /bars',
          headers,
          fetchImpl: this.fetchImpl,
        },
      );
      const page = (data.bars ?? [])
        .map((bar) => toBar(bar, exactTimestamps))
        .filter((bar): bar is Bar => bar !== null)
        .sort((a, b) => b.time - a.time);
      const accepted = page.slice(0, remaining);
      out.push(...accepted);
      pageToken = data.next_page_token ?? undefined;
      if (accepted.length < page.length || (pageToken && out.length >= this.maxBars)) {
        truncated = true;
        break;
      }
    } while (pageToken);

    const materialized = dropUnclosedBars(
      out.sort((a, b) => a.time - b.time),
      timeframe,
    );
    const bars = exactTimestamps
      ? applyExactQueryRange(materialized, range)
      : applyRange(materialized, range);
    const truncation = truncated
      ? ({
          side: 'before',
          reason: 'alpaca-max-bars',
          limit: this.maxBars,
        } satisfies HistoryTruncation)
      : undefined;
    return { bars, ...(truncation ? { truncated: truncation } : {}) };
  }
}

function normalizeEquitySymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) throw new Error('alpaca: cannot normalize empty symbol');
  return normalized;
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return limit;
}

function toAlpacaTimeframe(tf: Timeframe): string {
  const { n, unit } = parseTimeframe(tf);
  switch (unit) {
    case 'm':
      return `${n}Min`;
    case 'h':
      return `${n}Hour`;
    case 'd':
      return `${n}Day`;
    case 'w':
      return `${n}Week`;
    default:
      throw new Error(`alpaca: unsupported timeframe "${tf}"`);
  }
}

/** Alpaca requires start/end; when no range is given, derive a window covering ~`limit` bars. */
function deriveWindow(
  range: HistoryRange | undefined,
  timeframe: Timeframe,
): { startSec: number; endSec: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = range?.to ?? nowSec;
  if (range?.from != null) return { startSec: range.from, endSec };
  const limit = range?.limit ?? 500;
  const tfSec = timeframeSeconds(timeframe);
  const { unit } = parseTimeframe(timeframe);
  // Equities trade < 24/7, so pad the window: ~4x for intraday, ~2x for daily+.
  const pad = unit === 'm' || unit === 'h' ? 4 : 2;
  const span = Math.max(limit * tfSec * pad, 7 * 86400);
  return { startSec: endSec - span, endSec };
}

function toBar(bar: AlpacaBar, exactTimestamps = false): Bar | null {
  const ms = Date.parse(bar.t);
  if (!Number.isFinite(ms)) return null;
  const parsed: Bar = {
    time: exactTimestamps ? ms / 1000 : Math.floor(ms / 1000),
    open: Number(bar.o),
    high: Number(bar.h),
    low: Number(bar.l),
    close: Number(bar.c),
    volume: Number(bar.v ?? 0),
  };
  return [parsed.open, parsed.high, parsed.low, parsed.close].every(Number.isFinite)
    ? parsed
    : null;
}
