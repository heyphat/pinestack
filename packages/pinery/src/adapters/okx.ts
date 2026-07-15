/**
 * OKX provider — SPOT and SWAP (USDⓈ-margined perpetuals) candles via the keyless
 * OKX v5 REST API. Pages newest→oldest using the `after` cursor, falling through
 * from /market/candles (recent, 300/page) to /market/history-candles (deep, 100/page).
 */
import type { Bar, InstrumentInfo } from '../provider.js';
import {
  applyRange,
  dropUnclosedBars,
  type HistoryProvider,
  type HistoryRange,
} from '../provider.js';
import { parseTimeframe, type Timeframe } from '../timeframe.js';
import { fetchJson } from '../http.js';
import { normalizeOkxSpot, normalizeOkxSwap } from '../symbols.js';
import type { AssetClass } from '../asset-class.js';

const CANDLE_LIMIT = 300;
const HISTORY_CANDLE_LIMIT = 100;
const MAX_PAGES = 200;

export type OkxMarket = 'spot' | 'swap';

export interface OkxProviderOptions {
  /** 'spot' (default) or 'swap' (perpetual futures). */
  market?: OkxMarket;
  /** Override the REST base. Default https://www.okx.com */
  baseUrl?: string;
  maxBars?: number;
  fetchImpl?: typeof fetch;
}

// OKX candle row: [ts(ms), o, h, l, c, vol, volCcy, volCcyQuote, confirm].
// `ts` is a string of epoch millis; `confirm` is "0" while the candle is still forming.
type OkxCandle = [string, string, string, string, string, string, ...unknown[]];

export class OkxProvider implements HistoryProvider {
  readonly id: string;
  readonly assetClass: AssetClass;
  private readonly market: OkxMarket;
  private readonly baseUrl: string;
  private readonly maxBars: number;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: OkxProviderOptions = {}) {
    this.market = opts.market ?? 'spot';
    this.id = this.market === 'swap' ? 'okx-swap' : 'okx';
    this.assetClass = this.market === 'swap' ? 'futures' : 'crypto';
    this.baseUrl = (opts.baseUrl ?? 'https://www.okx.com').replace(/\/$/, '');
    this.maxBars = opts.maxBars ?? 50_000;
    this.fetchImpl = opts.fetchImpl;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const instId = this.market === 'swap' ? normalizeOkxSwap(symbol) : normalizeOkxSpot(symbol);
    const bar = toOkxBar(timeframe);

    const startMs = range?.from != null ? range.from * 1000 : 0;
    const endMs = range?.to != null ? range.to * 1000 : Date.now();
    const target = range?.limit ?? this.maxBars;

    const rows: OkxCandle[] = [];
    const seen = new Set<number>();
    let after = endMs + 1; // `after` returns rows strictly older than the value
    let useHistory = false;
    let pages = 0;

    while (rows.length < target && pages < MAX_PAGES) {
      pages++;
      const perPage = useHistory ? HISTORY_CANDLE_LIMIT : CANDLE_LIMIT;
      const limit = Math.min(perPage, target - rows.length + 1);
      const path = useHistory ? '/api/v5/market/history-candles' : '/api/v5/market/candles';
      const batch = await this.fetchCandles(path, { instId, bar, after, limit });

      if (batch.length === 0) {
        if (!useHistory) {
          useHistory = true;
          continue;
        }
        break;
      }
      for (const row of batch) {
        if (row[8] === '0') continue; // in-progress candle — incomplete OHLCV
        const ts = Number(row[0]);
        if (Number.isFinite(ts) && !seen.has(ts)) {
          seen.add(ts);
          rows.push(row);
        }
      }
      const oldest = Number(batch[batch.length - 1]![0]);
      if (!Number.isFinite(oldest) || oldest <= startMs) break;
      after = oldest;
      if (batch.length < limit) {
        if (!useHistory) {
          useHistory = true;
          continue;
        }
        break;
      }
    }
    if (pages >= MAX_PAGES && rows.length < target && after > startMs) {
      console.warn(
        `${this.id}: ${instId} ${bar} paged ${MAX_PAGES} times without reaching the range start — ` +
          `oldest bars are missing (narrow the range or reduce the requested depth)`,
      );
    }

    const bars = rows
      .map(toBar)
      .filter((b): b is Bar => b !== null)
      .sort((a, b) => a.time - b.time);
    return applyRange(dropUnclosedBars(bars, timeframe), range);
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

  /** lotSz → minQty, tickSz → mintick from /public/instruments. SWAP quantities
   *  are denominated in CONTRACTS; the engine sizes in base units, so the swap
   *  lot step converts via the contract value: minQty = lotSz × ctVal. */
  async instrument(symbol: string): Promise<InstrumentInfo | undefined> {
    const instId = this.market === 'swap' ? normalizeOkxSwap(symbol) : normalizeOkxSpot(symbol);
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
}

/** Map a canonical timeframe to OKX's `bar` string (UTC-aligned for day/week). */
function toOkxBar(tf: Timeframe): string {
  const { n, unit } = parseTimeframe(tf);
  switch (unit) {
    case 'm':
      return `${n}m`;
    case 'h':
      return `${n}H`;
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

function toBar(c: OkxCandle): Bar | null {
  const ms = Number(c[0]);
  if (!Number.isFinite(ms)) return null;
  const bar: Bar = {
    time: Math.floor(ms / 1000),
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5]),
  };
  return [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ? bar : null;
}
