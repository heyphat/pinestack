/**
 * Binance provider — Spot and USDⓈ-M Futures public klines. Keyless REST, so it
 * works in the browser and Node with no credentials. Pages through `startTime`
 * when a range is given; otherwise returns the most-recent `limit` bars.
 *
 * Canonical pinery timeframes map 1:1 onto Binance intervals.
 */
import type { Bar, InstrumentInfo } from '../provider.js';
import { dropUnclosedBars, type HistoryProvider, type HistoryRange } from '../provider.js';
import type { AssetClass } from '../asset-class.js';
import { timeframeSeconds } from '../timeframe.js';
import { fetchJson } from '../http.js';

const BINANCE_INTERVALS = new Set([
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
  '1M',
]);

const MAX_PER_REQUEST = 1000;

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

export class BinanceProvider implements HistoryProvider {
  readonly id: string;
  readonly assetClass: AssetClass;
  private readonly baseUrl: string;
  private readonly klinesPath: string;
  private readonly maxBars: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: BinanceProviderOptions = {}) {
    const market: BinanceMarket = opts.market ?? 'spot';
    this.id = market === 'futures' ? 'binance-futures' : 'binance';
    this.assetClass = market === 'futures' ? 'futures' : 'crypto';
    const defaultBase =
      market === 'futures' ? 'https://fapi.binance.com' : 'https://api.binance.com';
    this.baseUrl = (opts.baseUrl ?? defaultBase).replace(/\/$/, '');
    this.klinesPath = market === 'futures' ? '/fapi/v1/klines' : '/api/v3/klines';
    this.maxBars = opts.maxBars ?? 50_000;
    this.fetchImpl = opts.fetchImpl;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    if (!BINANCE_INTERVALS.has(timeframe)) {
      throw new Error(`binance: unsupported interval "${timeframe}"`);
    }
    const sym = symbol.trim().toUpperCase().replace(/\//g, '');
    const stepMs = timeframeSeconds(timeframe) * 1000;

    // No lower bound → "the most-recent N bars (before `to`)": page BACKWARDS via
    // endTime so a limit above Binance's 1000-per-request cap is honored instead
    // of silently truncated to one page.
    if (range?.from == null) {
      const target = Math.min(range?.limit ?? 500, this.maxBars);
      let endMs = range?.to != null ? range.to * 1000 : undefined;
      const out: Bar[] = [];
      while (out.length < target) {
        const perPage = Math.min(MAX_PER_REQUEST, target - out.length);
        const klines = await this.fetchKlines(sym, timeframe, { endTime: endMs, limit: perPage });
        if (klines.length === 0) break;
        for (const k of klines) out.push(toBar(k));
        endMs = klines[0]![0] - 1; // next page ends just before this page's oldest open
        if (klines.length < perPage) break;
      }
      let bars = dropUnclosedBars(dedupeAscending(out), timeframe);
      if (bars.length > target) bars = bars.slice(bars.length - target);
      return bars;
    }

    const endMs = range.to != null ? range.to * 1000 : Date.now();
    let startMs = range.from * 1000;

    const out: Bar[] = [];
    let truncated = false;
    while (startMs <= endMs) {
      if (out.length >= this.maxBars) {
        truncated = true;
        break;
      }
      const klines = await this.fetchKlines(sym, timeframe, {
        startTime: startMs,
        endTime: endMs,
        limit: MAX_PER_REQUEST,
      });
      if (klines.length === 0) break;
      for (const k of klines) out.push(toBar(k));
      const lastOpen = klines[klines.length - 1]![0];
      const next = lastOpen + stepMs;
      if (next <= startMs) break;
      startMs = next;
      if (klines.length < MAX_PER_REQUEST) break;
    }
    if (truncated) {
      console.warn(
        `${this.id}: ${sym} ${timeframe} range hit the ${this.maxBars}-bar safety cap — ` +
          `newest bars in the range were NOT fetched (raise maxBars or narrow the range)`,
      );
    }

    let bars = dropUnclosedBars(dedupeAscending(out), timeframe);
    if (range.limit != null && bars.length > range.limit)
      bars = bars.slice(bars.length - range.limit);
    return bars;
  }

  private async fetchKlines(
    symbol: string,
    interval: string,
    params: { startTime?: number; endTime?: number; limit?: number },
  ): Promise<Kline[]> {
    const url = new URL(this.klinesPath, this.baseUrl);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    if (params.startTime != null) url.searchParams.set('startTime', String(params.startTime));
    if (params.endTime != null) url.searchParams.set('endTime', String(params.endTime));
    if (params.limit != null) url.searchParams.set('limit', String(params.limit));
    return fetchJson<Kline[]>(url.toString(), {
      label: `${this.id} /klines`,
      fetchImpl: this.fetchImpl,
    });
  }

  /** Per-instance memo of exchangeInfo lookups — a scan over N symbols fetches
   *  the (unfiltered, ~MB-sized on futures) endpoint once, not N times. */
  private instruments?: Promise<Map<string, InstrumentInfo>>;

  /** LOT_SIZE.stepSize → minQty, PRICE_FILTER.tickSize → mintick, from
   *  exchangeInfo. Spot supports a per-symbol query; USDⓈ-M futures does not,
   *  so both markets fetch the full map once and answer from the memo. */
  async instrument(symbol: string): Promise<InstrumentInfo | undefined> {
    const sym = symbol.trim().toUpperCase().replace(/\//g, '');
    this.instruments ??= this.fetchInstruments();
    try {
      return (await this.instruments).get(sym);
    } catch (err) {
      this.instruments = undefined; // don't memoize a transient failure
      throw err;
    }
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

function toBar(k: Kline): Bar {
  return {
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  };
}

function dedupeAscending(bars: Bar[]): Bar[] {
  bars.sort((a, b) => a.time - b.time);
  const out: Bar[] = [];
  let last = -1;
  for (const b of bars) {
    if (b.time !== last) {
      out.push(b);
      last = b.time;
    }
  }
  return out;
}
