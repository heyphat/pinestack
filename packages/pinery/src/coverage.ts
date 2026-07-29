import type { Bar } from '@heyphat/piner';
import {
  ExactHistoryError,
  halfOpenIntervalSec,
  type AcquisitionProvenance,
  type CoverageGapReason,
  type CoverageGapSec,
  type HalfOpenIntervalSec,
  type HistoryAcquisition,
  type HistoryAlignment,
  type HistoryCapabilities,
  type HistoryCoverageSemantics,
  type HistoryRequest,
  type HistorySessionCalendar,
  type HistoryTruncation,
  type ResolvedHistorySource,
  type UnixSecond,
} from './provider.js';
import { canonicalTimeframeSecondsExact, parseCanonicalTimeframeExact } from './timeframe.js';

export interface RecordSpanFromBarsOptions {
  readonly bars: readonly Bar[];
  readonly timeframe: string;
  readonly alignment: HistoryAlignment;
  readonly weekAnchorSec?: UnixSecond;
  readonly calendar?: HistorySessionCalendar;
}

export interface HistoryAcquisitionFromBarsOptions {
  readonly bars: readonly Bar[];
  readonly request: HistoryRequest;
  readonly cacheIdentity: string;
  readonly normalizedSymbol: string;
  readonly alignment: HistoryAlignment;
  /** Explicit opening anchor for UTC week-unit bars. */
  readonly weekAnchorSec?: UnixSecond;
  readonly calendar?: HistorySessionCalendar;
  /** Omitted callers retain byte-for-byte bars-only coverage behavior. */
  readonly coverageSemantics?: HistoryCoverageSemantics;
  /** Required source-record evidence for complete-record semantics. */
  readonly recordSpan?: HalfOpenIntervalSec;
  readonly truncated?: HistoryTruncation;
}

/** One exchange-calendar day/week bucket with its authoritative active intervals. */
export interface CalendarSessionPeriod {
  /** Opening session and native/aggregate bar open. */
  readonly from: UnixSecond;
  /** Effective close: the final selected session close. */
  readonly to: UnixSecond;
  /** Full nominal boundary through which the calendar declaration must be complete. */
  readonly nominalTo: UnixSecond;
  readonly sessions: readonly HalfOpenIntervalSec[];
}

/** Exchange calendars give day/week tokens session-period rather than elapsed-time semantics. */
export function isCalendarSessionTimeframe(timeframe: string): boolean {
  return calendarPeriodSpec(timeframe) !== null;
}

/**
 * Derive periods from authoritative immutable calendar buckets when declared.
 * Otherwise retain the legacy inference: `1d` is one declared session and
 * larger day/week periods consume first-unassigned sessions before the nominal
 * open-based boundary.
 */
export function calendarSessionPeriods(
  calendar: HistorySessionCalendar,
  timeframe: string,
): readonly CalendarSessionPeriod[] {
  const spec = calendarPeriodSpec(timeframe);
  if (!spec) return [];

  const declared = calendar.periods?.[spec.canonical];
  if (declared) {
    const periods: CalendarSessionPeriod[] = [];
    let sessionIndex = 0;
    for (const boundary of declared) {
      const sessions: HalfOpenIntervalSec[] = [];
      while (
        sessionIndex < calendar.sessions.length &&
        calendar.sessions[sessionIndex]!.from < boundary.to
      ) {
        const session = calendar.sessions[sessionIndex]!;
        if (session.from < boundary.from || session.to > boundary.to) {
          malformed(
            'calendar-period-metadata-invalid',
            `calendar ${spec.canonical} period does not partition declared sessions`,
            { timeframe: spec.canonical, boundary, session },
          );
        }
        sessions.push(session);
        sessionIndex++;
      }
      const finalSession = sessions.at(-1);
      if (!finalSession) {
        malformed(
          'calendar-period-metadata-invalid',
          `calendar ${spec.canonical} period contains no declared session`,
          { timeframe: spec.canonical, boundary },
        );
      }
      periods.push({
        from: boundary.from,
        to: finalSession.to,
        nominalTo: boundary.to,
        sessions,
      });
    }
    if (sessionIndex !== calendar.sessions.length) {
      malformed(
        'calendar-period-metadata-invalid',
        `calendar ${spec.canonical} periods do not assign every declared session`,
        { timeframe: spec.canonical, session: calendar.sessions[sessionIndex] },
      );
    }
    return periods;
  }

  const periods: CalendarSessionPeriod[] = [];
  if (spec.singleSession) {
    for (const session of calendar.sessions) {
      periods.push({
        from: session.from,
        to: session.to,
        nominalTo: safeSecondAdd(session.from, spec.duration, 'calendar period boundary'),
        sessions: [session],
      });
    }
    return periods;
  }

  let index = 0;
  while (index < calendar.sessions.length) {
    const first = calendar.sessions[index]!;
    const nominalTo = safeSecondAdd(first.from, spec.duration, 'calendar period boundary');
    const selected: HalfOpenIntervalSec[] = [];
    while (index < calendar.sessions.length && calendar.sessions[index]!.from < nominalTo) {
      selected.push(calendar.sessions[index]!);
      index++;
    }
    periods.push({
      from: first.from,
      to: selected.at(-1)!.to,
      nominalTo,
      sessions: selected,
    });
  }
  return periods;
}

/** A period is authoritative only if the calendar declares the whole nominal window. */
export function assertCalendarPeriodCoverage(
  calendar: HistorySessionCalendar,
  period: CalendarSessionPeriod,
): void {
  if (calendar.coverage.from > period.from || calendar.coverage.to < period.nominalTo) {
    throw new ExactHistoryError({
      kind: 'unsupported',
      code: 'calendar-period-coverage-missing',
      message:
        `pinery: calendar ${calendar.calendarId}@${calendar.version} does not cover ` +
        'the complete nominal day/week period',
      details: {
        period: { from: period.from, to: period.to, nominalTo: period.nominalTo },
        calendarCoverage: calendar.coverage,
      },
    });
  }
}

export function calendarPeriodIntersects(
  period: CalendarSessionPeriod,
  interval: HalfOpenIntervalSec,
): boolean {
  return period.from < interval.to && interval.from < period.to;
}

/** Browser-safe stable identity over non-secret, data-affecting provider options. */
export function createHistoryCacheIdentity(
  providerId: string,
  options: Readonly<Record<string, unknown>>,
): string {
  return `${providerId}:${stableStringify(options)}`;
}

/** Strip credentials and secret-looking query parameters before including a base URL in identity. */
export function nonSecretBaseUrl(value: string): string {
  try {
    const url = new URL(value);
    // Every built-in adapter constructs absolute API paths, so a configured
    // pathname is not request-effective and may itself contain a proxy token.
    // Persist only the endpoint origin; credentials, query, fragment, and path
    // never enter cache identity or acquisition provenance.
    return `${url.protocol}//${url.host}`;
  } catch {
    // Never echo an unparsable value into provenance/cache payloads: it may be a
    // credential-bearing user input and the eventual HTTP construction will fail.
    return 'invalid-url';
  }
}

/**
 * Validate, normalize, clone, and deeply freeze exchange-session evidence.
 * Callers retain no mutable reference that can change identity or coverage proof.
 */
export function snapshotHistorySessionCalendar(
  calendar: HistorySessionCalendar,
): HistorySessionCalendar {
  if (!calendar || typeof calendar !== 'object') {
    malformed('calendar-metadata-invalid', 'calendar metadata must be an object');
  }
  if (typeof calendar.calendarId !== 'string' || calendar.calendarId.trim().length === 0) {
    malformed('calendar-metadata-invalid', 'calendar metadata requires a nonblank calendarId');
  }
  if (typeof calendar.version !== 'string' || calendar.version.trim().length === 0) {
    malformed('calendar-metadata-invalid', 'calendar metadata requires a nonblank version');
  }
  validateInterval(calendar.coverage, 'calendar coverage');
  if (!Array.isArray(calendar.sessions)) {
    malformed('calendar-metadata-invalid', 'calendar sessions must be an array');
  }
  validateNormalizedIntervals(calendar.sessions, calendar.coverage, 'calendar sessions');

  const cloneInterval = (interval: HalfOpenIntervalSec): HalfOpenIntervalSec =>
    Object.freeze({ from: interval.from, to: interval.to });
  const coverage = cloneInterval(calendar.coverage);
  const sessions = Object.freeze(calendar.sessions.map(cloneInterval));
  const periods =
    calendar.periods === undefined
      ? undefined
      : snapshotCalendarPeriods(calendar.periods, calendar.sessions, calendar.coverage);
  return Object.freeze({
    calendarId: calendar.calendarId.trim(),
    version: calendar.version.trim(),
    coverage,
    sessions,
    ...(periods ? { periods } : {}),
  });
}

function snapshotCalendarPeriods(
  periods: NonNullable<HistorySessionCalendar['periods']>,
  sessions: readonly HalfOpenIntervalSec[],
  coverage: HalfOpenIntervalSec,
): NonNullable<HistorySessionCalendar['periods']> {
  if (!periods || typeof periods !== 'object' || Array.isArray(periods)) {
    malformed('calendar-period-metadata-invalid', 'calendar periods must be an object');
  }

  const snapshot: Record<string, readonly HalfOpenIntervalSec[]> = {};
  for (const timeframe of Object.keys(periods).sort((a, b) => a.localeCompare(b))) {
    const parsed = parseCanonicalTimeframeExact(timeframe);
    if (
      parsed.kind !== 'ok' ||
      parsed.value.domain !== 'fixed' ||
      (parsed.value.unit !== 'd' && parsed.value.unit !== 'w') ||
      parsed.value.canonical !== timeframe
    ) {
      malformed(
        'calendar-period-metadata-invalid',
        `calendar period key "${timeframe}" must be a canonical day/week timeframe`,
        { timeframe },
      );
    }

    const boundaries = periods[timeframe];
    if (!Array.isArray(boundaries)) {
      malformed(
        'calendar-period-metadata-invalid',
        `calendar ${timeframe} periods must be an array`,
        { timeframe },
      );
    }
    validateNormalizedIntervals(boundaries, coverage, `calendar ${timeframe} periods`);
    validateCalendarPeriodPartition(timeframe, boundaries, sessions);
    snapshot[timeframe] = Object.freeze(
      boundaries.map((boundary) =>
        Object.freeze({ from: boundary.from, to: boundary.to } as HalfOpenIntervalSec),
      ),
    );
  }
  return Object.freeze(snapshot);
}

function validateCalendarPeriodPartition(
  timeframe: string,
  boundaries: readonly HalfOpenIntervalSec[],
  sessions: readonly HalfOpenIntervalSec[],
): void {
  let sessionIndex = 0;
  for (const boundary of boundaries) {
    const first = sessions[sessionIndex];
    if (!first || first.from !== boundary.from) {
      malformed(
        'calendar-period-metadata-invalid',
        `calendar ${timeframe} period must start at its first declared session`,
        { timeframe, boundary, session: first },
      );
    }

    const startIndex = sessionIndex;
    while (sessionIndex < sessions.length && sessions[sessionIndex]!.from < boundary.to) {
      const session = sessions[sessionIndex]!;
      if (session.to > boundary.to) {
        malformed(
          'calendar-period-metadata-invalid',
          `calendar ${timeframe} period cuts through a declared session`,
          { timeframe, boundary, session },
        );
      }
      sessionIndex++;
    }
    if (sessionIndex === startIndex) {
      malformed(
        'calendar-period-metadata-invalid',
        `calendar ${timeframe} period contains no declared session`,
        { timeframe, boundary },
      );
    }
  }

  if (sessionIndex !== sessions.length) {
    malformed(
      'calendar-period-metadata-invalid',
      `calendar ${timeframe} periods must assign every declared session exactly once`,
      { timeframe, unassignedSession: sessions[sessionIndex] },
    );
  }
}

/** Clone and freeze a caller/provider-owned timeframe declaration. */
export function snapshotHistoryTimeframes(
  timeframes: HistoryCapabilities['timeframes'],
): HistoryCapabilities['timeframes'] {
  if (timeframes === 'arbitrary') return timeframes;
  if (!Array.isArray(timeframes) || !timeframes.every((value) => typeof value === 'string')) {
    malformed('capability-timeframes', 'history capability timeframes must be a string array');
  }
  return Object.freeze([...timeframes]);
}

/** Clone and deeply freeze every resolved capability value before identity or exposure. */
export function snapshotHistoryCapabilities(
  capabilities: HistoryCapabilities,
): HistoryCapabilities {
  if (!capabilities || typeof capabilities !== 'object') {
    malformed('capabilities-shape', 'history capabilities must be an object');
  }
  if (
    capabilities.alignment !== 'utc-24x7' &&
    capabilities.alignment !== 'exchange-calendar' &&
    capabilities.alignment !== 'unknown'
  ) {
    malformed('capability-alignment', 'history capability alignment is invalid', capabilities);
  }
  for (const [name, value] of [
    ['maxBarsPerRequest', capabilities.maxBarsPerRequest],
    ['maxBarsPerAcquisition', capabilities.maxBarsPerAcquisition],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      malformed('capability-limit', `${name} must be a positive safe integer`, { name, value });
    }
  }
  if (capabilities.weekAnchorSec !== undefined) {
    if (capabilities.alignment !== 'utc-24x7') {
      malformed(
        'capability-week-anchor-alignment',
        'weekAnchorSec is valid only for utc-24x7 history capabilities',
        { alignment: capabilities.alignment, weekAnchorSec: capabilities.weekAnchorSec },
      );
    }
    if (!Number.isSafeInteger(capabilities.weekAnchorSec)) {
      malformed(
        'capability-week-anchor',
        'weekAnchorSec must be a safe integer UNIX second',
        capabilities.weekAnchorSec,
      );
    }
  }

  if (
    capabilities.coverageSemantics !== undefined &&
    capabilities.coverageSemantics !== 'bars-only' &&
    capabilities.coverageSemantics !== 'complete-record'
  ) {
    malformed(
      'capability-coverage-semantics',
      'history capability coverageSemantics is invalid',
      capabilities.coverageSemantics,
    );
  }
  const coverageSemantics = capabilities.coverageSemantics ?? 'bars-only';
  if (capabilities.recordSpan !== undefined) {
    validateInterval(capabilities.recordSpan, 'capability record span');
    if (coverageSemantics !== 'complete-record') {
      malformed(
        'capability-record-span-semantics',
        'recordSpan capability evidence requires complete-record semantics',
      );
    }
  }

  let recordSpans: Readonly<Record<string, HalfOpenIntervalSec>> | undefined;
  if (capabilities.recordSpans !== undefined) {
    if (
      !capabilities.recordSpans ||
      typeof capabilities.recordSpans !== 'object' ||
      Array.isArray(capabilities.recordSpans) ||
      coverageSemantics !== 'complete-record'
    ) {
      malformed(
        'capability-record-spans',
        'recordSpans capability evidence requires a timeframe map and complete-record semantics',
      );
    }
    const snapshot: Record<string, HalfOpenIntervalSec> = {};
    for (const timeframe of Object.keys(capabilities.recordSpans).sort((a, b) =>
      a.localeCompare(b),
    )) {
      const parsed = parseCanonicalTimeframeExact(timeframe);
      if (parsed.kind !== 'ok' || parsed.value.canonical !== timeframe) {
        malformed(
          'capability-record-span-timeframe',
          `recordSpans key "${timeframe}" must be canonical`,
        );
      }
      const span = capabilities.recordSpans[timeframe]!;
      validateInterval(span, `capability ${timeframe} record span`);
      snapshot[timeframe] = Object.freeze({ from: span.from, to: span.to });
    }
    recordSpans = Object.freeze(snapshot);
  }

  const timeframes = snapshotHistoryTimeframes(capabilities.timeframes);
  const calendar = capabilities.calendar
    ? snapshotHistorySessionCalendar(capabilities.calendar)
    : undefined;
  return Object.freeze({
    timeframes,
    ...(capabilities.maxBarsPerRequest !== undefined
      ? { maxBarsPerRequest: capabilities.maxBarsPerRequest }
      : {}),
    ...(capabilities.maxBarsPerAcquisition !== undefined
      ? { maxBarsPerAcquisition: capabilities.maxBarsPerAcquisition }
      : {}),
    alignment: capabilities.alignment,
    ...(capabilities.weekAnchorSec !== undefined
      ? { weekAnchorSec: capabilities.weekAnchorSec }
      : {}),
    ...(calendar ? { calendar } : {}),
    coverageSemantics,
    ...(capabilities.recordSpan
      ? {
          recordSpan: Object.freeze({
            from: capabilities.recordSpan.from,
            to: capabilities.recordSpan.to,
          }),
        }
      : {}),
    ...(recordSpans ? { recordSpans } : {}),
  });
}

/** Select trusted record-span evidence for one requested source timeframe. */
export function historyCapabilityRecordSpan(
  capabilities: HistoryCapabilities,
  timeframe: string,
): HalfOpenIntervalSec | undefined {
  return capabilities.recordSpans?.[timeframe] ?? capabilities.recordSpan;
}

/** Freeze the resolved envelope and replace mutable capability references with a snapshot. */
export function snapshotResolvedHistorySource(
  source: ResolvedHistorySource,
): ResolvedHistorySource {
  const history = source.history.bind(source);
  return Object.freeze({
    provider: source.provider,
    normalizedSymbol: source.normalizedSymbol,
    cacheIdentity: source.cacheIdentity,
    capabilities: snapshotHistoryCapabilities(source.capabilities),
    history,
  });
}

/** Derive an immutable exact source span from a fully parsed, validated record. */
export function historyRecordSpanFromBars(options: RecordSpanFromBarsOptions): HalfOpenIntervalSec {
  const duration = fixedDuration(options.timeframe);
  const calendar = options.calendar ? snapshotHistorySessionCalendar(options.calendar) : undefined;
  validateBarsExact(
    options.bars,
    duration,
    options.alignment,
    calendar,
    options.timeframe,
    options.weekAnchorSec,
  );
  if (options.bars.length === 0) {
    malformed('record-span-empty', 'complete-record evidence requires at least one source bar');
  }
  const periods =
    calendar && isCalendarSessionTimeframe(options.timeframe)
      ? new Map(
          calendarSessionPeriods(calendar, options.timeframe).map(
            (period) => [period.from as number, period] as const,
          ),
        )
      : undefined;
  const first = options.bars[0]!;
  const last = options.bars.at(-1)!;
  const to = periods
    ? periods.get(last.time)!.to
    : safeSecondAdd(last.time, duration, 'record span close');
  return Object.freeze(halfOpenIntervalSec(first.time, to));
}

/** Construct evidence from complete returned bar intervals, never from query success. */
export function historyAcquisitionFromBars(
  options: HistoryAcquisitionFromBarsOptions,
): HistoryAcquisition {
  const { request } = options;
  validateInterval(request.requested, 'requested');
  const query = request.query ?? request.requested;
  validateInterval(query, 'query');
  if (query.from > request.requested.from || query.to < request.requested.to) {
    malformed('query-does-not-enclose-request', 'exact query must enclose the logical request', {
      requested: request.requested,
      query,
    });
  }

  const coverageSemantics = options.coverageSemantics ?? 'bars-only';
  if (coverageSemantics !== 'bars-only' && coverageSemantics !== 'complete-record') {
    malformed('coverage-semantics', 'history coverage semantics is invalid', coverageSemantics);
  }
  if (coverageSemantics === 'complete-record') {
    if (!options.recordSpan) {
      malformed('record-span-missing', 'complete-record coverage requires recordSpan evidence');
    }
    validateInterval(options.recordSpan, 'record span');
  } else if (options.recordSpan !== undefined) {
    malformed('record-span-semantics', 'recordSpan evidence requires complete-record semantics');
  }

  if (options.weekAnchorSec !== undefined) {
    if (options.alignment !== 'utc-24x7') {
      malformed(
        'week-anchor-alignment',
        'weekAnchorSec evidence is valid only for utc-24x7 acquisitions',
        { alignment: options.alignment, weekAnchorSec: options.weekAnchorSec },
      );
    }
    if (!Number.isSafeInteger(options.weekAnchorSec)) {
      malformed(
        'week-anchor',
        'weekAnchorSec evidence must be a safe integer UNIX second',
        options.weekAnchorSec,
      );
    }
  }
  const calendar =
    options.alignment === 'exchange-calendar'
      ? requireCalendar(options.calendar, request.requested)
      : undefined;
  const duration = fixedDuration(request.timeframe);
  const periods =
    calendar && isCalendarSessionTimeframe(request.timeframe)
      ? calendarSessionPeriods(calendar, request.timeframe)
      : undefined;
  if (periods) {
    for (const period of periods) {
      if (calendarPeriodIntersects(period, request.requested)) {
        assertCalendarPeriodCoverage(calendar!, period);
      }
    }
  }
  validateBarsExact(
    options.bars,
    duration,
    options.alignment,
    calendar,
    request.timeframe,
    options.weekAnchorSec,
  );

  const recordCoverage =
    coverageSemantics === 'complete-record'
      ? intersect(options.recordSpan!, request.requested)
      : null;
  const completeIntervals: HalfOpenIntervalSec[] = recordCoverage ? [recordCoverage] : [];
  const periodsByOpen = periods
    ? new Map(periods.map((period) => [period.from as number, period] as const))
    : undefined;
  if (coverageSemantics === 'bars-only') {
    for (const bar of options.bars) {
      if (periodsByOpen) {
        const period = periodsByOpen.get(bar.time)!;
        for (const session of period.sessions) {
          const clipped = intersect(session, request.requested);
          if (clipped) completeIntervals.push(clipped);
        }
        continue;
      }
      const close = safeSecondAdd(bar.time, duration, 'bar close');
      const clipped = intersect(halfOpenIntervalSec(bar.time, close), request.requested);
      if (clipped) completeIntervals.push(clipped);
    }

    if (calendar) {
      completeIntervals.push(...closedCalendarIntervals(calendar, request.requested));
    }
  }

  const covered = mergeIntervals(completeIntervals);
  const missing = complementIntervals(request.requested, covered);
  const gaps = missing.map((gap) => ({
    ...gap,
    reason: gapReason(gap, request.requested, options.truncated),
  }));

  const provenance: AcquisitionProvenance = {
    cacheIdentity: options.cacheIdentity,
    normalizedSymbol: options.normalizedSymbol,
    sourceTimeframe: request.timeframe,
    targetTimeframe: request.timeframe,
    alignment: alignmentIdentity(options.alignment, calendar),
    ...(options.weekAnchorSec !== undefined ? { weekAnchorSec: options.weekAnchorSec } : {}),
    coverageSemantics,
    ...(options.recordSpan
      ? {
          recordSpan: Object.freeze({
            from: options.recordSpan.from,
            to: options.recordSpan.to,
          }),
        }
      : {}),
    aggregationVersion: 0,
  };

  return {
    bars: options.bars,
    requested: request.requested,
    covered,
    gaps,
    ...(options.truncated ? { truncated: options.truncated } : {}),
    complete: gaps.length === 0,
    provenance,
  };
}

/** Validate strict source order/OHLCV and optional UTC/session alignment. Never sorts or dedupes. */
export function validateBarsExact(
  bars: readonly Bar[],
  durationSeconds?: number,
  alignment: HistoryAlignment = 'unknown',
  calendar?: HistorySessionCalendar,
  timeframe?: string,
  weekAnchorSec?: UnixSecond,
): void {
  if (!Array.isArray(bars)) malformed('bars-shape', 'history bars must be an array');
  const periods =
    alignment === 'exchange-calendar' && calendar && timeframe
      ? calendarSessionPeriods(calendar, timeframe)
      : undefined;
  const periodsByOpen =
    periods && isCalendarSessionTimeframe(timeframe!)
      ? new Map(periods.map((period) => [period.from as number, period] as const))
      : undefined;
  const utcAnchor =
    alignment === 'utc-24x7' && timeframe ? utcTimeframeAnchor(timeframe, weekAnchorSec) : 0;

  let previous: number | undefined;
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index]!;
    if (!bar || typeof bar !== 'object') {
      malformed('bar-shape', `bar ${index} must be an object`, { index, bar });
    }
    if (Number.isFinite(bar.time) && !Number.isInteger(bar.time)) {
      throw new ExactHistoryError({
        kind: 'unsupported',
        code: 'subsecond-bar-boundary',
        message: `pinery: bar ${index} does not open on a whole UNIX second`,
        details: { index, time: bar.time },
      });
    }
    if (!Number.isSafeInteger(bar.time)) {
      malformed('bar-time', `bar ${index} time must be a safe integer UNIX second`, { index, bar });
    }
    if (previous !== undefined && bar.time <= previous) {
      malformed('bar-order', 'source bars must be strictly ascending with unique opens', {
        index,
        previous,
        current: bar.time,
      });
    }
    previous = bar.time;

    const values = [bar.open, bar.high, bar.low, bar.close, bar.volume];
    if (!values.every(Number.isFinite)) {
      malformed('bar-value', `bar ${index} contains a non-finite OHLCV value`, { index, bar });
    }
    if (
      bar.high < Math.max(bar.open, bar.low, bar.close) ||
      bar.low > Math.min(bar.open, bar.high, bar.close)
    ) {
      malformed('bar-ohlc', `bar ${index} violates OHLC bounds`, { index, bar });
    }

    if (durationSeconds !== undefined) {
      const fixedClose = periodsByOpen
        ? undefined
        : safeSecondAdd(bar.time, durationSeconds, 'bar close');
      if (alignment === 'utc-24x7') {
        if (floorMod(bar.time - utcAnchor, durationSeconds) !== 0) {
          malformed('bar-alignment', `bar ${index} is not UTC-aligned to its timeframe`, {
            index,
            time: bar.time,
            durationSeconds,
            anchor: utcAnchor,
          });
        }
      }
      if (alignment === 'exchange-calendar') {
        if (periodsByOpen) {
          const period = periodsByOpen.get(bar.time);
          if (!period) {
            malformed(
              'bar-session-alignment',
              `bar ${index} does not open at a declared calendar period`,
              { index, time: bar.time },
            );
          }
          assertCalendarPeriodCoverage(calendar!, period);
        } else {
          const declared = calendar?.sessions.find(
            (session) => bar.time >= session.from && fixedClose! <= session.to,
          );
          if (!declared || floorMod(bar.time - declared.from, durationSeconds) !== 0) {
            malformed(
              'bar-session-alignment',
              `bar ${index} is not aligned inside a declared session`,
              {
                index,
                time: bar.time,
              },
            );
          }
        }
      }
    }
  }
}

/** Validate cached/provider evidence rather than trusting `complete`. */
export function validateHistoryAcquisition(
  acquisition: HistoryAcquisition,
  expected?: {
    readonly requested?: HalfOpenIntervalSec;
    readonly cacheIdentity?: string;
    readonly normalizedSymbol?: string;
    readonly sourceTimeframe?: string;
    readonly targetTimeframe?: string;
    readonly aggregationVersion?: number;
    readonly alignment?: HistoryAlignment;
    readonly weekAnchorSec?: UnixSecond;
    readonly calendar?: HistorySessionCalendar;
    readonly coverageSemantics?: HistoryCoverageSemantics;
    readonly recordSpan?: HalfOpenIntervalSec;
  },
): void {
  if (!acquisition || typeof acquisition !== 'object') {
    malformed('acquisition-shape', 'history acquisition must be an object');
  }
  if (!Array.isArray(acquisition.bars)) {
    malformed('acquisition-bars', 'history acquisition bars must be an array');
  }
  if (!Array.isArray(acquisition.covered) || !Array.isArray(acquisition.gaps)) {
    malformed('acquisition-coverage', 'history acquisition covered and gaps must be arrays');
  }
  if (typeof acquisition.complete !== 'boolean') {
    malformed('acquisition-complete', 'history acquisition complete must be boolean');
  }
  const p = acquisition.provenance;
  if (
    !p ||
    typeof p !== 'object' ||
    typeof p.cacheIdentity !== 'string' ||
    p.cacheIdentity.length === 0 ||
    typeof p.normalizedSymbol !== 'string' ||
    p.normalizedSymbol.length === 0 ||
    typeof p.sourceTimeframe !== 'string' ||
    p.sourceTimeframe.length === 0 ||
    typeof p.targetTimeframe !== 'string' ||
    p.targetTimeframe.length === 0 ||
    typeof p.alignment !== 'string' ||
    p.alignment.length === 0 ||
    (p.weekAnchorSec !== undefined && !Number.isSafeInteger(p.weekAnchorSec)) ||
    !Number.isSafeInteger(p.aggregationVersion) ||
    p.aggregationVersion < 0
  ) {
    malformed('provenance', 'history acquisition provenance is incomplete or invalid', p);
  }
  const provenanceCoverageSemantics = p.coverageSemantics ?? 'bars-only';
  if (
    provenanceCoverageSemantics !== 'bars-only' &&
    provenanceCoverageSemantics !== 'complete-record'
  ) {
    malformed('provenance-coverage-semantics', 'acquisition coverage semantics is invalid', p);
  }
  if (provenanceCoverageSemantics === 'complete-record') {
    if (!p.recordSpan) {
      malformed('provenance-record-span', 'complete-record provenance requires recordSpan', p);
    }
    validateInterval(p.recordSpan, 'provenance record span');
  } else if (p.recordSpan !== undefined) {
    malformed(
      'provenance-record-span-semantics',
      'recordSpan provenance requires complete-record semantics',
      p,
    );
  }
  const provenanceUsesUtcWeeks =
    p.alignment === 'utc-24x7' &&
    (isUtcWeekTimeframe(p.sourceTimeframe) || isUtcWeekTimeframe(p.targetTimeframe));
  if (provenanceUsesUtcWeeks && p.weekAnchorSec === undefined) {
    malformed(
      'provenance-week-anchor',
      'UTC week-unit acquisition provenance requires explicit weekAnchorSec evidence',
      p,
    );
  }
  if (p.weekAnchorSec !== undefined && p.alignment !== 'utc-24x7') {
    malformed(
      'provenance-week-anchor-alignment',
      'weekAnchorSec provenance is valid only for utc-24x7 acquisitions',
      p,
    );
  }
  if (
    acquisition.truncated !== undefined &&
    (!acquisition.truncated ||
      (acquisition.truncated.side !== 'before' && acquisition.truncated.side !== 'after') ||
      typeof acquisition.truncated.reason !== 'string' ||
      acquisition.truncated.reason.length === 0 ||
      (acquisition.truncated.limit !== undefined &&
        (!Number.isSafeInteger(acquisition.truncated.limit) || acquisition.truncated.limit <= 0)))
  ) {
    malformed('truncation', 'history acquisition truncation is invalid', acquisition.truncated);
  }
  validateInterval(acquisition.requested, 'acquisition requested');
  if (expected?.requested && !sameInterval(acquisition.requested, expected.requested)) {
    malformed(
      'acquisition-requested',
      'acquisition requested interval does not match the request',
      {
        expected: expected.requested,
        actual: acquisition.requested,
      },
    );
  }
  if (expected?.cacheIdentity !== undefined && p.cacheIdentity !== expected.cacheIdentity) {
    malformed(
      'acquisition-identity',
      'acquisition cache identity does not match the resolved source',
    );
  }
  if (
    expected?.normalizedSymbol !== undefined &&
    p.normalizedSymbol !== expected.normalizedSymbol
  ) {
    malformed(
      'acquisition-symbol',
      'acquisition normalized symbol does not match the resolved source',
    );
  }
  if (expected?.sourceTimeframe !== undefined && p.sourceTimeframe !== expected.sourceTimeframe) {
    malformed('acquisition-timeframe', 'acquisition source timeframe does not match the request');
  }
  if (expected?.targetTimeframe !== undefined && p.targetTimeframe !== expected.targetTimeframe) {
    malformed(
      'acquisition-target-timeframe',
      'acquisition target timeframe does not match the stage',
    );
  }
  if (
    expected?.aggregationVersion !== undefined &&
    p.aggregationVersion !== expected.aggregationVersion
  ) {
    malformed(
      'acquisition-aggregation-version',
      'acquisition aggregation version does not match the stage',
    );
  }
  if (
    expected?.alignment !== undefined &&
    p.alignment !== alignmentIdentity(expected.alignment, expected.calendar)
  ) {
    malformed('acquisition-alignment', 'acquisition alignment does not match the resolved source');
  }
  if (
    expected?.coverageSemantics !== undefined &&
    provenanceCoverageSemantics !== expected.coverageSemantics
  ) {
    malformed(
      'acquisition-coverage-semantics',
      'acquisition coverage semantics do not match the resolved source',
      { expected: expected.coverageSemantics, actual: provenanceCoverageSemantics },
    );
  }
  if (expected?.recordSpan !== undefined) {
    if (!p.recordSpan || !sameInterval(p.recordSpan, expected.recordSpan)) {
      malformed(
        'acquisition-record-span',
        'acquisition record span does not match the resolved source',
        { expected: expected.recordSpan, actual: p.recordSpan },
      );
    }
  }
  if (expected?.weekAnchorSec !== undefined && p.weekAnchorSec !== expected.weekAnchorSec) {
    malformed(
      'acquisition-week-anchor',
      'acquisition weekly anchor does not match the resolved source',
      { expected: expected.weekAnchorSec, actual: p.weekAnchorSec },
    );
  }
  if (
    p.aggregationVersion === 0 &&
    fixedDuration(p.sourceTimeframe) !== fixedDuration(p.targetTimeframe)
  ) {
    malformed(
      'native-target-duration',
      'unaggregated acquisition source and target durations must match',
      { sourceTimeframe: p.sourceTimeframe, targetTimeframe: p.targetTimeframe },
    );
  }
  if (
    p.aggregationVersion === 0 &&
    (expected?.alignment === 'exchange-calendar' || p.alignment.startsWith('exchange-calendar:')) &&
    isCalendarSessionTimeframe(p.targetTimeframe) &&
    !sameCanonicalTimeframe(p.sourceTimeframe, p.targetTimeframe)
  ) {
    malformed(
      'native-target-calendar-timeframe',
      'unaggregated exchange-calendar day/week acquisitions require the exact target token',
      { sourceTimeframe: p.sourceTimeframe, targetTimeframe: p.targetTimeframe },
    );
  }

  validateBarsExact(acquisition.bars);
  validateNormalizedIntervals(acquisition.covered, acquisition.requested, 'covered');
  validateNormalizedIntervals(acquisition.gaps, acquisition.requested, 'gaps');
  for (const gap of acquisition.gaps) {
    if (!isGapReason(gap.reason))
      malformed('gap-reason', `unknown coverage gap reason "${gap.reason}"`);
  }

  const partition = [
    ...acquisition.covered.map((interval) => ({ ...interval, kind: 'covered' as const })),
    ...acquisition.gaps.map((interval) => ({ ...interval, kind: 'gap' as const })),
  ].sort((a, b) => a.from - b.from || a.to - b.to);
  let cursor = acquisition.requested.from as number;
  for (const interval of partition) {
    if (interval.from !== cursor) {
      malformed(
        'coverage-partition',
        'covered intervals and gaps must exactly partition requested',
        {
          cursor,
          interval,
        },
      );
    }
    cursor = interval.to;
  }
  if (cursor !== acquisition.requested.to) {
    malformed('coverage-partition', 'covered intervals and gaps do not reach requested end', {
      cursor,
      end: acquisition.requested.to,
    });
  }
  if (acquisition.complete !== (acquisition.gaps.length === 0)) {
    malformed('coverage-complete', '`complete` must equal whether the acquisition has no gaps');
  }

  // Bind every positive coverage claim back to returned complete target-bar
  // intervals (plus explicit calendar closures). A self-consistent covered/gap
  // partition is not, by itself, evidence that data exists.
  const alignment = expected?.alignment ?? provenanceAlignment(p.alignment);
  const evidence = historyAcquisitionFromBars({
    bars: acquisition.bars,
    request: { timeframe: p.targetTimeframe, requested: acquisition.requested },
    cacheIdentity: p.cacheIdentity,
    normalizedSymbol: p.normalizedSymbol,
    alignment,
    weekAnchorSec: expected?.weekAnchorSec ?? p.weekAnchorSec,
    calendar: expected?.calendar,
    coverageSemantics: provenanceCoverageSemantics,
    recordSpan: p.recordSpan,
    truncated: acquisition.truncated,
  });
  const provenCovered =
    provenanceCoverageSemantics === 'complete-record' && p.aggregationVersion > 0
      ? completeRecordAggregateCoverage(
          acquisition.requested,
          p.targetTimeframe,
          p.recordSpan!,
          alignment,
          expected?.calendar,
          expected?.weekAnchorSec ?? p.weekAnchorSec,
        )
      : evidence.covered;
  if (!sameIntervals(provenCovered, acquisition.covered)) {
    malformed('coverage-evidence', 'reported coverage is not proven by returned bars/calendar', {
      reported: acquisition.covered,
      proven: provenCovered,
    });
  }
}

function completeRecordAggregateCoverage(
  requested: HalfOpenIntervalSec,
  timeframe: string,
  recordSpan: HalfOpenIntervalSec,
  alignment: HistoryAlignment,
  calendar: HistorySessionCalendar | undefined,
  weekAnchorSec: UnixSecond | undefined,
): HalfOpenIntervalSec[] {
  const duration = fixedDuration(timeframe);
  const covered: HalfOpenIntervalSec[] = [];
  if (alignment === 'utc-24x7') {
    const anchor = utcTimeframeAnchor(timeframe, weekAnchorSec);
    let open = floorTo(requested.from, duration, anchor);
    while (open < requested.to) {
      const bucket = halfOpenIntervalSec(open, safeSecondAdd(open, duration, 'aggregate close'));
      if (covers([recordSpan], bucket)) {
        const clipped = intersect(bucket, requested);
        if (clipped) covered.push(clipped);
      }
      open = bucket.to;
    }
    return mergeIntervals(covered);
  }

  if (alignment !== 'exchange-calendar' || !calendar) return [];
  if (isCalendarSessionTimeframe(timeframe)) {
    for (const period of calendarSessionPeriods(calendar, timeframe)) {
      if (
        !calendarPeriodIntersects(period, requested) ||
        !covers([recordSpan], halfOpenIntervalSec(period.from, period.to))
      ) {
        continue;
      }
      for (const session of period.sessions) {
        const clipped = intersect(session, requested);
        if (clipped) covered.push(clipped);
      }
    }
  } else {
    for (const session of calendar.sessions) {
      if (!intersect(session, requested)) continue;
      let open = session.from as number;
      while (open < session.to) {
        const close = safeSecondAdd(open, duration, 'aggregate session close');
        if (close > session.to) break;
        const bucket = halfOpenIntervalSec(open, close);
        if (covers([recordSpan], bucket)) {
          const clipped = intersect(bucket, requested);
          if (clipped) covered.push(clipped);
        }
        open = close;
      }
    }
  }
  for (const closure of closedCalendarIntervals(calendar, requested)) {
    const clipped = intersect(closure, recordSpan);
    if (clipped) covered.push(clipped);
  }
  return mergeIntervals(covered);
}

export function mergeIntervals(intervals: readonly HalfOpenIntervalSec[]): HalfOpenIntervalSec[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: HalfOpenIntervalSec[] = [];
  for (const interval of sorted) {
    validateInterval(interval, 'coverage');
    const last = out[out.length - 1];
    if (!last || interval.from > last.to) {
      out.push({ ...interval });
    } else if (interval.to > last.to) {
      out[out.length - 1] = { from: last.from, to: interval.to };
    }
  }
  return out;
}

export function complementIntervals(
  requested: HalfOpenIntervalSec,
  covered: readonly HalfOpenIntervalSec[],
): HalfOpenIntervalSec[] {
  const out: HalfOpenIntervalSec[] = [];
  let cursor = requested.from as number;
  for (const interval of covered) {
    if (interval.from > cursor) out.push(halfOpenIntervalSec(cursor, interval.from));
    cursor = Math.max(cursor, interval.to);
  }
  if (cursor < requested.to) out.push(halfOpenIntervalSec(cursor, requested.to));
  return out;
}

export function intersect(
  a: HalfOpenIntervalSec,
  b: HalfOpenIntervalSec,
): HalfOpenIntervalSec | null {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);
  return from < to ? halfOpenIntervalSec(from, to) : null;
}

export function covers(
  intervals: readonly HalfOpenIntervalSec[],
  candidate: HalfOpenIntervalSec,
): boolean {
  return intervals.some(
    (interval) => interval.from <= candidate.from && interval.to >= candidate.to,
  );
}

export function alignmentIdentity(
  alignment: HistoryAlignment,
  calendar?: HistorySessionCalendar,
): string {
  return alignment === 'exchange-calendar' && calendar
    ? `exchange-calendar:${calendar.calendarId}@${calendar.version}`
    : alignment;
}

/** Whether a canonical fixed timeframe uses week-unit rather than elapsed-day semantics. */
export function isUtcWeekTimeframe(timeframe: string): boolean {
  const parsed = parseCanonicalTimeframeExact(timeframe);
  return parsed.kind === 'ok' && parsed.value.domain === 'fixed' && parsed.value.unit === 'w';
}

/** UTC grid anchor for a canonical timeframe; week-unit grids require explicit evidence. */
export function utcTimeframeAnchor(timeframe: string, weekAnchorSec?: UnixSecond): number {
  if (!isUtcWeekTimeframe(timeframe)) return 0;
  if (weekAnchorSec === undefined) {
    throw new ExactHistoryError({
      kind: 'unsupported',
      code: 'weekly-anchor-missing',
      message: `pinery: exact UTC week timeframe "${timeframe}" requires explicit weekAnchorSec capability evidence`,
      details: { timeframe },
    });
  }
  if (!Number.isSafeInteger(weekAnchorSec)) {
    malformed('week-anchor', 'weekAnchorSec must be a safe integer UNIX second', {
      timeframe,
      weekAnchorSec,
    });
  }
  return weekAnchorSec;
}

/**
 * True only when every source bucket boundary exactly tiles the target UTC grid.
 * Separate source/target week anchors let callers compare a provider's observed
 * week grid with a requested semantic grid; existing three-argument callers use
 * one shared anchor for both sides.
 */
export function utcTimeframesNest(
  sourceTimeframe: string,
  targetTimeframe: string,
  sourceWeekAnchorSec?: UnixSecond,
  targetWeekAnchorSec: UnixSecond | undefined = sourceWeekAnchorSec,
): boolean {
  const sourceDuration = fixedDuration(sourceTimeframe);
  const targetDuration = fixedDuration(targetTimeframe);
  if (targetDuration < sourceDuration || targetDuration % sourceDuration !== 0) return false;
  const sourceAnchor = utcTimeframeAnchor(sourceTimeframe, sourceWeekAnchorSec);
  const targetAnchor = utcTimeframeAnchor(targetTimeframe, targetWeekAnchorSec);
  return floorMod(targetAnchor - sourceAnchor, sourceDuration) === 0;
}

function calendarPeriodSpec(timeframe: string): {
  readonly canonical: string;
  readonly duration: number;
  readonly singleSession: boolean;
} | null {
  const parsed = parseCanonicalTimeframeExact(timeframe);
  if (
    parsed.kind !== 'ok' ||
    parsed.value.domain !== 'fixed' ||
    (parsed.value.unit !== 'd' && parsed.value.unit !== 'w')
  ) {
    return null;
  }
  return {
    canonical: parsed.value.canonical,
    duration: parsed.value.seconds,
    singleSession: parsed.value.unit === 'd' && parsed.value.count === 1,
  };
}

function sameCanonicalTimeframe(a: string, b: string): boolean {
  const left = parseCanonicalTimeframeExact(a);
  const right = parseCanonicalTimeframeExact(b);
  return (
    left.kind === 'ok' && right.kind === 'ok' && left.value.canonical === right.value.canonical
  );
}

export function fixedDuration(timeframe: string): number {
  const result = canonicalTimeframeSecondsExact(timeframe);
  if (result.kind !== 'ok') {
    throw new ExactHistoryError({
      kind: result.kind,
      code: result.code,
      message: result.message,
      details: { timeframe },
    });
  }
  return result.value;
}

export function floorTo(value: number, duration: number, anchor = 0): number {
  return anchor + Math.floor((value - anchor) / duration) * duration;
}

export function ceilTo(value: number, duration: number, anchor = 0): number {
  const floor = floorTo(value, duration, anchor);
  return floor === value ? value : safeSecondAdd(floor, duration, 'aligned interval end');
}

export function safeSecondAdd(value: number, delta: number, label: string): UnixSecond {
  const result = value + delta;
  if (!Number.isSafeInteger(result)) {
    malformed('timestamp-overflow', `${label} overflows safe UNIX seconds`, { value, delta });
  }
  return result as UnixSecond;
}

function closedCalendarIntervals(
  calendar: HistorySessionCalendar,
  requested: HalfOpenIntervalSec,
): HalfOpenIntervalSec[] {
  const declared = intersect(calendar.coverage, requested);
  if (!declared) return [];
  const active = mergeIntervals(
    calendar.sessions
      .map((session) => intersect(session, declared))
      .filter((value): value is HalfOpenIntervalSec => value !== null),
  );
  return complementIntervals(declared, active);
}

function requireCalendar(
  calendar: HistorySessionCalendar | undefined,
  requested: HalfOpenIntervalSec,
): HistorySessionCalendar {
  if (!calendar) {
    throw new ExactHistoryError({
      kind: 'unsupported',
      code: 'calendar-metadata-missing',
      message: 'pinery: exchange-calendar alignment requires explicit versioned calendar metadata',
    });
  }
  const snapshot = snapshotHistorySessionCalendar(calendar);
  if (snapshot.coverage.from > requested.from || snapshot.coverage.to < requested.to) {
    throw new ExactHistoryError({
      kind: 'unsupported',
      code: 'calendar-coverage-missing',
      message: 'pinery: calendar metadata does not cover the requested interval',
      details: { requested, calendarCoverage: snapshot.coverage },
    });
  }
  return snapshot;
}

function gapReason(
  gap: HalfOpenIntervalSec,
  requested: HalfOpenIntervalSec,
  truncated?: HistoryTruncation,
): CoverageGapReason {
  if (
    truncated &&
    ((truncated.side === 'before' && gap.from === requested.from) ||
      (truncated.side === 'after' && gap.to === requested.to))
  ) {
    return 'provider-truncated';
  }
  return 'provider-missing';
}

function validateInterval(interval: HalfOpenIntervalSec, label: string): void {
  if (
    !interval ||
    !Number.isSafeInteger(interval.from) ||
    !Number.isSafeInteger(interval.to) ||
    interval.from >= interval.to
  ) {
    malformed('interval', `${label} must be finite safe integer seconds with from < to`, interval);
  }
}

function validateNormalizedIntervals(
  intervals: readonly HalfOpenIntervalSec[],
  bounds: HalfOpenIntervalSec,
  label: string,
): void {
  let previousTo: number | undefined;
  for (const interval of intervals) {
    validateInterval(interval, label);
    if (interval.from < bounds.from || interval.to > bounds.to) {
      malformed('coverage-bounds', `${label} interval lies outside requested bounds`, {
        interval,
        bounds,
      });
    }
    if (previousTo !== undefined && interval.from < previousTo) {
      malformed(
        'coverage-order',
        `${label} intervals must be ascending and non-overlapping`,
        intervals,
      );
    }
    previousTo = interval.to;
  }
}

function sameInterval(a: HalfOpenIntervalSec, b: HalfOpenIntervalSec): boolean {
  return a.from === b.from && a.to === b.to;
}

function sameIntervals(
  a: readonly HalfOpenIntervalSec[],
  b: readonly HalfOpenIntervalSec[],
): boolean {
  return a.length === b.length && a.every((interval, index) => sameInterval(interval, b[index]!));
}

function provenanceAlignment(value: string): HistoryAlignment {
  if (value === 'utc-24x7') return 'utc-24x7';
  if (value === 'unknown') return 'unknown';
  if (value.startsWith('exchange-calendar:')) return 'exchange-calendar';
  malformed('provenance-alignment', `unknown provenance alignment "${value}"`);
}

function isGapReason(value: unknown): value is CoverageGapReason {
  return (
    value === 'provider-missing' || value === 'partial-aggregate' || value === 'provider-truncated'
  );
}

function floorMod(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function malformed(code: string, message: string, details?: unknown): never {
  throw new ExactHistoryError({ kind: 'malformed', code, message, details });
}
