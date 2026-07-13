/**
 * Canonical timeframe tokens used across pinery/pinerun: `1m 3m 5m 15m 30m 1h
 * 2h 4h 6h 8h 12h 1d 3d 1w 1M`. Providers map these to their own vocabulary.
 */
export type Timeframe = string;

const UNIT_SECONDS: Record<string, number> = {
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  M: 2592000, // 30d nominal — only used for cache bucketing / paging heuristics
};

/** Parse a canonical timeframe into its numeric value + unit. */
export function parseTimeframe(tf: Timeframe): { n: number; unit: 'm' | 'h' | 'd' | 'w' | 'M' } {
  const m = /^(\d+)\s*([mhdwM])$/.exec(tf.trim());
  if (!m) throw new Error(`pinery: unrecognized timeframe "${tf}" (use e.g. 1m, 15m, 1h, 4h, 1d, 1w)`);
  return { n: Number(m[1]), unit: m[2] as 'm' | 'h' | 'd' | 'w' | 'M' };
}

/** Parse a canonical timeframe (e.g. "15m", "4h", "1d") into seconds. */
export function timeframeSeconds(tf: Timeframe): number {
  const m = /^(\d+)\s*([mhdwM])$/.exec(tf.trim());
  if (!m) throw new Error(`pinery: unrecognized timeframe "${tf}" (use e.g. 1m, 15m, 1h, 4h, 1d, 1w)`);
  const n = Number(m[1]);
  const unit = m[2] as keyof typeof UNIT_SECONDS;
  return n * UNIT_SECONDS[unit]!;
}

/**
 * Map a canonical timeframe onto piner's timeframe-string convention (minutes as
 * a bare number, or `D`/`W`/`M` multiples). Used as the label passed to
 * `Engine.run({ timeframe })`; it only affects `timeframe.*` builtins and
 * `request.security`, not plain series math.
 */
export function toPinerTimeframe(tf: Timeframe): string {
  const m = /^(\d+)\s*([mhdwM])$/.exec(tf.trim());
  if (!m) return tf;
  const n = Number(m[1]);
  switch (m[2]) {
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
    default:
      return tf;
  }
}


/** Minutes → canonical token, for the round trip out of piner's minute-based tf strings. */
const MINUTES_TO_CANONICAL: Record<number, Timeframe> = {
  1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m',
  60: '1h', 120: '2h', 240: '4h', 360: '6h', 480: '8h', 720: '12h',
};

/**
 * Inverse of `toPinerTimeframe`: map a piner timeframe string back to a canonical
 * pinery token so it can be fetched from a provider. Handles minute counts
 * (`"1"`, `"60"`), day/week/month letters (`"D"`, `"1W"`, `"3M"`), and clamps
 * sub-minute/seconds (`"1S"`) to `"1m"` (pinery's finest). Returns `null` for an
 * empty/auto timeframe. Used to resolve `request.security_lower_tf` fetch TFs.
 */
export function pinerTimeframeToCanonical(pinerTf: string): Timeframe | null {
  const tf = pinerTf.trim();
  if (tf === '') return null;
  if (/^\d*S$/i.test(tf)) return '1m'; // seconds → finest we fetch
  const letter = /^(\d*)([DWM])$/.exec(tf);
  if (letter) {
    const n = letter[1] ? Number(letter[1]) : 1;
    const unit = letter[2] === 'D' ? 'd' : letter[2] === 'W' ? 'w' : 'M';
    return `${n}${unit}`;
  }
  if (/^\d+$/.test(tf)) {
    const min = Number(tf);
    return MINUTES_TO_CANONICAL[min] ?? `${min}m`;
  }
  return null;
}
