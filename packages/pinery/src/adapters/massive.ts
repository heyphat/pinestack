/**
 * Massive provider — US equities aggregates via the Massive REST API
 * (Polygon-compatible `/v2/aggs` endpoint). Requires an API key.
 *
 * The key comes from the constructor option, falling back to the `MASSIVE_API_KEY`
 * env var in Node. Called directly over REST so pinery stays dependency-free
 * (fractal-chart uses the @massive.com/client-js SDK; the wire format is the same).
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

const MAX_BARS = 50_000;

export interface MassiveProviderOptions {
  /** Massive API key. Falls back to env MASSIVE_API_KEY. */
  apiKey?: string;
  /** Split-adjust aggregates. Default true (matches the Alpaca adapter's
   *  `adjustment: 'split'` default so providers agree across splits). */
  adjusted?: boolean;
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

export class MassiveProvider implements HistoryProvider {
  readonly id = 'massive';
  readonly assetClass = 'equities' as const;
  private readonly apiKey: string;
  private readonly adjusted: boolean;
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;

  constructor(opts: MassiveProviderOptions = {}) {
    this.apiKey = opts.apiKey ?? envVar('MASSIVE_API_KEY') ?? '';
    this.adjusted = opts.adjusted ?? true;
    this.baseUrl = (opts.baseUrl ?? 'https://api.massive.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    if (!this.apiKey) {
      throw new Error('massive: missing API key (set apiKey or MASSIVE_API_KEY)');
    }
    const sym = symbol.trim().toUpperCase();
    const { multiplier, timespan } = toMassiveSpan(timeframe);
    const { fromMs, toMs } = deriveWindow(range, timeframe);

    const url = new URL(
      `/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${multiplier}/${timespan}/${fromMs}/${toMs}`,
      this.baseUrl,
    );
    url.searchParams.set('adjusted', String(this.adjusted));
    url.searchParams.set('sort', 'asc');
    url.searchParams.set('limit', String(MAX_BARS));

    const data = await fetchJson<{ results?: MassiveAgg[] }>(url.toString(), {
      label: 'massive /aggs',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      fetchImpl: this.fetchImpl,
    });

    const bars = (data.results ?? [])
      .map(toBar)
      .filter((b): b is Bar => b !== null)
      .sort((a, b) => a.time - b.time);
    return applyRange(dropUnclosedBars(bars, timeframe), range);
  }
  /** US equities: whole-share lot step (TV's margin-call step-9 truncates stock
   *  quantities to whole shares — its own TSLA worked example), one-cent tick. */
  async instrument(_symbol: string): Promise<InstrumentInfo | undefined> {
    return { minQty: 1, mintick: 0.01 };
  }
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

function toBar(a: MassiveAgg): Bar | null {
  if (a.t == null) return null;
  const bar: Bar = {
    time: Math.floor(a.t / 1000),
    open: Number(a.o),
    high: Number(a.h),
    low: Number(a.l),
    close: Number(a.c),
    volume: Number(a.v ?? 0),
  };
  return [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite) ? bar : null;
}
