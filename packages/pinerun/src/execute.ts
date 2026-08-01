/** Pure local/worker piner execution boundary. */
import { ArrayFeed, CompileError, Engine, StrategyBroker } from '@heyphat/piner';
import {
  calendarSessionPeriods,
  canonicalTimeframeSecondsExact,
  isCalendarSessionTimeframe,
  parseCanonicalTimeframeExact,
  pineTimeframeToCanonicalExact,
  snapshotHistorySessionCalendar,
  utcTimeframeAnchor,
  utcTimeframesNest,
  validateHistoryAcquisition,
  type HistorySessionCalendar,
  type UnixSecond,
} from '@heyphat/pinery';
import type { CompiledScript, EngineOptions } from '@heyphat/piner';
import { BarMagnifierError } from './failure.js';
import type { Bar, Job, ResolvedMagnifierDataset } from './job.js';
import { jobId } from './job.js';
import { marketDataDigest } from './digest.js';
import {
  assertBarMagnifierBudgets,
  exchangeCalendarChartOpensAligned,
  isResolverIssuedMagnifierDataset,
  magnifierDatasetAcquisitionKey,
  preflightBarMagnifier,
  utcFixedChartOpensAligned,
  type BarMagnifierBudgetOptions,
  type MagnifierPreflight,
} from './magnifier.js';
import {
  compilePinerSource,
  pinerCapabilities,
  type PinerCapabilityAdapter,
} from './piner-capabilities.js';
import { assertResolvedSecurityForBarMagnifier } from './security.js';
import type {
  BarMagnifierSummary,
  PlotResult,
  RunResult,
  StrategySummary,
  StrategyTrade,
} from './result.js';

/** See calc_on_order_fills audit: defaults, not configured extra keys, prove support. */
const ENGINE_SUPPORTS_COOF = 'calcOnOrderFills' in new StrategyBroker().settings;

export async function executeJob(job: Job): Promise<RunResult> {
  const id = jobId(job);
  const started = Date.now();
  const base: RunResult = {
    id,
    symbol: job.symbol,
    timeframe: job.timeframe,
    ok: false,
    bars: job.bars.length,
    plots: [],
    alerts: [],
  };

  let compiled: CompiledScript;
  try {
    compiled = compilePinerSource(job.source);
  } catch (err) {
    return {
      ...base,
      error: err instanceof CompileError ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }

  const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    return {
      ...base,
      diagnostics: compiled.diagnostics.map(fmtDiag),
      error: `compile: ${errors.map((diagnostic) => diagnostic.message).join('; ')}`,
      elapsedMs: Date.now() - started,
    };
  }

  const adapter = pinerCapabilities();
  let preparation: PinerEnginePreparation | undefined;

  try {
    // Host overrides are added only when defined; omission preserves the source
    // declaration. The cast is intentionally structural so pinerun still builds
    // against old piner declarations that do not yet name useBarMagnifier.
    const strategyOverride: Record<string, unknown> = {};
    if (job.minQty != null) strategyOverride.minQty = job.minQty;
    if (job.calcOnOrderFills != null && ENGINE_SUPPORTS_COOF) {
      strategyOverride.calcOnOrderFills = job.calcOnOrderFills;
    }
    if (job.useBarMagnifier != null) strategyOverride.useBarMagnifier = job.useBarMagnifier;

    const engine = new Engine(compiled, new ArrayFeed(toPinerBars(job.bars)), {
      backend: job.backend ?? 'js',
      inputs: job.inputs,
      strategy: Object.keys(strategyOverride).length
        ? (strategyOverride as EngineOptions['strategy'])
        : undefined,
    });

    preparation = preparePinerEngineForRun(engine, job, { adapter });

    if (job.calcOnOrderFills != null && !ENGINE_SUPPORTS_COOF) {
      return {
        ...base,
        error:
          'calc_on_order_fills override: the loaded @heyphat/piner engine does not ' +
          'model calc_on_order_fills (needs a release newer than 0.9.0) — remove ' +
          'the override or upgrade the engine',
        elapsedMs: Date.now() - started,
      };
    }

    await engine.run({ symbol: job.symbol, timeframe: job.timeframe, mintick: job.mintick });

    const plots: PlotResult[] = [];
    for (const plot of engine.outputs.plots.values()) {
      plots.push({
        id: plot.id,
        title: plot.title,
        data: fillDense(plot.data, job.bars.length),
      });
    }
    plots.sort((left, right) => left.id - right.id);
    const alerts = engine.outputs.alerts.map((alert) => ({
      bar: alert.bar,
      message: alert.message,
    }));

    let strategy: StrategySummary | undefined;
    let trades: StrategyTrade[] | undefined;
    let equityCurve: number[] | undefined;
    let barTimes: number[] | undefined;
    let closes: number[] | undefined;
    if (compiled.metadata.isStrategy) {
      const stats = engine.ctx.strategy;
      const broker = engine.ctx.strategyBroker;
      const report = engine.strategy;
      const effectiveCoof = (broker.settings as { calcOnOrderFills?: boolean }).calcOnOrderFills;
      const barMagnifier = projectAuthoritativeBarMagnifierReport(
        report as unknown,
        preparation.preflight.requested,
      );
      strategy = {
        calcOnOrderFills: effectiveCoof === true || undefined,
        ...(barMagnifier ? { barMagnifier } : {}),
        initialCapital: stats.initial_capital,
        netProfit: stats.netprofit,
        netProfitPercent: stats.netprofit_percent,
        grossProfit: stats.grossprofit,
        grossProfitPercent: stats.grossprofit_percent,
        grossLoss: stats.grossloss,
        grossLossPercent: stats.grossloss_percent,
        profitFactor: broker.profitFactor,
        wins: stats.wintrades,
        losses: stats.losstrades,
        evens: report.evens,
        closedTrades: stats.closedtrades,
        winRate: broker.winRate,
        avgTrade: stats.avg_trade,
        avgTradePercent: stats.avg_trade_percent,
        avgWinningTrade: stats.avg_winning_trade,
        avgLosingTrade: stats.avg_losing_trade,
        maxDrawdown: stats.max_drawdown,
        maxDrawdownPercent: stats.max_drawdown_percent,
        maxRunup: stats.max_runup,
        maxRunupPercent: stats.max_runup_percent,
        maxContractsHeld: stats.max_contracts_held_all,
        totalCommission: report.totalCommission,
        barsProcessed: report.barsProcessed,
        barsInMarket: report.barsInMarket,
        metrics: engine.strategyMetrics(job.metrics),
      };
      if (job.includeTrades) {
        trades = broker.closedTrades.map((trade) => ({ ...trade }));
        equityCurve = broker.equityCurve.slice();
        barTimes = job.bars.map((bar) => bar.time);
        closes = job.bars.map((bar) => bar.close);
      }
    }

    return {
      ...base,
      ok: true,
      plots,
      alerts,
      strategy,
      trades,
      equityCurve,
      barTimes,
      closes,
      securityRequests: engine.outputs.securityRequests.map((request) => ({ ...request })),
      diagnostics: compiled.diagnostics.length ? compiled.diagnostics.map(fmtDiag) : undefined,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof BarMagnifierError) return permanentFailure(base, error, started);
    const message = errorMessage(error);
    if (preparation?.preflight.requested && /bar magnifier/i.test(message)) {
      return permanentFailure(
        base,
        new BarMagnifierError({
          kind: 'malformed',
          code: 'invalid-injected-bar-magnifier-data',
          message,
        }),
        started,
      );
    }
    return { ...base, error: message, elapsedMs: Date.now() - started };
  }
}

export interface PreparedMagnifierSourceIdentity {
  readonly requestedSymbol: string;
  readonly normalizedSymbol: string;
  readonly cacheIdentity: string;
}

/** Authenticated facts Pinelive can persist beside its own run binding. */
export interface PreparedMagnifierBinding {
  readonly sourceIdentity: PreparedMagnifierSourceIdentity;
  readonly targetPineTf: string;
  readonly targetCanonicalTf: string;
  readonly sourceCanonicalTf: string;
  readonly targetBarCount: number;
  readonly rawBarCount: number;
  readonly acquisitionKey: string;
  readonly barsDigest: string;
  readonly coverage: ResolvedMagnifierDataset['coverage'];
  readonly chartOpenTimesMs: ResolvedMagnifierDataset['chartOpenTimesMs'];
  readonly chartCloseTimesMs: ResolvedMagnifierDataset['chartCloseTimesMs'];
}

export interface PinerEnginePreparation {
  readonly preflight: MagnifierPreflight;
  readonly magnifier?: PreparedMagnifierBinding;
  readonly securityKeys: readonly string[];
}

export interface PreparePinerEngineForRunOptions extends BarMagnifierBudgetOptions {
  readonly adapter?: PinerCapabilityAdapter;
}

/**
 * Authenticate, convert, and bind every pre-resolved exact input to an Engine.
 * The Engine is never run here. All validation and budgets complete before the
 * first mutation, and no returned fact can mint resolver authority. The Job
 * must describe the source/options used to construct the Engine; its effective
 * Bar Magnifier setting is independently checked below.
 */
export function preparePinerEngineForRun(
  engine: Engine,
  job: Job,
  options: PreparePinerEngineForRunOptions = {},
): PinerEnginePreparation {
  const adapter = options.adapter ?? pinerCapabilities();
  const preflight = preflightBarMagnifier(job.source, job.timeframe, job.useBarMagnifier, adapter);
  assertEngineMagnifierSetting(engine, preflight, adapter);
  let dataset: ResolvedMagnifierDataset | undefined;
  if (preflight.requested) {
    dataset = assertResolvedMagnifierDatasetForJob(job, preflight);
    assertResolvedSecurityForBarMagnifier(job.source, preflight.securityDependencies, job);
    assertBarMagnifierBudgets(dataset, options);
  }

  // Stage every conversion before mutating the already-created Engine.
  const securityEntries = Object.entries(job.securityBars ?? {}).map(
    ([key, bars]) => [key, toPinerBars(bars)] as const,
  );

  if (dataset) {
    try {
      adapter.injectMagnifierData(
        engine as unknown as { ctx: Record<string, unknown> },
        toPinerBarMagnifierData(dataset),
      );
    } catch (error) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'invalid-injected-bar-magnifier-data',
        message: errorMessage(error),
      });
    }
  }
  for (const [key, bars] of securityEntries) engine.ctx.securityBars.set(key, bars);

  const securityKeys = Object.freeze(securityEntries.map(([key]) => key).sort());
  const magnifier = dataset
    ? Object.freeze({
        sourceIdentity: Object.freeze({
          requestedSymbol: dataset.requestedSymbol,
          normalizedSymbol: dataset.provenance.normalizedSymbol,
          cacheIdentity: dataset.provenance.cacheIdentity,
        }),
        targetPineTf: dataset.targetPineTf,
        targetCanonicalTf: dataset.targetCanonicalTf,
        sourceCanonicalTf: dataset.sourceCanonicalTf,
        targetBarCount: dataset.barsMs.length,
        rawBarCount: dataset.rawBarCount,
        acquisitionKey: dataset.acquisitionKey,
        barsDigest: dataset.barsDigest,
        coverage: dataset.coverage,
        chartOpenTimesMs: dataset.chartOpenTimesMs,
        chartCloseTimesMs: dataset.chartCloseTimesMs,
      })
    : undefined;
  return Object.freeze({
    preflight,
    ...(magnifier ? { magnifier } : {}),
    securityKeys,
  });
}

function assertEngineMagnifierSetting(
  engine: Engine,
  preflight: MagnifierPreflight,
  adapter: PinerCapabilityAdapter,
): void {
  const broker = engine.ctx.strategyBroker as unknown as {
    readonly settings?: { readonly useBarMagnifier?: unknown };
  };
  const effective = broker.settings?.useBarMagnifier;
  if (typeof effective === 'boolean') {
    if (effective !== preflight.requested) {
      throw new BarMagnifierError({
        kind: 'malformed',
        code: 'bar-magnifier-engine-setting-mismatch',
        message:
          'The already-created Engine Bar Magnifier setting does not match the effective pinerun preflight',
        details: {
          preflightRequested: preflight.requested,
          engineRequested: effective,
        },
      });
    }
    return;
  }
  if (adapter.capable) {
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'piner-bar-magnifier-engine-setting-unavailable',
      message:
        'The loaded capable piner Engine does not expose its effective Bar Magnifier setting',
    });
  }
}

export function assertResolvedMagnifierDatasetForJob(
  job: Pick<Job, 'symbol' | 'timeframe' | 'bars' | 'magnifier'>,
  preflight: MagnifierPreflight,
): ResolvedMagnifierDataset {
  const dataset = job.magnifier;
  if (!dataset) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'unresolved-bar-magnifier-data',
      message:
        'Bar Magnifier was requested, but no exact resolved magnifier dataset was attached to the Job',
    });
  }
  const mismatches: string[] = [];
  const mismatch = (value: string): void => {
    if (!mismatches.includes(value)) mismatches.push(value);
  };
  if (!deeplyFrozen(dataset)) mismatch('dataset-not-deeply-immutable');
  if (!isResolverIssuedMagnifierDataset(dataset)) mismatch('resolver-authentication');
  if (!Array.isArray(dataset.barsMs)) mismatch('bars-shape');
  if (
    typeof dataset.barsDigest !== 'string' ||
    !Array.isArray(dataset.barsMs) ||
    dataset.barsDigest !== marketDataDigest(dataset.barsMs)
  ) {
    mismatch('bars-digest');
  }
  if (
    !Number.isSafeInteger(dataset.rawBarCount) ||
    !Array.isArray(dataset.barsMs) ||
    dataset.rawBarCount < dataset.barsMs.length
  ) {
    mismatch('raw-bar-count');
  }
  const alignmentEvidence = magnifierAlignmentEvidence(dataset.alignmentEvidence);
  if (!alignmentEvidence) mismatch('alignment-evidence');
  if (dataset.requestedSymbol !== job.symbol) mismatch('requested-symbol');
  if (preflight.chartPineTf !== job.timeframe) mismatch('chart-timeframe');
  if (dataset.contractVersion !== preflight.contractVersion) mismatch('contract-version');
  if (dataset.mappingVersion !== preflight.mappingVersion) mismatch('mapping-version');
  if (dataset.targetPineTf !== preflight.targetPineTf) mismatch('target-timeframe');

  const targetCanonical =
    preflight.targetPineTf === undefined
      ? undefined
      : pineTimeframeToCanonicalExact(preflight.targetPineTf);
  if (!targetCanonical || targetCanonical.kind !== 'ok') {
    mismatch('target-canonical-timeframe');
  } else if (dataset.targetCanonicalTf !== targetCanonical.value) {
    mismatch('target-canonical-timeframe');
  }
  if (canonicalTimeframeSecondsExact(dataset.sourceCanonicalTf).kind !== 'ok') {
    mismatch('source-canonical-timeframe');
  }
  if (
    typeof dataset.provenance.cacheIdentity !== 'string' ||
    dataset.provenance.cacheIdentity.length === 0 ||
    typeof dataset.provenance.normalizedSymbol !== 'string' ||
    dataset.provenance.normalizedSymbol.length === 0 ||
    typeof dataset.provenance.alignment !== 'string' ||
    dataset.provenance.alignment.length === 0 ||
    (dataset.provenance.weekAnchorSec !== undefined &&
      !Number.isSafeInteger(dataset.provenance.weekAnchorSec)) ||
    (dataset.provenance.coverageSemantics !== undefined &&
      dataset.provenance.coverageSemantics !== 'bars-only' &&
      dataset.provenance.coverageSemantics !== 'complete-record') ||
    ((dataset.provenance.coverageSemantics ?? 'bars-only') === 'complete-record' &&
      !validSecondInterval(dataset.provenance.recordSpan)) ||
    ((dataset.provenance.coverageSemantics ?? 'bars-only') === 'bars-only' &&
      dataset.provenance.recordSpan !== undefined) ||
    !Number.isSafeInteger(dataset.provenance.aggregationVersion) ||
    dataset.provenance.aggregationVersion < 0
  ) {
    mismatch('provenance');
  }
  if (dataset.provenance.targetTimeframe !== dataset.targetCanonicalTf) {
    mismatch('provenance-target-timeframe');
  }
  if (dataset.provenance.sourceTimeframe !== dataset.sourceCanonicalTf) {
    mismatch('provenance-source-timeframe');
  }
  if (alignmentEvidence) {
    if (dataset.provenance.alignment !== magnifierAlignmentIdentity(alignmentEvidence)) {
      mismatch('provenance-alignment');
    }
    if (
      alignmentEvidence.kind === 'utc-24x7' &&
      (dataset.provenance.weekAnchorSec ?? null) !== (alignmentEvidence.weekAnchorSec ?? null)
    ) {
      mismatch('provenance-week-anchor');
    }
    if (!validMagnifierTimeframeLineage(dataset.provenance, alignmentEvidence)) {
      mismatch('provenance-timeframe-lineage');
    }
  }
  const sourceTimeframe = parseCanonicalTimeframeExact(dataset.sourceCanonicalTf);
  const targetTimeframe = parseCanonicalTimeframeExact(dataset.targetCanonicalTf);
  const usesUtcWeek =
    dataset.provenance.alignment === 'utc-24x7' &&
    ((sourceTimeframe.kind === 'ok' &&
      sourceTimeframe.value.domain === 'fixed' &&
      sourceTimeframe.value.unit === 'w') ||
      (targetTimeframe.kind === 'ok' &&
        targetTimeframe.value.domain === 'fixed' &&
        targetTimeframe.value.unit === 'w'));
  if (usesUtcWeek && dataset.provenance.weekAnchorSec === undefined) {
    mismatch('provenance-week-anchor');
  }
  if (
    dataset.provenance.weekAnchorSec !== undefined &&
    dataset.provenance.alignment !== 'utc-24x7'
  ) {
    mismatch('provenance-week-anchor');
  }
  if (
    (dataset.chartIntervalSource === 'utc-fixed' && alignmentEvidence?.kind !== 'utc-24x7') ||
    (dataset.chartIntervalSource === 'provider-calendar' &&
      alignmentEvidence?.kind !== 'exchange-calendar')
  ) {
    mismatch('provenance-alignment');
  }
  if (dataset.coverage.complete !== true || dataset.coverage.gaps.length !== 0) {
    mismatch('coverage');
  }
  if (dataset.chartOpenTimesMs.length !== job.bars.length) mismatch('chart-open-count');
  if (dataset.chartCloseTimesMs.length !== job.bars.length) mismatch('chart-close-count');

  const expectedChartOpens = job.bars.map((bar) => chartTimeMilliseconds(bar.time));
  const chartCanonical = pineTimeframeToCanonicalExact(job.timeframe);
  const chartDuration =
    chartCanonical.kind === 'ok'
      ? canonicalTimeframeSecondsExact(chartCanonical.value)
      : chartCanonical;
  const utcDurationMs =
    chartDuration.kind === 'ok' && Number.isSafeInteger(chartDuration.value * 1000)
      ? chartDuration.value * 1000
      : undefined;
  if (
    alignmentEvidence &&
    chartCanonical.kind === 'ok' &&
    !utcFixedChartOpensAligned(expectedChartOpens, chartCanonical.value, alignmentEvidence, 1000)
  ) {
    mismatch('chart-open-grid');
  }
  if (
    alignmentEvidence &&
    chartCanonical.kind === 'ok' &&
    !exchangeCalendarChartOpensAligned(
      expectedChartOpens,
      chartCanonical.value,
      alignmentEvidence,
      1000,
    )
  ) {
    mismatch('chart-open-calendar');
  }

  const count = Math.min(
    job.bars.length,
    dataset.chartOpenTimesMs.length,
    dataset.chartCloseTimesMs.length,
  );
  for (let index = 0; index < count; index++) {
    const expectedOpen = expectedChartOpens[index]!;
    const open = dataset.chartOpenTimesMs[index]!;
    const close = dataset.chartCloseTimesMs[index]!;
    if (!Number.isSafeInteger(open) || open !== expectedOpen) mismatch('chart-open-boundary');
    if (!Number.isSafeInteger(close) || close <= open) mismatch('chart-close-boundary');
    if (dataset.chartIntervalSource === 'utc-fixed') {
      const expectedClose = utcDurationMs === undefined ? NaN : expectedOpen + utcDurationMs;
      if (!Number.isSafeInteger(expectedClose) || close !== expectedClose) {
        mismatch('chart-close-boundary');
      }
    }
    const nextOpen = expectedChartOpens[index + 1];
    if (nextOpen !== undefined && close > nextOpen) mismatch('chart-interval-overlap');
  }

  const firstOpen = expectedChartOpens[0];
  const finalClose = dataset.chartCloseTimesMs.at(-1);
  if (
    firstOpen === undefined ||
    finalClose === undefined ||
    dataset.coverage.requested.from !== firstOpen ||
    dataset.coverage.requested.to !== finalClose
  ) {
    mismatch('coverage-requested-envelope');
  }
  if (!millisecondIntervalsCover(dataset.coverage.covered, dataset.coverage.requested)) {
    mismatch('coverage-covered-envelope');
  }
  if (
    alignmentEvidence &&
    !magnifierCoverageMatchesAuthenticatedEvidence(dataset, alignmentEvidence)
  ) {
    mismatch('coverage-evidence');
  }

  try {
    const expectedAcquisitionKey = magnifierDatasetAcquisitionKey({
      ...dataset,
      chartOpenTimesMs:
        expectedChartOpens as unknown as ResolvedMagnifierDataset['chartOpenTimesMs'],
    });
    if (dataset.acquisitionKey !== expectedAcquisitionKey) mismatch('acquisition-identity');
  } catch {
    mismatch('acquisition-identity');
  }

  if (mismatches.length > 0) {
    throw new BarMagnifierError({
      kind: 'malformed',
      code: 'invalid-injected-bar-magnifier-data',
      message: `Resolved Bar Magnifier data does not match this Job/preflight: ${mismatches.join(', ')}`,
      details: {
        mismatches,
        expected: {
          requestedSymbol: job.symbol,
          chartPineTf: job.timeframe,
          contractVersion: preflight.contractVersion,
          mappingVersion: preflight.mappingVersion,
          targetPineTf: preflight.targetPineTf,
          targetCanonicalTf: targetCanonical?.kind === 'ok' ? targetCanonical.value : undefined,
          chartBars: job.bars.length,
          firstChartOpenMs: expectedChartOpens[0],
        },
        actual: {
          requestedSymbol: dataset.requestedSymbol,
          contractVersion: dataset.contractVersion,
          mappingVersion: dataset.mappingVersion,
          targetPineTf: dataset.targetPineTf,
          targetCanonicalTf: dataset.targetCanonicalTf,
          chartOpens: dataset.chartOpenTimesMs.length,
          chartCloses: dataset.chartCloseTimesMs.length,
          coverageComplete: dataset.coverage.complete,
          coverageRequested: dataset.coverage.requested,
          acquisitionKey: dataset.acquisitionKey,
        },
      },
    });
  }
  return dataset;
}

type ValidatedMagnifierAlignmentEvidence =
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

function magnifierAlignmentEvidence(
  value: unknown,
): ValidatedMagnifierAlignmentEvidence | undefined {
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
    return {
      kind: 'exchange-calendar',
      alignment: 'exchange-calendar',
      calendar: snapshotHistorySessionCalendar(value.calendar as unknown as HistorySessionCalendar),
    };
  } catch {
    return undefined;
  }
}

function magnifierAlignmentIdentity(evidence: ValidatedMagnifierAlignmentEvidence): string {
  return evidence.kind === 'utc-24x7'
    ? evidence.kind
    : `exchange-calendar:${evidence.calendar.calendarId}@${evidence.calendar.version}`;
}

function validMagnifierTimeframeLineage(
  provenance: ResolvedMagnifierDataset['provenance'],
  evidence: ValidatedMagnifierAlignmentEvidence,
): boolean {
  const source = canonicalTimeframeSecondsExact(provenance.sourceTimeframe);
  const target = canonicalTimeframeSecondsExact(provenance.targetTimeframe);
  if (source.kind !== 'ok' || target.kind !== 'ok') return false;
  let nested = target.value % source.value === 0;
  if (evidence.kind === 'utc-24x7') {
    try {
      nested = utcTimeframesNest(
        provenance.sourceTimeframe,
        provenance.targetTimeframe,
        evidence.weekAnchorSec,
        evidence.weekAnchorSec,
      );
    } catch {
      return false;
    }
  }
  if (provenance.aggregationVersion === 0) return source.value === target.value && nested;
  return provenance.aggregationVersion > 0 && source.value < target.value && nested;
}

interface MagnifierIntervalMs {
  readonly from: number;
  readonly to: number;
}

/** Reconstruct coverage under the authenticated bars-only or complete-record contract. */
function magnifierCoverageMatchesAuthenticatedEvidence(
  dataset: ResolvedMagnifierDataset,
  evidence: ValidatedMagnifierAlignmentEvidence,
): boolean {
  if ((dataset.provenance.coverageSemantics ?? 'bars-only') !== 'complete-record') {
    return magnifierCoverageMatchesBars(dataset, evidence);
  }
  if (!validSecondInterval(dataset.provenance.recordSpan)) return false;
  const seconds = (value: number): number =>
    Number.isSafeInteger(value) && value % 1_000 === 0 ? value / 1_000 : NaN;
  try {
    validateHistoryAcquisition(
      {
        bars: dataset.barsMs.map((bar) => ({ ...bar, time: seconds(bar.time) })),
        requested: {
          from: seconds(dataset.coverage.requested.from),
          to: seconds(dataset.coverage.requested.to),
        } as import('@heyphat/pinery').HalfOpenIntervalSec,
        covered: dataset.coverage.covered.map((interval) => ({
          from: seconds(interval.from),
          to: seconds(interval.to),
        })) as import('@heyphat/pinery').HalfOpenIntervalSec[],
        gaps: dataset.coverage.gaps.map((gap) => ({
          from: seconds(gap.from),
          to: seconds(gap.to),
          reason: gap.reason,
        })) as import('@heyphat/pinery').CoverageGapSec[],
        complete: dataset.coverage.complete,
        provenance: dataset.provenance,
      },
      {
        cacheIdentity: dataset.provenance.cacheIdentity,
        normalizedSymbol: dataset.provenance.normalizedSymbol,
        sourceTimeframe: dataset.provenance.sourceTimeframe,
        targetTimeframe: dataset.targetCanonicalTf,
        aggregationVersion: dataset.provenance.aggregationVersion,
        alignment: evidence.alignment,
        weekAnchorSec: evidence.weekAnchorSec,
        calendar: evidence.calendar,
        coverageSemantics: 'complete-record',
        recordSpan: dataset.provenance.recordSpan,
      },
    );
    return true;
  } catch {
    return false;
  }
}

/** Reconstruct target-grid coverage directly from barsMs without copying its rows. */
function magnifierCoverageMatchesBars(
  dataset: ResolvedMagnifierDataset,
  evidence: ValidatedMagnifierAlignmentEvidence,
): boolean {
  const requested = dataset.coverage.requested;
  if (!validMillisecondInterval(requested) || !Array.isArray(dataset.coverage.covered)) {
    return false;
  }
  const parsed = parseCanonicalTimeframeExact(dataset.targetCanonicalTf);
  const duration = canonicalTimeframeSecondsExact(dataset.targetCanonicalTf);
  if (parsed.kind !== 'ok' || parsed.value.domain !== 'fixed' || duration.kind !== 'ok') {
    return false;
  }
  const durationMs = duration.value * 1000;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return false;

  const reconstructed: MagnifierIntervalMs[] = [];
  const calendarPeriods =
    evidence.kind === 'exchange-calendar' && isCalendarSessionTimeframe(parsed.value.canonical)
      ? calendarSessionPeriods(evidence.calendar, parsed.value.canonical)
      : undefined;
  const periodsByOpen = calendarPeriods
    ? new Map(calendarPeriods.map((period) => [period.from as number, period] as const))
    : undefined;

  let previousOpen: number | undefined;
  let sessionIndex = 0;
  for (const bar of dataset.barsMs) {
    if (!validMagnifierBar(bar) || (previousOpen !== undefined && bar.time <= previousOpen)) {
      return false;
    }
    previousOpen = bar.time;
    const fixedClose = bar.time + durationMs;
    if (!Number.isSafeInteger(fixedClose)) return false;

    if (evidence.kind === 'utc-24x7') {
      let anchorMs: number;
      try {
        anchorMs = utcTimeframeAnchor(dataset.targetCanonicalTf, evidence.weekAnchorSec) * 1000;
      } catch {
        return false;
      }
      if (!Number.isSafeInteger(anchorMs) || floorMod(bar.time - anchorMs, durationMs) !== 0) {
        return false;
      }
      const clipped = intersectMs({ from: bar.time, to: fixedClose }, requested);
      if (clipped) reconstructed.push(clipped);
      continue;
    }

    if (periodsByOpen) {
      const period = periodsByOpen.get(bar.time / 1000);
      if (!period || bar.time % 1000 !== 0) return false;
      const intersectsRequested =
        period.from * 1000 < requested.to && requested.from < period.to * 1000;
      if (
        intersectsRequested &&
        (evidence.calendar.coverage.from > period.from ||
          evidence.calendar.coverage.to < period.nominalTo)
      ) {
        return false;
      }
      for (const session of period.sessions) {
        const clipped = intersectMs(
          { from: session.from * 1000, to: session.to * 1000 },
          requested,
        );
        if (clipped) reconstructed.push(clipped);
      }
      continue;
    }

    while (
      sessionIndex < evidence.calendar.sessions.length &&
      evidence.calendar.sessions[sessionIndex]!.to * 1000 <= bar.time
    ) {
      sessionIndex++;
    }
    const session = evidence.calendar.sessions[sessionIndex];
    if (
      !session ||
      bar.time < session.from * 1000 ||
      fixedClose > session.to * 1000 ||
      floorMod(bar.time - session.from * 1000, durationMs) !== 0
    ) {
      return false;
    }
    const clipped = intersectMs({ from: bar.time, to: fixedClose }, requested);
    if (clipped) reconstructed.push(clipped);
  }

  if (evidence.kind === 'exchange-calendar') {
    const calendarFrom = evidence.calendar.coverage.from * 1000;
    const calendarTo = evidence.calendar.coverage.to * 1000;
    if (
      !Number.isSafeInteger(calendarFrom) ||
      !Number.isSafeInteger(calendarTo) ||
      calendarFrom > requested.from ||
      calendarTo < requested.to
    ) {
      return false;
    }
    const active = mergeMsIntervals(
      evidence.calendar.sessions
        .map((session) =>
          intersectMs({ from: session.from * 1000, to: session.to * 1000 }, requested),
        )
        .filter((interval): interval is MagnifierIntervalMs => interval !== null),
    );
    reconstructed.push(...complementMsIntervals(requested, active));
  }

  const proven = mergeMsIntervals(reconstructed);
  return sameMsIntervals(proven, dataset.coverage.covered);
}

function validMagnifierBar(bar: Readonly<Bar>): boolean {
  if (!bar || !Number.isSafeInteger(bar.time)) return false;
  const values = [bar.open, bar.high, bar.low, bar.close, bar.volume];
  return (
    values.every(Number.isFinite) &&
    bar.high >= Math.max(bar.open, bar.low, bar.close) &&
    bar.low <= Math.min(bar.open, bar.high, bar.close)
  );
}

function validSecondInterval(
  value: unknown,
): value is import('@heyphat/pinery').HalfOpenIntervalSec {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.from) &&
    Number.isSafeInteger(value.to) &&
    (value.from as number) < (value.to as number)
  );
}

function validMillisecondInterval(value: unknown): value is MagnifierIntervalMs {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.from) &&
    Number.isSafeInteger(value.to) &&
    (value.from as number) < (value.to as number)
  );
}

function intersectMs(
  left: MagnifierIntervalMs,
  right: MagnifierIntervalMs,
): MagnifierIntervalMs | null {
  const from = Math.max(left.from, right.from);
  const to = Math.min(left.to, right.to);
  return from < to ? { from, to } : null;
}

function mergeMsIntervals(intervals: readonly MagnifierIntervalMs[]): MagnifierIntervalMs[] {
  const sorted = [...intervals].sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: MagnifierIntervalMs[] = [];
  for (const interval of sorted) {
    if (!validMillisecondInterval(interval)) return [];
    const previous = merged.at(-1);
    if (!previous || interval.from > previous.to) merged.push({ ...interval });
    else if (interval.to > previous.to)
      merged[merged.length - 1] = { from: previous.from, to: interval.to };
  }
  return merged;
}

function complementMsIntervals(
  requested: MagnifierIntervalMs,
  covered: readonly MagnifierIntervalMs[],
): MagnifierIntervalMs[] {
  const gaps: MagnifierIntervalMs[] = [];
  let cursor = requested.from;
  for (const interval of covered) {
    if (interval.from > cursor) gaps.push({ from: cursor, to: interval.from });
    cursor = Math.max(cursor, interval.to);
  }
  if (cursor < requested.to) gaps.push({ from: cursor, to: requested.to });
  return gaps;
}

function sameMsIntervals(
  left: readonly MagnifierIntervalMs[],
  right: readonly MagnifierIntervalMs[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (interval, index) =>
        validMillisecondInterval(right[index]) &&
        interval.from === right[index]!.from &&
        interval.to === right[index]!.to,
    )
  );
}

function floorMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (seen.has(value) || !Object.isFrozen(value)) return false;
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

function chartTimeMilliseconds(time: number): number {
  const value = time >= 1e12 ? time : time * 1000;
  return Number.isSafeInteger(value) ? value : NaN;
}

function millisecondIntervalsCover(
  intervals: readonly { readonly from: number; readonly to: number }[],
  requested: { readonly from: number; readonly to: number },
): boolean {
  if (
    !Number.isSafeInteger(requested.from) ||
    !Number.isSafeInteger(requested.to) ||
    requested.from >= requested.to
  ) {
    return false;
  }
  let cursor = requested.from;
  for (const interval of intervals) {
    if (
      !Number.isSafeInteger(interval.from) ||
      !Number.isSafeInteger(interval.to) ||
      interval.from >= interval.to
    ) {
      return false;
    }
    if (interval.to <= cursor) continue;
    if (interval.from > cursor) return false;
    cursor = Math.max(cursor, interval.to);
    if (cursor >= requested.to) return true;
  }
  return false;
}

export interface PinerBarMagnifierDataLike {
  readonly targetTimeframe: string;
  readonly bars: ResolvedMagnifierDataset['barsMs'];
  readonly chartIntervals: {
    readonly closeTimes: ResolvedMagnifierDataset['chartCloseTimesMs'];
    readonly source: ResolvedMagnifierDataset['chartIntervalSource'];
  };
  readonly coverage: ResolvedMagnifierDataset['coverage'];
}

/** Build the tiny piner channel wrapper without copying either large array. */
export function toPinerBarMagnifierData(
  dataset: ResolvedMagnifierDataset,
): PinerBarMagnifierDataLike {
  return {
    targetTimeframe: dataset.targetPineTf,
    bars: dataset.barsMs,
    chartIntervals: {
      closeTimes: dataset.chartCloseTimesMs,
      source: dataset.chartIntervalSource,
    },
    coverage: dataset.coverage,
  };
}

export function projectAuthoritativeBarMagnifierReport(
  reportValue: unknown,
  requested: boolean,
): BarMagnifierSummary | undefined {
  const report = isRecord(reportValue) ? reportValue : {};
  const value = report.barMagnifier;
  if (value === undefined) {
    if (!requested) return undefined;
    throw new BarMagnifierError({
      kind: 'unsupported',
      code: 'piner-bar-magnifier-report-unavailable',
      message:
        'Bar Magnifier was requested, but the loaded piner run did not return its authoritative report block',
    });
  }
  if (!isRecord(value)) throw malformedReport();
  const coverage = value.coverage;
  if (
    value.requested !== true ||
    typeof value.active !== 'boolean' ||
    typeof value.targetTimeframe !== 'string' ||
    !integer(value.magnifiedBars) ||
    !integer(value.fallbackBars) ||
    !integer(value.capFallbackBars) ||
    !integer(value.dataFallbackBars) ||
    !integer(value.intrabarsUsed) ||
    (value.firstMagnifiedBar !== undefined && !integer(value.firstMagnifiedBar)) ||
    (coverage !== 'complete' &&
      coverage !== 'tv-cap-fallback' &&
      coverage !== 'mixed-data-fallback' &&
      coverage !== 'no-data')
  ) {
    throw malformedReport();
  }
  return {
    requested: true,
    active: value.active,
    targetTimeframe: value.targetTimeframe,
    magnifiedBars: value.magnifiedBars,
    fallbackBars: value.fallbackBars,
    capFallbackBars: value.capFallbackBars,
    dataFallbackBars: value.dataFallbackBars,
    intrabarsUsed: value.intrabarsUsed,
    ...(value.firstMagnifiedBar !== undefined
      ? { firstMagnifiedBar: value.firstMagnifiedBar }
      : {}),
    coverage,
  };
}

function malformedReport(): BarMagnifierError {
  return new BarMagnifierError({
    kind: 'malformed',
    code: 'malformed-piner-bar-magnifier-report',
    message: 'The loaded piner returned a malformed Bar Magnifier report block',
  });
}

function permanentFailure(base: RunResult, error: BarMagnifierError, started: number): RunResult {
  return {
    ...base,
    error: error.message,
    failure: error.toJSON(),
    elapsedMs: Date.now() - started,
  };
}

function fmtDiag(diagnostic: { severity: string; message: string }): string {
  return `${diagnostic.severity}: ${diagnostic.message}`;
}

function fillDense(data: number[], length: number): number[] {
  const out = new Array<number>(length);
  for (let index = 0; index < length; index++) {
    const value = data[index];
    out[index] = value === undefined ? NaN : value;
  }
  return out;
}

/** pinery seconds -> piner milliseconds at the existing chart/security boundary. */
function toPinerBars(bars: readonly Bar[]): Bar[] {
  return bars.map((bar) => (bar.time >= 1e12 ? bar : { ...bar, time: bar.time * 1000 }));
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
