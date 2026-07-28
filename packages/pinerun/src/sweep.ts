/**
 * sweep — the parameter-optimization fan-out: run ONE Pine script across a grid
 * of input values, in parallel, and rank the combinations. Where `scan` fans a
 * script out over N symbols, `sweep` fans it out over N parameter combos (the
 * cartesian product of the axes), sharing one fetched bar set per symbol.
 * `symbols` widens the grid to symbols × combos (the symbol becomes an implicit
 * axis); `sample` swaps the exhaustive grid for a seeded random subset (smart
 * search over grids too large to exhaust).
 *
 * It rides the exact same infrastructure as scan: the `Job` model, `jobHash`
 * memoization, any `Runner`, and the ranker. The only new pieces are the axis
 * grammar (`params.ts`) and this orchestrator. Browser-safe: pass any
 * `HistoryProvider` and any `Runner`.
 *
 * Each combo becomes a `Job` whose `inputs` override the script's `input(...)`
 * values by title. Axis names are validated against the script's declared
 * inputs up front (piner silently ignores unknown override keys, which would
 * otherwise make every combo an identical default run), and values are checked
 * against the declared input kind (a string reaching an int/float input becomes
 * NaN inside piner with no error).
 */
import type { Bar, HistoryProvider, HistoryRange } from '@heyphat/pinery';
import { toPinerTimeframe } from '@heyphat/pinery';
import { compile } from '@heyphat/piner';
import type { InputDecl } from '@heyphat/piner';
import type {
  Job,
  JobMetricsOptions,
  ResolvedMagnifierDataset,
  ResolvedSecurityDatasetProof,
} from './job.js';
import type { RunResult } from './result.js';
import { LocalRunner, type Runner } from './runner.js';
import { evalRank, parseRankSpec, sortRanked, type RankSpec } from './rank.js';
import {
  createMagnifierResolutionScope,
  preflightBarMagnifier,
  resolveBarMagnifier,
} from './magnifier.js';
import { assertBooleanOverride, exactRunFailure, failedJobResult } from './command-failure.js';
import { resolveSecurity } from './security.js';
import { resolveInstrument } from './instrument.js';
import {
  assertComboBudget,
  cartesian,
  comboId,
  countCombos,
  sampleCombos,
  type Axis,
} from './params.js';

export interface SweepOptions {
  source: string;
  /** Single symbol to backtest across the grid. */
  symbol?: string;
  /** Multi-symbol grid: run every combo on every symbol (the symbol becomes an
   *  implicit axis). Bars are fetched once per symbol and shared across that
   *  symbol's combos. Takes precedence over `symbol` when non-empty. */
  symbols?: string[];
  /** Canonical pinery timeframe (e.g. "1h", "1d"); mapped to the piner label internally. */
  timeframe: string;
  provider: HistoryProvider;
  range?: HistoryRange;
  /** Pre-fetched bars — skips the provider fetch (used by walk-forward to sweep
   *  a window slice). `range` should still describe the slice's time span so
   *  request.security fetches cover it. */
  bars?: Bar[];
  /** The input grid. Each axis expands to a list of values (see params.ts). */
  axes: Axis[];
  /** Fixed inputs applied to every combo (merged under each combo's swept values). */
  baseInputs?: Record<string, unknown>;
  /** Rank spec (e.g. "strategy.netProfit", "last(rsi)"). When omitted, defaults
   *  to "strategy.netProfit" if the results reveal a strategy, else "last". */
  rank?: string;
  direction?: 'asc' | 'desc';
  top?: number;
  /** Max jobs in flight. Default: the runner's own default (pool size for a
   *  worker pool, 4 in-process). */
  concurrency?: number;
  backend?: 'js' | 'interp';
  mintick?: number;
  /** Lot-step override; unset → provider instrument metadata → piner default. */
  minQty?: number;
  /** Override the script's calc_on_order_fills (TV's "After order is filled"
   *  checkbox). Unset → the script's own flag. */
  calcOnOrderFills?: boolean;
  /** Override strategy()'s use_bar_magnifier Properties toggle. Unset keeps
   *  the source declaration; true/false wins in either direction. */
  useBarMagnifier?: boolean;
  /** Attach the full trade ledger + equity curve to each result (strategies only). */
  includeTrades?: boolean;
  /** Host conventions for the derived risk-adjusted metrics (strategies only). */
  metrics?: JobMetricsOptions;
  /** Resolve request.security dependencies once and share across all combos. Default true. */
  resolveSecurity?: boolean;
  /** Cap on total RUNS (combos × symbols); throws before any I/O when exceeded.
   *  Default 5000. */
  maxCombos?: number;
  /** Smart search: randomly sample N distinct combos from the grid instead of
   *  running it exhaustively. Deterministic for a given `seed`; the budget guard
   *  then applies to the sampled count, so a huge grid can be explored cheaply. */
  sample?: number;
  /** PRNG seed for `sample` (default 42, so unseeded samples still reproduce). */
  seed?: number;
  runner?: Runner;
  onResult?: (result: RunResult, done: number, total: number) => void;
  onFetch?: (symbol: string, bars: number) => void;
  /** A request.security dependency failed to fetch; its series degrades to na/[]. */
  onSecurityError?: (label: string, error: string) => void;
}

/** One point in the sweep: a parameter combo, its run result, and its ranked value. */
export interface SweepPoint {
  /** The symbol this run executed on. */
  symbol: string;
  /** The swept input values that produced this run (title → value). */
  inputs: Record<string, unknown>;
  result: RunResult;
  /** The ranked metric for this combo (NaN if the run failed / produced no value). */
  value: number;
}

export interface SweepReport {
  /** Display label: the single symbol, or the comma-joined multi-symbol list. */
  symbol: string;
  /** Every symbol the grid was requested on (fetch failures included). */
  symbols: string[];
  /** The effective rank spec string (reflects the strategy default when `rank` was omitted). */
  rank: string;
  spec: RankSpec;
  axes: Axis[];
  /** Number of runs executed (== points.length == combos × fetched symbols). */
  total: number;
  /** Combos run per symbol (the full grid, or the sampled count). */
  combos: number;
  /** Full cartesian size of the grid — > `combos` when `sample` was used. */
  gridTotal: number;
  /** Sorted (top-N applied), NaN values dropped. */
  ranked: SweepPoint[];
  /** Every run, symbols outermost then cartesian order (holds failures too). */
  points: SweepPoint[];
  /** Runs that failed (compile/runtime error). */
  errors: RunResult[];
  /** Non-fatal caveats about how the sweep was resolved (surfaced by the CLI). */
  warnings: string[];
  /** Symbols whose history fetch failed (their combos are skipped). */
  fetchErrors: { symbol: string; error: string }[];
  /** Set when EVERY symbol's history fetch failed (ranked/points are then empty). */
  fetchError?: string;
}

/** Input kinds whose override value must be a JS number (piner NaNs a string). */
const NUMERIC_KINDS = new Set<InputDecl['kind']>(['int', 'float', 'price', 'time']);
/** Input kinds whose override piner reads as a string (titles, tfs, sessions…). */
const STRINGY_KINDS = new Set<InputDecl['kind']>([
  'string',
  'source',
  'timeframe',
  'symbol',
  'session',
  'color',
  'text_area',
]);

/**
 * Check every axis against the script's declared inputs and normalize values to
 * the declared kind (numbers stringified for string-family inputs, so
 * `--input tf=5,15` sweeps the strings "5"/"15"). Returns the normalized axes,
 * or the axes unchanged when the script doesn't compile — the real runs will
 * surface the compile error with full diagnostics. `label` prefixes error
 * messages (shared by `sweep` and `backtest`).
 */
export function validateAxes(source: string, axes: Axis[], label = 'sweep'): Axis[] {
  let decls: InputDecl[];
  try {
    decls = compile(source).metadata.inputs ?? [];
  } catch {
    return axes; // compile error — surfaced by the runs themselves
  }
  const byKey = new Map(decls.map((d) => [d.key, d]));

  const unknown = axes.filter((a) => !byKey.has(a.name));
  if (unknown.length > 0) {
    const names = unknown.map((a) => `"${a.name}"`).join(', ');
    const known = decls.map((d) => `"${d.key}"`).join(', ') || '(none)';
    throw new Error(
      `${label}: input ${names} not found in script — declared inputs: ${known} ` +
        `(the axis name must match the input() title exactly)`,
    );
  }

  return axes.map((axis) => {
    const decl = byKey.get(axis.name)!;
    if (NUMERIC_KINDS.has(decl.kind)) {
      const bad = axis.values.find((v) => typeof v !== 'number');
      if (bad !== undefined) {
        throw new Error(
          `${label}: input "${axis.name}" is ${decl.kind} but axis value "${String(bad)}" is not a number`,
        );
      }
      return axis;
    }
    if (decl.kind === 'bool') {
      const bad = axis.values.find((v) => typeof v !== 'boolean');
      if (bad !== undefined) {
        throw new Error(
          `${label}: input "${axis.name}" is bool but axis value "${String(bad)}" is not true/false`,
        );
      }
      return axis;
    }
    if (STRINGY_KINDS.has(decl.kind)) {
      // A numeric-looking token ("5") was coerced to a number; the input wants a string.
      return { ...axis, values: axis.values.map((v) => (typeof v === 'number' ? String(v) : v)) };
    }
    return axis; // enum: options may be strings or numbers — let piner decide
  });
}

interface PreparedWalkforwardExactData {
  readonly magnifier: ResolvedMagnifierDataset;
  readonly securityBars?: Record<string, Bar[]>;
  readonly securityProofs?: Record<string, ResolvedSecurityDatasetProof>;
}

/** Internal fold seam: acquisition is anchored to the complete IS+OOS window. */
export function sweepPreparedForWalkforward(
  opts: SweepOptions,
  prepared: PreparedWalkforwardExactData,
): Promise<SweepReport> {
  return runSweep(opts, prepared);
}

export function sweep(opts: SweepOptions): Promise<SweepReport> {
  return runSweep(opts);
}

async function runSweep(
  opts: SweepOptions,
  preparedExact?: PreparedWalkforwardExactData,
): Promise<SweepReport> {
  assertBooleanOverride(opts.useBarMagnifier);
  // Validate everything user-shaped BEFORE any network / execution work.
  const explicitSpec = opts.rank != null ? parseRankSpec(opts.rank) : null;
  if (opts.top != null && !Number.isFinite(opts.top)) {
    throw new Error(`sweep: top must be a finite number (got ${opts.top})`);
  }
  if (opts.concurrency != null && !Number.isFinite(opts.concurrency)) {
    throw new Error(`sweep: concurrency must be a finite number (got ${opts.concurrency})`);
  }
  if (opts.sample != null && (!Number.isInteger(opts.sample) || opts.sample < 1)) {
    throw new Error(`sweep: sample must be a positive integer (got ${opts.sample})`);
  }
  const symbols =
    opts.symbols != null && opts.symbols.length > 0
      ? opts.symbols
      : opts.symbol != null
        ? [opts.symbol]
        : [];
  if (symbols.length === 0) throw new Error('sweep: no symbol (set symbol or symbols)');
  if (opts.bars != null && symbols.length > 1) {
    throw new Error('sweep: pre-fetched bars only apply to a single symbol');
  }
  assertComboBudget(opts.axes, opts.maxCombos ?? undefined, {
    symbols: symbols.length,
    sample: opts.sample,
  });
  const axes = validateAxes(opts.source, opts.axes);

  const pinerTf = toPinerTimeframe(opts.timeframe);
  const runner = opts.runner ?? new LocalRunner();
  const fetchConcurrency = Math.max(1, opts.concurrency ?? 4);
  const gridTotal = countCombos(axes);
  const combos = opts.sample != null ? sampleCombos(axes, opts.sample, opts.seed) : cartesian(axes);
  const warnings: string[] = [];
  const symbolLabel = symbols.join(',');

  if (preparedExact && symbols.length !== 1) {
    throw new Error('sweep: prepared walk-forward exact data requires one symbol');
  }

  let magnifierRequested = preparedExact !== undefined;
  if (!preparedExact) {
    try {
      magnifierRequested = preflightBarMagnifier(
        opts.source,
        pinerTf,
        opts.useBarMagnifier,
      ).requested;
    } catch (error) {
      if (exactRunFailure(error)) {
        const results = symbols.flatMap((symbol) =>
          combos.map((combo) =>
            failedJobResult(
              {
                id: comboId(combo),
                symbol,
                timeframe: pinerTf,
                bars: [],
              },
              error,
            ),
          ),
        );
        const rank = opts.rank ?? 'last';
        const spec = explicitSpec ?? parseRankSpec(rank);
        const points: SweepPoint[] = results.map((result, index) => ({
          symbol: symbols[Math.floor(index / combos.length)]!,
          inputs: combos[index % combos.length]!,
          result,
          value: evalRank(result, spec),
        }));
        results.forEach((result, index) => opts.onResult?.(result, index + 1, results.length));
        return {
          symbol: symbolLabel,
          symbols,
          rank,
          spec,
          axes,
          total: points.length,
          combos: combos.length,
          gridTotal,
          ranked: [],
          points,
          errors: results,
          warnings,
          fetchErrors: [],
        };
      }
      // Ordinary compile failures are surfaced by the existing execution path.
    }
  }

  // Fetch each symbol's bars ONCE — every combo of a symbol shares its series.
  // Slots are filled by symbol index so job/point order stays deterministic.
  type Fetched = { symbol: string; bars: Bar[]; inst?: { minQty?: number; mintick?: number } };
  const slots = new Array<Fetched | undefined>(symbols.length);
  const fetchErrors: { symbol: string; error: string }[] = [];
  if (opts.bars != null) {
    slots[0] = {
      symbol: symbols[0]!,
      bars: opts.bars,
      inst: await resolveInstrument(opts.provider, symbols[0]!, opts),
    };
    opts.onFetch?.(symbols[0]!, opts.bars.length);
  } else {
    await mapLimit(symbols, fetchConcurrency, async (symbol, i) => {
      try {
        const bars = await opts.provider.history(symbol, opts.timeframe, opts.range);
        opts.onFetch?.(symbol, bars.length);
        const inst = await resolveInstrument(opts.provider, symbol, opts);
        slots[i] = { symbol, bars, inst };
      } catch (err) {
        fetchErrors.push({ symbol, error: err instanceof Error ? err.message : String(err) });
      }
    });
  }
  const fetched = slots.filter((s): s is Fetched => s != null);

  if (fetched.length === 0) {
    const rank = opts.rank ?? 'last';
    return {
      symbol: symbolLabel,
      symbols,
      rank,
      spec: explicitSpec ?? parseRankSpec(rank),
      axes,
      total: 0,
      combos: combos.length,
      gridTotal,
      ranked: [],
      points: [],
      errors: [],
      warnings,
      fetchErrors,
      fetchError: fetchErrors[0]?.error ?? 'no bars',
    };
  }

  // Build one Job per (symbol, combo): the symbol's shared bars, per-combo
  // inputs, and a readable combo id (result.symbol tells the symbols apart).
  const jobs: Job[] = fetched.flatMap(({ symbol, bars, inst }) =>
    combos.map((combo) => ({
      id: comboId(combo),
      source: opts.source,
      symbol,
      timeframe: pinerTf,
      bars,
      inputs: { ...opts.baseInputs, ...combo },
      mintick: inst?.mintick ?? opts.mintick,
      minQty: inst?.minQty ?? opts.minQty,
      calcOnOrderFills: opts.calcOnOrderFills,
      useBarMagnifier: opts.useBarMagnifier,
      backend: opts.backend,
      includeTrades: opts.includeTrades,
      metrics: opts.metrics,
    })),
  );

  let results: RunResult[];
  if (preparedExact) {
    for (const job of jobs) {
      job.magnifier = preparedExact.magnifier;
      if (preparedExact.securityBars) job.securityBars = preparedExact.securityBars;
      if (preparedExact.securityProofs) job.securityProofs = preparedExact.securityProofs;
    }
    results = await runner.runAll(jobs, {
      concurrency: opts.concurrency,
      onResult: opts.onResult,
    });
  } else if (magnifierRequested) {
    // Resolve one complete template per symbol, then share its immutable exact
    // payload/security bars across that symbol's parameter jobs. No candidate
    // executes until every template has resolved or produced an explicit error.
    const failures = new Array<RunResult | undefined>(jobs.length);
    const magnifierScope = createMagnifierResolutionScope();
    await mapLimit(fetched, fetchConcurrency, async (_entry, symbolIndex) => {
      const start = symbolIndex * combos.length;
      const template = jobs[start]!;
      try {
        await resolveBarMagnifier(template, opts.timeframe, opts.provider, {
          securityConcurrency: fetchConcurrency,
          onSecurityFetch: opts.onFetch ? (label, n) => opts.onFetch!(label, n) : undefined,
          onSecurityError: opts.onSecurityError,
          scope: magnifierScope,
        });
        for (let offset = 1; offset < combos.length; offset++) {
          const job = jobs[start + offset]!;
          job.magnifier = template.magnifier;
          if (template.securityBars) job.securityBars = template.securityBars;
          if (template.securityProofs) job.securityProofs = template.securityProofs;
        }
      } catch (error) {
        for (let offset = 0; offset < combos.length; offset++) {
          failures[start + offset] = failedJobResult(jobs[start + offset]!, error);
        }
      }
    });

    const runnable: Job[] = [];
    const runnableIndexes: number[] = [];
    for (let index = 0; index < jobs.length; index++) {
      if (!failures[index]) {
        runnable.push(jobs[index]!);
        runnableIndexes.push(index);
      }
    }
    const executed = await runner.runAll(runnable, { concurrency: opts.concurrency });
    results = new Array<RunResult>(jobs.length);
    for (let index = 0; index < jobs.length; index++) {
      if (failures[index]) results[index] = failures[index]!;
    }
    executed.forEach((result, index) => {
      results[runnableIndexes[index]!] = result;
    });
    results.forEach((result, index) => opts.onResult?.(result, index + 1, results.length));
  } else {
    // Resolve request.security ONCE across all jobs (combos of one symbol share
    // its bars; cross-symbol deps dedupe inside resolveSecurity) and inject.
    if (opts.resolveSecurity !== false) {
      const { discovered } = await resolveSecurity(
        opts.source,
        jobs,
        opts.timeframe,
        pinerTf,
        opts.provider,
        {
          range: opts.range,
          inputs: { ...opts.baseInputs },
          backend: opts.backend,
          mintick: opts.mintick,
          concurrency: fetchConcurrency,
          onFetch: opts.onFetch ? (label, n) => opts.onFetch!(label, n) : undefined,
          onError: opts.onSecurityError,
        },
      );
      // A discovery run means some request.security argument is only known at
      // runtime — it was resolved ONCE with default/base inputs. If that argument
      // depends on a swept input, every combo received the default's bars.
      if (discovered && axes.length > 0) {
        warnings.push(
          'request.security has dynamic (runtime-computed) arguments, resolved once with ' +
            'default/base inputs — if a swept input feeds request.security, its combos ran ' +
            'against the wrong series; pass resolveSecurity: false (--no-security) to be safe',
        );
      }
    }

    // Fan out through the SAME runner + memo as scan. fanOut preserves job order,
    // so results[i] corresponds to combos[i]. Concurrency is left to the runner's
    // default (pool size / 4 in-process) unless explicitly set.
    results = await runner.runAll(jobs, {
      concurrency: opts.concurrency,
      onResult: opts.onResult,
    });
  }

  // Resolve the effective rank: an omitted rank defaults to net profit once the
  // results reveal a strategy. Then zip, rank via the SAME pipeline as scan.
  const rank = opts.rank ?? (results.some((r) => r.strategy) ? 'strategy.netProfit' : 'last');
  const spec = explicitSpec ?? parseRankSpec(rank);

  const points: SweepPoint[] = results.map((result, i) => ({
    symbol: fetched[Math.floor(i / combos.length)]!.symbol,
    inputs: combos[i % combos.length]!,
    result,
    value: evalRank(result, spec),
  }));

  const ranked = sortRanked(points, { direction: opts.direction, top: opts.top });
  const errors = results.filter((r) => !r.ok);
  return {
    symbol: symbolLabel,
    symbols,
    rank,
    spec,
    axes,
    total: points.length,
    combos: combos.length,
    gridTotal,
    ranked,
    points,
    errors,
    warnings,
    fetchErrors,
  };
}

/** Bounded-concurrency map, slots filled by index (same helper shape as scan's). */
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
