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
import {
  ExactHistoryError,
  acquireExactHistory,
  assertCalendarPeriodCoverage,
  calendarSessionPeriods,
  canonicalTimeframeSecondsExact,
  halfOpenIntervalSec,
  isCalendarSessionTimeframe,
  isUtcWeekTimeframe,
  parseCanonicalTimeframeExact,
  pineTimeframeToCanonicalExact,
  pinerTimeframeToCanonical,
  resolveHistorySource,
  snapshotHistorySessionCalendar,
  timeframeSeconds,
  unixSecond,
  utcTimeframeAnchor,
  utcTimeframesNest,
  validateHistoryAcquisition,
  type AcquisitionProvenance,
  type Bar,
  type CoverageGapSec,
  type HalfOpenIntervalSec,
  type HistoryAcquisition,
  type HistoryAlignment,
  type HistoryCapabilities,
  type HistoryProvider,
  type HistoryRange,
  type HistorySessionCalendar,
  type Timeframe,
  type UnixSecond,
} from '@heyphat/pinery';
import type { SecurityRequest, SecurityDependency } from '@heyphat/piner';
import type {
  Job,
  ResolvedSecurityAlignmentEvidence,
  ResolvedSecurityDependencyIdentity,
  ResolvedSecurityDatasetProof,
  ResolvedSecurityRequestKind,
} from './job.js';
import { canonicalDigest, marketDataDigest, registerOwnedImmutableBars } from './digest.js';
import { BarMagnifierError } from './failure.js';
import { compilePinerSource } from './piner-capabilities.js';

/** Sentinel symbol used for the discovery run (disambiguates self-refs from literals). */
export const PROBE_SYMBOL = '__pinerun_probe__';

/**
 * Piner/Pine `W` uses one universal Monday phase: bucketKey() computes
 * floor((day + 3) / (7 * multiplier)), so every W multiplier opens at
 * epoch day -3 modulo its complete duration. Elapsed `7D` stays epoch-anchored.
 */
const PINE_UTC_WEEK_PHASE_SEC = unixSecond(-3 * 86_400);

/**
 * Exact static-security proofs are executable only when this module issued the
 * immutable snapshot. Content hashes detect mutation/substitution, while this
 * process-local authority prevents callers from fabricating a new calendar and
 * recomputing every public digest around it.
 */
const resolverIssuedSecurityProofs = new WeakSet<object>();
let workerSecurityProofAuthSecret: string | undefined;

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
  // Lazy import keeps the pure static planner usable by executeJob without a
  // security -> execute -> magnifier -> security initialization cycle.
  const { executeJob } = await import('./execute.js');
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
  /** Cross-symbol plain requests, deduped by symbol for legacy chart-TF fetching. */
  crossHtf: string[];
  /** Concrete cross-symbol plain request identities retained for exact planning. A null raw TF
   * means the statically proven chart timeframe (`timeframe.period` / empty timeframe). */
  crossPlain?: { symbol: string; rawTf: string | null; lookaheadOn?: true }[];
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

export function classifyRequests(
  requests: SecurityRequest[],
  chartTf: Timeframe,
): ClassifiedRequests {
  const crossHtf = new Set<string>();
  const crossPlainSeen = new Set<string>();
  const crossPlain: { symbol: string; rawTf: string | null; lookaheadOn?: true }[] = [];
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
      const key = `${r.symbol}\u0000${r.timeframe}`;
      if (!crossPlainSeen.has(key)) {
        crossPlainSeen.add(key);
        crossPlain.push({ symbol: r.symbol, rawTf: r.timeframe });
      }
    }
  }
  return {
    crossHtf: [...crossHtf],
    crossPlain,
    crossLtf,
    selfLtfRawTfs: [...selfLtf],
    selfPlainRawTfs: [...selfPlain],
  };
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
  /** A dependency fetch failed; its series degrades to na/[] in the run. The
   *  degrade is deliberate (one flaky dependency must not kill a 100-symbol
   *  scan) but must be VISIBLE — a strategy whose condition reads a silently-na
   *  series produces plausible-looking, wrong results. */
  onError?: (label: string, error: string) => void;
  /** Exact Bar Magnifier mode: dynamic request identities are rejected and
   *  every static dependency must resolve; no discovery/degrade pass is allowed. */
  barMagnifierRequested?: boolean;
  /** Already-compiled dependencies from the matching magnifier preflight.
   *  Avoids recompiling through a different runtime adapter. */
  staticDependencies?: readonly SecurityDependency[];
  /** Exact chart envelope from the same resolved magnifier interval plan. */
  exactChartEnvelope?: {
    readonly firstChartOpen: number;
    readonly finalChartOpen: number;
    readonly finalChartClose: number;
  };
}

interface ExactSecurityDependencyMetadata {
  readonly lookahead: boolean | null;
  readonly expressionPriorBars: number;
}

interface ExactPlannedSecurityDependency extends ResolvedSecurityDependencyIdentity {
  readonly lowerTf: boolean;
  readonly self: boolean;
  readonly symbol: string | null;
  readonly tfSelf: boolean;
  readonly rawTf: string | null;
}

interface ExactStaticSecurityPlan extends ClassifiedRequests {
  readonly exactDependencies: readonly ExactPlannedSecurityDependency[];
}

/** Local additive-contract guard: installed piner declarations may not name these fields yet. */
function hasExactSecurityDependencyMetadata(
  value: SecurityDependency,
): value is SecurityDependency & {
  readonly lookahead: boolean | null;
  readonly expressionPriorBars: number | null;
} {
  if (!isRecord(value)) return false;
  return (
    Object.prototype.hasOwnProperty.call(value, 'lookahead') &&
    Object.prototype.hasOwnProperty.call(value, 'expressionPriorBars')
  );
}

function exactSecurityDependencyMetadata(
  dependency: SecurityDependency,
  dependencyIndex: number,
): ExactSecurityDependencyMetadata {
  if (!hasExactSecurityDependencyMetadata(dependency)) {
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'static-security-compiler-metadata-unavailable',
      message:
        'Bar Magnifier exact security requires piner dependency lookahead and expression-history metadata',
      details: { dependencyIndex, missing: ['lookahead', 'expressionPriorBars'] },
    });
  }

  const lookahead = dependency.lookahead;
  if (dependency.lowerTf) {
    if (lookahead !== null) {
      throw new BarMagnifierError({
        kind: 'unsupported',
        code: 'static-security-compiler-metadata-invalid',
        message:
          'request.security_lower_tf compiler metadata must mark lookahead as not applicable',
        details: { dependencyIndex, lookahead },
      });
    }
  } else if (lookahead === null) {
    throw dynamicSecurityFailure({
      reason: 'plain request.security lookahead is dynamic or unprovable',
      dependencyIndex,
    });
  } else if (typeof lookahead !== 'boolean') {
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'static-security-compiler-metadata-invalid',
      message: 'Plain request.security compiler lookahead metadata must be boolean',
      details: { dependencyIndex, lookahead },
    });
  }

  const expressionPriorBars = dependency.expressionPriorBars;
  if (expressionPriorBars === null) {
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'static-security-expression-history-unbounded',
      message:
        'Bar Magnifier exact security requires a finite compiler proof for requested-expression history',
      details: { dependencyIndex },
    });
  }
  if (!Number.isSafeInteger(expressionPriorBars) || expressionPriorBars < 0) {
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'static-security-expression-history-invalid',
      message: 'Bar Magnifier exact security requires a nonnegative safe expressionPriorBars value',
      details: { dependencyIndex, expressionPriorBars },
    });
  }

  return { lookahead, expressionPriorBars };
}

/**
 * Conservative operation-wide range for callers that still need one envelope.
 * Exact acquisitions independently derive a metadata- and calendar-specific
 * interval per grouped security requirement; this range is never reused as
 * another source's proof boundary.
 */
export function securityRangeForBarMagnifier(
  firstChartOpen: number,
  finalChartClose: number,
  chartCanonicalTf: string,
  dependencies: readonly SecurityDependency[],
): HistoryRange {
  if (
    !Number.isSafeInteger(firstChartOpen) ||
    !Number.isSafeInteger(finalChartClose) ||
    firstChartOpen >= finalChartClose
  ) {
    throw securityRangeOverflow({ firstChartOpen, finalChartClose });
  }

  const exactDependencies = buildExactPlannedSecurityDependencies(dependencies, chartCanonicalTf);
  let from = firstChartOpen;
  let to = finalChartClose;
  for (const dependency of exactDependencies) {
    const rangeTimeframe = dependency.lowerTf
      ? exactLowerSecurityTimeframe(dependency.rawTf!, chartCanonicalTf)
      : dependency.requestedCanonicalTf;
    if (rangeTimeframe === null) continue;
    const duration = exactSecurityDuration(rangeTimeframe);
    const firstRuntimeOpen = exactRuntimeBucketOpen(
      rangeTimeframe,
      firstChartOpen,
      dependency.dependencyIndex,
    );
    const leading = safeSecurityMultiply(
      duration,
      dependency.totalRequiredPriorTargetBars,
      dependency,
    );
    from = Math.min(from, safeSecurityAdd(firstRuntimeOpen, -leading, dependency));
    if (dependency.lookahead === true) {
      const finalRuntimeOpen = exactRuntimeBucketOpen(
        rangeTimeframe,
        finalChartClose - 1,
        dependency.dependencyIndex,
      );
      to = Math.max(to, safeSecurityAdd(finalRuntimeOpen, duration, dependency));
    }
  }
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) {
    throw securityRangeOverflow({ firstChartOpen, finalChartClose, from, to });
  }
  return { from, to: to - 1 };
}

function securityRangeOverflow(details: unknown): BarMagnifierError {
  return new BarMagnifierError({
    kind: 'malformed',
    code: 'security-range-overflow',
    message: 'Bar Magnifier static-security range overflows safe UNIX seconds',
    details,
  });
}

function exactSecurityDuration(timeframe: string): number {
  const duration = canonicalTimeframeSecondsExact(timeframe);
  if (duration.kind !== 'ok') throw exactTimeframeError(duration, timeframe);
  return duration.value;
}

function exactRuntimeBucketOpen(timeframe: string, time: number, dependencyIndex: number): number {
  const duration = exactSecurityDuration(timeframe);
  const anchor = isUtcWeekTimeframe(timeframe) ? PINE_UTC_WEEK_PHASE_SEC : 0;
  const offset = time - anchor;
  const bucket = anchor + Math.floor(offset / duration) * duration;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(bucket)) {
    throw securityRangeOverflow({ timeframe, time, dependencyIndex });
  }
  return bucket;
}

function safeSecurityMultiply(
  left: number,
  right: number,
  dependency: Pick<ResolvedSecurityDependencyIdentity, 'dependencyIndex'>,
): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    throw securityRangeOverflow({
      dependencyIndex: dependency.dependencyIndex,
      left,
      right,
    });
  }
  return value;
}

function safeSecurityAdd(
  value: number,
  delta: number,
  dependency: Pick<ResolvedSecurityDependencyIdentity, 'dependencyIndex'>,
): number {
  const result = value + delta;
  if (!Number.isSafeInteger(result)) {
    throw securityRangeOverflow({
      dependencyIndex: dependency.dependencyIndex,
      value,
      delta,
    });
  }
  return result;
}

/**
 * Classify request.security dependencies from piner's compile-time metadata,
 * WITHOUT running the script. Returns null when any dependency is dynamic (its
 * symbol/timeframe couldn't be resolved statically) — the caller must then fall
 * back to a discovery run. An empty `deps` yields an empty (all-clear) plan.
 */
export function planFromStatic(
  deps: readonly SecurityDependency[],
  chartTf: Timeframe,
): ClassifiedRequests | null {
  return planStaticSecurityRequests(deps, chartTf, false);
}

/** Exact planning consumes only facts bound to piner's post-inline dependency array. */
function planExactStaticSecurityRequests(
  deps: readonly SecurityDependency[],
  chartTf: Timeframe,
): ExactStaticSecurityPlan {
  assertStaticSecurityForBarMagnifier('', deps);
  return {
    ...planStaticSecurityRequests(deps, chartTf, true)!,
    exactDependencies: buildExactPlannedSecurityDependencies(deps, chartTf),
  };
}

function planStaticSecurityRequests(
  deps: readonly SecurityDependency[],
  chartTf: Timeframe,
  exact: boolean,
): ClassifiedRequests | null {
  if (deps.some((dependency) => dependency.dynamic)) return null;
  const crossHtf = new Set<string>();
  const crossPlainSeen = new Set<string>();
  const crossPlain: { symbol: string; rawTf: string | null; lookaheadOn?: true }[] = [];
  const crossLtfSeen = new Set<string>();
  const crossLtf: { symbol: string; rawTf: string }[] = [];
  const selfLtf = new Set<string>();
  const selfPlain = new Set<string>();
  for (const [dependencyIndex, dependency] of deps.entries()) {
    if (dependency.lowerTf) {
      if (dependency.self) {
        if (dependency.timeframe !== null) selfLtf.add(dependency.timeframe);
      } else if (dependency.symbol !== null && dependency.timeframe !== null) {
        const key = `${dependency.symbol}@${dependency.timeframe}`;
        if (!crossLtfSeen.has(key)) {
          crossLtfSeen.add(key);
          crossLtf.push({ symbol: dependency.symbol, rawTf: dependency.timeframe });
        }
      }
    } else if (dependency.self) {
      if (
        dependency.timeframe !== null &&
        (exact
          ? exactSameSymbolTimeframeDiffers(dependency.timeframe, chartTf)
          : resolveSameSymbolFetchTf(dependency.timeframe, chartTf) !== null)
      ) {
        selfPlain.add(dependency.timeframe);
      }
    } else if (dependency.symbol !== null) {
      crossHtf.add(dependency.symbol);
      const rawTf = dependency.tfSelf ? null : dependency.timeframe;
      const lookaheadOn =
        exact && exactSecurityDependencyMetadata(dependency, dependencyIndex).lookahead === true;
      const key = `${dependency.symbol}\u0000${rawTf ?? '<chart>'}\u0000${lookaheadOn ? 'on' : 'off'}`;
      if (!crossPlainSeen.has(key)) {
        crossPlainSeen.add(key);
        crossPlain.push({
          symbol: dependency.symbol,
          rawTf,
          ...(lookaheadOn ? { lookaheadOn: true as const } : {}),
        });
      }
    }
  }
  return {
    crossHtf: [...crossHtf],
    crossPlain,
    crossLtf,
    selfLtfRawTfs: [...selfLtf],
    selfPlainRawTfs: [...selfPlain],
  };
}

function buildExactPlannedSecurityDependencies(
  dependencies: readonly SecurityDependency[],
  chartTf: Timeframe,
): readonly ExactPlannedSecurityDependency[] {
  assertStaticSecurityForBarMagnifier('', dependencies);
  const chartCanonicalTf = exactCanonicalSecurityTimeframe(chartTf, 'chart timeframe');
  return Object.freeze(
    dependencies.map((dependency, dependencyIndex) => {
      const metadata = exactSecurityDependencyMetadata(dependency, dependencyIndex);
      if (
        (dependency.self && dependency.symbol !== null) ||
        (!dependency.self &&
          (typeof dependency.symbol !== 'string' || dependency.symbol.length === 0)) ||
        (dependency.tfSelf && dependency.timeframe !== null) ||
        (!dependency.tfSelf &&
          (typeof dependency.timeframe !== 'string' || dependency.timeframe.length === 0))
      ) {
        throw new BarMagnifierError({
          kind: 'unsupported',
          code: 'static-security-compiler-metadata-invalid',
          message: 'Bar Magnifier received inconsistent static security identity metadata',
          details: { dependencyIndex, dependency },
        });
      }
      const requestedCanonicalTf = dependency.tfSelf
        ? chartCanonicalTf
        : exactPineSecurityTimeframe(dependency.timeframe!);
      const baseMappingPriorBars = exactBaseMappingPriorBars(
        dependency,
        requestedCanonicalTf,
        chartCanonicalTf,
      );
      const totalRequiredPriorTargetBars = baseMappingPriorBars + metadata.expressionPriorBars;
      if (!Number.isSafeInteger(totalRequiredPriorTargetBars)) {
        throw new BarMagnifierError({
          kind: 'unsupported',
          code: 'static-security-expression-history-invalid',
          message: 'Static-security total target-bar history exceeds the safe integer range',
          details: {
            dependencyIndex,
            baseMappingPriorBars,
            expressionPriorBars: metadata.expressionPriorBars,
          },
        });
      }
      return Object.freeze({
        dependencyIndex,
        lowerTf: dependency.lowerTf,
        self: dependency.self,
        symbol: dependency.symbol,
        tfSelf: dependency.tfSelf,
        rawTf: dependency.tfSelf ? null : dependency.timeframe,
        requestedCanonicalTf,
        lookahead: metadata.lookahead,
        expressionPriorBars: metadata.expressionPriorBars,
        baseMappingPriorBars,
        totalRequiredPriorTargetBars,
      });
    }),
  );
}

function exactBaseMappingPriorBars(
  dependency: SecurityDependency,
  requestedCanonicalTf: string,
  chartCanonicalTf: string,
): number {
  if (dependency.lowerTf) return 0;
  const requestedDuration = exactSecurityDuration(requestedCanonicalTf);
  const chartDuration = exactSecurityDuration(chartCanonicalTf);
  const equalDurationShiftedGrid =
    requestedDuration === chartDuration &&
    !(
      pineUtcTimeframeNests(chartCanonicalTf, requestedCanonicalTf) &&
      pineUtcTimeframeNests(requestedCanonicalTf, chartCanonicalTf)
    );
  return requestedDuration > chartDuration || equalDurationShiftedGrid ? 2 : 0;
}

function exactSameSymbolTimeframeDiffers(rawPinerTf: string, chartTf: Timeframe): boolean {
  const requested = pineTimeframeToCanonicalExact(rawPinerTf);
  const chart = parseCanonicalTimeframeExact(chartTf);
  // Preserve malformed/unsupported static identities so exact requirement
  // construction emits its existing typed conversion failure instead of
  // accidentally classifying them as an identity request.
  if (requested.kind !== 'ok' || chart.kind !== 'ok') return true;
  try {
    return !(
      utcTimeframesNest(
        requested.value,
        chart.value.canonical,
        PINE_UTC_WEEK_PHASE_SEC,
        PINE_UTC_WEEK_PHASE_SEC,
      ) &&
      utcTimeframesNest(
        chart.value.canonical,
        requested.value,
        PINE_UTC_WEEK_PHASE_SEC,
        PINE_UTC_WEEK_PHASE_SEC,
      )
    );
  } catch {
    return true;
  }
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
  let exactPlan: ExactStaticSecurityPlan | undefined;
  try {
    const deps =
      opts.staticDependencies ?? compilePinerSource(source).metadata.securityDependencies;
    if (opts.barMagnifierRequested) {
      if (!Array.isArray(deps)) {
        throw new BarMagnifierError({
          kind: 'unsupported',
          code: 'static-security-compiler-metadata-unavailable',
          message:
            'Bar Magnifier exact security requires piner compiler dependency metadata, including an explicit empty dependency array',
          details: { missing: ['securityDependencies'] },
        });
      }
      assertStaticSecurityForBarMagnifier(source, deps);
      exactPlan = planExactStaticSecurityRequests(deps, chartTf);
      cls = exactPlan;
    } else {
      cls = deps ? planFromStatic(deps, chartTf) : null;
    }
  } catch (error) {
    if (error instanceof BarMagnifierError) throw error;
    return { discovered: false }; // compile error — the real runs will surface it
  }

  let discovered = false;
  if (cls === null) {
    if (opts.barMagnifierRequested) {
      // assertStaticSecurityForBarMagnifier normally catches this. Keep the
      // branch fail-closed for runtimes whose metadata shape is incomplete.
      throw dynamicSecurityFailure({ reason: 'static planner returned no exact plan' });
    }
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

  if (opts.barMagnifierRequested) {
    if (!exactPlan) {
      throw dynamicSecurityFailure({ reason: 'static planner returned no exact plan' });
    }
    await resolveExactStaticSecurityPlan(jobs, chartTf, exactPlan, provider, opts);
    return { discovered: false };
  }

  // ── shared cross-symbol bars (fetched once, injected into every job) ──
  const shared: Record<string, Bar[]> = {};
  await mapLimit(cls.crossHtf, opts.concurrency, async (symbol) => {
    try {
      const bars = await provider.history(symbol, chartTf, opts.range);
      if (bars.length) {
        shared[symbol] = bars;
        opts.onFetch?.(symbol, bars.length);
      } else if (opts.barMagnifierRequested) {
        throw staticSecurityUnavailable(symbol);
      }
    } catch (err) {
      // Legacy scans degrade visibly; exact magnifier mode must resolve the
      // complete static plan before execution and therefore fails here.
      opts.onError?.(symbol, errorMessage(err));
      if (opts.barMagnifierRequested) throw err;
    }
  });
  await mapLimit(cls.crossLtf, opts.concurrency, async ({ symbol, rawTf }) => {
    const fetchTf = resolveLowerFetchTf(rawTf, chartTf);
    if (!fetchTf) return;
    try {
      const bars = await provider.history(symbol, fetchTf, opts.range);
      const label = `${symbol}@${rawTf}`;
      if (bars.length) {
        shared[label] = bars;
        opts.onFetch?.(label, bars.length);
      } else if (opts.barMagnifierRequested) {
        throw staticSecurityUnavailable(label);
      }
    } catch (err) {
      const label = `${symbol}@${rawTf}`;
      opts.onError?.(label, errorMessage(err));
      if (opts.barMagnifierRequested) throw err;
    }
  });

  // ── self lower-TF + self plain non-chart TF: fetch each scanned symbol at that TF (deduped) ──
  // lower_tf clamps to a finer TF; a plain self request fetches its EXACT (finer OR higher) TF.
  const selfCache = new Map<string, Bar[]>();
  const selfPlan = [
    ...cls.selfLtfRawTfs.map((rawTf) => ({ rawTf, fetchTf: resolveLowerFetchTf(rawTf, chartTf) })),
    ...cls.selfPlainRawTfs.map((rawTf) => ({
      rawTf,
      fetchTf: resolveSameSymbolFetchTf(rawTf, chartTf),
    })),
  ].filter((e): e is { rawTf: string; fetchTf: Timeframe } => e.fetchTf !== null);

  if (selfPlan.length > 0) {
    await mapLimit(jobs, opts.concurrency, async (job) => {
      for (const { rawTf, fetchTf } of selfPlan) {
        const cacheKey = `${job.symbol}|${fetchTf}`;
        let bars = selfCache.get(cacheKey);
        if (!bars) {
          try {
            bars = await provider.history(job.symbol, fetchTf, opts.range);
            if (bars.length === 0 && opts.barMagnifierRequested) {
              throw staticSecurityUnavailable(`${job.symbol}@${rawTf}`);
            }
          } catch (err) {
            opts.onError?.(`${job.symbol}@${rawTf}`, errorMessage(err));
            if (opts.barMagnifierRequested) throw err;
            bars = []; // legacy mode degrades, but says so
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

type ExactSecurityRequirementKind = ResolvedSecurityRequestKind;

interface ExactSecurityChartEnvelope {
  readonly firstChartOpen: number;
  readonly finalChartOpen: number;
  readonly finalChartClose: number;
}

interface ExactSecurityRequirement {
  readonly kind: ExactSecurityRequirementKind;
  readonly key: string;
  readonly symbol: string;
  readonly targetCanonicalTf: string;
  readonly dependencies: readonly ResolvedSecurityDependencyIdentity[];
  readonly requestedCanonicalTfs: readonly string[];
  readonly lookaheadOnCanonicalTfs: readonly string[];
  readonly chartEnvelopes: readonly ExactSecurityChartEnvelope[];
  readonly jobs: Set<Job>;
}

interface ExactSecurityRequirementDraft {
  readonly kind: ExactSecurityRequirementKind;
  readonly key: string;
  readonly symbol: string;
  readonly targetCanonicalTf: string;
  readonly dependencies: Map<number, ResolvedSecurityDependencyIdentity>;
  readonly chartEnvelopes: Map<Job, ExactSecurityChartEnvelope>;
  readonly jobs: Set<Job>;
}

/**
 * Coverage-aware exact branch used only when Bar Magnifier is effective. It
 * snapshots every dependency and its proof before attaching either to a Job;
 * ordinary scans continue through the legacy history() path above unchanged.
 */
async function resolveExactStaticSecurityPlan(
  jobs: Job[],
  chartTf: Timeframe,
  plan: ExactStaticSecurityPlan,
  provider: HistoryProvider,
  opts: ResolveSecurityOptions,
): Promise<void> {
  const chartEnvelopes = exactSecurityChartEnvelopes(jobs, opts);
  const requirements = exactSecurityRequirements(jobs, chartTf, plan, chartEnvelopes);
  const resolved = new Map<
    ExactSecurityRequirement,
    ReturnType<typeof snapshotSecurityAcquisition>
  >();

  // Acquire and snapshot the complete plan first. No Job is mutated until every
  // dependency has succeeded, so a late partial/missing/unsupported dependency
  // cannot leave an apparently resolved fragment attached to an executable Job.
  await mapLimit([...requirements.values()], opts.concurrency, async (requirement) => {
    const label = requirement.key;
    try {
      const source = await resolveHistorySource(provider, requirement.symbol);
      const targetWeekAnchorSec = isUtcWeekTimeframe(requirement.targetCanonicalTf)
        ? PINE_UTC_WEEK_PHASE_SEC
        : undefined;
      const rangeEvidence = snapshotSecurityAlignmentEvidence(
        source.capabilities,
        targetWeekAnchorSec ?? source.capabilities.weekAnchorSec,
      );
      assertExactSecurityResamplingAlignment(requirement, rangeEvidence);
      const requirementRequested = exactSecurityRangeForRequirement(requirement, rangeEvidence);
      const acquisition = await acquireExactHistory(source, {
        targetTimeframe: requirement.targetCanonicalTf,
        requested: requirementRequested,
        ...(targetWeekAnchorSec !== undefined ? { targetWeekAnchorSec } : {}),
      });
      const alignmentEvidence = snapshotSecurityAlignmentEvidence(
        source.capabilities,
        acquisition.provenance.weekAnchorSec,
      );
      const authenticatedRange = exactSecurityRangeForRequirement(requirement, alignmentEvidence);
      if (
        authenticatedRange.from !== acquisition.requested.from ||
        authenticatedRange.to !== acquisition.requested.to
      ) {
        throw new BarMagnifierError({
          kind: 'malformed',
          code: 'static-security-range-evidence-mismatch',
          message: 'Static-security range changed after authenticated acquisition',
          details: { requirement: requirement.key, requested: acquisition.requested },
        });
      }
      assertExactSecurityResamplingAlignment(requirement, alignmentEvidence);
      resolved.set(
        requirement,
        snapshotSecurityAcquisition(
          acquisition,
          requirement.kind,
          requirement.targetCanonicalTf,
          requirement.symbol,
          requirement.dependencies,
          requirement.requestedCanonicalTfs,
          requirement.lookaheadOnCanonicalTfs,
          alignmentEvidence,
        ),
      );
    } catch (error) {
      opts.onError?.(label, errorMessage(error));
      throw error;
    }
  });

  for (const [requirement, { bars, proof }] of resolved) {
    for (const job of requirement.jobs) {
      (job.securityBars ??= {})[requirement.key] = bars;
      (job.securityProofs ??= {})[requirement.key] = proof;
    }
    opts.onFetch?.(requirement.key, bars.length);
  }
}

function exactSecurityChartEnvelopes(
  jobs: readonly Job[],
  opts: ResolveSecurityOptions,
): ReadonlyMap<Job, ExactSecurityChartEnvelope> {
  const envelopes = new Map<Job, ExactSecurityChartEnvelope>();
  const fallbackClose = opts.range?.to === undefined ? undefined : Number(opts.range.to) + 1;
  for (const job of jobs) {
    const firstChartOpen = job.bars[0]?.time;
    const finalChartOpen = job.bars.at(-1)?.time;
    const magnifierCloseMs = job.magnifier?.chartCloseTimesMs.at(-1);
    const finalChartClose = opts.exactChartEnvelope
      ? opts.exactChartEnvelope.finalChartClose
      : Number.isSafeInteger(magnifierCloseMs) && magnifierCloseMs! % 1_000 === 0
        ? magnifierCloseMs! / 1_000
        : fallbackClose;
    if (
      !Number.isSafeInteger(firstChartOpen) ||
      !Number.isSafeInteger(finalChartOpen) ||
      !Number.isSafeInteger(finalChartClose) ||
      firstChartOpen! >= 1e12 ||
      finalChartOpen! >= 1e12 ||
      firstChartOpen! > finalChartOpen! ||
      finalChartOpen! >= finalChartClose!
    ) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'bar-magnifier-static-security-envelope-unavailable',
        message:
          'Bar Magnifier static-security planning requires a bounded whole-second chart envelope',
        details: { firstChartOpen, finalChartOpen, finalChartClose },
      });
    }
    if (
      opts.exactChartEnvelope &&
      (opts.exactChartEnvelope.firstChartOpen !== firstChartOpen ||
        opts.exactChartEnvelope.finalChartOpen !== finalChartOpen)
    ) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'bar-magnifier-static-security-envelope-mismatch',
        message: 'Resolved static-security chart envelope does not match the Job bars',
        details: {
          expected: opts.exactChartEnvelope,
          actual: { firstChartOpen, finalChartOpen, finalChartClose },
        },
      });
    }
    envelopes.set(
      job,
      Object.freeze({
        firstChartOpen,
        finalChartOpen,
        finalChartClose,
      }) as ExactSecurityChartEnvelope,
    );
  }
  return envelopes;
}

function exactSecurityRequirements(
  jobs: readonly Job[],
  chartTf: Timeframe,
  plan: ExactStaticSecurityPlan,
  chartEnvelopes: ReadonlyMap<Job, ExactSecurityChartEnvelope>,
): Map<string, ExactSecurityRequirement> {
  const drafts = new Map<string, ExactSecurityRequirementDraft>();
  const chartTarget = exactCanonicalSecurityTimeframe(chartTf, 'chart timeframe');
  const crossRequestedBySymbol = new Map<string, Set<string>>();
  for (const dependency of plan.exactDependencies) {
    if (dependency.lowerTf || dependency.self || dependency.symbol === null) continue;
    let requested = crossRequestedBySymbol.get(dependency.symbol);
    if (!requested) {
      requested = new Set();
      crossRequestedBySymbol.set(dependency.symbol, requested);
    }
    requested.add(dependency.requestedCanonicalTf);
  }
  const crossTargetBySymbol = new Map(
    [...crossRequestedBySymbol].map(([symbol, requested]) => [
      symbol,
      exactCrossSymbolSourceTimeframe(symbol, sortCanonicalTimeframes(requested), chartTarget),
    ]),
  );

  const add = (
    identity: string,
    kind: ExactSecurityRequirementKind,
    job: Job,
    key: string,
    symbol: string,
    targetCanonicalTf: string,
    dependency: ExactPlannedSecurityDependency,
  ): void => {
    let requirement = drafts.get(identity);
    if (!requirement) {
      requirement = {
        kind,
        key,
        symbol,
        targetCanonicalTf,
        dependencies: new Map(),
        chartEnvelopes: new Map(),
        jobs: new Set(),
      };
      drafts.set(identity, requirement);
    }
    if (
      requirement.kind !== kind ||
      requirement.key !== key ||
      requirement.symbol !== symbol ||
      requirement.targetCanonicalTf !== targetCanonicalTf
    ) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'static-security-requirement-identity-collision',
        message: 'Bar Magnifier static-security requirements produced a conflicting identity',
        details: { identity, kind, key, symbol, targetCanonicalTf },
      });
    }
    const dependencyIdentity = securityDependencyIdentity(dependency);
    const existing = requirement.dependencies.get(dependency.dependencyIndex);
    if (existing && !sameSecurityDependencyIdentity(existing, dependencyIdentity)) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'static-security-dependency-identity-collision',
        message: 'A compiler dependency index resolved to conflicting exact identities',
        details: { identity, dependencyIndex: dependency.dependencyIndex },
      });
    }
    const envelope = chartEnvelopes.get(job);
    if (!envelope) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'bar-magnifier-static-security-envelope-unavailable',
        message: 'Static-security requirement is missing its chart envelope',
        details: { key },
      });
    }
    requirement.dependencies.set(dependency.dependencyIndex, dependencyIdentity);
    requirement.chartEnvelopes.set(job, envelope);
    requirement.jobs.add(job);
  };

  for (const job of jobs) {
    for (const dependency of plan.exactDependencies) {
      if (dependency.lowerTf) {
        if (dependency.rawTf === null) continue;
        const target = exactLowerSecurityTimeframe(dependency.rawTf, chartTf);
        if (target === null) continue;
        const symbol = dependency.self ? job.symbol : dependency.symbol!;
        add(
          `lower\u0000${symbol}\u0000${dependency.rawTf}\u0000${target}`,
          'lower',
          job,
          `${symbol}@${dependency.rawTf}`,
          symbol,
          target,
          dependency,
        );
        continue;
      }

      if (dependency.self) {
        if (
          dependency.rawTf === null ||
          !exactSameSymbolTimeframeDiffers(dependency.rawTf, chartTf)
        ) {
          continue;
        }
        add(
          `self-plain\u0000${job.symbol}\u0000${dependency.rawTf}\u0000${dependency.requestedCanonicalTf}`,
          'self-plain',
          job,
          `${job.symbol}@${dependency.rawTf}`,
          job.symbol,
          dependency.requestedCanonicalTf,
          dependency,
        );
        continue;
      }

      const symbol = dependency.symbol!;
      add(
        `cross\u0000${symbol}`,
        'cross-plain',
        job,
        symbol,
        symbol,
        crossTargetBySymbol.get(symbol)!,
        dependency,
      );
    }
  }

  return new Map(
    [...drafts].map(([identity, requirement]) => {
      const dependencies = Object.freeze(
        [...requirement.dependencies.values()].sort(
          (left, right) => left.dependencyIndex - right.dependencyIndex,
        ),
      );
      return [
        identity,
        {
          kind: requirement.kind,
          key: requirement.key,
          symbol: requirement.symbol,
          targetCanonicalTf: requirement.targetCanonicalTf,
          dependencies,
          requestedCanonicalTfs: sortCanonicalTimeframes(
            dependencies.map((dependency) => dependency.requestedCanonicalTf),
          ),
          lookaheadOnCanonicalTfs: sortCanonicalTimeframes(
            dependencies
              .filter((dependency) => dependency.lookahead === true)
              .map((dependency) => dependency.requestedCanonicalTf),
          ),
          chartEnvelopes: Object.freeze([...requirement.chartEnvelopes.values()]),
          jobs: requirement.jobs,
        },
      ];
    }),
  );
}

function securityDependencyIdentity(
  dependency: ExactPlannedSecurityDependency,
): ResolvedSecurityDependencyIdentity {
  return Object.freeze({
    dependencyIndex: dependency.dependencyIndex,
    requestedCanonicalTf: dependency.requestedCanonicalTf,
    lookahead: dependency.lookahead,
    expressionPriorBars: dependency.expressionPriorBars,
    baseMappingPriorBars: dependency.baseMappingPriorBars,
    totalRequiredPriorTargetBars: dependency.totalRequiredPriorTargetBars,
  });
}

function sameSecurityDependencyIdentity(
  left: ResolvedSecurityDependencyIdentity,
  right: ResolvedSecurityDependencyIdentity,
): boolean {
  return (
    left.dependencyIndex === right.dependencyIndex &&
    left.requestedCanonicalTf === right.requestedCanonicalTf &&
    left.lookahead === right.lookahead &&
    left.expressionPriorBars === right.expressionPriorBars &&
    left.baseMappingPriorBars === right.baseMappingPriorBars &&
    left.totalRequiredPriorTargetBars === right.totalRequiredPriorTargetBars
  );
}

function exactCrossSymbolSourceTimeframe(
  symbol: string,
  requestedCanonicalTfs: readonly string[],
  chartCanonicalTf: string,
): string {
  const chart = canonicalTimeframeSecondsExact(chartCanonicalTf);
  if (chart.kind !== 'ok') throw exactTimeframeError(chart, chartCanonicalTf);
  const requested = requestedCanonicalTfs.map((timeframe) => {
    const duration = canonicalTimeframeSecondsExact(timeframe);
    if (duration.kind !== 'ok') throw exactTimeframeError(duration, timeframe);
    if (duration.value < chart.value) {
      throw new BarMagnifierError({
        kind: 'unsupported',
        code: 'cross-symbol-plain-lower-timeframe-unsupported',
        message:
          `Bar Magnifier exact mode cannot safely execute cross-symbol request.security(${symbol}, ${timeframe}) ` +
          `below the ${chartCanonicalTf} chart timeframe with the loaded piner runtime`,
        details: {
          symbol,
          requestedCanonicalTf: timeframe,
          chartCanonicalTf,
        },
      });
    }
    if (duration.value % chart.value !== 0) {
      throw new BarMagnifierError({
        kind: 'unsupported',
        code: 'cross-symbol-plain-timeframe-resampling-unsupported',
        message:
          `Bar Magnifier exact mode cannot form ${timeframe} exactly from ${chartCanonicalTf} ` +
          `cross-symbol source bars`,
        details: {
          symbol,
          requestedCanonicalTf: timeframe,
          chartCanonicalTf,
        },
      });
    }
    return { timeframe, duration: duration.value };
  });

  // Prefer the chart source, then a requested grid, when one source grid tiles
  // every request sharing piner's single cross-symbol injection key.
  const candidates = [
    chartCanonicalTf,
    ...requested
      .slice()
      .sort((left, right) => left.duration - right.duration)
      .map((value) => value.timeframe),
  ];
  for (const candidate of new Set(candidates)) {
    if (requested.every(({ timeframe }) => pineUtcTimeframeNests(candidate, timeframe))) {
      return candidate;
    }
  }

  // Pine W (universal Monday phase -259200) and elapsed 7D (epoch phase 0)
  // have a common epoch-aligned daily tiler. Derive the largest common fixed UTC grid so one
  // provider-backed dataset can safely represent both requests.
  let commonSeconds = 0;
  for (const { timeframe, duration } of requested) {
    commonSeconds = greatestCommonDivisor(commonSeconds, duration);
    commonSeconds = greatestCommonDivisor(
      commonSeconds,
      Math.abs(utcTimeframeAnchor(timeframe, PINE_UTC_WEEK_PHASE_SEC)),
    );
  }
  if (commonSeconds > 0) return canonicalFixedTimeframe(commonSeconds);

  throw new BarMagnifierError({
    kind: 'unsupported',
    code: 'cross-symbol-plain-timeframe-grid-unsupported',
    message:
      `Bar Magnifier exact mode cannot select one UTC source grid for ${symbol} requests ` +
      requestedCanonicalTfs.join(', '),
    details: { symbol, requestedCanonicalTfs, chartCanonicalTf },
  });
}

function pineUtcTimeframeNests(sourceTimeframe: string, targetTimeframe: string): boolean {
  try {
    return utcTimeframesNest(
      sourceTimeframe,
      targetTimeframe,
      PINE_UTC_WEEK_PHASE_SEC,
      PINE_UTC_WEEK_PHASE_SEC,
    );
  } catch {
    return false;
  }
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function canonicalFixedTimeframe(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function assertExactSecurityResamplingAlignment(
  requirement: ExactSecurityRequirement,
  evidence: ResolvedSecurityAlignmentEvidence,
): void {
  const unrepresented = exactSecurityUnrepresentedTimeframes(requirement, evidence);
  if (unrepresented.length === 0) return;

  if (evidence.kind === 'exchange-calendar') {
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'cross-symbol-plain-exchange-calendar-resampling-unsupported',
      message:
        `Bar Magnifier exact mode cannot safely resample exchange-aligned ${requirement.targetCanonicalTf} ` +
        `bars for cross-symbol request.security timeframes ${unrepresented.join(', ')} with the loaded piner runtime`,
      details: {
        symbol: requirement.symbol,
        sourceCanonicalTf: requirement.targetCanonicalTf,
        requestedCanonicalTfs: unrepresented,
        calendarId: evidence.calendar.calendarId,
        calendarVersion: evidence.calendar.version,
      },
    });
  }

  throw new BarMagnifierError({
    kind: 'unsupported',
    code: 'static-security-utc-grid-unsupported',
    message:
      `Bar Magnifier exact mode cannot form Pine UTC timeframes ${unrepresented.join(', ')} ` +
      `from ${requirement.targetCanonicalTf} bars on the resolved provider grid`,
    details: {
      symbol: requirement.symbol,
      sourceCanonicalTf: requirement.targetCanonicalTf,
      sourceWeekAnchorSec: isUtcWeekTimeframe(requirement.targetCanonicalTf)
        ? (evidence.weekAnchorSec ?? null)
        : utcTimeframeAnchor(requirement.targetCanonicalTf),
      requestedCanonicalTfs: unrepresented,
      pineWeekAnchorSec: PINE_UTC_WEEK_PHASE_SEC,
    },
  });
}

function exactSecurityUnrepresentedTimeframes(
  requirement: ExactSecurityRequirement,
  evidence: ResolvedSecurityAlignmentEvidence,
): string[] {
  if (evidence.kind === 'exchange-calendar') {
    if (requirement.kind !== 'cross-plain') return [];
    return requirement.requestedCanonicalTfs.filter(
      (timeframe) => !sameCanonicalSecurityTimeframe(requirement.targetCanonicalTf, timeframe),
    );
  }

  return requirement.requestedCanonicalTfs.filter((timeframe) => {
    try {
      return !utcTimeframesNest(
        requirement.targetCanonicalTf,
        timeframe,
        evidence.weekAnchorSec,
        PINE_UTC_WEEK_PHASE_SEC,
      );
    } catch {
      return true;
    }
  });
}

function sameCanonicalSecurityTimeframe(left: string, right: string): boolean {
  const a = parseCanonicalTimeframeExact(left);
  const b = parseCanonicalTimeframeExact(right);
  return a.kind === 'ok' && b.kind === 'ok' && a.value.canonical === b.value.canonical;
}

function sortCanonicalTimeframes(values: Iterable<string>): readonly string[] {
  return Object.freeze(
    [...new Set(values)].sort((left, right) => {
      const a = canonicalTimeframeSecondsExact(left);
      const b = canonicalTimeframeSecondsExact(right);
      if (a.kind === 'ok' && b.kind === 'ok' && a.value !== b.value) return a.value - b.value;
      return left.localeCompare(right);
    }),
  );
}

/** Derive the exact contiguous acquisition envelope for one grouped runtime key. */
function exactSecurityRangeForRequirement(
  requirement: ExactSecurityRequirement,
  evidence: ResolvedSecurityAlignmentEvidence,
): HalfOpenIntervalSec {
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;

  for (const dependency of requirement.dependencies) {
    const runtimeTimeframe =
      requirement.kind === 'lower'
        ? requirement.targetCanonicalTf
        : dependency.requestedCanonicalTf;
    const duration = exactSecurityDuration(runtimeTimeframe);
    for (const envelope of requirement.chartEnvelopes) {
      const firstRuntimeOpen = exactRuntimeBucketOpen(
        runtimeTimeframe,
        envelope.firstChartOpen,
        dependency.dependencyIndex,
      );
      let runtimeFrom: number;
      if (evidence.kind === 'exchange-calendar') {
        runtimeFrom = exactExchangeSecurityHistoryStart(
          requirement,
          dependency,
          runtimeTimeframe,
          firstRuntimeOpen,
          evidence.calendar,
        );
      } else {
        const leading = safeSecurityMultiply(
          duration,
          dependency.totalRequiredPriorTargetBars,
          dependency,
        );
        runtimeFrom = safeSecurityAdd(firstRuntimeOpen, -leading, dependency);
      }
      let runtimeTo = envelope.finalChartClose;
      if (dependency.lookahead === true) {
        const finalRuntimeOpen = exactRuntimeBucketOpen(
          runtimeTimeframe,
          envelope.finalChartOpen,
          dependency.dependencyIndex,
        );
        runtimeTo = Math.max(runtimeTo, safeSecurityAdd(finalRuntimeOpen, duration, dependency));
      }
      if (!Number.isSafeInteger(runtimeTo) || runtimeFrom >= runtimeTo) {
        throw securityRangeOverflow({
          key: requirement.key,
          dependencyIndex: dependency.dependencyIndex,
          runtimeFrom,
          runtimeTo,
        });
      }

      const dependencyRange =
        evidence.kind === 'exchange-calendar'
          ? exactExchangeSecurityRange(
              requirement,
              dependency,
              runtimeFrom,
              runtimeTo,
              evidence.calendar,
            )
          : halfOpenIntervalSec(runtimeFrom, runtimeTo);
      from = Math.min(from, dependencyRange.from);
      to = Math.max(to, dependencyRange.to);
    }
  }

  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) {
    throw securityRangeOverflow({ key: requirement.key, from, to });
  }
  return halfOpenIntervalSec(from, to);
}

/**
 * Resolve compiler-required target history against populated exchange buckets,
 * not elapsed nominal time. Calendar closures can span arbitrarily many UTC
 * buckets without contributing an input bar to piner's resampled series.
 */
function exactExchangeSecurityHistoryStart(
  requirement: ExactSecurityRequirement,
  dependency: ResolvedSecurityDependencyIdentity,
  runtimeTimeframe: string,
  firstRuntimeOpen: number,
  calendar: HistorySessionCalendar,
): number {
  const required = dependency.totalRequiredPriorTargetBars;
  if (required === 0) return firstRuntimeOpen;

  const populatedRuntimeBuckets = new Set<number>();
  const addTargetOpen = (
    targetOpen: number,
    period?: ReturnType<typeof calendarSessionPeriods>[number],
  ): number | undefined => {
    const runtimeOpen = exactRuntimeBucketOpen(
      runtimeTimeframe,
      targetOpen,
      dependency.dependencyIndex,
    );
    if (runtimeOpen >= firstRuntimeOpen) return undefined;
    if (period) assertCalendarPeriodCoverage(calendar, period);
    if (populatedRuntimeBuckets.has(runtimeOpen)) return undefined;
    populatedRuntimeBuckets.add(runtimeOpen);
    return populatedRuntimeBuckets.size === required ? runtimeOpen : undefined;
  };

  if (isCalendarSessionTimeframe(requirement.targetCanonicalTf)) {
    const periods = calendarSessionPeriods(calendar, requirement.targetCanonicalTf);
    for (let index = periods.length - 1; index >= 0; index--) {
      const selected = addTargetOpen(periods[index]!.from, periods[index]);
      if (selected !== undefined) return selected;
    }
  } else {
    const targetDuration = exactSecurityDuration(requirement.targetCanonicalTf);
    for (let sessionIndex = calendar.sessions.length - 1; sessionIndex >= 0; sessionIndex--) {
      const session = calendar.sessions[sessionIndex]!;
      const span = session.to - session.from;
      const completeTargetBars = Math.floor(span / targetDuration);
      if (!Number.isSafeInteger(span) || !Number.isSafeInteger(completeTargetBars)) {
        throw securityRangeOverflow({
          key: requirement.key,
          dependencyIndex: dependency.dependencyIndex,
          session,
          targetDuration,
        });
      }
      for (let barIndex = completeTargetBars - 1; barIndex >= 0; barIndex--) {
        const targetOpen = session.from + barIndex * targetDuration;
        if (!Number.isSafeInteger(targetOpen)) {
          throw securityRangeOverflow({
            key: requirement.key,
            dependencyIndex: dependency.dependencyIndex,
            session,
            targetDuration,
            barIndex,
          });
        }
        const selected = addTargetOpen(targetOpen);
        if (selected !== undefined) return selected;
      }
    }
  }

  throw new BarMagnifierError({
    kind: 'provider-limited',
    code: 'static-security-history-calendar-coverage-insufficient',
    message:
      'Static security exchange-calendar evidence does not prove enough populated prior runtime buckets',
    details: {
      key: requirement.key,
      dependencyIndex: dependency.dependencyIndex,
      requestedCanonicalTf: dependency.requestedCanonicalTf,
      targetCanonicalTf: requirement.targetCanonicalTf,
      runtimeTimeframe,
      firstRuntimeOpen,
      requiredPriorTargetBars: required,
      availablePriorRuntimeBuckets: populatedRuntimeBuckets.size,
      calendarId: calendar.calendarId,
      calendarVersion: calendar.version,
      calendarCoverage: calendar.coverage,
    },
  });
}

/**
 * Exchange provider bars are session/period aligned while piner groups their
 * opens on UTC runtime buckets. Prove both runtime boundaries, then include the
 * complete provider bar for every aligned open inside the required span.
 */
function exactExchangeSecurityRange(
  requirement: ExactSecurityRequirement,
  dependency: ResolvedSecurityDependencyIdentity,
  runtimeFrom: number,
  runtimeTo: number,
  calendar: HistorySessionCalendar,
): HalfOpenIntervalSec {
  if (calendar.coverage.from > runtimeFrom || calendar.coverage.to < runtimeTo) {
    throw new BarMagnifierError({
      kind: 'provider-limited',
      code:
        dependency.lookahead === true
          ? 'static-security-lookahead-calendar-coverage-insufficient'
          : 'static-security-runtime-bucket-calendar-coverage-insufficient',
      message:
        'Static security requires exchange-calendar evidence for both runtime-bucket boundaries',
      details: {
        key: requirement.key,
        dependencyIndex: dependency.dependencyIndex,
        runtimeBuckets: { from: runtimeFrom, to: runtimeTo },
        calendarId: calendar.calendarId,
        calendarVersion: calendar.version,
        calendarCoverage: calendar.coverage,
      },
    });
  }

  let from = runtimeFrom;
  let to = runtimeTo;
  if (isCalendarSessionTimeframe(requirement.targetCanonicalTf)) {
    for (const period of calendarSessionPeriods(calendar, requirement.targetCanonicalTf)) {
      if (period.from < runtimeFrom || period.from >= runtimeTo) continue;
      assertCalendarPeriodCoverage(calendar, period);
      from = Math.min(from, period.from);
      to = Math.max(to, period.to);
    }
    return halfOpenIntervalSec(from, to);
  }

  const duration = exactSecurityDuration(requirement.targetCanonicalTf);
  for (const session of calendar.sessions) {
    const openLimit = Math.min(runtimeTo, session.to);
    if (runtimeFrom >= openLimit || session.from >= runtimeTo) continue;
    const stepsToFirst = Math.max(0, Math.ceil((runtimeFrom - session.from) / duration));
    const firstOpen = session.from + stepsToFirst * duration;
    if (firstOpen >= openLimit || firstOpen + duration > session.to) continue;
    const stepsToLast = Math.floor((openLimit - 1 - firstOpen) / duration);
    const lastOpen = firstOpen + stepsToLast * duration;
    const lastClose = lastOpen + duration;
    if (!Number.isSafeInteger(firstOpen) || !Number.isSafeInteger(lastClose)) {
      throw securityRangeOverflow({
        key: requirement.key,
        dependencyIndex: dependency.dependencyIndex,
        session,
      });
    }
    from = Math.min(from, firstOpen);
    to = Math.max(to, lastClose);
  }
  return halfOpenIntervalSec(from, to);
}

function exactCanonicalSecurityTimeframe(timeframe: string, label: string): string {
  const result = parseCanonicalTimeframeExact(timeframe);
  if (result.kind !== 'ok') {
    throw new ExactHistoryError({
      kind: result.kind,
      code: result.code,
      message: result.message,
      details: { label, timeframe },
    });
  }
  if (result.value.domain !== 'fixed') {
    const duration = canonicalTimeframeSecondsExact(timeframe);
    if (duration.kind !== 'ok') {
      throw new ExactHistoryError({
        kind: duration.kind,
        code: duration.code,
        message: duration.message,
        details: { label, timeframe },
      });
    }
  }

  // Jobs carry Pine's minute spelling (`60`), while callers commonly supply
  // canonical hour aliases (`1h`). Normalize only that equivalent fixed alias
  // so resolver-created and execution-recomputed proofs have one identity.
  return result.value.domain === 'fixed' && result.value.unit === 'h'
    ? `${result.value.count * 60}m`
    : result.value.canonical;
}

function exactPineSecurityTimeframe(rawTf: string): string {
  const result = pineTimeframeToCanonicalExact(rawTf);
  if (result.kind !== 'ok') {
    throw new ExactHistoryError({
      kind: result.kind,
      code: result.code,
      message: result.message,
      details: { rawTf },
    });
  }
  return result.value;
}

/** Exact counterpart of the legacy lower-TF planner: preserve valid requested
 * finer intervals, use piner's established 1m degradation for equal/coarser
 * requests, and reject (rather than clamp) an unparseable static identity. */
function exactLowerSecurityTimeframe(rawTf: string, chartTf: Timeframe): string | null {
  const requested = exactPineSecurityTimeframe(rawTf);
  const requestedDuration = canonicalTimeframeSecondsExact(requested);
  const chartDuration = canonicalTimeframeSecondsExact(chartTf);
  if (requestedDuration.kind !== 'ok') throw exactTimeframeError(requestedDuration, rawTf);
  if (chartDuration.kind !== 'ok') throw exactTimeframeError(chartDuration, chartTf);
  if (requestedDuration.value < chartDuration.value) return requested;
  return chartDuration.value > 60 ? '1m' : null;
}

function exactTimeframeError(
  result: { kind: 'unsupported' | 'malformed'; code: string; message: string },
  timeframe: string,
): ExactHistoryError {
  return new ExactHistoryError({
    kind: result.kind,
    code: result.code,
    message: result.message,
    details: { timeframe },
  });
}

export type SecurityDatasetAcquisitionKeyInput = Omit<
  ResolvedSecurityDatasetProof,
  'acquisitionKey'
>;

/** Canonical execution identity binding coverage and source evidence to exact bar content. */
export function securityDatasetAcquisitionKey(input: SecurityDatasetAcquisitionKeyInput): string {
  return `security-dataset-acquisition-v2:${canonicalDigest({
    requestKind: input.requestKind,
    requestedSymbol: input.requestedSymbol,
    dependencies: input.dependencies,
    requestedCanonicalTfs: input.requestedCanonicalTfs,
    lookaheadOnCanonicalTfs: input.lookaheadOnCanonicalTfs,
    targetCanonicalTf: input.targetCanonicalTf,
    requested: input.requested,
    covered: input.covered,
    gaps: input.gaps,
    complete: input.complete,
    provenance: input.provenance,
    alignmentEvidence: input.alignmentEvidence,
    barsDigest: input.barsDigest,
    completenessPolicy: 'bar-derived-exact-complete-v2',
  })}`;
}

/** Internal worker-channel authority; intentionally not exported from the package entrypoint. */
export function isResolverIssuedSecurityProof(
  value: unknown,
): value is ResolvedSecurityDatasetProof {
  return isRecord(value) && resolverIssuedSecurityProofs.has(value);
}

/** Canonically binds a resolver-issued proof to one wire key under a per-worker secret. */
export function securityProofWireAuthenticator(
  secret: string,
  key: string,
  proof: ResolvedSecurityDatasetProof,
): string {
  if (!validSecurityProofAuthSecret(secret)) {
    throw new TypeError('pinerun: invalid worker static-security authentication secret');
  }
  return `security-proof-wire-auth-v1:${canonicalDigest({
    domain: 'pinerun-static-security-worker-v1',
    secret,
    key,
    proof,
  })}`;
}

/** Initialize once inside a worker from private workerData supplied by its parent handle. */
export function initializeWorkerSecurityProofAuthentication(secret: string): void {
  if (!validSecurityProofAuthSecret(secret)) {
    throw new TypeError('pinerun: invalid worker static-security authentication secret');
  }
  if (workerSecurityProofAuthSecret !== undefined && workerSecurityProofAuthSecret !== secret) {
    throw new Error('pinerun: worker static-security authentication was already initialized');
  }
  workerSecurityProofAuthSecret = secret;
}

/** Restore process-local authority only after a worker verifies its parent-bound authenticator. */
export function authenticateHydratedSecurityProof(
  key: string,
  proof: ResolvedSecurityDatasetProof,
  authenticator: unknown,
): boolean {
  const secret = workerSecurityProofAuthSecret;
  if (secret === undefined || typeof authenticator !== 'string') return false;
  let expected: string;
  try {
    expected = securityProofWireAuthenticator(secret, key, proof);
  } catch {
    return false;
  }
  if (!constantTimeTextEqual(authenticator, expected)) return false;
  resolverIssuedSecurityProofs.add(proof);
  return true;
}

function validSecurityProofAuthSecret(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function snapshotSecurityAlignmentEvidence(
  capabilities: HistoryCapabilities,
  acquisitionWeekAnchorSec?: UnixSecond,
): ResolvedSecurityAlignmentEvidence {
  if (capabilities.alignment === 'utc-24x7') {
    return Object.freeze({
      kind: 'utc-24x7',
      ...(acquisitionWeekAnchorSec !== undefined
        ? { weekAnchorSec: acquisitionWeekAnchorSec }
        : {}),
    });
  }
  if (capabilities.alignment === 'exchange-calendar' && capabilities.calendar) {
    return Object.freeze({
      kind: 'exchange-calendar',
      calendar: snapshotHistorySessionCalendar(capabilities.calendar),
    });
  }
  throw new ExactHistoryError({
    kind: 'unsupported',
    code:
      capabilities.alignment === 'exchange-calendar'
        ? 'calendar-metadata-missing'
        : 'unknown-alignment',
    message:
      capabilities.alignment === 'exchange-calendar'
        ? 'pinery: exchange-calendar static security requires explicit calendar metadata'
        : 'pinery: exact static security requires proven UTC or exchange-calendar alignment',
  });
}

function snapshotSecurityAcquisition(
  acquisition: HistoryAcquisition,
  requestKind: ExactSecurityRequirementKind,
  targetCanonicalTf: string,
  requestedSymbol: string,
  dependencies: readonly ResolvedSecurityDependencyIdentity[],
  requestedCanonicalTfs: readonly string[],
  lookaheadOnCanonicalTfs: readonly string[],
  alignmentEvidence: ResolvedSecurityAlignmentEvidence,
): { bars: Bar[]; proof: ResolvedSecurityDatasetProof } {
  if (acquisition.truncated) {
    throw new ExactHistoryError({
      kind: 'provider-limited',
      code: 'static-security-provider-truncated',
      message: `pinery: ${requestedSymbol} ${targetCanonicalTf} static-security acquisition was truncated`,
      details: { requestedSymbol, targetCanonicalTf },
      requested: acquisition.requested,
      covered: acquisition.covered,
      gaps: acquisition.gaps,
      truncated: acquisition.truncated,
    });
  }
  const immutable = registerOwnedImmutableBars(
    Object.freeze(acquisition.bars.map((bar) => Object.freeze({ ...bar }))),
  );
  // Job keeps the historical mutable-array type for compatibility; this exact
  // branch deliberately supplies a deeply frozen owned snapshot.
  const bars = immutable as unknown as Bar[];
  const interval = (value: HalfOpenIntervalSec): HalfOpenIntervalSec =>
    Object.freeze({ from: value.from, to: value.to });
  const gap = (value: CoverageGapSec): CoverageGapSec =>
    Object.freeze({ from: value.from, to: value.to, reason: value.reason });
  const provenance = Object.freeze({ ...acquisition.provenance }) as AcquisitionProvenance;
  const bound = {
    requestKind,
    requestedSymbol,
    dependencies: Object.freeze(dependencies.map((dependency) => Object.freeze({ ...dependency }))),
    requestedCanonicalTfs: Object.freeze([...requestedCanonicalTfs]),
    lookaheadOnCanonicalTfs: Object.freeze([...lookaheadOnCanonicalTfs]),
    targetCanonicalTf,
    requested: interval(acquisition.requested),
    covered: Object.freeze(acquisition.covered.map(interval)),
    gaps: Object.freeze(acquisition.gaps.map(gap)),
    complete: acquisition.complete,
    provenance,
    alignmentEvidence,
    barsDigest: marketDataDigest(immutable),
  } satisfies SecurityDatasetAcquisitionKeyInput;
  const proof = Object.freeze({
    ...bound,
    acquisitionKey: securityDatasetAcquisitionKey(bound),
  }) satisfies ResolvedSecurityDatasetProof;
  resolverIssuedSecurityProofs.add(proof);
  return { bars, proof };
}

export interface ResolverIssuedSecurityPrefix {
  readonly securityBars?: Record<string, Bar[]>;
  readonly securityProofs?: Record<string, ResolvedSecurityDatasetProof>;
}

/**
 * Derive an authoritative in-sample view from full-fold exact security data.
 * Only lower-TF requests are clipped: HTF/lookahead datasets retain their full
 * resolver-issued objects because their legitimately exposed bucket may close
 * after the chart prefix.
 */
export function deriveResolverIssuedSecurityPrefix(
  securityBars: Job['securityBars'],
  securityProofs: Job['securityProofs'],
  finalChartClose: number,
): ResolverIssuedSecurityPrefix {
  if (securityBars === undefined && securityProofs === undefined) return Object.freeze({});
  if (
    securityBars === undefined ||
    securityProofs === undefined ||
    !Number.isSafeInteger(finalChartClose)
  ) {
    throw securityPrefixAuthorityFailure(
      'Walk-forward static-security prefixes require paired exact datasets and a whole-second close',
    );
  }

  const barKeys = Object.keys(securityBars).sort();
  const proofKeys = Object.keys(securityProofs).sort();
  if (!sameStrings(barKeys, proofKeys)) {
    throw securityPrefixAuthorityFailure(
      'Walk-forward static-security prefixes require matching bars/proof keys',
    );
  }

  const derivedBars: Record<string, Bar[]> = {};
  const derivedProofs: Record<string, ResolvedSecurityDatasetProof> = {};
  let copied = false;
  for (const key of barKeys) {
    const bars = securityBars[key]!;
    const proof = securityProofs[key]!;
    let expectedKey: string | undefined;
    try {
      const { acquisitionKey: _ignored, ...bound } = proof;
      expectedKey = securityDatasetAcquisitionKey(bound);
    } catch {
      // Report the same authority failure below without exposing partial views.
    }
    if (
      !deeplyFrozen(bars) ||
      !deeplyFrozen(proof) ||
      !isResolverIssuedSecurityProof(proof) ||
      proof.barsDigest !== marketDataDigest(bars) ||
      expectedKey === undefined ||
      proof.acquisitionKey !== expectedKey
    ) {
      throw securityPrefixAuthorityFailure(
        `Walk-forward static-security prefix ${key} is not resolver-issued and content-authenticated`,
      );
    }

    if (proof.requestKind !== 'lower' || finalChartClose === proof.requested.to) {
      derivedBars[key] = bars;
      derivedProofs[key] = proof;
      continue;
    }
    if (
      !validInterval(proof.requested) ||
      finalChartClose <= proof.requested.from ||
      finalChartClose > proof.requested.to
    ) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'walkforward-static-security-prefix-mismatch',
        message: `Walk-forward static-security prefix ${key} is outside the resolved fold envelope`,
        details: { key, finalChartClose, requested: proof.requested },
      });
    }

    const requested = Object.freeze({
      from: proof.requested.from,
      to: unixSecond(finalChartClose),
    }) as HalfOpenIntervalSec;
    const clip = <T extends { readonly from: number; readonly to: number }>(
      interval: T,
    ): T | undefined => {
      const from = Math.max(interval.from, requested.from);
      const to = Math.min(interval.to, requested.to);
      return from < to ? (Object.freeze({ ...interval, from, to }) as T) : undefined;
    };
    const covered = Object.freeze(
      proof.covered
        .map(clip)
        .filter((interval): interval is NonNullable<typeof interval> => interval !== undefined),
    );
    const gaps = Object.freeze(
      proof.gaps
        .map(clip)
        .filter((interval): interval is NonNullable<typeof interval> => interval !== undefined),
    );
    const immutable = registerOwnedImmutableBars(
      Object.freeze(bars.filter((bar) => bar.time < finalChartClose)),
    );
    const prefixBars = immutable as unknown as Bar[];
    const { acquisitionKey: _oldKey, ...fullBound } = proof;
    const prefixBound = {
      ...fullBound,
      requested,
      covered,
      gaps,
      complete: gaps.length === 0,
      barsDigest: marketDataDigest(prefixBars),
    } satisfies SecurityDatasetAcquisitionKeyInput;
    const prefixProof = Object.freeze({
      ...prefixBound,
      acquisitionKey: securityDatasetAcquisitionKey(prefixBound),
    }) satisfies ResolvedSecurityDatasetProof;
    resolverIssuedSecurityProofs.add(prefixProof);
    derivedBars[key] = prefixBars;
    derivedProofs[key] = prefixProof;
    copied = true;
  }

  if (!copied) return Object.freeze({ securityBars, securityProofs });
  return Object.freeze({
    securityBars: Object.freeze(derivedBars),
    securityProofs: Object.freeze(derivedProofs),
  });
}

function securityPrefixAuthorityFailure(message: string): BarMagnifierError {
  return new BarMagnifierError({
    kind: 'malformed',
    code: 'walkforward-static-security-prefix-authority',
    message,
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/**
 * Exact-mode gate. Every accepted fact comes from piner's exact post-inline
 * dependency object; the source text is deliberately not parsed or zipped to
 * compiler output. Non-magnifier discovery/classification remains unchanged.
 */
export function assertStaticSecurityForBarMagnifier(
  _source: string,
  dependencies: readonly SecurityDependency[],
): void {
  const dynamicDependencies: Array<{
    readonly dependency: SecurityDependency;
    readonly index: number;
  }> = [];
  for (const [index, dependency] of dependencies.entries()) {
    // Validate the additive compiler contract even for a dynamic dependency so
    // an older piner fails with the explicit metadata-unavailable code.
    exactSecurityDependencyMetadata(dependency, index);
    if (dependency.dynamic) dynamicDependencies.push({ dependency, index });
  }
  if (dynamicDependencies.length === 0) return;

  throw dynamicSecurityFailure({
    dynamicDependencies: dynamicDependencies.map(({ dependency, index }) => ({
      index,
      lowerTf: dependency.lowerTf,
      self: dependency.self,
      symbol: dependency.symbol,
      timeframe: dependency.timeframe,
    })),
  });
}

/**
 * Execution-boundary proof that every statically planned request dataset is
 * already attached. This does not fetch or discover; it independently rebuilds
 * each requirement, compiler identity, and metadata-specific range before piner
 * executes it.
 */
export function assertResolvedSecurityForBarMagnifier(
  source: string,
  dependencies: readonly SecurityDependency[],
  job: Pick<Job, 'symbol' | 'timeframe' | 'bars' | 'magnifier' | 'securityBars' | 'securityProofs'>,
): void {
  assertStaticSecurityForBarMagnifier(source, dependencies);
  if (dependencies.length === 0) return;

  const chartTfResult = pineTimeframeToCanonicalExact(job.timeframe);
  if (chartTfResult.kind !== 'ok') {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'bar-magnifier-chart-timeframe-unresolvable',
      message: `Cannot resolve chart timeframe ${job.timeframe} for exact security planning`,
      details: { chartPineTf: job.timeframe },
    });
  }
  const chartTf = chartTfResult.value;
  const plan = planExactStaticSecurityRequests(dependencies, chartTf);

  const firstChartOpen = job.bars[0]?.time;
  const finalChartOpen = job.bars.at(-1)?.time;
  const finalCloseMs = job.magnifier?.chartCloseTimesMs.at(-1);
  const finalChartClose =
    Number.isSafeInteger(finalCloseMs) && finalCloseMs! % 1_000 === 0
      ? finalCloseMs! / 1_000
      : undefined;
  if (
    !Number.isSafeInteger(firstChartOpen) ||
    !Number.isSafeInteger(finalChartOpen) ||
    !Number.isSafeInteger(finalChartClose) ||
    firstChartOpen! >= 1e12 ||
    finalChartOpen! >= 1e12 ||
    firstChartOpen! > finalChartOpen! ||
    finalChartOpen! >= finalChartClose!
  ) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'bar-magnifier-static-security-envelope-unavailable',
      message:
        'Bar Magnifier static-security proof validation requires the resolved whole-second chart envelope',
      details: { firstChartOpen, finalChartOpen, finalCloseMs },
    });
  }

  const exactJob = job as Job;
  const chartEnvelope = Object.freeze({
    firstChartOpen: firstChartOpen!,
    finalChartOpen: finalChartOpen!,
    finalChartClose: finalChartClose!,
  });
  const requirements = exactSecurityRequirements(
    [exactJob],
    chartTf,
    plan,
    new Map([[exactJob, chartEnvelope]]),
  );

  const missing: string[] = [];
  const invalid: { key: string; reasons: string[] }[] = [];
  const required: Array<{ key: string; requested?: HalfOpenIntervalSec }> = [];
  for (const requirement of requirements.values()) {
    const hasBars = Object.prototype.hasOwnProperty.call(job.securityBars ?? {}, requirement.key);
    const bars = job.securityBars?.[requirement.key];
    const proof = job.securityProofs?.[requirement.key];
    if (!hasBars || !bars || !proof) {
      missing.push(requirement.key);
      continue;
    }

    const reasons: string[] = [];
    const reason = (value: string): void => {
      if (!reasons.includes(value)) reasons.push(value);
    };
    if (!deeplyFrozen(bars)) reason('bars-not-deeply-immutable');
    if (!deeplyFrozen(proof)) reason('proof-not-deeply-immutable');
    if (!isResolverIssuedSecurityProof(proof)) reason('resolver-authentication');
    if (proof.requestKind !== requirement.kind) reason('request-kind');
    if (proof.requestedSymbol !== requirement.symbol) reason('requested-symbol');
    if (proof.targetCanonicalTf !== requirement.targetCanonicalTf) reason('target-timeframe');
    if (!sameSecurityDependencyIdentities(proof.dependencies, requirement.dependencies)) {
      reason('dependency-identity');
    }
    if (
      !Array.isArray(proof.requestedCanonicalTfs) ||
      !sameStrings(proof.requestedCanonicalTfs, requirement.requestedCanonicalTfs)
    ) {
      reason('requested-timeframes');
    }
    if (
      !Array.isArray(proof.lookaheadOnCanonicalTfs) ||
      !sameStrings(proof.lookaheadOnCanonicalTfs, requirement.lookaheadOnCanonicalTfs)
    ) {
      reason('lookahead-identity');
    }

    const evidence = securityAlignmentEvidence(proof.alignmentEvidence);
    if (!evidence) reason('alignment-evidence');

    const provenance = isRecord(proof.provenance) ? proof.provenance : undefined;
    if (
      !provenance ||
      typeof provenance.cacheIdentity !== 'string' ||
      provenance.cacheIdentity.length === 0 ||
      typeof provenance.normalizedSymbol !== 'string' ||
      provenance.normalizedSymbol.length === 0 ||
      typeof provenance.sourceTimeframe !== 'string' ||
      provenance.sourceTimeframe.length === 0 ||
      typeof provenance.targetTimeframe !== 'string' ||
      provenance.targetTimeframe.length === 0 ||
      typeof provenance.alignment !== 'string' ||
      provenance.alignment.length === 0 ||
      (provenance.weekAnchorSec !== undefined && !Number.isSafeInteger(provenance.weekAnchorSec)) ||
      !Number.isSafeInteger(provenance.aggregationVersion) ||
      (provenance.aggregationVersion as number) < 0
    ) {
      reason('provenance');
    } else {
      if (provenance.targetTimeframe !== requirement.targetCanonicalTf) {
        reason('provenance-target-timeframe');
      }
      if (!evidence || !validSecurityTimeframeLineage(provenance, evidence)) {
        reason('provenance-timeframe-lineage');
      }
    }

    let requiredInterval: HalfOpenIntervalSec | undefined;
    if (evidence) {
      try {
        requiredInterval = exactSecurityRangeForRequirement(requirement, evidence);
        required.push({ key: requirement.key, requested: requiredInterval });
      } catch {
        reason('lookahead-range-evidence');
        required.push({ key: requirement.key });
      }
    }

    if (proof.complete !== true) reason('coverage-incomplete');
    if (!Array.isArray(proof.gaps) || proof.gaps.length !== 0) reason('coverage-gaps');
    if (!Array.isArray(proof.covered)) reason('covered-intervals');
    if (!validInterval(proof.requested)) reason('requested-interval');
    else if (
      requiredInterval &&
      (proof.requested.from > requiredInterval.from || proof.requested.to < requiredInterval.to)
    ) {
      reason('requested-envelope');
    }
    if (typeof proof.barsDigest !== 'string' || proof.barsDigest !== marketDataDigest(bars)) {
      reason('bars-digest');
    }

    if (evidence && exactSecurityUnrepresentedTimeframes(requirement, evidence).length > 0) {
      reason('requested-timeframe-grid');
    }
    if (
      evidence &&
      provenance &&
      provenance.alignment !== securityAlignmentIdentity(proof.alignmentEvidence)
    ) {
      reason('provenance-alignment');
    } else if (
      evidence &&
      provenance &&
      (provenance.weekAnchorSec ?? null) !== (evidence.weekAnchorSec ?? null)
    ) {
      reason('provenance-week-anchor');
    }

    // Reconstruct and validate the acquisition from the immutable bars. This is
    // the authoritative coverage check: caller-authored covered/gap intervals,
    // even when self-consistent and paired with a matching bars digest, cannot
    // claim empty, sparse, misaligned, or internally-holed data as complete.
    if (
      evidence &&
      provenance &&
      validInterval(proof.requested) &&
      Array.isArray(proof.covered) &&
      Array.isArray(proof.gaps)
    ) {
      try {
        validateHistoryAcquisition(
          {
            bars,
            requested: proof.requested,
            covered: proof.covered,
            gaps: proof.gaps,
            complete: proof.complete,
            provenance: proof.provenance,
          },
          {
            requested: proof.requested,
            cacheIdentity: provenance.cacheIdentity as string,
            normalizedSymbol: provenance.normalizedSymbol as string,
            sourceTimeframe: provenance.sourceTimeframe as string,
            targetTimeframe: requirement.targetCanonicalTf,
            aggregationVersion: provenance.aggregationVersion as number,
            alignment: evidence.alignment,
            weekAnchorSec: evidence.weekAnchorSec,
            calendar: evidence.calendar,
          },
        );
      } catch {
        reason('coverage-evidence');
      }
    }

    if (typeof proof.acquisitionKey !== 'string' || proof.acquisitionKey.length === 0) {
      reason('acquisition-identity');
    } else {
      try {
        const { acquisitionKey: _ignored, ...bound } = proof;
        if (proof.acquisitionKey !== securityDatasetAcquisitionKey(bound)) {
          reason('acquisition-identity');
        }
      } catch {
        reason('acquisition-identity');
      }
    }
    if (reasons.length > 0) invalid.push({ key: requirement.key, reasons });
  }

  if (missing.length > 0 || invalid.length > 0) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'unresolved-static-security-with-bar-magnifier',
      message:
        'Bar Magnifier exact mode cannot execute until every static request.security dataset is resolved with complete bar-derived coverage and a matching immutable proof',
      details: { missing, invalid, required },
    });
  }
}

function validInterval(interval: unknown): interval is HalfOpenIntervalSec {
  return (
    isRecord(interval) &&
    Number.isSafeInteger(interval.from) &&
    Number.isSafeInteger(interval.to) &&
    (interval.from as number) < (interval.to as number)
  );
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => typeof value === 'string' && value === expected[index])
  );
}

function sameSecurityDependencyIdentities(
  actual: unknown,
  expected: readonly ResolvedSecurityDependencyIdentity[],
): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (value, index) =>
        isRecord(value) &&
        sameSecurityDependencyIdentity(
          value as unknown as ResolvedSecurityDependencyIdentity,
          expected[index]!,
        ),
    )
  );
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  try {
    for (const child of Object.values(value)) {
      if (!deeplyFrozen(child, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

type ValidatedSecurityAlignmentEvidence =
  | {
      readonly kind: 'utc-24x7';
      readonly alignment: 'utc-24x7';
      readonly weekAnchorSec?: UnixSecond;
      readonly calendar?: never;
    }
  | {
      readonly kind: 'exchange-calendar';
      readonly alignment: 'exchange-calendar';
      readonly weekAnchorSec?: never;
      readonly calendar: HistorySessionCalendar;
    };

function securityAlignmentEvidence(value: unknown): ValidatedSecurityAlignmentEvidence | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'utc-24x7') {
    if (value.weekAnchorSec !== undefined && !Number.isSafeInteger(value.weekAnchorSec)) {
      return undefined;
    }
    return {
      kind: 'utc-24x7',
      alignment: 'utc-24x7',
      ...(value.weekAnchorSec !== undefined
        ? { weekAnchorSec: value.weekAnchorSec as UnixSecond }
        : {}),
    };
  }
  if (value.kind !== 'exchange-calendar' || !isRecord(value.calendar)) return undefined;
  try {
    const calendar = snapshotHistorySessionCalendar(
      value.calendar as unknown as HistorySessionCalendar,
    );
    return { kind: 'exchange-calendar', alignment: 'exchange-calendar', calendar };
  } catch {
    return undefined;
  }
}

function securityAlignmentIdentity(evidence: ResolvedSecurityAlignmentEvidence): string {
  return evidence.kind === 'utc-24x7'
    ? evidence.kind
    : `exchange-calendar:${evidence.calendar.calendarId}@${evidence.calendar.version}`;
}

function validSecurityTimeframeLineage(
  provenance: Record<string, unknown>,
  evidence: ValidatedSecurityAlignmentEvidence,
): boolean {
  const sourceTimeframe = String(provenance.sourceTimeframe);
  const targetTimeframe = String(provenance.targetTimeframe);
  const source = canonicalTimeframeSecondsExact(sourceTimeframe);
  const target = canonicalTimeframeSecondsExact(targetTimeframe);
  if (source.kind !== 'ok' || target.kind !== 'ok') return false;
  const aggregationVersion = provenance.aggregationVersion;
  if (!Number.isSafeInteger(aggregationVersion) || (aggregationVersion as number) < 0) return false;

  let nested = target.value % source.value === 0;
  if (evidence.kind === 'utc-24x7') {
    try {
      nested = utcTimeframesNest(
        sourceTimeframe,
        targetTimeframe,
        evidence.weekAnchorSec,
        evidence.weekAnchorSec,
      );
    } catch {
      return false;
    }
  }

  if (aggregationVersion === 0) return source.value === target.value && nested;
  return source.value < target.value && nested;
}

function dynamicSecurityFailure(details: unknown): BarMagnifierError {
  return new BarMagnifierError({
    kind: 'unsupported',
    code: 'dynamic-security-unsupported-with-bar-magnifier',
    message:
      'Bar Magnifier exact mode requires every request.security/security_lower_tf ' +
      'symbol, timeframe, and lookahead identity to be statically resolvable',
    details,
  });
}

function staticSecurityUnavailable(label: string): BarMagnifierError {
  return new BarMagnifierError({
    kind: 'provider-limited',
    code: 'static-security-data-unavailable-with-bar-magnifier',
    message: `Bar Magnifier exact mode could not resolve static security data for ${label}`,
    details: { label },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
