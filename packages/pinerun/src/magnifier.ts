import { parse, tokenize, type CompiledScript, type SecurityDependency } from '@heyphat/piner';
import {
  ExactHistoryError,
  HISTORY_AGGREGATION_VERSION,
  acquireExactHistory,
  assertCalendarPeriodCoverage,
  calendarSessionPeriods,
  canonicalTimeframeSecondsExact,
  halfOpenIntervalSec,
  isCalendarSessionTimeframe,
  isUtcWeekTimeframe,
  parseCanonicalTimeframeExact,
  pineTimeframeToCanonicalExact,
  planHistoryAcquisition,
  resolveHistorySource,
  snapshotHistorySessionCalendar,
  unixMillisecond,
  unixSecond,
  utcTimeframeAnchor,
  type AcquisitionProvenance,
  type Bar,
  type CalendarSessionPeriod,
  type CoverageGapMs,
  type HalfOpenIntervalMs,
  type HistoryAcquisition,
  type HistoryCapabilities,
  type HistoryProvider,
  type HistoryRange,
  type HistorySessionCalendar,
  type ResolvedHistorySource,
  type UnixMillisecond,
} from '@heyphat/pinery';
import {
  canonicalDigest,
  marketDataDigest,
  registerOwnedImmutableBars,
  textDigest,
} from './digest.js';
import { BarMagnifierError } from './failure.js';
import type { Job, ResolvedMagnifierAlignmentEvidence, ResolvedMagnifierDataset } from './job.js';
import {
  compilePinerSource,
  pinerCapabilities,
  type PinerCapabilityAdapter,
} from './piner-capabilities.js';
import {
  assertStaticSecurityForBarMagnifier,
  resolveSecurity,
  securityRangeForBarMagnifier,
} from './security.js';

interface CompiledMetadataLike {
  readonly isStrategy?: boolean;
  readonly strategy?: Record<string, unknown>;
  readonly securityDependencies?: readonly SecurityDependency[];
}

interface CompiledLike {
  readonly metadata?: CompiledMetadataLike;
}

export interface MagnifierPreflight {
  readonly metadataKey: string;
  readonly sourceIdentity: string;
  readonly chartPineTf: string;
  readonly override: boolean | undefined;
  readonly isStrategy: boolean;
  readonly sourceRequested: boolean;
  /** Final strategy setting after host-override precedence. */
  readonly requested: boolean;
  readonly targetPineTf?: string;
  readonly contractVersion?: number;
  readonly mappingVersion?: number;
  readonly securityDependencies: readonly SecurityDependency[];
}

export interface MagnifierResolutionScope {
  /** Equal acquisition keys share only while this top-level operation is alive. */
  readonly acquisitions: Map<string, Promise<ResolvedMagnifierDataset>>;
}

export function createMagnifierResolutionScope(): MagnifierResolutionScope {
  return { acquisitions: new Map() };
}

export interface ResolveBarMagnifierOptions {
  readonly adapter?: PinerCapabilityAdapter;
  /** Explicit host/provider chart closes in UNIX seconds. */
  readonly chartCloseTimesSec?: readonly number[];
  readonly securityRange?: HistoryRange;
  readonly securityConcurrency?: number;
  readonly onSecurityFetch?: (label: string, bars: number) => void;
  readonly onSecurityError?: (label: string, error: string) => void;
  /** Command/fold-local reuse. Never persist this scope across refresh cycles. */
  readonly scope?: MagnifierResolutionScope;
}

export interface MagnifierResolution {
  readonly preflight: MagnifierPreflight;
  readonly dataset?: ResolvedMagnifierDataset;
}

interface ChartIntervalsSec {
  readonly opens: readonly number[];
  readonly closes: readonly number[];
  readonly source: ResolvedMagnifierDataset['chartIntervalSource'];
}

const preflightCaches = new WeakMap<
  PinerCapabilityAdapter,
  Map<string, MagnifierPreflight | BarMagnifierError>
>();

/**
 * Exact magnifier datasets are executable only when this module issued their
 * deeply immutable snapshot. Public digests detect mutation; this process-local
 * authority prevents callers from self-signing replacement content/evidence.
 */
const resolverIssuedMagnifierDatasets = new WeakSet<object>();
let workerMagnifierAuthSecret: string | undefined;

export function magnifierMetadataKey(
  source: string,
  chartPineTf: string,
  override: boolean | undefined,
): string {
  return `magnifier-metadata-v1:${canonicalDigest({
    sourceIdentity: textDigest(source),
    chartPineTf,
    override: override === undefined ? 'unset' : override,
  })}`;
}

/** Compile and resolve source-header/host-override metadata without any provider I/O. */
export function preflightBarMagnifier(
  source: string,
  chartPineTf: string,
  override?: boolean,
  adapter: PinerCapabilityAdapter = pinerCapabilities(),
): MagnifierPreflight {
  const key = magnifierMetadataKey(source, chartPineTf, override);
  let cache = preflightCaches.get(adapter);
  if (!cache) {
    cache = new Map();
    preflightCaches.set(adapter, cache);
  }
  const cached = cache.get(key);
  if (cached instanceof BarMagnifierError) throw cached;
  if (cached) return cached;

  const compiled =
    adapter === pinerCapabilities()
      ? (compilePinerSource(source) as unknown as CompiledLike)
      : (adapter.compile(source) as unknown as CompiledLike);
  try {
    const preflight = resolvePreflight(source, chartPineTf, override, adapter, compiled, key);
    cache.set(key, preflight);
    return preflight;
  } catch (error) {
    if (error instanceof BarMagnifierError) cache.set(key, error);
    throw error;
  }
}

/** Internal execution seam that reuses an already-compiled script. */
export function preflightCompiledBarMagnifier(
  source: string,
  chartPineTf: string,
  override: boolean | undefined,
  compiled: CompiledScript,
  adapter: PinerCapabilityAdapter = pinerCapabilities(),
): MagnifierPreflight {
  const key = magnifierMetadataKey(source, chartPineTf, override);
  let cache = preflightCaches.get(adapter);
  if (!cache) {
    cache = new Map();
    preflightCaches.set(adapter, cache);
  }
  const cached = cache.get(key);
  if (cached instanceof BarMagnifierError) throw cached;
  if (cached) return cached;
  try {
    const preflight = resolvePreflight(source, chartPineTf, override, adapter, compiled, key);
    cache.set(key, preflight);
    return preflight;
  } catch (error) {
    if (error instanceof BarMagnifierError) cache.set(key, error);
    throw error;
  }
}

/**
 * Resolve and attach one exact dataset. Flag-off/unrequested jobs return before
 * source routing or history acquisition. Dynamic security identities fail before
 * either acquisition or execution.
 */
export async function resolveBarMagnifier(
  job: Job,
  chartCanonicalTf: string,
  provider: HistoryProvider,
  options: ResolveBarMagnifierOptions = {},
): Promise<MagnifierResolution> {
  const adapter = options.adapter ?? pinerCapabilities();
  // Preflight reuse is exclusively keyed by this source/configuration and
  // adapter. Caller-supplied metadata is intentionally not accepted: stale
  // state could otherwise bypass capability and exact-security checks.
  const preflight = preflightBarMagnifier(job.source, job.timeframe, job.useBarMagnifier, adapter);
  if (!preflight.requested) return { preflight };

  assertStaticSecurityForBarMagnifier(job.source, preflight.securityDependencies);
  const source = await resolveHistorySource(provider, job.symbol);
  const alignmentEvidence = snapshotMagnifierAlignmentEvidence(source.capabilities);
  const intervals = chartIntervals(
    job.bars,
    chartCanonicalTf,
    source,
    alignmentEvidence,
    options.chartCloseTimesSec,
  );

  // Exact mode never executes a discovery approximation. Resolve every static
  // dependency before acquiring/attaching the final magnifier dataset. Passing
  // preflight's dependencies also avoids compiling through a different runtime.
  await resolveSecurity(job.source, [job], chartCanonicalTf, job.timeframe, provider, {
    range:
      options.securityRange ??
      securityRangeForBarMagnifier(
        intervals.opens[0]!,
        intervals.closes.at(-1)!,
        chartCanonicalTf,
        preflight.securityDependencies,
      ),
    inputs: job.inputs,
    backend: job.backend,
    mintick: job.mintick,
    concurrency: Math.max(1, options.securityConcurrency ?? 1),
    onFetch: options.onSecurityFetch,
    onError: options.onSecurityError,
    barMagnifierRequested: true,
    staticDependencies: preflight.securityDependencies,
    exactChartEnvelope: {
      firstChartOpen: intervals.opens[0]!,
      finalChartOpen: intervals.opens.at(-1)!,
      finalChartClose: intervals.closes.at(-1)!,
    },
  });

  const targetCanonical = pineTimeframeToCanonicalExact(preflight.targetPineTf!);
  if (targetCanonical.kind !== 'ok') throw exactConversionError(targetCanonical);

  const requested = halfOpenIntervalSec(intervals.opens[0]!, intervals.closes.at(-1)!);
  const plan = planHistoryAcquisition(source.capabilities, targetCanonical.value);
  if (plan.kind === 'unsupported' || plan.kind === 'malformed') {
    throw new ExactHistoryError({
      kind: plan.kind,
      code: plan.code,
      message: plan.message,
      details: plan.details,
    });
  }

  const reuseKey = magnifierAcquisitionKey({
    source,
    symbol: job.symbol,
    requested: { from: requested.from, to: requested.to },
    targetPineTf: preflight.targetPineTf!,
    targetCanonicalTf: plan.targetTimeframe,
    sourceCanonicalTf: plan.sourceTimeframe,
    chartOpensSec: intervals.opens,
    chartCloseTimesSec: intervals.closes,
    chartIntervalSource: intervals.source,
    aggregationVersion: plan.kind === 'aggregate' ? HISTORY_AGGREGATION_VERSION : 0,
    contractVersion: preflight.contractVersion!,
    mappingVersion: preflight.mappingVersion!,
  });

  const create = () =>
    acquireAndConvert(
      source,
      job.symbol,
      requested,
      plan.targetTimeframe,
      plan.sourceTimeframe,
      preflight,
      intervals,
      alignmentEvidence,
    );
  const cache = options.scope?.acquisitions;
  let pending = cache?.get(reuseKey);
  if (!pending) {
    pending = create();
    if (cache) {
      cache.set(reuseKey, pending);
      pending.catch(() => {
        if (cache.get(reuseKey) === pending) cache.delete(reuseKey);
      });
    }
  }
  const dataset = await pending;
  job.magnifier = dataset;
  return { preflight, dataset };
}

export interface MagnifierAcquisitionKeyInput {
  readonly source: Pick<
    ResolvedHistorySource,
    'cacheIdentity' | 'normalizedSymbol' | 'capabilities'
  >;
  readonly symbol: string;
  readonly requested: { readonly from: number; readonly to: number };
  readonly targetPineTf: string;
  readonly targetCanonicalTf: string;
  readonly sourceCanonicalTf: string;
  readonly chartOpensSec: readonly number[];
  readonly chartCloseTimesSec: readonly number[];
  readonly chartIntervalSource: ResolvedMagnifierDataset['chartIntervalSource'];
  readonly aggregationVersion: number;
  readonly contractVersion: number;
  readonly mappingVersion: number;
}

/** Full acquisition identity; deliberately separate from metadata-preflight reuse. */
export function magnifierAcquisitionKey(input: MagnifierAcquisitionKeyInput): string {
  const calendar = input.source.capabilities.calendar;
  return `magnifier-acquisition-v3:${canonicalDigest({
    cacheIdentity: input.source.cacheIdentity,
    normalizedSymbol: input.source.normalizedSymbol,
    requestedSymbol: input.symbol,
    requested: input.requested,
    targetPineTf: input.targetPineTf,
    targetCanonicalTf: input.targetCanonicalTf,
    sourceCanonicalTf: input.sourceCanonicalTf,
    chartIntervals: input.chartOpensSec.map((open, index) => [
      open,
      input.chartCloseTimesSec[index],
    ]),
    chartIntervalSource: input.chartIntervalSource,
    alignment: input.source.capabilities.alignment,
    weekAnchorSec: input.source.capabilities.weekAnchorSec ?? null,
    calendar: calendar
      ? {
          calendarId: calendar.calendarId,
          version: calendar.version,
          coverage: calendar.coverage,
          sessions: calendar.sessions,
          periods: calendar.periods ?? null,
        }
      : null,
    completenessPolicy: 'exact-complete-v1',
    aggregationVersion: input.aggregationVersion,
    contractVersion: input.contractVersion,
    mappingVersion: input.mappingVersion,
  })}`;
}

export type MagnifierDatasetAcquisitionKeyInput = Pick<
  ResolvedMagnifierDataset,
  | 'contractVersion'
  | 'mappingVersion'
  | 'requestedSymbol'
  | 'targetPineTf'
  | 'targetCanonicalTf'
  | 'sourceCanonicalTf'
  | 'chartOpenTimesMs'
  | 'chartCloseTimesMs'
  | 'chartIntervalSource'
  | 'coverage'
  | 'provenance'
  | 'alignmentEvidence'
  | 'barsDigest'
>;

/**
 * Serializable execution identity. Unlike the operation-local reuse key above,
 * every input survives Job/wire transport. Execution recomputes this value with
 * chart opens derived from the actual Job bars and independently verifies the
 * strong target-bar digest, so the stored string alone is never accepted.
 */
export function magnifierDatasetAcquisitionKey(input: MagnifierDatasetAcquisitionKeyInput): string {
  return `magnifier-dataset-acquisition-v3:${canonicalDigest({
    cacheIdentity: input.provenance.cacheIdentity,
    normalizedSymbol: input.provenance.normalizedSymbol,
    requestedSymbol: input.requestedSymbol,
    requested: input.coverage.requested,
    targetPineTf: input.targetPineTf,
    targetCanonicalTf: input.targetCanonicalTf,
    sourceCanonicalTf: input.sourceCanonicalTf,
    chartIntervals: input.chartOpenTimesMs.map((open, index) => [
      open,
      input.chartCloseTimesMs[index],
    ]),
    chartIntervalSource: input.chartIntervalSource,
    alignment: input.provenance.alignment,
    weekAnchorSec: input.provenance.weekAnchorSec ?? null,
    alignmentEvidence: input.alignmentEvidence,
    barsDigest: input.barsDigest,
    completenessPolicy: 'bar-derived-exact-complete-v2',
    aggregationVersion: input.provenance.aggregationVersion,
    contractVersion: input.contractVersion,
    mappingVersion: input.mappingVersion,
  })}`;
}

/** Internal worker-channel authority; intentionally absent from the public entrypoint. */
export function isResolverIssuedMagnifierDataset(
  value: unknown,
): value is ResolvedMagnifierDataset {
  return isRecord(value) && resolverIssuedMagnifierDatasets.has(value);
}

/**
 * Derive an in-sample chart prefix from one authoritative full-fold dataset.
 * Target bars deliberately remain the same no-copy array; only the chart and
 * coverage envelope is clipped, rebound, frozen, and issued as new authority.
 */
export function deriveResolverIssuedMagnifierPrefix(
  dataset: ResolvedMagnifierDataset,
  chartBars: number,
): ResolvedMagnifierDataset {
  if (!isResolverIssuedMagnifierDataset(dataset)) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'walkforward-bar-magnifier-prefix-authority',
      message: 'Walk-forward Bar Magnifier prefixes require a resolver-issued full-fold dataset',
    });
  }
  if (
    !Object.isFrozen(dataset) ||
    !Object.isFrozen(dataset.barsMs) ||
    !Object.isFrozen(dataset.chartOpenTimesMs) ||
    !Object.isFrozen(dataset.chartCloseTimesMs) ||
    !Object.isFrozen(dataset.coverage) ||
    dataset.barsDigest !== marketDataDigest(dataset.barsMs)
  ) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'walkforward-bar-magnifier-prefix-authority',
      message:
        'Walk-forward Bar Magnifier prefixes require an immutable content-authenticated full-fold dataset',
    });
  }
  if (
    !Number.isSafeInteger(chartBars) ||
    chartBars < 1 ||
    chartBars > dataset.chartCloseTimesMs.length ||
    dataset.chartOpenTimesMs.length !== dataset.chartCloseTimesMs.length ||
    dataset.coverage.requested.from !== dataset.chartOpenTimesMs[0] ||
    dataset.coverage.requested.to !== dataset.chartCloseTimesMs.at(-1)
  ) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'walkforward-bar-magnifier-prefix-mismatch',
      message: 'Walk-forward Bar Magnifier prefix is outside the resolved fold envelope',
      details: {
        chartBars,
        opens: dataset.chartOpenTimesMs.length,
        closes: dataset.chartCloseTimesMs.length,
        requested: dataset.coverage.requested,
      },
    });
  }

  const requested = Object.freeze({
    from: dataset.chartOpenTimesMs[0]!,
    to: dataset.chartCloseTimesMs[chartBars - 1]!,
  }) as ResolvedMagnifierDataset['coverage']['requested'];
  const clip = <T extends { readonly from: number; readonly to: number }>(
    interval: T,
  ): T | undefined => {
    const from = Math.max(interval.from, requested.from);
    const to = Math.min(interval.to, requested.to);
    return from < to ? (Object.freeze({ ...interval, from, to }) as T) : undefined;
  };
  const covered = Object.freeze(
    dataset.coverage.covered
      .map(clip)
      .filter((interval): interval is NonNullable<typeof interval> => interval !== undefined),
  ) as ResolvedMagnifierDataset['coverage']['covered'];
  const gaps = Object.freeze(
    dataset.coverage.gaps
      .map(clip)
      .filter((interval): interval is NonNullable<typeof interval> => interval !== undefined),
  ) as ResolvedMagnifierDataset['coverage']['gaps'];
  const barsDigest = marketDataDigest(dataset.barsMs);
  const prefix = {
    ...dataset,
    barsMs: dataset.barsMs,
    chartOpenTimesMs: Object.freeze(dataset.chartOpenTimesMs.slice(0, chartBars)),
    chartCloseTimesMs: Object.freeze(dataset.chartCloseTimesMs.slice(0, chartBars)),
    coverage: Object.freeze({
      requested,
      covered,
      gaps,
      complete: gaps.length === 0,
    }),
    barsDigest,
  } satisfies Omit<ResolvedMagnifierDataset, 'acquisitionKey'>;
  const derived = Object.freeze({
    ...prefix,
    acquisitionKey: magnifierDatasetAcquisitionKey(prefix),
  });
  resolverIssuedMagnifierDatasets.add(derived);
  return derived;
}

/** Bind one resolver-issued magnifier envelope to a private per-worker channel. */
export function magnifierDatasetWireAuthenticator(
  secret: string,
  dataset: ResolvedMagnifierDataset,
): string {
  if (!validMagnifierAuthSecret(secret)) {
    throw new TypeError('pinerun: invalid worker magnifier authentication secret');
  }
  const { barsMs: _bars, ...attestedEnvelope } = dataset;
  return `magnifier-dataset-wire-auth-v1:${canonicalDigest({
    domain: 'pinerun-magnifier-worker-v1',
    secret,
    dataset: attestedEnvelope,
  })}`;
}

/** Initialize once inside a worker from private workerData supplied by its parent. */
export function initializeWorkerMagnifierDatasetAuthentication(secret: string): void {
  if (!validMagnifierAuthSecret(secret)) {
    throw new TypeError('pinerun: invalid worker magnifier authentication secret');
  }
  if (workerMagnifierAuthSecret !== undefined && workerMagnifierAuthSecret !== secret) {
    throw new Error('pinerun: worker magnifier authentication was already initialized');
  }
  workerMagnifierAuthSecret = secret;
}

/** Restore resolver authority only after authenticating the complete frozen envelope. */
export function authenticateHydratedMagnifierDataset(
  dataset: ResolvedMagnifierDataset,
  authenticator: unknown,
): boolean {
  const secret = workerMagnifierAuthSecret;
  if (secret === undefined || typeof authenticator !== 'string') return false;
  let expected: string;
  try {
    expected = magnifierDatasetWireAuthenticator(secret, dataset);
  } catch {
    return false;
  }
  if (!constantTimeTextEqual(authenticator, expected)) return false;
  resolverIssuedMagnifierDatasets.add(dataset);
  return true;
}

function validMagnifierAuthSecret(value: string): boolean {
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

function resolvePreflight(
  source: string,
  chartPineTf: string,
  override: boolean | undefined,
  adapter: PinerCapabilityAdapter,
  compiled: CompiledLike,
  metadataKey: string,
): MagnifierPreflight {
  const metadata = compiled.metadata ?? {};
  const isStrategy = metadata.isStrategy === true;
  const compilerSecurityDependencies = metadata.securityDependencies;
  const securityDependencies = Object.freeze(
    (Array.isArray(compilerSecurityDependencies) ? compilerSecurityDependencies : []).map(
      (dependency) => Object.freeze({ ...dependency }),
    ),
  );

  if (override === true && !isStrategy) {
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'bar-magnifier-strategy-only',
      message: 'Bar Magnifier can only be enabled for a strategy() script, not an indicator()',
    });
  }

  // A false host override wins without touching any new runtime contract. This is
  // what keeps mixed-version flag-off runs compatible even when the source header
  // would request magnification on a newer engine.
  if (override === false) {
    const sourceRequested = adapter.capable && metadata.strategy?.useBarMagnifier === true;
    return freezePreflight({
      metadataKey,
      sourceIdentity: textDigest(source),
      chartPineTf,
      override,
      isStrategy,
      sourceRequested,
      requested: false,
      ...(adapter.capable
        ? {
            contractVersion: adapter.contractVersion,
            mappingVersion: adapter.mappingVersion,
          }
        : {}),
      securityDependencies,
    });
  }

  if (!adapter.capable) {
    const legacyIntent = legacyMagnifierIntent(source);
    if (override === true || legacyIntent !== false) throw incapableRuntime(adapter);
    return freezePreflight({
      metadataKey,
      sourceIdentity: textDigest(source),
      chartPineTf,
      override,
      isStrategy,
      sourceRequested: false,
      requested: false,
      securityDependencies,
    });
  }

  // Only a version-compatible adapter may expose/interpret this additive field.
  const sourceRequested = metadata.strategy?.useBarMagnifier === true;
  const requested = override ?? sourceRequested;
  if (!requested) {
    return freezePreflight({
      metadataKey,
      sourceIdentity: textDigest(source),
      chartPineTf,
      override,
      isStrategy,
      sourceRequested,
      requested: false,
      contractVersion: adapter.contractVersion,
      mappingVersion: adapter.mappingVersion,
      securityDependencies,
    });
  }
  if (!isStrategy) {
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'bar-magnifier-strategy-only',
      message: 'Bar Magnifier can only be enabled for a strategy() script, not an indicator()',
    });
  }

  // Fail the complete exact-security compiler contract during preflight, before
  // source routing or any provider acquisition can begin. An explicit empty
  // array proves that the compiler found no dependencies; an absent field does not.
  if (!Array.isArray(compilerSecurityDependencies)) {
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'static-security-compiler-metadata-unavailable',
      message:
        'Bar Magnifier exact security requires piner compiler dependency metadata, including an explicit empty dependency array',
      details: { missing: ['securityDependencies'] },
    });
  }
  assertStaticSecurityForBarMagnifier(source, securityDependencies);

  let targetPineTf: string;
  try {
    targetPineTf = adapter.mapTargetTimeframe(chartPineTf);
  } catch (error) {
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'bar-magnifier-chart-timeframe-unsupported',
      message:
        `Bar Magnifier is unavailable for chart timeframe "${chartPineTf}": ` +
        (error instanceof Error ? error.message : String(error)),
      details: { chartPineTf },
    });
  }
  return freezePreflight({
    metadataKey,
    sourceIdentity: textDigest(source),
    chartPineTf,
    override,
    isStrategy,
    sourceRequested,
    requested: true,
    targetPineTf,
    contractVersion: adapter.contractVersion,
    mappingVersion: adapter.mappingVersion,
    securityDependencies,
  });
}

function freezePreflight(value: MagnifierPreflight): MagnifierPreflight {
  return Object.freeze(value);
}

function incapableRuntime(adapter: PinerCapabilityAdapter): BarMagnifierError {
  return new BarMagnifierError({
    kind: 'unsupported',
    code: 'piner-bar-magnifier-capability-unavailable',
    message:
      'Bar Magnifier was requested, but the loaded @heyphat/piner runtime does not expose ' +
      'the compatible mapping, metadata, data-channel, and report contract',
    details: {
      contractVersion: adapter.contractVersion,
      mappingVersion: adapter.mappingVersion,
      missing: adapter.missing,
    },
  });
}

/**
 * Old piner releases silently ignored this unknown strategy() argument. Inspect
 * only that declaration's named argument: an unrelated Pine variable with the
 * same spelling is not a source request. Provably constant booleans preserve
 * compatibility; runtime-dependent values fail closed.
 */
function legacyMagnifierIntent(source: string): boolean | undefined {
  try {
    const program = parse(tokenize(source)) as unknown;
    if (!isRecord(program) || !Array.isArray(program.body)) return undefined;
    const constants = new Map<string, unknown>();
    for (const statement of program.body) {
      if (
        isRecord(statement) &&
        statement.kind === 'VarDecl' &&
        statement.declQual === 0 &&
        typeof statement.name === 'string'
      ) {
        constants.set(statement.name, statement.init);
      }
    }
    for (const statement of program.body) {
      if (!isRecord(statement) || statement.kind !== 'ExprStmt' || !isRecord(statement.expr)) {
        continue;
      }
      const expression = statement.expr;
      if (
        expression.kind !== 'Call' ||
        !isRecord(expression.callee) ||
        expression.callee.kind !== 'Ident' ||
        expression.callee.name !== 'strategy' ||
        !Array.isArray(expression.args)
      ) {
        continue;
      }
      const setting = expression.args.find(
        (argument) => isRecord(argument) && argument.name === 'use_bar_magnifier',
      );
      if (setting === undefined) return false;
      return isRecord(setting)
        ? legacyConstBoolean(setting.value, constants, new Set(), 0)
        : undefined;
    }
    return false;
  } catch {
    return undefined;
  }
}

/** Prove only compile-time booleans needed by the legacy compatibility gate. */
function legacyConstBoolean(
  value: unknown,
  constants: ReadonlyMap<string, unknown>,
  resolving: Set<string>,
  depth: number,
): boolean | undefined {
  if (!isRecord(value) || depth > 32) return undefined;
  if (value.kind === 'Bool') {
    return typeof value.value === 'boolean' ? value.value : undefined;
  }
  if (value.kind === 'Unary' && value.op === 'not') {
    const operand = legacyConstBoolean(value.operand, constants, resolving, depth + 1);
    return operand === undefined ? undefined : !operand;
  }
  if (value.kind === 'Binary' && (value.op === 'and' || value.op === 'or')) {
    const left = legacyConstBoolean(value.left, constants, resolving, depth + 1);
    const right = legacyConstBoolean(value.right, constants, resolving, depth + 1);
    if (value.op === 'and') {
      if (left === false || right === false) return false;
      return left === true && right === true ? true : undefined;
    }
    if (left === true || right === true) return true;
    return left === false && right === false ? false : undefined;
  }
  if (value.kind === 'Ternary') {
    const condition = legacyConstBoolean(value.cond, constants, resolving, depth + 1);
    const yes = legacyConstBoolean(value.then, constants, resolving, depth + 1);
    const no = legacyConstBoolean(value.else, constants, resolving, depth + 1);
    if (condition !== undefined) return condition ? yes : no;
    return yes !== undefined && yes === no ? yes : undefined;
  }
  if (value.kind === 'Ident' && typeof value.name === 'string') {
    if (resolving.has(value.name)) return undefined;
    const expression = constants.get(value.name);
    if (expression === undefined) return undefined;
    resolving.add(value.name);
    try {
      return legacyConstBoolean(expression, constants, resolving, depth + 1);
    } finally {
      resolving.delete(value.name);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snapshotMagnifierAlignmentEvidence(
  capabilities: HistoryCapabilities,
): ResolvedMagnifierAlignmentEvidence {
  if (capabilities.alignment === 'utc-24x7') {
    return Object.freeze({
      kind: 'utc-24x7',
      ...(capabilities.weekAnchorSec !== undefined
        ? { weekAnchorSec: capabilities.weekAnchorSec }
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
        ? 'pinery: exchange-calendar magnifier resolution requires explicit calendar metadata'
        : 'pinery: exact magnifier resolution requires proven UTC or exchange-calendar alignment',
  });
}

const PINE_UTC_WEEK_PHASE_SEC = unixSecond(-3 * 86_400);

/** Shared resolver/execution predicate for every authenticated UTC fixed chart grid. */
export function utcFixedChartOpensAligned(
  opens: readonly number[],
  chartCanonicalTf: string,
  evidence: ResolvedMagnifierAlignmentEvidence,
  unitsPerSecond: 1 | 1000,
): boolean {
  if (evidence.kind !== 'utc-24x7') return true;
  const parsed = parseCanonicalTimeframeExact(chartCanonicalTf);
  if (parsed.kind !== 'ok' || parsed.value.domain !== 'fixed') return true;
  try {
    const duration = parsed.value.seconds * unitsPerSecond;
    // Piner gives every W multiplier one universal Monday phase. Elapsed D
    // multiples and all other fixed UTC durations remain epoch-anchored.
    const anchor = utcTimeframeAnchor(chartCanonicalTf, PINE_UTC_WEEK_PHASE_SEC) * unitsPerSecond;
    if (!Number.isSafeInteger(duration) || !Number.isSafeInteger(anchor)) return false;
    return opens.every(
      (open) => Number.isSafeInteger(open) && floorMod(open - anchor, duration) === 0,
    );
  } catch {
    return false;
  }
}

/** Shared resolver/execution predicate for authenticated exchange chart opens. */
export function exchangeCalendarChartOpensAligned(
  opens: readonly number[],
  chartCanonicalTf: string,
  evidence: ResolvedMagnifierAlignmentEvidence,
  unitsPerSecond: 1 | 1000,
): boolean {
  if (evidence.kind !== 'exchange-calendar') return true;
  const opensSec = opens.map((open) => {
    if (!Number.isSafeInteger(open) || open % unitsPerSecond !== 0) return NaN;
    return open / unitsPerSecond;
  });
  if (opensSec.some((open) => !Number.isSafeInteger(open))) return false;
  try {
    exchangeCalendarPeriodsForChartOpens(opensSec, chartCanonicalTf, evidence.calendar);
    return true;
  } catch {
    return false;
  }
}

/**
 * Authenticate day/week opens against declared periods and intraday opens
 * against the containing session's fixed-duration phase. The return value is
 * reused when provider-calendar closes need the matched day/week periods.
 */
function exchangeCalendarPeriodsForChartOpens(
  opens: readonly number[],
  chartCanonicalTf: string,
  calendar: HistorySessionCalendar,
): readonly CalendarSessionPeriod[] | undefined {
  if (isCalendarSessionTimeframe(chartCanonicalTf)) {
    const periods = calendarSessionPeriods(calendar, chartCanonicalTf);
    const byOpen = new Map(periods.map((period) => [period.from as number, period] as const));
    return opens.map((open, index) => {
      const period = byOpen.get(open);
      if (!period) {
        throw new BarMagnifierError({
          kind: 'unsupported',
          code: 'chart-open-outside-calendar',
          message: `chart bar ${index} does not open at a declared provider calendar period`,
          details: { index, open, calendarId: calendar.calendarId, version: calendar.version },
        });
      }
      assertCalendarPeriodCoverage(calendar, period);
      return period;
    });
  }

  const parsed = parseCanonicalTimeframeExact(chartCanonicalTf);
  if (parsed.kind !== 'ok' || parsed.value.domain !== 'fixed') return undefined;
  const duration = parsed.value.seconds;
  let sessionIndex = 0;
  for (const [index, open] of opens.entries()) {
    while (sessionIndex < calendar.sessions.length && calendar.sessions[sessionIndex]!.to <= open) {
      sessionIndex++;
    }
    const session = calendar.sessions[sessionIndex];
    if (!session || open < session.from || open >= session.to) {
      throw new BarMagnifierError({
        kind: 'unsupported',
        code: 'chart-open-outside-calendar',
        message: `chart bar ${index} is not inside a declared provider session`,
        details: { index, open, calendarId: calendar.calendarId, version: calendar.version },
      });
    }
    if (floorMod(open - session.from, duration) !== 0) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'chart-fixed-grid-mismatch',
        message: `chart bar ${index} does not open on the authenticated provider session grid`,
        details: {
          index,
          open,
          sessionOpen: session.from,
          chartCanonicalTf,
          calendarId: calendar.calendarId,
          version: calendar.version,
        },
      });
    }
  }
  return undefined;
}

function floorMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function chartIntervals(
  bars: readonly Bar[],
  chartCanonicalTf: string,
  source: ResolvedHistorySource,
  alignmentEvidence: ResolvedMagnifierAlignmentEvidence,
  explicitCloses?: readonly number[],
): ChartIntervalsSec {
  if (bars.length === 0) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'empty-chart-envelope',
      message: 'Bar Magnifier exact acquisition requires at least one chart bar',
    });
  }
  const opens = Object.freeze(
    bars.map((bar, index) => {
      if (!Number.isSafeInteger(bar.time) || bar.time >= 1e12) {
        throw new BarMagnifierError({
          kind: 'malformed',
          code: 'chart-time-unit',
          message: `chart bar ${index} must use a whole UNIX-second open before magnifier resolution`,
          details: { index, time: bar.time },
        });
      }
      if (index > 0 && bar.time <= bars[index - 1]!.time) {
        throw new BarMagnifierError({
          kind: 'malformed',
          code: 'chart-bar-order',
          message: 'chart bars must be strictly ascending with unique opens',
          details: { index, previous: bars[index - 1]!.time, current: bar.time },
        });
      }
      return bar.time;
    }),
  );

  if (!utcFixedChartOpensAligned(opens, chartCanonicalTf, alignmentEvidence, 1)) {
    const weekly = isUtcWeekTimeframe(chartCanonicalTf);
    throw new BarMagnifierError({
      kind: 'malformed',
      code: weekly ? 'chart-week-grid-mismatch' : 'chart-fixed-grid-mismatch',
      message: weekly
        ? 'Bar Magnifier UTC week chart opens do not match piner runtime week boundaries'
        : 'Bar Magnifier UTC chart opens do not match the authenticated fixed-duration grid',
      details: {
        chartCanonicalTf,
        runtimeWeekPhaseSec: weekly ? PINE_UTC_WEEK_PHASE_SEC : null,
        opens,
      },
    });
  }

  const exchangeCalendarPeriods =
    alignmentEvidence.kind === 'exchange-calendar'
      ? exchangeCalendarPeriodsForChartOpens(opens, chartCanonicalTf, alignmentEvidence.calendar)
      : undefined;

  let closes: readonly number[];
  let intervalSource: ChartIntervalsSec['source'];
  if (explicitCloses) {
    closes = [...explicitCloses];
    intervalSource = 'host-explicit';
  } else if (source.capabilities.alignment === 'utc-24x7') {
    const duration = fixedDuration(chartCanonicalTf);
    closes = opens.map((open) => safeSecondAdd(open, duration, 'chart bar close'));
    intervalSource = 'utc-fixed';
  } else if (source.capabilities.alignment === 'exchange-calendar') {
    const calendar = source.capabilities.calendar;
    if (!calendar) {
      throw new BarMagnifierError({
        kind: 'unsupported',
        code: 'chart-calendar-metadata-missing',
        message: 'exchange-calendar chart intervals require provider calendar metadata',
      });
    }
    const duration = fixedDuration(chartCanonicalTf);
    closes = calendarChartCloses(
      opens,
      duration,
      chartCanonicalTf,
      calendar,
      exchangeCalendarPeriods,
    );
    intervalSource = 'provider-calendar';
  } else {
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'chart-interval-alignment-unknown',
      message:
        'Bar Magnifier exact acquisition requires explicit, UTC, or provider-calendar closes',
    });
  }

  validateChartCloses(opens, closes);
  return { opens, closes: Object.freeze([...closes]), source: intervalSource };
}

function validateChartCloses(opens: readonly number[], closes: readonly number[]): void {
  if (closes.length !== opens.length) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'chart-close-count',
      message: 'chart close count must equal chart bar count',
      details: { bars: opens.length, closes: closes.length },
    });
  }
  for (let index = 0; index < closes.length; index++) {
    const close = closes[index]!;
    if (!Number.isSafeInteger(close) || close <= opens[index]!) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'chart-close-boundary',
        message: `chart close ${index} must be a whole UNIX second after its open`,
        details: { index, open: opens[index], close },
      });
    }
    const nextOpen = opens[index + 1];
    if (nextOpen !== undefined && close > nextOpen) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'chart-interval-overlap',
        message: `chart interval ${index} overlaps the next chart bar`,
        details: { index, close, nextOpen },
      });
    }
  }
}

function fixedDuration(timeframe: string): number {
  const duration = canonicalTimeframeSecondsExact(timeframe);
  if (duration.kind !== 'ok') throw exactConversionError(duration);
  return duration.value;
}

function calendarChartCloses(
  opens: readonly number[],
  duration: number,
  chartCanonicalTf: string,
  calendar: HistorySessionCalendar,
  matchedPeriods?: readonly CalendarSessionPeriod[],
): readonly number[] {
  if (isCalendarSessionTimeframe(chartCanonicalTf)) {
    const periods =
      matchedPeriods ??
      exchangeCalendarPeriodsForChartOpens(opens, chartCanonicalTf, calendar) ??
      [];
    return periods.map((period) => period.to);
  }

  let openingSessionIndex = 0;
  return opens.map((open, index) => {
    while (
      openingSessionIndex < calendar.sessions.length &&
      calendar.sessions[openingSessionIndex]!.to <= open
    ) {
      openingSessionIndex++;
    }
    const openingSession = calendar.sessions[openingSessionIndex];
    if (!openingSession || open < openingSession.from || open >= openingSession.to) {
      throw new BarMagnifierError({
        kind: 'unsupported',
        code: 'chart-open-outside-calendar',
        message: `chart bar ${index} is not inside a declared provider session`,
        details: { index, open, calendarId: calendar.calendarId, version: calendar.version },
      });
    }

    const nominalBoundary = safeSecondAdd(open, duration, 'chart bar close boundary');
    const nextOpen = opens[index + 1];
    const boundary = nextOpen === undefined ? nominalBoundary : Math.min(nominalBoundary, nextOpen);
    if (open < calendar.coverage.from || boundary > calendar.coverage.to) {
      throw new BarMagnifierError({
        kind: 'provider-limited',
        code: 'chart-calendar-coverage-insufficient',
        message:
          `Provider calendar ${calendar.calendarId}@${calendar.version} does not cover ` +
          `the complete chart interval ${index}; supply explicit chart closes`,
        details: { index, open, boundary, coverage: calendar.coverage },
      });
    }

    let close: number | undefined;
    for (
      let sessionIndex = openingSessionIndex;
      sessionIndex < calendar.sessions.length;
      sessionIndex++
    ) {
      const session = calendar.sessions[sessionIndex]!;
      if (session.from >= boundary) break;
      if (session.from < boundary && boundary <= session.to) return boundary;
      if (session.to <= boundary) close = session.to;
    }
    if (close !== undefined && close > open) return close;

    throw new BarMagnifierError({
      kind: 'provider-limited',
      code: 'chart-close-unprovable-from-calendar',
      message:
        `Provider calendar ${calendar.calendarId}@${calendar.version} cannot prove ` +
        `the close of chart interval ${index}; supply explicit chart closes`,
      details: { index, open, boundary },
    });
  });
}

async function acquireAndConvert(
  source: ResolvedHistorySource,
  requestedSymbol: string,
  requested: ReturnType<typeof halfOpenIntervalSec>,
  targetCanonicalTf: string,
  sourceCanonicalTf: string,
  preflight: MagnifierPreflight,
  intervals: ChartIntervalsSec,
  alignmentEvidence: ResolvedMagnifierAlignmentEvidence,
): Promise<ResolvedMagnifierDataset> {
  const acquisition = await acquireExactHistory(source, {
    targetTimeframe: targetCanonicalTf,
    requested,
  });
  return convertAcquisition(
    acquisition,
    requestedSymbol,
    preflight,
    targetCanonicalTf,
    sourceCanonicalTf,
    intervals,
    alignmentEvidence,
  );
}

function convertAcquisition(
  acquisition: HistoryAcquisition,
  requestedSymbol: string,
  preflight: MagnifierPreflight,
  targetCanonicalTf: string,
  sourceCanonicalTf: string,
  intervals: ChartIntervalsSec,
  alignmentEvidence: ResolvedMagnifierAlignmentEvidence,
): ResolvedMagnifierDataset {
  const barsMs = registerOwnedImmutableBars(
    Object.freeze(
      acquisition.bars.map((bar) =>
        Object.freeze({
          time: secondsToMilliseconds(bar.time),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.volume,
        }),
      ),
    ),
  );
  const chartOpenTimesMs = Object.freeze(
    intervals.opens.map((open) => secondsToMilliseconds(open)),
  );
  const chartCloseTimesMs = Object.freeze(
    intervals.closes.map((close) => secondsToMilliseconds(close)),
  );
  const coverage = Object.freeze({
    requested: freezeIntervalMs(acquisition.requested),
    covered: Object.freeze(acquisition.covered.map(freezeIntervalMs)),
    gaps: Object.freeze(
      acquisition.gaps.map(
        (gap) =>
          Object.freeze({
            ...freezeIntervalMs(gap),
            reason: gap.reason,
          }) as CoverageGapMs,
      ),
    ),
    complete: acquisition.complete,
  });
  const provenance = Object.freeze({ ...acquisition.provenance }) as AcquisitionProvenance;
  const resolved = {
    contractVersion: preflight.contractVersion!,
    mappingVersion: preflight.mappingVersion!,
    requestedSymbol,
    targetPineTf: preflight.targetPineTf!,
    targetCanonicalTf,
    sourceCanonicalTf,
    barsMs,
    chartOpenTimesMs,
    chartCloseTimesMs,
    chartIntervalSource: intervals.source,
    coverage,
    provenance,
    alignmentEvidence,
    barsDigest: marketDataDigest(barsMs),
  } satisfies Omit<ResolvedMagnifierDataset, 'acquisitionKey'>;
  const dataset = Object.freeze({
    ...resolved,
    acquisitionKey: magnifierDatasetAcquisitionKey(resolved),
  });
  resolverIssuedMagnifierDatasets.add(dataset);
  return dataset;
}

function freezeIntervalMs(interval: {
  readonly from: number;
  readonly to: number;
}): HalfOpenIntervalMs {
  return Object.freeze({
    from: secondsToMilliseconds(interval.from),
    to: secondsToMilliseconds(interval.to),
  });
}

function secondsToMilliseconds(seconds: number): UnixMillisecond {
  if (!Number.isSafeInteger(seconds)) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'noninteger-second-boundary',
      message: 'Bar Magnifier timestamps must use whole safe UNIX seconds before conversion',
      details: { seconds },
    });
  }
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'millisecond-boundary-overflow',
      message: 'Bar Magnifier timestamp overflows safe UNIX milliseconds',
      details: { seconds },
    });
  }
  return unixMillisecond(milliseconds);
}

function safeSecondAdd(value: number, delta: number, label: string): number {
  const result = value + delta;
  if (!Number.isSafeInteger(result)) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'chart-boundary-overflow',
      message: `${label} overflows safe UNIX seconds`,
      details: { value, delta },
    });
  }
  return result;
}

function exactConversionError(result: {
  readonly kind: 'unsupported' | 'malformed';
  readonly code: string;
  readonly message: string;
  readonly input: string;
}): ExactHistoryError {
  return new ExactHistoryError({
    kind: result.kind,
    code: result.code,
    message: result.message,
    details: { input: result.input },
  });
}
