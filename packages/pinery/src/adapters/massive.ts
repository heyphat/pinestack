/*
 * Massive provider — US equities aggregates via the Massive REST API
 * (Polygon-compatible `/v2/aggs` endpoint). Requires an API key. Results are
 * requested descending, so the one-request cap preserves newest coverage.
 *
 * The key comes from the constructor option, falling back to the `MASSIVE_API_KEY`
 * env var in Node. Called directly over REST so pinery stays dependency-free.
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

const MAX_PER_REQUEST = 50_000;
const DEFAULT_MAX_BARS = 50_000;
const MASSIVE_EXACT_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const;

export interface MassiveProviderOptions {
  /** Massive API key. Falls back to env MASSIVE_API_KEY. */
  apiKey?: string;
  /** Split-adjust aggregates. Default true (matches the Alpaca adapter's
   *  `adjustment: 'split'` default so providers agree across splits). */
  adjusted?: boolean;
  /** Maximum newest bars retained from the aggregate response. Default 50_000. */
  maxBars?: number;
  /** Override the REST base. Default https://api.massive.com */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface MassiveAgg {
  t?: number; // ms
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
}

interface LoadedHistory {
  readonly bars: Bar[];
  readonly truncated?: HistoryTruncation;
}

export class MassiveProvider implements HistoryProvider {
  readonly id = 'massive';
  readonly assetClass = 'equities' as const;
  private readonly apiKey: string;
  private readonly adjusted: boolean;
  private readonly configuredMaxBars: number;
  private readonly maxBars: number;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: MassiveProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? envVar('MASSIVE_API_KEY') ?? '';
    this.adjusted = opts.adjusted ?? true;
    this.configuredMaxBars = positiveLimit(opts.maxBars, DEFAULT_MAX_BARS, 'massive maxBars');
    this.maxBars = Math.min(this.configuredMaxBars, MAX_PER_REQUEST);
    this.baseUrl = (opts.baseUrl ?? 'https://api.massive.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    return (await this.loadHistory(normalizeEquitySymbol(symbol), timeframe, range)).bars;
  }

  async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
    const normalizedSymbol = normalizeEquitySymbol(symbol);
    const capabilities = snapshotHistoryCapabilities({
      timeframes: [...MASSIVE_EXACT_TIMEFRAMES],
      maxBarsPerRequest: MAX_PER_REQUEST,
      maxBarsPerAcquisition: this.maxBars,
      // Without versioned exchange-session metadata, exact coverage must fail closed.
      alignment: 'unknown',
    });
    const cacheIdentity = createHistoryCacheIdentity(this.id, {
      symbol: normalizedSymbol,
      baseUrl: nonSecretBaseUrl(this.baseUrl),
      adjusted: this.adjusted,
      maxBarsPolicy: {
        configured: this.configuredMaxBars,
        effective: this.maxBars,
        apiMaximum: MAX_PER_REQUEST,
      },
      sort: 'desc',
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
    if (!this.apiKey) {
      throw new Error('massive: missing API key (set apiKey or MASSIVE_API_KEY)');
    }
    const { multiplier, timespan } = toMassiveSpan(timeframe);
    const derivedWindow = deriveWindow(range, timeframe);
    const exactRangeMs =
      exactTimestamps && range ? boundedHistoryRangeToHalfOpenMs(range) : undefined;
    const fromMs = exactRangeMs?.from ?? derivedWindow.fromMs;
    const toMs = exactRangeMs != null ? exactRangeMs.to - 1 : derivedWindow.toMs;

    const url = new URL(
      `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${fromMs}/${toMs}`,
      this.baseUrl,
    );
    url.searchParams.set('adjusted', String(this.adjusted));
    url.searchParams.set('sort', 'desc');
    url.searchParams.set('limit', String(this.maxBars));

    const data = await fetchJson<{
      results?: MassiveAgg[];
      resultsCount?: number;
      next_url?: string;
    }>(url.toString(), {
      label: 'massive /aggs',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      fetchImpl: this.fetchImpl,
    });

    const allBars = (data.results ?? [])
      .map((aggregate) => toBar(aggregate, exactTimestamps))
      .filter((bar): bar is Bar => bar !== null)
      .sort((a, b) => b.time - a.time);
    const limitedBars = allBars.slice(0, this.maxBars).sort((a, b) => a.time - b.time);
    const hitCap =
      Boolean(data.next_url) ||
      (data.results?.length ?? 0) >= this.maxBars ||
      (data.resultsCount ?? 0) > this.maxBars;
    const truncation = hitCap
      ? ({
          side: 'before',
          reason: 'massive-max-bars',
          limit: this.maxBars,
        } satisfies HistoryTruncation)
      : undefined;

    const materialized = dropUnclosedBars(limitedBars, timeframe);
    return {
      bars: exactTimestamps
        ? applyExactQueryRange(materialized, range)
        : applyRange(materialized, range),
      ...(truncation ? { truncated: truncation } : {}),
    };
  }
}

function normalizeEquitySymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) throw new Error('massive: cannot normalize empty symbol');
  return normalized;
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return limit;
}

function toMassiveSpan(tf: Timeframe): { multiplier: number; timespan: string } {
  const { n, unit } = parseTimeframe(tf);
  switch (unit) {
    case 'm':
      return { multiplier: n, timespan: 'minute' };
    case 'h':
      return { multiplier: n, timespan: 'hour' };
    case 'd':
      return { multiplier: n, timespan: 'day' };
    case 'w':
      return { multiplier: n, timespan: 'week' };
    case 'M':
      return { multiplier: n, timespan: 'month' };
    default:
      throw new Error(`massive: unsupported timeframe "${tf}"`);
  }
}

/** Aggregates need a from/to path segment; derive a window covering ~`limit` bars when no range is given. */
function deriveWindow(
  range: HistoryRange | undefined,
  timeframe: Timeframe,
): { fromMs: number; toMs: number } {
  const nowSec = Math.floor(Date.now() / 1000);
  const endSec = range?.to ?? nowSec;
  const startSec =
    range?.from ??
    endSec - Math.max((range?.limit ?? 500) * timeframeSeconds(timeframe) * 2, 7 * 86400);
  return { fromMs: startSec * 1000, toMs: endSec * 1000 };
}

function toBar(aggregate: MassiveAgg, exactTimestamps = false): Bar | null {
  if (aggregate.t == null) return null;
  const bar: Bar = {
    time: exactTimestamps ? aggregate.t / 1000 : Math.floor(aggregate.t / 1000),
    open: Number(aggregate.o),
    high: Number(aggregate.h),
    low: Number(aggregate.l),
    close: Number(aggregate.c),
    volume: Number(aggregate.v ?? 0),
  };
  return [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ? bar : null;
}
