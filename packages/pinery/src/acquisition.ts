import {
  ExactHistoryError,
  halfOpenIntervalSec,
  type HalfOpenIntervalSec,
  type HistoryAcquisition,
  type HistoryCapabilities,
  type HistoryProvider,
  type HistoryRequest,
  type ResolvedHistorySource,
  type UnixSecond,
} from './provider.js';
import {
  HISTORY_AGGREGATION_VERSION,
  aggregateBars,
  type AggregateAlignment,
  type AggregateSpec,
} from './aggregate.js';
import {
  assertCalendarPeriodCoverage,
  calendarPeriodIntersects,
  calendarSessionPeriods,
  ceilTo,
  fixedDuration,
  floorTo,
  intersect,
  isCalendarSessionTimeframe,
  isUtcWeekTimeframe,
  snapshotHistoryCapabilities,
  snapshotHistorySessionCalendar,
  snapshotResolvedHistorySource,
  utcTimeframeAnchor,
  utcTimeframesNest,
  validateHistoryAcquisition,
} from './coverage.js';
import {
  canonicalTimeframeSecondsExact,
  parseCanonicalTimeframeExact,
  selectLargestExactDivisor,
} from './timeframe.js';

export type HistoryAcquisitionPlan =
  | {
      readonly kind: 'native';
      readonly sourceTimeframe: string;
      readonly targetTimeframe: string;
      readonly alignment: AggregateAlignment;
    }
  | {
      readonly kind: 'aggregate';
      readonly sourceTimeframe: string;
      readonly targetTimeframe: string;
      readonly alignment: AggregateAlignment;
    };

export type HistoryAcquisitionPlanResult =
  | HistoryAcquisitionPlan
  | {
      readonly kind: 'unsupported';
      readonly code: string;
      readonly message: string;
      readonly details?: unknown;
    }
  | {
      readonly kind: 'malformed';
      readonly code: string;
      readonly message: string;
      readonly details?: unknown;
    };

export interface ExactHistoryRequest {
  readonly targetTimeframe: string;
  readonly requested: HalfOpenIntervalSec;
  /** Optional semantic anchor for a UTC week-unit target (for example Pine Monday weeks). */
  readonly targetWeekAnchorSec?: UnixSecond;
}

/** Resolve a symbol-specific source; generic legacy providers fail closed. */
export async function resolveHistorySource(
  provider: HistoryProvider,
  symbol: string,
): Promise<ResolvedHistorySource> {
  if (provider.resolveHistorySource) {
    const source = await provider.resolveHistorySource(symbol);
    validateResolvedSource(source);
    return snapshotResolvedHistorySource(source);
  }

  const normalizedSymbol = symbol.trim();
  return snapshotResolvedHistorySource({
    provider,
    normalizedSymbol,
    cacheIdentity: `legacy:${provider.id}`,
    capabilities: snapshotHistoryCapabilities({ timeframes: [], alignment: 'unknown' }),
    async history(_request: HistoryRequest): Promise<HistoryAcquisition> {
      throw new ExactHistoryError({
        kind: 'unsupported',
        code: 'legacy-provider-exact-history',
        message: `pinery: provider "${provider.id}" does not expose exact-history capabilities`,
        details: { providerId: provider.id, normalizedSymbol },
      });
    },
  });
}

/** Native-first target planning, then the largest exact supported divisor. */
export function planHistoryAcquisition(
  capabilities: HistoryCapabilities,
  targetTimeframe: string,
  targetWeekAnchorSec?: UnixSecond,
): HistoryAcquisitionPlanResult {
  const target = parseCanonicalTimeframeExact(targetTimeframe);
  if (target.kind !== 'ok') return conversionFailure(target);
  if (target.value.domain !== 'fixed') {
    return {
      kind: 'unsupported',
      code: 'calendar-target-timeframe',
      message: `pinery: exact target "${targetTimeframe}" does not have a fixed duration`,
    };
  }
  if (targetWeekAnchorSec !== undefined && !Number.isSafeInteger(targetWeekAnchorSec)) {
    return {
      kind: 'malformed',
      code: 'target-week-anchor',
      message: 'pinery: exact target week anchor must be a safe UNIX second',
      details: { targetWeekAnchorSec },
    };
  }

  const alignment = planningAlignment(capabilities, target.value.canonical, targetWeekAnchorSec);
  if (alignment.kind === 'unsupported') return alignment;
  if (
    alignment.value.kind === 'utc' &&
    isUtcWeekTimeframe(target.value.canonical) &&
    alignment.value.weekAnchorSec === undefined
  ) {
    return {
      kind: 'unsupported',
      code: 'weekly-anchor-missing',
      message:
        `pinery: exact UTC week target "${target.value.canonical}" requires explicit ` +
        'weekAnchorSec capability evidence',
      details: { targetTimeframe: target.value.canonical },
    };
  }

  if (capabilities.timeframes === 'arbitrary') {
    if (
      alignment.value.kind === 'utc' &&
      isUtcWeekTimeframe(target.value.canonical) &&
      (alignment.value.sourceWeekAnchorSec === undefined ||
        !utcTimeframesNest(
          target.value.canonical,
          target.value.canonical,
          alignment.value.sourceWeekAnchorSec,
          alignment.value.weekAnchorSec,
        ))
    ) {
      return {
        kind: 'aggregate',
        sourceTimeframe: '1d',
        targetTimeframe: target.value.canonical,
        alignment: alignment.value,
      };
    }
    return {
      kind: 'native',
      sourceTimeframe: target.value.canonical,
      targetTimeframe: target.value.canonical,
      alignment: alignment.value,
    };
  }

  const normalized: string[] = [];
  for (const timeframe of capabilities.timeframes) {
    const parsed = parseCanonicalTimeframeExact(timeframe);
    if (parsed.kind !== 'ok') return conversionFailure(parsed);
    normalized.push(parsed.value.canonical);
  }

  if (alignment.value.kind === 'session' && isCalendarSessionTimeframe(target.value.canonical)) {
    return planCalendarHistoryAcquisition(target.value.canonical, normalized, alignment.value);
  }

  const utcAlignment = alignment.value.kind === 'utc' ? alignment.value : undefined;
  const aligned = utcAlignment
    ? normalized.filter((timeframe) => {
        if (isUtcWeekTimeframe(timeframe) && utcAlignment.sourceWeekAnchorSec === undefined) {
          return false;
        }
        return utcTimeframesNest(
          timeframe,
          target.value.canonical,
          utcAlignment.sourceWeekAnchorSec,
          utcAlignment.weekAnchorSec,
        );
      })
    : normalized;
  const targetSeconds = target.value.seconds;
  const nativeSource = aligned.find((timeframe) => {
    const duration = canonicalTimeframeSecondsExact(timeframe);
    return duration.kind === 'ok' && duration.value === targetSeconds;
  });
  if (nativeSource) {
    return {
      kind: 'native',
      sourceTimeframe: nativeSource,
      targetTimeframe: target.value.canonical,
      alignment: alignment.value,
    };
  }

  const divisor = selectLargestExactDivisor(target.value.canonical, aligned);
  if (divisor.kind !== 'ok') return conversionFailure(divisor);
  return {
    kind: 'aggregate',
    sourceTimeframe: divisor.value.timeframe,
    targetTimeframe: target.value.canonical,
    alignment: alignment.value,
  };
}

/**
 * Acquire a complete target dataset or throw a serializable permanent exact-history error.
 * Raw source acquisitions may be incomplete; this high-level seam never returns them as success.
 */
export async function acquireExactHistory(
  source: ResolvedHistorySource,
  request: ExactHistoryRequest,
): Promise<HistoryAcquisition> {
  validateResolvedSource(source);
  source = snapshotResolvedHistorySource(source);
  validateRequested(request.requested);
  if (
    request.targetWeekAnchorSec !== undefined &&
    !Number.isSafeInteger(request.targetWeekAnchorSec)
  ) {
    throw new ExactHistoryError({
      kind: 'malformed',
      code: 'target-week-anchor',
      message: 'pinery: exact target week anchor must be a safe UNIX second',
      details: { targetWeekAnchorSec: request.targetWeekAnchorSec },
    });
  }
  const plan = planHistoryAcquisition(
    source.capabilities,
    request.targetTimeframe,
    request.targetWeekAnchorSec,
  );
  if (plan.kind === 'unsupported' || plan.kind === 'malformed') {
    throw new ExactHistoryError({
      kind: plan.kind,
      code: plan.code,
      message: plan.message,
      details: plan.details,
    });
  }

  const query = paddedQuery(request.requested, plan.targetTimeframe, plan.alignment);
  const raw = await source.history({
    timeframe: plan.sourceTimeframe,
    requested: request.requested,
    query,
  });
  validateHistoryAcquisition(raw, {
    requested: request.requested,
    cacheIdentity: source.cacheIdentity,
    normalizedSymbol: source.normalizedSymbol,
    sourceTimeframe: plan.sourceTimeframe,
    targetTimeframe: plan.sourceTimeframe,
    aggregationVersion: 0,
    alignment: source.capabilities.alignment,
    weekAnchorSec: source.capabilities.weekAnchorSec,
    calendar: source.capabilities.calendar,
  });

  const acquisition =
    plan.kind === 'native'
      ? {
          ...raw,
          provenance: {
            ...raw.provenance,
            targetTimeframe: plan.targetTimeframe,
            ...(plan.alignment.kind === 'utc' && plan.alignment.weekAnchorSec !== undefined
              ? { weekAnchorSec: plan.alignment.weekAnchorSec }
              : {}),
          },
        }
      : aggregateBars(raw, {
          sourceTimeframe: plan.sourceTimeframe,
          targetTimeframe: plan.targetTimeframe,
          alignment: plan.alignment,
        } satisfies AggregateSpec);
  validateHistoryAcquisition(acquisition, {
    requested: request.requested,
    cacheIdentity: source.cacheIdentity,
    normalizedSymbol: source.normalizedSymbol,
    sourceTimeframe: plan.sourceTimeframe,
    targetTimeframe: plan.targetTimeframe,
    aggregationVersion: plan.kind === 'aggregate' ? HISTORY_AGGREGATION_VERSION : 0,
    alignment: source.capabilities.alignment,
    weekAnchorSec:
      plan.alignment.kind === 'utc'
        ? plan.alignment.weekAnchorSec
        : source.capabilities.weekAnchorSec,
    calendar: source.capabilities.calendar,
  });

  if (!acquisition.complete) {
    throw new ExactHistoryError({
      kind: 'provider-limited',
      code: 'incomplete-required-coverage',
      message: `pinery: ${source.normalizedSymbol} ${plan.targetTimeframe} coverage is incomplete`,
      details: { provenance: acquisition.provenance },
      requested: acquisition.requested,
      covered: acquisition.covered,
      gaps: acquisition.gaps,
      truncated: acquisition.truncated,
    });
  }
  return acquisition;
}

function planCalendarHistoryAcquisition(
  targetTimeframe: string,
  supportedTimeframes: readonly string[],
  alignment: Extract<AggregateAlignment, { kind: 'session' }>,
): HistoryAcquisitionPlanResult {
  const nativeSource = supportedTimeframes.find((timeframe) => timeframe === targetTimeframe);
  if (nativeSource) {
    return {
      kind: 'native',
      sourceTimeframe: nativeSource,
      targetTimeframe,
      alignment,
    };
  }

  let selected:
    { readonly timeframe: string; readonly duration: number; readonly daily: boolean } | undefined;
  for (const timeframe of supportedTimeframes) {
    const parsed = parseCanonicalTimeframeExact(timeframe);
    if (parsed.kind !== 'ok' || parsed.value.domain !== 'fixed') continue;
    const value = parsed.value;
    const daily = value.canonical === '1d';
    const intraday = value.unit === 's' || value.unit === 'm' || value.unit === 'h';
    if (!daily && !intraday) continue;
    if (
      intraday &&
      !alignment.sessions.every((session) => (session.to - session.from) % value.seconds === 0)
    ) {
      continue;
    }
    if (
      !selected ||
      value.seconds > selected.duration ||
      (value.seconds === selected.duration && daily && !selected.daily)
    ) {
      selected = { timeframe: value.canonical, duration: value.seconds, daily };
    }
  }

  if (!selected) {
    return {
      kind: 'unsupported',
      code: 'no-exact-calendar-tiler',
      message:
        `pinery: no supported timeframe exactly tiles every declared session for ` +
        `"${targetTimeframe}"`,
      details: { targetTimeframe, supportedTimeframes },
    };
  }
  return {
    kind: 'aggregate',
    sourceTimeframe: selected.timeframe,
    targetTimeframe,
    alignment,
  };
}

function paddedQuery(
  requested: HalfOpenIntervalSec,
  targetTimeframe: string,
  alignment: AggregateAlignment,
): HalfOpenIntervalSec {
  const duration = fixedDuration(targetTimeframe);
  if (alignment.kind === 'utc') {
    const anchor = utcTimeframeAnchor(targetTimeframe, alignment.weekAnchorSec);
    return halfOpenIntervalSec(
      floorTo(requested.from, duration, anchor),
      ceilTo(requested.to, duration, anchor),
    );
  }

  if (isCalendarSessionTimeframe(targetTimeframe)) {
    const periods = calendarSessionPeriods(alignment, targetTimeframe).filter((period) =>
      calendarPeriodIntersects(period, requested),
    );
    if (periods.length === 0) return requested;
    let from = requested.from as number;
    let to = requested.to as number;
    for (const period of periods) {
      assertCalendarPeriodCoverage(alignment, period);
      from = Math.min(from, period.from);
      to = Math.max(to, period.to);
    }
    return halfOpenIntervalSec(from, to);
  }

  const relevant = alignment.sessions.filter((session) => intersect(session, requested));
  if (relevant.length === 0) {
    // A request wholly in a declared closure needs no bars, but the provider query
    // still needs a valid interval for a uniform cache/acquisition contract.
    return requested;
  }
  let from = requested.from as number;
  let to = requested.to as number;
  for (const session of relevant) {
    const overlap = intersect(session, requested)!;
    from = Math.min(from, floorTo(overlap.from, duration, session.from));
    to = Math.max(to, ceilTo(overlap.to, duration, session.from));
  }
  return halfOpenIntervalSec(from, to);
}

function planningAlignment(
  capabilities: HistoryCapabilities,
  targetTimeframe: string,
  targetWeekAnchorSec?: UnixSecond,
):
  | { readonly kind: 'ok'; readonly value: AggregateAlignment }
  | { readonly kind: 'unsupported'; readonly code: string; readonly message: string } {
  if (capabilities.alignment === 'utc-24x7') {
    const weekAnchorSec = isUtcWeekTimeframe(targetTimeframe)
      ? (targetWeekAnchorSec ?? capabilities.weekAnchorSec)
      : capabilities.weekAnchorSec;
    return {
      kind: 'ok',
      value: {
        kind: 'utc',
        sourceWeekAnchorSec: capabilities.weekAnchorSec,
        ...(weekAnchorSec !== undefined ? { weekAnchorSec } : {}),
      },
    };
  }
  if (capabilities.alignment === 'exchange-calendar') {
    const calendar = capabilities.calendar;
    if (!calendar) {
      return {
        kind: 'unsupported',
        code: 'calendar-metadata-missing',
        message: 'pinery: exchange-calendar exact acquisition requires explicit calendar metadata',
      };
    }
    let snapshot;
    try {
      snapshot = snapshotHistorySessionCalendar(calendar);
    } catch {
      return {
        kind: 'unsupported',
        code: 'calendar-metadata-invalid',
        message:
          'pinery: exchange-calendar exact acquisition requires valid nonblank versioned calendar metadata',
      };
    }
    return {
      kind: 'ok',
      value: {
        kind: 'session',
        calendarId: snapshot.calendarId,
        version: snapshot.version,
        coverage: snapshot.coverage,
        sessions: snapshot.sessions,
        ...(snapshot.periods ? { periods: snapshot.periods } : {}),
      },
    };
  }
  return {
    kind: 'unsupported',
    code: 'unknown-alignment',
    message: 'pinery: exact acquisition requires proven UTC or exchange-calendar alignment',
  };
}

function conversionFailure(result: {
  readonly kind: 'unsupported' | 'malformed';
  readonly code: string;
  readonly message: string;
  readonly input: string;
}): Extract<HistoryAcquisitionPlanResult, { kind: 'unsupported' | 'malformed' }> {
  return {
    kind: result.kind,
    code: result.code,
    message: result.message,
    details: { input: result.input },
  };
}

function validateResolvedSource(source: ResolvedHistorySource): void {
  if (
    !source ||
    !source.provider ||
    !source.normalizedSymbol ||
    !source.cacheIdentity ||
    !source.capabilities ||
    typeof source.history !== 'function'
  ) {
    throw new ExactHistoryError({
      kind: 'malformed',
      code: 'resolved-history-source',
      message: 'pinery: resolved history source is incomplete',
    });
  }
  if (source.capabilities.timeframes !== 'arbitrary') {
    for (const timeframe of source.capabilities.timeframes) {
      const duration = canonicalTimeframeSecondsExact(timeframe);
      if (duration.kind !== 'ok') {
        throw new ExactHistoryError({
          kind: duration.kind,
          code: duration.code,
          message: duration.message,
          details: { timeframe },
        });
      }
    }
  }
}

function validateRequested(requested: HalfOpenIntervalSec): void {
  if (
    !Number.isSafeInteger(requested.from) ||
    !Number.isSafeInteger(requested.to) ||
    requested.from >= requested.to
  ) {
    throw new ExactHistoryError({
      kind: 'malformed',
      code: 'requested-interval',
      message: 'pinery: exact requested interval must use whole safe UNIX seconds with from < to',
      details: requested,
    });
  }
}
