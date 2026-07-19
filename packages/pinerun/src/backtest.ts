/**
 * backtest — deep single-run analysis: ONE script, ONE symbol, full detail.
 *
 * Where `scan` fans out across symbols and `sweep` across parameter combos,
 * `backtest` runs exactly one job and always attaches the closed-trade ledger,
 * equity curve, and bar times — the inputs a tearsheet (and CSV/plot export)
 * needs. Browser-safe: same building blocks as scan (provider fetch,
 * request.security resolution, `executeJob`), no runner indirection — a single
 * run gains nothing from a worker pool.
 */
import type { HistoryProvider, HistoryRange } from '@heyphat/pinery';
import { toPinerTimeframe } from '@heyphat/pinery';
import type { Job, JobMetricsOptions } from './job.js';
import type { RunResult } from './result.js';
import { executeJob } from './execute.js';
import { resolveSecurity } from './security.js';
import { resolveInstrument } from './instrument.js';

export interface BacktestOptions {
  source: string;
  /** The single symbol to backtest. */
  symbol: string;
  /** Canonical pinery timeframe (e.g. "1h", "1d"); mapped to the piner label internally. */
  timeframe: string;
  provider: HistoryProvider;
  range?: HistoryRange;
  /** Fixed input overrides keyed by input title. */
  inputs?: Record<string, unknown>;
  mintick?: number;
  /** Lot-step override; unset → provider instrument metadata → piner default. */
  minQty?: number;
  backend?: 'js' | 'interp';
  /** Host conventions for the derived risk-adjusted metrics. */
  metrics?: JobMetricsOptions;
  /** Resolve request.security dependencies (fetch + inject). Default true. */
  resolveSecurity?: boolean;
  onFetch?: (symbol: string, bars: number) => void;
  /** A request.security dependency failed to fetch; its series degrades to na/[]. */
  onSecurityError?: (label: string, error: string) => void;
}

export interface BacktestReport {
  /** The full run result (ledger, equity curve, bar times, closes always
   *  attached). Absent only when the history fetch itself failed. */
  result?: RunResult;
  /** Set when the symbol's history fetch failed (no run happened). */
  fetchError?: string;
}

export async function backtest(opts: BacktestOptions): Promise<BacktestReport> {
  const pinerTf = toPinerTimeframe(opts.timeframe);

  let bars;
  try {
    bars = await opts.provider.history(opts.symbol, opts.timeframe, opts.range);
    opts.onFetch?.(opts.symbol, bars.length);
  } catch (err) {
    return { fetchError: err instanceof Error ? err.message : String(err) };
  }

  const inst = await resolveInstrument(opts.provider, opts.symbol, opts);

  const job: Job = {
    source: opts.source,
    symbol: opts.symbol,
    timeframe: pinerTf,
    bars,
    inputs: opts.inputs,
    mintick: inst.mintick,
    minQty: inst.minQty,
    backend: opts.backend,
    metrics: opts.metrics,
    includeTrades: true, // the whole point of a backtest is the full detail
  };

  if (opts.resolveSecurity !== false) {
    await resolveSecurity(opts.source, [job], opts.timeframe, pinerTf, opts.provider, {
      range: opts.range,
      inputs: opts.inputs,
      backend: opts.backend,
      mintick: opts.mintick,
      concurrency: 4, // security fetches only — the run itself is a single job
      onFetch: opts.onFetch ? (label, n) => opts.onFetch!(label, n) : undefined,
      onError: opts.onSecurityError,
    });
  }

  return { result: await executeJob(job) };
}
