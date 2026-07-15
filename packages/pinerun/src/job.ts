/**
 * The unit of work. A `Job` is a pure description of one piner run:
 * `(source, symbol, timeframe, bars, inputs)`. It is fully serializable so it can
 * cross a worker boundary — note we carry the Pine *source string*, never a
 * compiled script (compiled bodies are functions and can't be structured-cloned).
 */
import type { Bar } from '@heyphat/pinery';

export type { Bar };

export interface Job {
  /** Stable id for this job (defaults to `${symbol}@${timeframe}` when omitted). */
  id?: string;
  /** Pine v6 source. */
  source: string;
  symbol: string;
  /** piner timeframe label (see pinery `toPinerTimeframe`). */
  timeframe: string;
  /** OHLCV bars to run against (ascending by time). */
  bars: Bar[];
  /** Input overrides keyed by input title. */
  inputs?: Record<string, unknown>;
  /** Instrument tick size (defaults to 0.01). */
  mintick?: number;
  /** Instrument minimum quantity step (lot step). Configures the broker's
   *  TV-parity quantity truncation (derived order sizes, margin-call
   *  liquidations). Unset → piner's default (0.001). */
  minQty?: number;
  /** Which piner backend to use. Default 'js'. */
  backend?: 'js' | 'interp';
  /** Attach the full trade ledger + equity curve to the result (strategies only). */
  includeTrades?: boolean;
  /** Options for piner's derived risk-adjusted metrics (strategies only). */
  metrics?: JobMetricsOptions;
  /** Host-fetched bars for request.security, keyed as piner expects: `<symbol>` for a
   *  cross-symbol request, `<symbol>@<tf>` for request.security_lower_tf. Injected into
   *  `ctx.securityBars` before the run. */
  securityBars?: Record<string, Bar[]>;
}

/** Host conventions for piner's `Engine.strategyMetrics` (annualization + risk-free). */
export interface JobMetricsOptions {
  /** Return-annualization periods per year (e.g. 252 daily US-equity bars).
   *  Overrides piner's empirical bar-time / 24/7-timeframe resolution. */
  periodsPerYear?: number;
  /** Annual risk-free rate as a fraction (e.g. 0.02). Default 0. */
  riskFreeRate?: number;
}

export function jobId(job: Job): string {
  return job.id ?? `${job.symbol}@${job.timeframe}`;
}
