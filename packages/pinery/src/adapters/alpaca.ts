/**
 * Alpaca provider — US equities bars via the Alpaca Market Data v2 REST API.
 * Requires an API key id + secret (data plan). Pages via `next_page_token`.
 *
 * Credentials come from constructor options, falling back to the
 * `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` env vars in Node.
 */
import type { Bar, InstrumentInfo } from '../provider.js';
import {
  applyRange,
  dropUnclosedBars,
  type HistoryProvider,
  type HistoryRange,
} from '../provider.js';
import { parseTimeframe, timeframeSeconds, type Timeframe } from '../timeframe.js';
import { fetchJson, envVar } from '../http.js';

const PAGE_LIMIT = 10_000;
const MAX_TOTAL_BARS = 50_000;

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

export class AlpacaProvider implements HistoryProvider {
  readonly id = 'alpaca';
  readonly assetClass = 'equities' as const;
  private readonly keyId: string;
  private readonly secretKey: string;
  private readonly feed: 'iex' | 'sip';
  private readonly adjustment: 'raw' | 'split' | 'dividend' | 'all';
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: AlpacaProviderOptions = {}) {
    this.keyId = opts.keyId ?? envVar('ALPACA_API_KEY_ID') ?? '';
    this.secretKey = opts.secretKey ?? envVar('ALPACA_API_SECRET_KEY') ?? '';
    this.feed = opts.feed ?? 'iex';
    this.adjustment = opts.adjustment ?? 'split';
    this.baseUrl = (opts.baseUrl ?? 'https://data.alpaca.markets').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    if (!this.keyId || !this.secretKey) {
      throw new Error(
        'alpaca: missing credentials (set keyId/secretKey or ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY)',
      );
    }
    const sym = symbol.trim().toUpperCase();
    const tf = toAlpacaTimeframe(timeframe);
    const { startSec, endSec } = deriveWindow(range, timeframe);

    const headers = { 'APCA-API-KEY-ID': this.keyId, 'APCA-API-SECRET-KEY': this.secretKey };
    const out: Bar[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(`/v2/stocks/${encodeURIComponent(sym)}/bars`, this.baseUrl);
      url.searchParams.set('timeframe', tf);
      url.searchParams.set('start', new Date(startSec * 1000).toISOString());
      url.searchParams.set('end', new Date(endSec * 1000).toISOString());
      url.searchParams.set('limit', String(PAGE_LIMIT));
      url.searchParams.set('adjustment', this.adjustment);
      url.searchParams.set('feed', this.feed);
      if (pageToken) url.searchParams.set('page_token', pageToken);

      const data = await fetchJson<{ bars?: AlpacaBar[]; next_page_token?: string | null }>(
        url.toString(),
        {
          label: 'alpaca /bars',
          headers,
          fetchImpl: this.fetchImpl,
        },
      );
      for (const b of data.bars ?? []) {
        const bar = toBar(b);
        if (bar) out.push(bar);
      }
      pageToken = data.next_page_token ?? undefined;
    } while (pageToken && out.length < MAX_TOTAL_BARS);

    out.sort((a, b) => a.time - b.time);
    return applyRange(dropUnclosedBars(out, timeframe), range);
  }
  /** US equities: whole-share lot step (TV's margin-call step-9 truncates stock
   *  quantities to whole shares — its own TSLA worked example), one-cent tick. */
  async instrument(_symbol: string): Promise<InstrumentInfo | undefined> {
    return { minQty: 1, mintick: 0.01 };
  }
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

function toBar(b: AlpacaBar): Bar | null {
  const ms = Date.parse(b.t);
  if (!Number.isFinite(ms)) return null;
  const bar: Bar = {
    time: Math.floor(ms / 1000),
    open: Number(b.o),
    high: Number(b.h),
    low: Number(b.l),
    close: Number(b.c),
    volume: Number(b.v ?? 0),
  };
  return [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ? bar : null;
}
