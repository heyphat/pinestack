/*
 * Binance provider — Spot and USDⓈ-M Futures public klines. Keyless REST, so it
 * works in the browser and Node with no credentials. Ranged loads page newest
 * to oldest so a safety cap preserves the newest coverage.
 *
 * Canonical pinery timeframes map 1:1 onto Binance intervals.
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
import type { AssetClass } from '../asset-class.js';
import { timeframeSeconds } from '../timeframe.js';
import { fetchJson } from '../http.js';
import {
  createHistoryCacheIdentity,
  historyAcquisitionFromBars,
  nonSecretBaseUrl,
  snapshotHistoryCapabilities,
  snapshotResolvedHistorySource,
} from '../coverage.js';

const BINANCE_COMMON_EXACT_TIMEFRAMES = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
] as const;
const BINANCE_SPOT_EXACT_TIMEFRAMES = ['1s', ...BINANCE_COMMON_EXACT_TIMEFRAMES] as const;

const BINANCE_INTERVALS = new Set<string>([...BINANCE_SPOT_EXACT_TIMEFRAMES, '1M']);
const MAX_PER_REQUEST = 1000;
const DEFAULT_MAX_BARS = 50_000;
/** Binance spot/futures 1w klines open Monday 00:00 UTC. */
const BINANCE_WEEK_ANCHOR_SEC = unixSecond(4 * 86_400);

export type BinanceMarket = 'spot' | 'futures';

export interface BinanceProviderOptions {
  /** 'spot' (api.binance.com) or 'futures' (USDⓈ-M perps, fapi.binance.com). Default 'spot'. */
  market?: BinanceMarket;
  /** Override the REST base (proxy, regional endpoint). Defaults per market. */
  baseUrl?: string;
  /** Safety cap on total bars fetched when paging a range. Default 50_000. */
  maxBars?: number;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

type Kline = [number, string, string, string, string, string, ...unknown[]];

interface LoadedHistory {
  readonly bars: Bar[];
  readonly truncated?: HistoryTruncation;
}

export class BinanceProvider implements HistoryProvider {
  readonly id: string;
  readonly assetClass: AssetClass;
  private readonly market: BinanceMarket;
  private readonly baseUrl: string;
  private readonly klinesPath: string;
  private readonly maxBars: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: BinanceProviderOptions = {}) {
    this.market = opts.market ?? 'spot';
    this.id = this.market === 'futures' ? 'binance-futures' : 'binance';
    this.assetClass = this.market === 'futures' ? 'futures' : 'crypto';
    const defaultBase =
      this.market === 'futures' ? 'https://fapi.binance.com' : 'https://api.binance.com';
    this.baseUrl = (opts.baseUrl ?? defaultBase).replace(/\/$/, '');
    this.klinesPath = this.market === 'futures' ? '/fapi/v1/klines' : '/api/v3/klines';
    this.maxBars = positiveLimit(opts.maxBars, DEFAULT_MAX_BARS, 'binance maxBars');
    this.fetchImpl = opts.fetchImpl;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const normalizedSymbol = normalizeBinanceSymbol(symbol);
    const loaded = await this.loadHistory(normalizedSymbol, timeframe, range);
    if (loaded.truncated) {
      console.warn(
        `${this.id}: ${normalizedSymbol} ${timeframe} range hit the ${loaded.truncated.limit}-bar ` +
          'safety cap — oldest bars in the range were not fetched (raise maxBars or narrow the range)',
      );
    }
    return loaded.bars;
  }

  async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
    const normalizedSymbol = normalizeBinanceSymbol(symbol);
    const exactTimeframes =
      this.market === 'spot' ? BINANCE_SPOT_EXACT_TIMEFRAMES : BINANCE_COMMON_EXACT_TIMEFRAMES;
    const capabilities = snapshotHistoryCapabilities({
      timeframes: [...exactTimeframes],
      maxBarsPerRequest: MAX_PER_REQUEST,
      maxBarsPerAcquisition: this.maxBars,
      alignment: 'utc-24x7',
      weekAnchorSec: BINANCE_WEEK_ANCHOR_SEC,
    });
    const cacheIdentity = createHistoryCacheIdentity(this.id, {
      symbol: normalizedSymbol,
      market: this.market,
      baseUrl: nonSecretBaseUrl(this.baseUrl),
      path: this.klinesPath,
      maxBars: this.maxBars,
      maxBarsPerRequest: MAX_PER_REQUEST,
      pagination: 'newest-first',
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
          weekAnchorSec: capabilities.weekAnchorSec,
          truncated: loaded.truncated,
        });
      },
    });
  }

  /** Per-instance memo of exchangeInfo lookups — a scan over N symbols fetches
   *  the (unfiltered, ~MB-sized on futures) endpoint once, not N times. */
  private instruments?: Promise<Map<string, InstrumentInfo>>;

  /** LOT_SIZE.stepSize → minQty, PRICE_FILTER.tickSize → mintick, from
   *  exchangeInfo. Spot supports a per-symbol query; USDⓈ-M futures does not,
   *  so both markets fetch the full map once and answer from the memo. */
  async instrument(symbol: string): Promise<InstrumentInfo | undefined> {
    const sym = normalizeBinanceSymbol(symbol);
    this.instruments ??= this.fetchInstruments();
    try {
      return (await this.instruments).get(sym);
    } catch (err) {
      this.instruments = undefined; // don't memoize a transient failure
      throw err;
    }
  }

  private async loadHistory(
    symbol: string,
    timeframe: string,
    range?: HistoryRange,
    exactTimestamps = false,
  ): Promise<LoadedHistory> {
    if (!BINANCE_INTERVALS.has(timeframe) || (timeframe === '1s' && this.market !== 'spot')) {
      throw new Error(`binance: unsupported interval "${timeframe}"`);
    }

    const stepMs = (timeframe === '1s' ? 1 : timeframeSeconds(timeframe)) * 1000;
    const exactRangeMs =
      exactTimestamps && range ? boundedHistoryRangeToHalfOpenMs(range) : undefined;
    const startMs = exactRangeMs?.from ?? (range?.from != null ? range.from * 1000 : undefined);
    let endMs =
      exactRangeMs != null ? exactRangeMs.to - 1 : range?.to != null ? range.to * 1000 : undefined;
    const defaultTarget = startMs == null ? 500 : this.maxBars;
    const target = Math.min(range?.limit ?? defaultTarget, this.maxBars);
    if (target <= 0) return { bars: [] };

    const out: Bar[] = [];
    let oldestFetched: number | undefined;
    while (out.length < target) {
      const perPage = Math.min(MAX_PER_REQUEST, target - out.length);
      const klines = await this.fetchKlines(symbol, timeframe, { endTime: endMs, limit: perPage });
      if (klines.length === 0) break;
      const accepted = klines.length > perPage ? klines.slice(klines.length - perPage) : klines;
      for (const kline of accepted) out.push(toBar(kline, exactTimestamps));

      const oldest = accepted[0]![0];
      oldestFetched = oldest;
      if (startMs != null && oldest <= startMs) break;
      const nextEnd = oldest - 1;
      if (endMs != null && nextEnd >= endMs) break;
      endMs = nextEnd;
      if (klines.length < perPage) break;
    }

    const providerSafetyCap = range?.limit == null || range.limit >= this.maxBars;
    const truncated =
      providerSafetyCap &&
      startMs != null &&
      out.length >= target &&
      oldestFetched != null &&
      oldestFetched > startMs
        ? ({
            side: 'before',
            reason: 'binance-max-bars',
            limit: this.maxBars,
          } satisfies HistoryTruncation)
        : undefined;

    const filteredBars = exactTimestamps
      ? applyExactQueryRange(dropClosedBars(dedupeAscending(out), timeframe), range)
      : applyRange(dropClosedBars(dedupeAscending(out), timeframe), range);
    return { bars: filteredBars, ...(truncated ? { truncated } : {}) };
  }

  private async fetchKlines(
    symbol: string,
    interval: string,
    params: { endTime?: number; limit?: number },
  ): Promise<Kline[]> {
    const url = new URL(this.klinesPath, this.baseUrl);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    if (params.endTime != null) url.searchParams.set('endTime', String(params.endTime));
    if (params.limit != null) url.searchParams.set('limit', String(params.limit));
    return fetchJson<Kline[]>(url.toString(), {
      label: `${this.id} /klines`,
      fetchImpl: this.fetchImpl,
    });
  }

  private async fetchInstruments(): Promise<Map<string, InstrumentInfo>> {
    const path = this.klinesPath.includes('/fapi/')
      ? '/fapi/v1/exchangeInfo'
      : '/api/v3/exchangeInfo';
    const data = await fetchJson<{
      symbols?: Array<{ symbol: string; filters?: Array<Record<string, string>> }>;
    }>(new URL(path, this.baseUrl).toString(), {
      label: `${this.id} /exchangeInfo`,
      fetchImpl: this.fetchImpl,
    });
    const map = new Map<string, InstrumentInfo>();
    for (const s of data.symbols ?? []) {
      const lot = s.filters?.find((f) => f.filterType === 'LOT_SIZE');
      const price = s.filters?.find((f) => f.filterType === 'PRICE_FILTER');
      const minQty = lot ? Number(lot.stepSize) : NaN;
      const mintick = price ? Number(price.tickSize) : NaN;
      map.set(s.symbol, {
        ...(Number.isFinite(minQty) && minQty > 0 ? { minQty } : {}),
        ...(Number.isFinite(mintick) && mintick > 0 ? { mintick } : {}),
      });
    }
    return map;
  }
}

function normalizeBinanceSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase().replace(/\//g, '');
  if (!normalized) throw new Error('binance: cannot normalize empty symbol');
  return normalized;
}

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return limit;
}

function toBar(k: Kline, exactTimestamps = false): Bar {
  return {
    time: exactTimestamps ? k[0] / 1000 : Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  };
}

function dropClosedBars(bars: Bar[], timeframe: string): Bar[] {
  if (timeframe !== '1s') return dropUnclosedBars(bars, timeframe);
  const nowSec = Math.floor(Date.now() / 1000);
  let end = bars.length;
  while (end > 0 && bars[end - 1]!.time + 1 > nowSec) end--;
  return end === bars.length ? bars : bars.slice(0, end);
}

function dedupeAscending(bars: Bar[]): Bar[] {
  bars.sort((a, b) => a.time - b.time);
  const out: Bar[] = [];
  let last: number | undefined;
  for (const bar of bars) {
    if (bar.time !== last) {
      out.push(bar);
      last = bar.time;
    }
  }
  return out;
}
