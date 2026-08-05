/**
 * Tearsheet tables — pure string builders (browser-safe, no I/O).
 *
 * `monthlyReturnsAscii` renders the classic year × month % grid off an equity
 * curve; `monthlyTradesAscii` tallies closed trades per exit month in the same
 * grid; `topDrawdownsAscii` tables the deepest peak→trough→recovery episodes;
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

export interface MonthlyTradesOptions {
  /** Paint win tallies green and loss tallies red. Default false. */
  color?: boolean;
}

interface MonthTradeTally {
  wins: number;
  losses: number;
  evens: number;
}

/**
 * Year × month closed-trade tally grid in the MONTHLY RETURNS layout. Each
 * trade counts toward its exit month (UTC) — the month its P/L is realized,
 * matching the equity-based returns grid. Cells list only nonzero tallies as
 * bare counts in wins/losses/evens order (`5/3`, `5/2/1`), told apart by
 * color: wins green, losses red, evens uncolored. Months without closed
 * trades print `·`, and the YEAR column totals the row. Returns '' when no
 * trade has a finite profit and exit time.
 */
export function monthlyTradesAscii(
  trades: readonly { profit: number; exitTime: number }[],
  opts: MonthlyTradesOptions = {},
): string {
  const byYear = new Map<number, MonthTradeTally[]>();
  for (const trade of trades) {
    if (!Number.isFinite(trade.profit) || !Number.isFinite(trade.exitTime)) continue;
    const d = new Date(toMs(trade.exitTime));
    let row = byYear.get(d.getUTCFullYear());
    if (!row) {
      row = Array.from({ length: 12 }, () => ({ wins: 0, losses: 0, evens: 0 }));
      byYear.set(d.getUTCFullYear(), row);
    }
    const tally = row[d.getUTCMonth()]!;
    if (trade.profit > 0) tally.wins++;
    else if (trade.profit < 0) tally.losses++;
    else tally.evens++;
  }
  if (byYear.size === 0) return '';

  const color = opts.color === true;
  const cellParts = (t: MonthTradeTally): { plain: string; painted: string } | undefined => {
    const segments: [count: number, ansi?: number][] = [
      [t.wins, GREEN],
      [t.losses, RED],
      [t.evens],
    ];
    const present = segments.filter(([count]) => count > 0);
    if (present.length === 0) return undefined;
    return {
      plain: present.map(([count]) => String(count)).join('/'),
      painted: present
        .map(([count, ansi]) =>
          ansi === undefined ? String(count) : paint(String(count), ansi, color),
        )
        .join('/'),
    };
  };

  const years = [...byYear.keys()];
  const rows: {
    year: number;
    months: (ReturnType<typeof cellParts> | undefined)[];
    total: ReturnType<typeof cellParts> | undefined;
  }[] = [];
  for (let year = Math.min(...years); year <= Math.max(...years); year++) {
    const row = byYear.get(year);
    const totals = { wins: 0, losses: 0, evens: 0 };
    for (const t of row ?? []) {
      totals.wins += t.wins;
      totals.losses += t.losses;
      totals.evens += t.evens;
    }
    rows.push({
      year,
      months: Array.from({ length: 12 }, (_, m) => (row ? cellParts(row[m]!) : undefined)),
      total: cellParts(totals),
    });
  }

  const widest = (cells: (ReturnType<typeof cellParts> | undefined)[]): number =>
    Math.max(1, ...cells.map((c) => (c ? c.plain.length : 0)));
  const cellW = Math.max(7, widest(rows.flatMap((r) => r.months)) + 2);
  const yearW = Math.max(cellW + 2, widest(rows.map((r) => r.total)) + 2);
  // Pad BEFORE painting so ANSI codes never disturb the column alignment.
  const cell = (c: ReturnType<typeof cellParts> | undefined, w: number): string =>
    c === undefined ? '·'.padStart(w) : ' '.repeat(w - c.plain.length) + c.painted;

  const lines: string[] = [];
  lines.push(
    `      ${MONTH_LABELS.map((m) => m.padStart(cellW)).join('')}${'YEAR'.padStart(yearW)}`,
  );
  for (const r of rows) {
    const cells = r.months.map((c) => cell(c, cellW));
    lines.push(`  ${r.year}${cells.join('')}${cell(r.total, yearW)}`);
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

export interface TradeDiagnosticOptions {
  /** Total output width (default 40, minimum 28). */
  width?: number;
  /** Maximum output rows (default 5 for buckets, 7 for density). */
  height?: number;
  /** Paint positive/negative outcomes green/red. Default false. */
  color?: boolean;
}

/** Compact number for bucket boundaries and counts. */
function compactNumber(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000)
    return `${(value / 1_000_000).toFixed(magnitude < 10_000_000 ? 1 : 0)}m`;
  if (magnitude >= 1_000) return `${(value / 1_000).toFixed(magnitude < 10_000 ? 1 : 0)}k`;
  return String(Math.round(value));
}

/** Compact deterministic percentage, optionally showing a positive sign. */
function diagnosticPercent(value: number, signed = false): string {
  const normalized = Math.abs(value) < 0.005 ? 0 : value;
  const magnitude = Math.abs(normalized);
  let number: string;
  if (magnitude >= 1_000) number = `${(magnitude / 1_000).toFixed(magnitude < 10_000 ? 1 : 0)}k`;
  else number = magnitude.toFixed(magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2);
  const sign = normalized < 0 ? '-' : signed && normalized > 0 ? '+' : '';
  return `${sign}${number}%`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor((sorted.length - 1) * Math.max(0, Math.min(1, quantile)));
  return sorted[index]!;
}

/**
 * Holding-time quantile buckets with median realized return, win rate, sample
 * count, and a median-magnitude bar. Equal durations are never split between
 * buckets, and the final open-ended bucket prevents one very long trade from
 * stretching an axis. Returns '' when no trade has finite duration and return.
 */
export function durationReturnAscii(
  trades: readonly {
    entryPrice: number;
    qty: number;
    entryBar: number;
    exitBar: number;
    profit: number;
  }[],
  opts: TradeDiagnosticOptions = {},
): string {
  const observations: { duration: number; returnPercent: number; profit: number }[] = [];
  for (const trade of trades) {
    const notional = Math.abs(trade.entryPrice * trade.qty);
    const duration = trade.exitBar - trade.entryBar;
    if (
      !Number.isFinite(notional) ||
      notional <= 0 ||
      !Number.isFinite(duration) ||
      duration < 0 ||
      !Number.isFinite(trade.profit)
    ) {
      continue;
    }
    observations.push({
      duration,
      returnPercent: (trade.profit / notional) * 100,
      profit: trade.profit,
    });
  }
  if (observations.length === 0) return '';
  observations.sort((a, b) => a.duration - b.duration);

  const width = Math.max(28, Math.floor(opts.width ?? 40));
  const wanted = Math.min(5, Math.max(1, Math.floor(opts.height ?? 5)), observations.length);
  const cuts: number[] = [];
  for (let i = 1; i <= wanted; i++) {
    const index = Math.min(
      observations.length - 1,
      Math.ceil((i * observations.length) / wanted) - 1,
    );
    const cut = observations[index]!.duration;
    if (cuts[cuts.length - 1] !== cut) cuts.push(cut);
  }

  const buckets = cuts.map(() => [] as typeof observations);
  for (const observation of observations) {
    let bucket = cuts.findIndex((cut) => observation.duration <= cut);
    if (bucket < 0) bucket = cuts.length - 1;
    buckets[bucket]!.push(observation);
  }

  const rows = buckets.map((bucket, index) => {
    const previous = index === 0 ? undefined : cuts[index - 1]!;
    const lower = bucket[0]!.duration;
    const upper = cuts[index]!;
    let label: string;
    if (cuts.length === 1) label = `${compactNumber(lower)}+`;
    else if (index === cuts.length - 1) label = `>${compactNumber(previous!)}`;
    else if (lower === upper) label = compactNumber(upper);
    else label = `${compactNumber(lower)}–${compactNumber(upper)}`;
    if (label.length > 8)
      label = index === 0 ? `≤${compactNumber(upper)}` : `>${compactNumber(previous!)}`;

    const med = median(bucket.map((item) => item.returnPercent));
    const wins = bucket.filter((item) => item.profit > 0).length;
    return {
      label,
      median: med,
      returnText: diagnosticPercent(med, true),
      winText: `${Math.round((wins / bucket.length) * 100)}%`,
      countText: `n${compactNumber(bucket.length)}`,
    };
  });
  // Display duration as a vertical magnitude axis: longest holds at the top,
  // shortest at the bottom, matching the tearsheet's top-to-bottom ordering.
  rows.reverse();

  const labelW = Math.max(...rows.map((row) => row.label.length));
  const returnW = Math.max(...rows.map((row) => row.returnText.length));
  const winW = Math.max(...rows.map((row) => row.winText.length));
  const countW = Math.max(...rows.map((row) => row.countText.length));
  const fixedWidth = labelW + returnW + winW + countW + 4;
  const barW = Math.max(0, width - fixedWidth);
  const maxMedian = Math.max(...rows.map((row) => Math.abs(row.median)));

  return rows
    .map((row) => {
      const barLength =
        barW === 0 || row.median === 0 || maxMedian === 0
          ? 0
          : Math.max(1, Math.round((Math.abs(row.median) / maxMedian) * barW));
      const ansi = row.median >= 0 ? GREEN : RED;
      const returnCell = paint(
        row.returnText.padStart(returnW),
        ansi,
        opts.color === true && row.median !== 0,
      );
      const barCell = paint(
        '▇'.repeat(barLength).padEnd(barW),
        ansi,
        opts.color === true && row.median !== 0 && barW > 0,
      );
      return `${row.label.padStart(labelW)} ${returnCell} ${barCell} ${row.winText.padStart(winW)} ${row.countText.padStart(countW)}`;
    })
    .join('\n');
}

interface DensityCell {
  count: number;
  wins: number;
  losses: number;
}

/**
 * MAE/MFE density heatmap. Both axes are percentages of absolute entry
 * notional and clamp at their 95th percentile, so rare excursions accumulate
 * in edge cells instead of flattening the useful population. `░▒▓█` encodes
 * log-scaled density; color shows the cell's majority realized outcome.
 */
export function maeMfeAscii(
  trades: readonly {
    entryPrice: number;
    qty: number;
    profit: number;
    maxRunup: number;
    maxDrawdown: number;
  }[],
  opts: TradeDiagnosticOptions = {},
): string {
  const observations: { mae: number; mfe: number; profit: number }[] = [];
  for (const trade of trades) {
    const notional = Math.abs(trade.entryPrice * trade.qty);
    if (
      !Number.isFinite(notional) ||
      notional <= 0 ||
      !Number.isFinite(trade.profit) ||
      !Number.isFinite(trade.maxRunup) ||
      trade.maxRunup < 0 ||
      !Number.isFinite(trade.maxDrawdown) ||
      trade.maxDrawdown < 0
    ) {
      continue;
    }
    observations.push({
      mae: (trade.maxDrawdown / notional) * 100,
      mfe: (trade.maxRunup / notional) * 100,
      profit: trade.profit,
    });
  }
  if (observations.length === 0) return '';

  const width = Math.max(28, Math.floor(opts.width ?? 40));
  const height = Math.max(4, Math.floor(opts.height ?? 7));
  const plotRows = height - 1;
  const rawMaeCap = percentile(
    observations.map((item) => item.mae),
    0.95,
  );
  const rawMfeCap = percentile(
    observations.map((item) => item.mfe),
    0.95,
  );
  const maeCap = rawMaeCap > 0 ? rawMaeCap : Math.max(1, ...observations.map((item) => item.mae));
  const mfeCap = rawMfeCap > 0 ? rawMfeCap : Math.max(1, ...observations.map((item) => item.mfe));
  const topLabel = diagnosticPercent(mfeCap);
  const bottomLabel = diagnosticPercent(0);
  const labelW = Math.max(topLabel.length, bottomLabel.length);
  const plotW = Math.max(8, width - labelW - 1);
  const grid = Array.from({ length: plotRows }, () =>
    Array.from({ length: plotW }, (): DensityCell => ({ count: 0, wins: 0, losses: 0 })),
  );

  for (const observation of observations) {
    const col = Math.min(
      plotW - 1,
      Math.round((Math.min(observation.mae, maeCap) / maeCap) * (plotW - 1)),
    );
    const row = Math.min(
      plotRows - 1,
      Math.round((1 - Math.min(observation.mfe, mfeCap) / mfeCap) * (plotRows - 1)),
    );
    const cell = grid[row]![col]!;
    cell.count += 1;
    if (observation.profit > 0) cell.wins += 1;
    else if (observation.profit < 0) cell.losses += 1;
  }

  const maxCount = Math.max(...grid.flat().map((cell) => cell.count));
  const density = ['░', '▒', '▓', '█'] as const;
  const lines = grid.map((row, rowIndex) => {
    const label = rowIndex === 0 ? topLabel : rowIndex === plotRows - 1 ? bottomLabel : '';
    const cells = row.map((cell) => {
      if (cell.count === 0) return ' ';
      const scaled = Math.log1p(cell.count) / Math.log1p(maxCount);
      const glyph =
        density[Math.max(0, Math.min(density.length - 1, Math.ceil(scaled * density.length) - 1))]!;
      const majority = Math.sign(cell.wins - cell.losses);
      return paint(glyph, majority >= 0 ? GREEN : RED, opts.color === true && majority !== 0);
    });
    return `${label.padStart(labelW)}│${cells.join('')}`;
  });
  const caption = `MAE p95 ${diagnosticPercent(maeCap)}`.slice(0, plotW).padEnd(plotW);
  lines.push(`${' '.repeat(labelW)}└${caption}`);
  return lines.join('\n');
}
