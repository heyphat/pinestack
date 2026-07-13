/**
 * Tearsheet tables — pure string builders (browser-safe, no I/O).
 *
 * `monthlyReturnsAscii` renders the classic year × month % grid off an equity
 * curve; `topDrawdownsAscii` tables the deepest peak→trough→recovery episodes;
 * `profitHistogramAscii` buckets closed-trade profits into a horizontal-bar
 * distribution; `correlationMatrixAscii` prints a pairwise return-correlation
 * grid for aligned series. Monochrome and pipe-safe by default; the `color`
 * flags (opt-in, CLI enables them only on a TTY) wrap value cells in ANSI
 * green/red without touching layout — stripping the codes recovers the plain
 * table exactly.
 */
import { returnCorrelation } from './align.js';

const GREEN = 32;
const RED = 31;

/** Wrap `s` in an ANSI color when `on`; zero visual width either way. */
function paint(s: string, ansi: number, on: boolean): string {
  return on ? `\x1b[${ansi}m${s}\x1b[39m` : s;
}

/** unix seconds or ms → ms. */
function toMs(t: number): number {
  return t >= 1e12 ? t : t * 1000;
}

/** unix seconds or ms → YYYY-MM-DD (UTC). */
function isoDay(t: number): string {
  return new Date(toMs(t)).toISOString().slice(0, 10);
}

/** Grouped whole number ≥ 1000, 2 decimals below — deterministic across locales. */
function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return 'na';
  const a = Math.abs(v);
  if (a >= 1000) {
    const r = Math.round(v);
    const sign = r < 0 ? '-' : '';
    const digits = String(Math.abs(r));
    let grouped = '';
    for (let i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 === 0) grouped += ',';
      grouped += digits[i];
    }
    return sign + grouped;
  }
  return v.toFixed(2);
}

const MONTH_LABELS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

export interface MonthlyReturnsOptions {
  /** Wrap positive cells in ANSI green and negative in red. Default false. */
  color?: boolean;
}

/**
 * Year × month percent-return grid from a per-bar equity curve. Each cell is
 * the equity change over that calendar month (UTC); the YEAR column compounds
 * the whole year. Months with no bars print `·`. Returns '' when the curve
 * spans fewer than two finite points.
 */
export function monthlyReturnsAscii(
  equity: number[],
  times: number[],
  opts: MonthlyReturnsOptions = {},
): string {
  if (equity.length !== times.length || equity.length < 2) return '';

  // Last finite equity per (year, month), in chronological order.
  const monthEnd = new Map<string, { year: number; month: number; equity: number }>();
  let baseline: number | undefined;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i]!;
    if (!Number.isFinite(v)) continue;
    if (baseline === undefined) baseline = v;
    const d = new Date(toMs(times[i]!));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    monthEnd.set(`${year}-${month}`, { year, month, equity: v });
  }
  if (baseline === undefined || monthEnd.size === 0) return '';

  // Percent return per month = end / previous month's end (or the baseline).
  const entries = [...monthEnd.values()]; // insertion order = chronological
  const byYear = new Map<number, (number | undefined)[]>();
  let prev = baseline;
  for (const e of entries) {
    let row = byYear.get(e.year);
    if (!row) byYear.set(e.year, (row = new Array<number | undefined>(12)));
    row[e.month] = prev > 0 ? (e.equity / prev - 1) * 100 : NaN;
    prev = e.equity;
  }

  const cellW = 7;
  const color = opts.color === true;
  // Pad BEFORE painting so ANSI codes never disturb the column alignment.
  const cell = (v: number | undefined, w = cellW): string => {
    if (v === undefined) return '·'.padStart(w);
    if (!Number.isFinite(v)) return 'na'.padStart(w);
    const s = v.toFixed(1).padStart(w);
    return v > 0 ? paint(s, GREEN, color) : v < 0 ? paint(s, RED, color) : s;
  };

  const lines: string[] = [];
  lines.push(
    `      ${MONTH_LABELS.map((m) => m.padStart(cellW)).join('')}${'YEAR'.padStart(cellW + 2)}`,
  );
  let yearStart = baseline;
  for (const [year, row] of byYear) {
    // The YEAR column compounds the whole year: last month-end vs the equity
    // entering the year.
    const yearEnd = entries.filter((e) => e.year === year).pop()!;
    const yearRet = yearStart > 0 ? (yearEnd.equity / yearStart - 1) * 100 : NaN;
    yearStart = yearEnd.equity;
    const cells = Array.from({ length: 12 }, (_, m) => cell(row[m]));
    lines.push(`  ${year}${cells.join('')}${cell(yearRet, cellW + 2)}`);
  }
  return lines.join('\n');
}

export interface DrawdownEpisode {
  /** Peak → trough loss, percent (negative). */
  depthPercent: number;
  peakIndex: number;
  troughIndex: number;
  /** Bar index where equity regained the peak; null while still underwater. */
  recoveryIndex: number | null;
}

/**
 * Peak→trough→recovery episodes of an equity curve, deepest first. An episode
 * opens when equity drops below the running peak and closes when it regains
 * it; the final episode may be unrecovered. NaN points carry (no episode
 * breaks). Pure computation — `topDrawdownsAscii` renders it.
 */
export function drawdownEpisodes(equity: number[]): DrawdownEpisode[] {
  const out: DrawdownEpisode[] = [];
  let peak = -Infinity;
  let peakIdx = -1;
  let troughIdx = -1;
  let trough = Infinity;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i]!;
    if (!Number.isFinite(v)) continue;
    if (v >= peak) {
      if (troughIdx >= 0 && peak > 0) {
        out.push({
          depthPercent: (trough / peak - 1) * 100,
          peakIndex: peakIdx,
          troughIndex: troughIdx,
          recoveryIndex: i,
        });
      }
      peak = v;
      peakIdx = i;
      troughIdx = -1;
      trough = Infinity;
    } else if (v < trough) {
      trough = v;
      troughIdx = i;
    }
  }
  if (troughIdx >= 0 && peak > 0) {
    out.push({
      depthPercent: (trough / peak - 1) * 100,
      peakIndex: peakIdx,
      troughIndex: troughIdx,
      recoveryIndex: null,
    });
  }
  return out.sort((a, b) => a.depthPercent - b.depthPercent);
}

export interface TopDrawdownsOptions {
  /** Episodes to show (default 5). */
  top?: number;
}

/**
 * The deepest drawdown episodes as a table: depth %, peak / trough / recovery
 * dates, and duration in bars (peak → recovery, or → the end while
 * unrecovered, marked `>`). Returns '' when the curve never draws down.
 */
export function topDrawdownsAscii(
  equity: number[],
  times: number[],
  opts: TopDrawdownsOptions = {},
): string {
  if (equity.length !== times.length || equity.length < 2) return '';
  const episodes = drawdownEpisodes(equity).slice(0, Math.max(1, opts.top ?? 5));
  if (episodes.length === 0) return '';

  const header = `   #   DEPTH%  ${'PEAK'.padEnd(10)}  ${'TROUGH'.padEnd(10)}  ${'RECOVERY'.padEnd(10)}  ${'BARS'.padStart(5)}`;
  const rows = episodes.map((e, i) => {
    const bars =
      e.recoveryIndex != null
        ? String(e.recoveryIndex - e.peakIndex).padStart(5)
        : `>${equity.length - 1 - e.peakIndex}`.padStart(5);
    const recovery = e.recoveryIndex != null ? isoDay(times[e.recoveryIndex]!) : '—'.padEnd(10);
    return (
      `  ${String(i + 1).padStart(2)}  ${e.depthPercent.toFixed(2).padStart(6)}%` +
      `  ${isoDay(times[e.peakIndex]!)}  ${isoDay(times[e.troughIndex]!)}  ${recovery.padEnd(10)}  ${bars}`
    );
  });
  return [header, '  ' + '-'.repeat(header.length - 2), ...rows].join('\n');
}

export interface ProfitHistogramOptions {
  /** Bar width in characters at the fullest bucket (default 40). */
  width?: number;
  /** Bucket count (default 9). Zero is always a bucket edge when profits straddle it. */
  buckets?: number;
  /** Color losing buckets red and winning buckets green. Default false. */
  color?: boolean;
}

/**
 * Closed-trade P/L distribution as horizontal ▇ bars, most profitable bucket
 * on top. Zero is forced onto a bucket edge when trades straddle it, so every
 * bucket is purely winning or purely losing. Returns '' with no finite
 * profits.
 */
export function profitHistogramAscii(profits: number[], opts: ProfitHistogramOptions = {}): string {
  const width = Math.max(8, opts.width ?? 40);
  const finite = profits.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return '';

  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const want = Math.max(1, opts.buckets ?? 9);

  // Bucket edges — split at zero so win/loss never share a bucket.
  let edges: number[];
  if (lo >= hi) {
    edges = [lo - 0.5, hi + 0.5];
  } else if (lo < 0 && hi > 0) {
    const nNeg = Math.min(want - 1, Math.max(1, Math.round((want * -lo) / (hi - lo))));
    const nPos = want - nNeg;
    edges = [
      ...Array.from({ length: nNeg }, (_, i) => lo + ((0 - lo) * i) / nNeg),
      ...Array.from({ length: nPos + 1 }, (_, i) => (hi * i) / nPos),
    ];
  } else {
    edges = Array.from({ length: want + 1 }, (_, i) => lo + ((hi - lo) * i) / want);
  }

  const counts = new Array<number>(edges.length - 1).fill(0);
  for (const v of finite) {
    let b = edges.length - 2;
    for (let i = 0; i < edges.length - 1; i++) {
      if (v < edges[i + 1]!) {
        b = i;
        break;
      }
    }
    counts[b]!++;
  }
  const maxCount = Math.max(...counts);

  const labels = counts.map((_, i) => `${fmtVal(edges[i]!)} → ${fmtVal(edges[i + 1]!)}`);
  const labelW = Math.max(...labels.map((l) => l.length));
  const lines: string[] = [];
  for (let i = counts.length - 1; i >= 0; i--) {
    const count = counts[i]!;
    const len = count === 0 ? 0 : Math.max(1, Math.round((count / maxCount) * width));
    const winning = edges[i]! >= 0;
    const losing = edges[i + 1]! <= 0;
    const bar = paint(
      '▇'.repeat(len),
      winning ? GREEN : RED,
      opts.color === true && count > 0 && (winning || losing),
    );
    lines.push(`  ${labels[i]!.padStart(labelW)}  ${bar}${count > 0 ? ` ${count}` : ' 0'}`);
  }
  return lines.join('\n');
}

/**
 * Pairwise per-step return correlation of aligned series as a grid (Pearson,
 * via `returnCorrelation`). Series must share one time axis (align them with
 * `alignEquity` first). Degenerate pairs print `na`. Returns '' with fewer
 * than two series.
 */
export function correlationMatrixAscii(items: { label: string; series: number[] }[]): string {
  if (items.length < 2) return '';
  const labelW = Math.max(...items.map((s) => s.label.length), 5);
  const cellW = Math.max(labelW, 5) + 2;
  const fmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : 'na');

  const header = `  ${' '.repeat(labelW)}${items.map((s) => s.label.padStart(cellW)).join('')}`;
  const rows = items.map((a, i) => {
    const cells = items.map((b, j) => {
      const v = i === j ? 1 : returnCorrelation(a.series, b.series);
      return fmt(v).padStart(cellW);
    });
    return `  ${a.label.padEnd(labelW)}${cells.join('')}`;
  });
  return [header, ...rows].join('\n');
}
