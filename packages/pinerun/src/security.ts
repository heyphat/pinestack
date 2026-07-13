/**
 * request.security orchestration (Stage 1). piner never fetches — it declares its
 * data dependencies (`outputs.securityRequests`) and reads host-injected bars from
 * `ctx.securityBars`. This module drives the plan-then-execute loop for a scan:
 *
 *   1. DISCOVER — run the script once under a sentinel symbol to learn its
 *      request.security[_lower_tf] dependencies. The sentinel lets us tell a
 *      self-reference (`syminfo.tickerid`) apart from a literal that happens to
 *      equal a scanned symbol.
 *   2. PLAN + FETCH — classify the deps and fetch each unique (symbol, tf) ONCE
 *      via the pinery provider (shared across all jobs); self lower-TF is the only
 *      per-scanned-symbol fetch.
 *   3. INJECT — attach the resolved bars to each Job so the real (parallel) run
 *      resolves every request in a single pass.
 *
 * A same-symbol request.security at the chart's OWN timeframe needs no fetch (piner passes it
 * through); one at any OTHER timeframe (finer or higher) IS fetched — piner resolves it against the
 * real injected series (close-time aligned) rather than resampling the job's own bars, which can't
 * produce a finer TF and lags a just-closed higher-TF bar by one chart bar.
 */
import type { Bar, HistoryProvider, HistoryRange, Timeframe } from '@heyphat/pinery';
import { pinerTimeframeToCanonical, timeframeSeconds } from '@heyphat/pinery';
import { compile } from '@heyphat/piner';
import type { SecurityRequest, SecurityDependency } from '@heyphat/piner';
import type { Job } from './job.js';
import { executeJob } from './execute.js';

/** Sentinel symbol used for the discovery run (disambiguates self-refs from literals). */
export const PROBE_SYMBOL = '__pinerun_probe__';

export interface DiscoverOptions {
  timeframe: string; // piner tf label
  inputs?: Record<string, unknown>;
  backend?: 'js' | 'interp';
  mintick?: number;
}

/** Run the script once under the sentinel symbol and return its declared deps. */
export async function discoverSecurityRequests(
  source: string,
  bars: Bar[],
  opts: DiscoverOptions,
): Promise<SecurityRequest[]> {
  const res = await executeJob({
    source,
    symbol: PROBE_SYMBOL,
    timeframe: opts.timeframe,
    bars,
    inputs: opts.inputs,
    backend: opts.backend,
    mintick: opts.mintick,
  });
  return res.securityRequests ?? [];
}

export interface ClassifiedRequests {
  /** Cross-symbol higher-TF: fetch at the chart TF, key by symbol. */
  crossHtf: string[];
  /** Cross-symbol lower-TF: fetch a finer TF, key `<symbol>@<rawTf>`. */
  crossLtf: { symbol: string; rawTf: string }[];
  /** Self lower-TF raw TFs: fetch each scanned symbol at a finer TF, key `<symbol>@<rawTf>`. */
  selfLtfRawTfs: string[];
  /**
   * Self PLAIN request.security raw TFs whose timeframe DIFFERS from the chart (finer OR higher):
   * fetch each scanned symbol's ACTUAL bars at that TF, key `<symbol>@<rawTf>`. piner then resolves
   * against the real series (close-time aligned) instead of resampling the chart's own bars — which
   * can't produce a finer TF and lags a just-closed higher-TF bar by one chart bar.
   */
  selfPlainRawTfs: string[];
}

export function classifyRequests(requests: SecurityRequest[], chartTf: Timeframe): ClassifiedRequests {
  const crossHtf = new Set<string>();
  const crossLtfSeen = new Set<string>();
  const crossLtf: { symbol: string; rawTf: string }[] = [];
  const selfLtf = new Set<string>();
  const selfPlain = new Set<string>();
  for (const r of requests) {
    const isSelf = r.symbol === PROBE_SYMBOL || r.symbol === '';
    if (r.lowerTf) {
      if (isSelf) {
        selfLtf.add(r.timeframe);
      } else {
        const key = `${r.symbol}@${r.timeframe}`;
        if (!crossLtfSeen.has(key)) {
          crossLtfSeen.add(key);
          crossLtf.push({ symbol: r.symbol, rawTf: r.timeframe });
        }
      }
    } else if (isSelf) {
      // self plain request.security: fetch the real series when its TF differs from the chart's
      // (identity → piner passes through, nothing to fetch).
      if (resolveSameSymbolFetchTf(r.timeframe, chartTf)) selfPlain.add(r.timeframe);
    } else {
      crossHtf.add(r.symbol);
    }
  }
  return { crossHtf: [...crossHtf], crossLtf, selfLtfRawTfs: [...selfLtf], selfPlainRawTfs: [...selfPlain] };
}

/**
 * Resolve a `request.security_lower_tf` timeframe to the canonical TF to fetch: the
 * finer TF strictly below the chart TF; clamps sub-minute to `1m`; returns null when
 * the chart is already at the finest TF (request degrades to []).
 */
export function resolveLowerFetchTf(rawPinerTf: string, chartTf: Timeframe): Timeframe | null {
  const canon = pinerTimeframeToCanonical(rawPinerTf) ?? '1m';
  const chartSec = timeframeSeconds(chartTf);
  let sec: number;
  try {
    sec = timeframeSeconds(canon);
  } catch {
    return chartSec > 60 ? '1m' : null;
  }
  if (sec < chartSec) return canon;
  return chartSec > 60 ? '1m' : null; // coarser/equal request → finest available, if any
}

/**
 * Resolve a PLAIN self `request.security` timeframe to the canonical TF to fetch, or null when it
 * is the chart's own TF (piner passes it through) or unknown. Unlike `resolveLowerFetchTf` this
 * returns the EXACT requested TF (finer OR higher) with no clamping — we fetch the real series so
 * piner resolves against it instead of resampling the chart's bars.
 */
export function resolveSameSymbolFetchTf(rawPinerTf: string, chartTf: Timeframe): Timeframe | null {
  const canon = pinerTimeframeToCanonical(rawPinerTf);
  if (!canon) return null;
  try {
    return timeframeSeconds(canon) !== timeframeSeconds(chartTf) ? canon : null;
  } catch {
    return null;
  }
}

export interface ResolveSecurityOptions {
  range?: HistoryRange;
  inputs?: Record<string, unknown>;
  backend?: 'js' | 'interp';
  mintick?: number;
  concurrency: number;
  onFetch?: (label: string, bars: number) => void;
}

/**
 * Classify request.security dependencies from piner's compile-time metadata,
 * WITHOUT running the script. Returns null when any dependency is dynamic (its
 * symbol/timeframe couldn't be resolved statically) — the caller must then fall
 * back to a discovery run. An empty `deps` yields an empty (all-clear) plan.
 */
export function planFromStatic(deps: SecurityDependency[], chartTf: Timeframe): ClassifiedRequests | null {
  if (deps.some((d) => d.dynamic)) return null;
  const crossHtf = new Set<string>();
  const crossLtfSeen = new Set<string>();
  const crossLtf: { symbol: string; rawTf: string }[] = [];
  const selfLtf = new Set<string>();
  const selfPlain = new Set<string>();
  for (const d of deps) {
    if (d.lowerTf) {
      if (d.self) {
        if (d.timeframe !== null) selfLtf.add(d.timeframe);
      } else if (d.symbol !== null && d.timeframe !== null) {
        const key = `${d.symbol}@${d.timeframe}`;
        if (!crossLtfSeen.has(key)) {
          crossLtfSeen.add(key);
          crossLtf.push({ symbol: d.symbol, rawTf: d.timeframe });
        }
      }
    } else if (d.self) {
      if (d.timeframe !== null && resolveSameSymbolFetchTf(d.timeframe, chartTf)) selfPlain.add(d.timeframe);
    } else if (d.symbol !== null) {
      crossHtf.add(d.symbol);
    }
  }
  return { crossHtf: [...crossHtf], crossLtf, selfLtfRawTfs: [...selfLtf], selfPlainRawTfs: [...selfPlain] };
}

/**
 * Discover + fetch + inject in place: mutates each job's `securityBars`. `chartTf`
 * is the canonical pinery timeframe of the scan; `pinerTf` is its piner label
 * (jobs already carry it). Static-first: reads compile-time dependencies and only
 * runs a discovery pass when a dependency is dynamic. Returns `{ discovered }` so
 * callers can tell whether a discovery run was needed.
 */
export async function resolveSecurity(
  source: string,
  jobs: Job[],
  chartTf: Timeframe,
  pinerTf: string,
  provider: HistoryProvider,
  opts: ResolveSecurityOptions,
): Promise<{ discovered: boolean }> {
  if (jobs.length === 0) return { discovered: false };

  // Static-first: classify from compile-time metadata; only run a discovery pass
  // when a dependency is dynamic (or piner is too old to report dependencies).
  let cls: ClassifiedRequests | null = null;
  try {
    const deps = compile(source).metadata.securityDependencies;
    cls = deps ? planFromStatic(deps, chartTf) : null;
  } catch {
    return { discovered: false }; // compile error — the real runs will surface it
  }

  let discovered = false;
  if (cls === null) {
    const requests = await discoverSecurityRequests(source, jobs[0]!.bars, {
      timeframe: pinerTf,
      inputs: opts.inputs,
      backend: opts.backend,
      mintick: opts.mintick,
    });
    discovered = true;
    cls = classifyRequests(requests, chartTf);
  }

  if (
    cls.crossHtf.length === 0 &&
    cls.crossLtf.length === 0 &&
    cls.selfLtfRawTfs.length === 0 &&
    cls.selfPlainRawTfs.length === 0
  ) {
    return { discovered }; // only identity self-tf (or nothing): piner handles it, nothing to fetch
  }

  // ── shared cross-symbol bars (fetched once, injected into every job) ──
  const shared: Record<string, Bar[]> = {};
  await mapLimit(cls.crossHtf, opts.concurrency, async (symbol) => {
    try {
      const bars = await provider.history(symbol, chartTf, opts.range);
      if (bars.length) {
        shared[symbol] = bars;
        opts.onFetch?.(symbol, bars.length);
      }
    } catch {
      /* leave out → request resolves to na */
    }
  });
  await mapLimit(cls.crossLtf, opts.concurrency, async ({ symbol, rawTf }) => {
    const fetchTf = resolveLowerFetchTf(rawTf, chartTf);
    if (!fetchTf) return;
    try {
      const bars = await provider.history(symbol, fetchTf, opts.range);
      if (bars.length) {
        shared[`${symbol}@${rawTf}`] = bars;
        opts.onFetch?.(`${symbol}@${rawTf}`, bars.length);
      }
    } catch {
      /* leave out → request resolves to [] */
    }
  });

  // ── self lower-TF + self plain non-chart TF: fetch each scanned symbol at that TF (deduped) ──
  // lower_tf clamps to a finer TF; a plain self request fetches its EXACT (finer OR higher) TF.
  const selfCache = new Map<string, Bar[]>();
  const selfPlan = [
    ...cls.selfLtfRawTfs.map((rawTf) => ({ rawTf, fetchTf: resolveLowerFetchTf(rawTf, chartTf) })),
    ...cls.selfPlainRawTfs.map((rawTf) => ({ rawTf, fetchTf: resolveSameSymbolFetchTf(rawTf, chartTf) })),
  ].filter((e): e is { rawTf: string; fetchTf: Timeframe } => e.fetchTf !== null);

  if (selfPlan.length > 0) {
    await mapLimit(jobs, opts.concurrency, async (job) => {
      for (const { rawTf, fetchTf } of selfPlan) {
        const cacheKey = `${job.symbol}|${fetchTf}`;
        let bars = selfCache.get(cacheKey);
        if (!bars) {
          try {
            bars = await provider.history(job.symbol, fetchTf, opts.range);
          } catch {
            bars = [];
          }
          selfCache.set(cacheKey, bars);
        }
        if (bars.length) (job.securityBars ??= { ...shared })[`${job.symbol}@${rawTf}`] = bars;
      }
      if (!job.securityBars && Object.keys(shared).length) job.securityBars = shared;
    });
  } else if (Object.keys(shared).length) {
    for (const job of jobs) job.securityBars = shared;
  }

  return { discovered };
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
}
