/**
 * scan — the flagship fan-out: run ONE Pine script across N symbols and rank the
 * outputs. Ties pinery (history) to a pinerun Runner (execution) + the ranker.
 * Browser-safe: pass any `HistoryProvider` and any `Runner`.
 */
import type { HistoryProvider, HistoryRange } from '@heyphat/pinery';
import { toPinerTimeframe } from '@heyphat/pinery';
import type { Job, JobMetricsOptions } from './job.js';
import type { RunResult } from './result.js';
import { LocalRunner, type Runner } from './runner.js';
import { parseRankSpec, rankResults, type RankedResult, type RankSpec } from './rank.js';
import { resolveSecurity } from './security.js';
import { resolveInstrument } from './instrument.js';

export interface ScanOptions {
  source: string;
  symbols: string[];
  /** Canonical pinery timeframe (e.g. "1h", "1d"); mapped to the piner label internally. */
  timeframe: string;
  provider: HistoryProvider;
  range?: HistoryRange;
  /** Rank spec (e.g. "last(rsi)", "max(#0)", "strategy.netProfit"). Default "last". */
  rank?: string;
  direction?: 'asc' | 'desc';
  top?: number;
  concurrency?: number;
  backend?: 'js' | 'interp';
  inputs?: Record<string, unknown>;
  mintick?: number;
  /** Lot-step override; unset → provider instrument metadata → piner default. */
  minQty?: number;
  /** Attach the full trade ledger + equity curve to each result (strategies only). */
  includeTrades?: boolean;
  /** Host conventions for the derived risk-adjusted metrics (strategies only). */
  metrics?: JobMetricsOptions;
  /** Resolve request.security dependencies (discover → fetch cross-symbol/lower-TF via the
   *  provider → inject). Default true. */
  resolveSecurity?: boolean;
  runner?: Runner;
  onResult?: (result: RunResult, done: number, total: number) => void;
  onFetch?: (symbol: string, bars: number) => void;
  onFetchError?: (symbol: string, error: string) => void;
}

export interface ScanReport {
  spec: RankSpec;
  ranked: RankedResult[];
  /** Every run result (including failures), in symbol order. */
  results: RunResult[];
  /** Results that failed to run (compile/runtime error). */
  errors: RunResult[];
  /** Symbols whose history fetch failed. */
  fetchErrors: { symbol: string; error: string }[];
}

export async function scan(opts: ScanOptions): Promise<ScanReport> {
  if (opts.top != null && !Number.isFinite(opts.top)) {
    throw new Error(`scan: top must be a finite number (got ${opts.top})`);
  }
  if (opts.concurrency != null && !Number.isFinite(opts.concurrency)) {
    throw new Error(`scan: concurrency must be a finite number (got ${opts.concurrency})`);
  }
  const spec = parseRankSpec(opts.rank ?? 'last');
  const pinerTf = toPinerTimeframe(opts.timeframe);
  // Bounded concurrency for provider fetches; job execution concurrency is left
  // to the runner's default (pool size / 4 in-process) unless explicitly set.
  const fetchConcurrency = Math.max(1, opts.concurrency ?? 4);
  const runner = opts.runner ?? new LocalRunner();

  // Fetch history for every symbol (bounded concurrency). Slots are filled by
  // symbol index — not push-on-completion — so `results` really is in symbol order.
  const slots = new Array<Job | undefined>(opts.symbols.length);
  const fetchErrors: { symbol: string; error: string }[] = [];
  await mapLimit(opts.symbols, fetchConcurrency, async (symbol, i) => {
    try {
      const bars = await opts.provider.history(symbol, opts.timeframe, opts.range);
      opts.onFetch?.(symbol, bars.length);
      const inst = await resolveInstrument(opts.provider, symbol, opts);
      slots[i] = {
        source: opts.source,
        symbol,
        timeframe: pinerTf,
        bars,
        inputs: opts.inputs,
        mintick: inst.mintick,
        minQty: inst.minQty,
        backend: opts.backend,
        includeTrades: opts.includeTrades,
        metrics: opts.metrics,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      fetchErrors.push({ symbol, error });
      opts.onFetchError?.(symbol, error);
    }
  });
  const jobs = slots.filter((j): j is Job => j != null);

  // Resolve request.security dependencies (cross-symbol / lower-TF) and inject into jobs.
  if (opts.resolveSecurity !== false && jobs.length > 0) {
    await resolveSecurity(opts.source, jobs, opts.timeframe, pinerTf, opts.provider, {
      range: opts.range,
      inputs: opts.inputs,
      backend: opts.backend,
      mintick: opts.mintick,
      concurrency: fetchConcurrency,
      onFetch: opts.onFetch ? (label, n) => opts.onFetch!(label, n) : undefined,
    });
  }

  const results = await runner.runAll(jobs, {
    concurrency: opts.concurrency,
    onResult: opts.onResult,
  });
  const errors = results.filter((r) => !r.ok);
  const ranked = rankResults(results, spec, { direction: opts.direction, top: opts.top });

  return { spec, ranked, results, errors, fetchErrors };
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}
