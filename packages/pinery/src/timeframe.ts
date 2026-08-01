/**
 * Canonical timeframe tokens used across pinery/pinerun. Legacy helpers retain
 * their existing permissive/clamping behavior; exact Bar Magnifier helpers are
 * separate and never clamp or substitute a nearby interval.
 */
export type Timeframe = string;

export type ExactTimeframeFailureKind = 'unsupported' | 'malformed';

export type ExactTimeframeResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | {
      readonly kind: ExactTimeframeFailureKind;
      readonly code: string;
      readonly input: string;
      readonly message: string;
    };

export interface FixedCanonicalTimeframe {
  readonly domain: 'fixed';
  readonly count: number;
  readonly unit: 's' | 'm' | 'h' | 'd' | 'w';
  readonly canonical: string;
  readonly seconds: number;
}

export interface CalendarCanonicalTimeframe {
  readonly domain: 'calendar';
  readonly count: number;
  readonly unit: 'M';
  readonly canonical: string;
}

export type ParsedCanonicalTimeframe = FixedCanonicalTimeframe | CalendarCanonicalTimeframe;

type TimeframeUnit = 'm' | 'h' | 'd' | 'w' | 'M';

const FIXED_UNIT_SECONDS: Readonly<Record<FixedCanonicalTimeframe['unit'], number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

const LEGACY_UNIT_SECONDS: Readonly<Record<TimeframeUnit, number>> = {
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  M: 2592000, // 30d nominal — only used for non-exact ordering/paging heuristics
};

/** Strict canonical parser used only by exact acquisition. */
export function parseCanonicalTimeframeExact(
  input: string,
): ExactTimeframeResult<ParsedCanonicalTimeframe> {
  const tf = input.trim();
  const match = /^(\d+)([smhdwM])$/.exec(tf);
  if (!match) {
    if (/^\d+T$/i.test(tf)) return unsupportedTick(input);
    return malformed(
      input,
      'canonical-timeframe-syntax',
      `pinery: malformed canonical timeframe "${input}"`,
    );
  }
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count <= 0) {
    return malformed(
      input,
      'canonical-timeframe-count',
      `pinery: canonical timeframe count must be a positive safe integer (received "${input}")`,
    );
  }
  const unit = match[2] as 's' | 'm' | 'h' | 'd' | 'w' | 'M';
  const canonical = `${count}${unit}`;
  if (unit === 'M') {
    return { kind: 'ok', value: { domain: 'calendar', count, unit, canonical } };
  }
  const seconds = count * FIXED_UNIT_SECONDS[unit];
  if (!Number.isSafeInteger(seconds)) {
    return malformed(
      input,
      'timeframe-duration-overflow',
      'pinery: timeframe duration overflows safe seconds',
    );
  }
  return { kind: 'ok', value: { domain: 'fixed', count, unit, canonical, seconds } };
}

/** Exact Pine TF → canonical pinery TF. Seconds remain seconds; ticks are unsupported. */
export function pineTimeframeToCanonicalExact(input: string): ExactTimeframeResult<string> {
  const tf = input.trim();
  if (/^(\d+)T$/i.test(tf)) return unsupportedTick(input);

  const seconds = /^(\d+)S$/.exec(tf);
  if (seconds) return positivePineCount(input, seconds[1]!, (n) => `${n}s`);

  const minutes = /^(\d+)$/.exec(tf);
  if (minutes) return positivePineCount(input, minutes[1]!, (n) => `${n}m`);

  const letter = /^(\d*)([DWM])$/.exec(tf);
  if (letter) {
    const raw = letter[1] || '1';
    return positivePineCount(input, raw, (n) => {
      const unit = letter[2] === 'D' ? 'd' : letter[2] === 'W' ? 'w' : 'M';
      return `${n}${unit}`;
    });
  }

  return malformed(input, 'pine-timeframe-syntax', `pinery: malformed Pine timeframe "${input}"`);
}

/** Exact canonical pinery TF → Pine TF. No tick representation is accepted. */
export function canonicalTimeframeToPineExact(input: string): ExactTimeframeResult<string> {
  const parsed = parseCanonicalTimeframeExact(input);
  if (parsed.kind !== 'ok') return parsed;
  const tf = parsed.value;
  if (tf.domain === 'calendar') return { kind: 'ok', value: tf.count === 1 ? 'M' : `${tf.count}M` };
  switch (tf.unit) {
    case 's':
      return { kind: 'ok', value: `${tf.count}S` };
    case 'm':
      return { kind: 'ok', value: String(tf.count) };
    case 'h':
      return { kind: 'ok', value: String(tf.count * 60) };
    case 'd':
      return { kind: 'ok', value: tf.count === 1 ? 'D' : `${tf.count}D` };
    case 'w':
      return { kind: 'ok', value: tf.count === 1 ? 'W' : `${tf.count}W` };
  }
}

/** Fixed duration for exact acquisition. Calendar months are typed unsupported. */
export function canonicalTimeframeSecondsExact(input: string): ExactTimeframeResult<number> {
  const parsed = parseCanonicalTimeframeExact(input);
  if (parsed.kind !== 'ok') return parsed;
  if (parsed.value.domain === 'calendar') {
    return {
      kind: 'unsupported',
      code: 'calendar-duration',
      input,
      message: `pinery: calendar timeframe "${input}" has no fixed second duration`,
    };
  }
  return { kind: 'ok', value: parsed.value.seconds };
}

export interface ExactDivisorSelection {
  readonly timeframe: string;
  readonly durationSeconds: number;
}

/** Choose the largest supported fixed duration that divides the target exactly. */
export function selectLargestExactDivisor(
  targetTimeframe: string,
  supportedTimeframes: readonly string[],
): ExactTimeframeResult<ExactDivisorSelection> {
  const target = canonicalTimeframeSecondsExact(targetTimeframe);
  if (target.kind !== 'ok') return target;

  let selected: ExactDivisorSelection | undefined;
  for (const candidate of supportedTimeframes) {
    const duration = canonicalTimeframeSecondsExact(candidate);
    if (duration.kind !== 'ok') return duration;
    if (duration.value > target.value || target.value % duration.value !== 0) continue;
    if (!selected || duration.value > selected.durationSeconds) {
      const parsed = parseCanonicalTimeframeExact(candidate);
      if (parsed.kind !== 'ok') return parsed;
      selected = { timeframe: parsed.value.canonical, durationSeconds: duration.value };
    }
  }

  if (!selected) {
    return {
      kind: 'unsupported',
      code: 'no-exact-divisor',
      input: targetTimeframe,
      message: `pinery: no supported timeframe is an exact divisor of "${targetTimeframe}"`,
    };
  }
  return { kind: 'ok', value: selected };
}

/** Parse a legacy/public canonical timeframe into its numeric value and unit. */
export function parseTimeframe(tf: Timeframe): { n: number; unit: TimeframeUnit } {
  const match = /^(\d+)\s*([mhdwM])$/.exec(tf.trim());
  if (!match)
    throw new Error(`pinery: unrecognized timeframe "${tf}" (use e.g. 1m, 15m, 1h, 4h, 1d, 1w)`);
  const n = Number(match[1]);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new RangeError(`pinery: timeframe "${tf}" magnitude must be a positive safe integer`);
  return { n, unit: match[2] as TimeframeUnit };
}

/** Parse a canonical timeframe into nominal seconds for non-exact callers. */
export function timeframeSeconds(tf: Timeframe): number {
  const { n, unit } = parseTimeframe(tf);
  const seconds = n * LEGACY_UNIT_SECONDS[unit];
  if (!Number.isSafeInteger(seconds) || seconds <= 0)
    throw new RangeError(`pinery: timeframe "${tf}" duration must be a positive safe integer`);
  return seconds;
}

/** Legacy canonical → piner converter. */
export function toPinerTimeframe(tf: Timeframe): string {
  if (!/^(\d+)\s*([mhdwM])$/.test(tf.trim())) return tf;
  const { n, unit } = parseTimeframe(tf);
  timeframeSeconds(tf);
  switch (unit) {
    case 'm':
      return String(n);
    case 'h':
      return String(n * 60);
    case 'd':
      return n === 1 ? 'D' : `${n}D`;
    case 'w':
      return n === 1 ? 'W' : `${n}W`;
    case 'M':
      return n === 1 ? 'M' : `${n}M`;
  }
}

/** Minutes → canonical token, for the round trip out of piner's minute-based tf strings. */
const MINUTES_TO_CANONICAL: Readonly<Record<number, Timeframe>> = {
  1: '1m',
  3: '3m',
  5: '5m',
  15: '15m',
  30: '30m',
  60: '1h',
  120: '2h',
  240: '4h',
  360: '6h',
  480: '8h',
  720: '12h',
};

/**
 * Inverse of `toPinerTimeframe`: map a piner timeframe string back to a canonical
 * pinery token so it can be fetched from a provider. Handles minute counts
 * (`"1"`, `"60"`), day/week/month letters (`"D"`, `"1W"`, `"3M"`), and clamps
 * sub-minute/seconds (`"1S"`) to `"1m"` (pinery's finest). Returns `null` for an
 * empty/auto timeframe or an unsafe magnitude. Used to resolve shared data
 * dependencies; exact acquisition uses the strict helpers above.
 */
export function pinerTimeframeToCanonical(pinerTf: string): Timeframe | null {
  const tf = pinerTf.trim();
  if (tf === '') return null;
  const seconds = /^(\d*)S$/i.exec(tf);
  if (seconds) {
    const n = seconds[1] ? Number(seconds[1]) : 1;
    return Number.isSafeInteger(n) && n > 0 ? '1m' : null;
  }
  const letter = /^(\d*)([DWM])$/.exec(tf);
  if (letter) {
    const n = letter[1] ? Number(letter[1]) : 1;
    if (!Number.isSafeInteger(n) || n <= 0) return null;
    const unit = letter[2] === 'D' ? 'd' : letter[2] === 'W' ? 'w' : 'M';
    const canonical = `${n}${unit}`;
    try {
      timeframeSeconds(canonical);
      return canonical;
    } catch {
      return null;
    }
  }
  if (/^\d+$/.test(tf)) {
    const minutes = Number(tf);
    if (!Number.isSafeInteger(minutes) || minutes <= 0) return null;
    const canonical = MINUTES_TO_CANONICAL[minutes] ?? `${minutes}m`;
    try {
      timeframeSeconds(canonical);
      return canonical;
    } catch {
      return null;
    }
  }
  return null;
}

function positivePineCount(
  input: string,
  raw: string,
  convert: (count: number) => string,
): ExactTimeframeResult<string> {
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count <= 0) {
    return malformed(
      input,
      'pine-timeframe-count',
      `pinery: Pine timeframe count must be a positive safe integer (received "${input}")`,
    );
  }
  return { kind: 'ok', value: convert(count) };
}

function unsupportedTick(input: string): ExactTimeframeResult<never> {
  return {
    kind: 'unsupported',
    code: 'tick-timeframe',
    input,
    message: `pinery: tick timeframe "${input}" is unsupported for exact acquisition`,
  };
}

function malformed(input: string, code: string, message: string): ExactTimeframeResult<never> {
  return { kind: 'malformed', code, input, message };
}

/**
 * Resolve a `request.security_lower_tf` timeframe to the canonical TF to fetch: the
 * finer TF strictly below the chart TF; clamps sub-minute to `1m`; returns null when
 * the chart is already at the finest TF (the request degrades to []).
 *
 * Shared by every host that resolves piner's data dependencies (pinerun's scans and
 * pinelive's forward runner) so backtest and live plan identical fetches.
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
  return chartSec > 60 ? '1m' : null;
}

/** Fixed-duration aliases compare by seconds; calendar months compare only to calendar months. */
function sameTimeframe(a: Timeframe, b: Timeframe): boolean {
  const left = parseTimeframe(a);
  const right = parseTimeframe(b);
  if (left.unit === 'M' || right.unit === 'M')
    return left.unit === right.unit && left.n === right.n;
  return timeframeSeconds(a) === timeframeSeconds(b);
}

/**
 * Resolve a plain same-symbol `request.security` timeframe to the canonical TF to fetch, or null
 * when it is the chart's own TF (piner passes it through) or unknown. Unlike `resolveLowerFetchTf`,
 * this returns the exact requested TF (finer or higher) with no clamping, so the real series is
 * fetched instead of resampling the chart's own bars.
 */
export function resolveSameSymbolFetchTf(rawPinerTf: string, chartTf: Timeframe): Timeframe | null {
  const canon = pinerTimeframeToCanonical(rawPinerTf);
  if (!canon) return null;
  try {
    return sameTimeframe(canon, chartTf) ? null : canon;
  } catch {
    return null;
  }
}
