/**
 * Terminal charts — pure string builders (browser-safe, no I/O).
 *
 * `equityChartAscii` draws an equity curve as a braille line chart (each cell
 * is a 2×4 dot grid, so a 64×10-char chart carries 128×40 samples) with an
 * optional dashed initial-capital guide; `priceChartAscii` draws the close
 * series with each trade marked at its fill price (▲/▼ entry by direction,
 * ●/○ exit by win/loss); `drawdownChartAscii` renders the underwater
 * drawdown-% area below it; `sparkline` compresses any series into one row of
 * ▁▂▃▄▅▆▇█ blocks. Monochrome and pipe-safe by default: plain unicode text
 * that survives `> file`, `| less`, and CI logs. The one opt-in exception is
 * `priceChartAscii`'s `color` flag, which wraps the trade markers (only) in
 * ANSI green/red — the CLI enables it only on a TTY, and the win/loss glyphs
 * carry the same information uncolored.
 *
 * The CLI prints these in the tearsheets (disable with `--no-chart`); they
 * are exported for programmatic use on any RunResult-shaped curve.
 */

/** Braille dot bits by [rowInCell 0..3][colInCell 0..1] (U+2800 base). */
const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

const BLOCKS = '▁▂▃▄▅▆▇█';

export interface EquityChartOptions {
  /** Chart width in characters (default 64 → 128 x-samples). */
  width?: number;
  /** Chart height in characters (default 10 → 40 y-levels). */
  height?: number;
  /** Bar times (unix s or ms) — enables the date row under the chart. */
  times?: number[];
  /** Draw a dashed guide at this level (the initial capital). */
  capital?: number;
}

/**
 * Equity curve as a braille line chart with a y-axis gutter (max / capital /
 * min labels), and a date row when `times` are provided. NaN points break the
 * line (a gap, not an interpolation). Returns '' when there are fewer than two
 * finite points to draw.
 */
export function equityChartAscii(equity: number[], opts: EquityChartOptions = {}): string {
  const width = Math.max(16, opts.width ?? 64);
  const height = Math.max(4, opts.height ?? 10);
  const finite = equity.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return '';

  let lo = Math.min(...chunkedMinMax(finite, 'min'));
  let hi = Math.max(...chunkedMinMax(finite, 'max'));
  if (opts.capital != null && Number.isFinite(opts.capital)) {
    lo = Math.min(lo, opts.capital);
    hi = Math.max(hi, opts.capital);
  }
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }

  const grid = new Uint8Array(width * height);
  const slots = width * 2;
  const levels = height * 4;
  const lvl = (v: number): number =>
    Math.min(levels - 1, Math.max(0, Math.round(((hi - v) / (hi - lo)) * (levels - 1))));
  const set = (x: number, y: number): void => {
    const i = (y >> 2) * width + (x >> 1);
    grid[i] = grid[i]! | DOT[y & 3]![x & 1]!;
  };

  // Dashed capital guide first, so the equity line draws over it.
  if (opts.capital != null && Number.isFinite(opts.capital)) {
    const y = lvl(opts.capital);
    for (let x = 0; x < slots; x++) if (x % 6 < 2) set(x, y);
  }

  // The curve: sample one value per x-slot; connect consecutive samples with a
  // vertical run so steep moves stay visually continuous.
  const n = equity.length;
  let prev: number | null = null;
  for (let x = 0; x < slots; x++) {
    const v = equity[Math.round((x * (n - 1)) / (slots - 1))]!;
    if (!Number.isFinite(v)) {
      prev = null;
      continue;
    }
    const y = lvl(v);
    const from = prev == null ? y : Math.min(prev, y);
    const to = prev == null ? y : Math.max(prev, y);
    for (let yy = from; yy <= to; yy++) set(x, yy);
    prev = y;
  }

  // Gutter labels: max on the top row, min on the bottom, the capital on its
  // own row when it doesn't collide with either.
  const labels = new Map<number, string>();
  labels.set(0, fmtMoney(hi));
  labels.set(height - 1, fmtMoney(lo));
  if (opts.capital != null && Number.isFinite(opts.capital)) {
    const row = lvl(opts.capital) >> 2;
    if (!labels.has(row)) labels.set(row, fmtMoney(opts.capital));
  }
  const gutterW = Math.max(...[...labels.values()].map((l) => l.length));

  const lines: string[] = [];
  for (let r = 0; r < height; r++) {
    const label = labels.get(r) ?? '';
    const rail = labels.has(r) ? '┤' : '│';
    let row = '';
    for (let c = 0; c < width; c++) {
      const bits = grid[r * width + c]!;
      row += bits === 0 ? ' ' : String.fromCharCode(0x2800 + bits);
    }
    lines.push(`${label.padStart(gutterW)} ${rail}${row}`);
  }

  pushDateRow(lines, opts.times ?? [], equity.length, width, gutterW);
  return lines.join('\n');
}

/** Date row: first / middle / last bar dates, aligned to the chart columns. */
function pushDateRow(
  lines: string[],
  times: number[],
  points: number,
  width: number,
  gutterW: number,
): void {
  if (times.length !== points || times.length < 2) return;
  const day = (t: number): string => new Date(t >= 1e12 ? t : t * 1000).toISOString().slice(0, 10);
  const left = day(times[0]!);
  const mid = day(times[Math.floor((times.length - 1) / 2)]!);
  const right = day(times[times.length - 1]!);
  const inner = Math.max(width, left.length + mid.length + right.length + 4);
  const midStart = Math.max(
    left.length + 2,
    Math.min(Math.floor((inner - mid.length) / 2), inner - right.length - mid.length - 2),
  );
  const row =
    left +
    ' '.repeat(midStart - left.length) +
    mid +
    ' '.repeat(Math.max(1, inner - midStart - mid.length - right.length)) +
    right;
  lines.push(`${' '.repeat(gutterW)} └${row}`);
}

/** The trade fields a price chart marks — StrategyTrade is assignable as-is. */
export interface PriceChartTrade {
  /** +1 long, -1 short. */
  dir: number;
  entryBar: number;
  exitBar: number;
  entryPrice: number;
  exitPrice: number;
  profit: number;
}

export interface PriceChartOptions {
  /** Chart width in characters (default 64 → 128 x-samples). */
  width?: number;
  /** Chart height in characters (default 10 → 40 y-levels). */
  height?: number;
  /** Bar times (unix s or ms) — enables the date row under the chart. */
  times?: number[];
  /** Closed trades to mark at their fill prices. */
  trades?: PriceChartTrade[];
  /**
   * Wrap the trade markers in ANSI color (entries cyan; exits green = win,
   * red = loss). Default false — the ▲/▼ and ●/○ glyphs carry the same
   * information, so piped output loses nothing.
   */
  color?: boolean;
}

const MARKER = {
  longEntry: '▲',
  shortEntry: '▼',
  winExit: '●',
  lossExit: '○',
} as const;

/**
 * Close-price braille line chart with per-trade markers at the actual fill
 * prices: ▲ long entry / ▼ short entry, ● winning exit / ○ losing exit. When
 * an entry and an exit land on the same cell the exit wins (it carries the
 * P/L). Same layout contract as `equityChartAscii` (y-gutter with max/min
 * price labels, date row when `times` are provided, NaN gaps); returns ''
 * when there are fewer than two finite points.
 */
export function priceChartAscii(closes: number[], opts: PriceChartOptions = {}): string {
  const width = Math.max(16, opts.width ?? 64);
  const height = Math.max(4, opts.height ?? 10);
  const finite = closes.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return '';

  const trades = opts.trades ?? [];
  let lo = Math.min(...chunkedMinMax(finite, 'min'));
  let hi = Math.max(...chunkedMinMax(finite, 'max'));
  for (const t of trades) {
    for (const p of [t.entryPrice, t.exitPrice]) {
      if (Number.isFinite(p)) {
        lo = Math.min(lo, p);
        hi = Math.max(hi, p);
      }
    }
  }
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }

  const grid = new Uint8Array(width * height);
  const slots = width * 2;
  const levels = height * 4;
  const lvl = (v: number): number =>
    Math.min(levels - 1, Math.max(0, Math.round(((hi - v) / (hi - lo)) * (levels - 1))));
  const set = (x: number, y: number): void => {
    const i = (y >> 2) * width + (x >> 1);
    grid[i] = grid[i]! | DOT[y & 3]![x & 1]!;
  };

  // The close line: same sampling and vertical-run connection as the equity chart.
  const n = closes.length;
  let prev: number | null = null;
  for (let x = 0; x < slots; x++) {
    const v = closes[Math.round((x * (n - 1)) / (slots - 1))]!;
    if (!Number.isFinite(v)) {
      prev = null;
      continue;
    }
    const y = lvl(v);
    const from = prev == null ? y : Math.min(prev, y);
    const to = prev == null ? y : Math.max(prev, y);
    for (let yy = from; yy <= to; yy++) set(x, yy);
    prev = y;
  }

  // Trade markers replace whole cells (a marker is a printable char, not a
  // braille dot). Entries first, exits second so an exit wins a collision.
  const paint = (glyph: string, ansi: number): string =>
    opts.color ? `\x1b[${ansi}m${glyph}\x1b[39m` : glyph;
  const cellOf = (bar: number, price: number): number => {
    const col = Math.min(width - 1, Math.max(0, Math.round((bar * (slots - 1)) / (n - 1)) >> 1));
    return (lvl(price) >> 2) * width + col;
  };
  const markers = new Map<number, string>();
  for (const t of trades) {
    if (!Number.isFinite(t.entryPrice) || !Number.isFinite(t.entryBar)) continue;
    const glyph = t.dir < 0 ? MARKER.shortEntry : MARKER.longEntry;
    markers.set(cellOf(t.entryBar, t.entryPrice), paint(glyph, 36));
  }
  for (const t of trades) {
    if (!Number.isFinite(t.exitPrice) || !Number.isFinite(t.exitBar)) continue;
    const win = t.profit >= 0;
    markers.set(
      cellOf(t.exitBar, t.exitPrice),
      paint(win ? MARKER.winExit : MARKER.lossExit, win ? 32 : 31),
    );
  }

  const labels = new Map<number, string>([
    [0, fmtPrice(hi)],
    [height - 1, fmtPrice(lo)],
  ]);
  const gutterW = Math.max(...[...labels.values()].map((l) => l.length));

  const lines: string[] = [];
  for (let r = 0; r < height; r++) {
    const label = labels.get(r) ?? '';
    const rail = labels.has(r) ? '┤' : '│';
    let row = '';
    for (let c = 0; c < width; c++) {
      const marker = markers.get(r * width + c);
      if (marker != null) {
        row += marker;
        continue;
      }
      const bits = grid[r * width + c]!;
      row += bits === 0 ? ' ' : String.fromCharCode(0x2800 + bits);
    }
    lines.push(`${label.padStart(gutterW)} ${rail}${row}`);
  }

  pushDateRow(lines, opts.times ?? [], closes.length, width, gutterW);
  return lines.join('\n');
}

/**
 * Underwater drawdown-% area (running-peak reduction of the equity curve, the
 * same presentation series the HTML plot shades). 0 sits on the top row; the
 * floor label is the deepest drawdown. Returns '' for fewer than two points.
 */
export function drawdownChartAscii(
  equity: number[],
  opts: { width?: number; height?: number } = {},
): string {
  const width = Math.max(16, opts.width ?? 64);
  const height = Math.max(2, opts.height ?? 4);
  const finite = equity.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return '';

  // Per-point underwater %, NaN points carrying the previous depth.
  const dd: number[] = [];
  let peak = -Infinity;
  for (const v of equity) {
    if (Number.isFinite(v)) peak = Math.max(peak, v);
    dd.push(peak > 0 && Number.isFinite(v) ? (v / peak - 1) * 100 : (dd[dd.length - 1] ?? 0));
  }
  const floor = Math.min(...chunkedMinMax(dd, 'min'));
  const lo = floor === 0 ? -1 : floor;

  const grid = new Uint8Array(width * height);
  const slots = width * 2;
  const levels = height * 4;
  const lvl = (v: number): number =>
    Math.min(levels - 1, Math.max(0, Math.round((v / lo) * (levels - 1))));
  const n = dd.length;
  for (let x = 0; x < slots; x++) {
    const v = dd[Math.round((x * (n - 1)) / (slots - 1))]!;
    // filled area: every level from the 0-line down to the current depth
    for (let yy = 0; yy <= lvl(v); yy++) {
      const i = (yy >> 2) * width + (x >> 1);
      grid[i] = grid[i]! | DOT[yy & 3]![x & 1]!;
    }
  }

  const labels = new Map<number, string>([
    [0, '0%'],
    [height - 1, `${floor >= -9.995 ? floor.toFixed(2) : floor.toFixed(1)}%`],
  ]);
  const gutterW = Math.max(...[...labels.values()].map((l) => l.length));
  const lines: string[] = [];
  for (let r = 0; r < height; r++) {
    let row = '';
    for (let c = 0; c < width; c++) {
      const bits = grid[r * width + c]!;
      row += bits === 0 ? ' ' : String.fromCharCode(0x2800 + bits);
    }
    lines.push(`${(labels.get(r) ?? '').padStart(gutterW)} ${labels.has(r) ? '┤' : '│'}${row}`);
  }
  return lines.join('\n');
}

export interface RollingSharpeChartOptions {
  /** Chart width in characters (default 64). */
  width?: number;
  /** Chart height in characters (default 4). */
  height?: number;
  /** Bar times (unix s or ms) — enables the date row under the chart. */
  times?: number[];
  /** Return window in bars. Defaults to `adaptiveRollingSharpeWindow`. */
  window?: number;
  /** Return observations per year for annualization. Default 1 (unannualized). */
  periodsPerYear?: number;
  /** Annual risk-free rate as a fraction. Default 0. */
  riskFreeRate?: number;
}

/**
 * Adaptive bar-count window for rolling Sharpe. With a valid annualization
 * factor, target one empirical year of returns, capped at one fifth of the
 * longest contiguous history so the chart still has enough rolling points.
 * Without one, retain the compact 14–30-bar fallback for unannualized callers.
 * Returns undefined when fewer than 15 contiguous finite returns are available.
 */
export function adaptiveRollingSharpeWindow(
  equity: number[],
  periodsPerYear?: number,
): number | undefined {
  let run = 0;
  let longest = 0;
  for (let i = 1; i < equity.length; i++) {
    const previous = equity[i - 1]!;
    const current = equity[i]!;
    if (Number.isFinite(previous) && previous !== 0 && Number.isFinite(current)) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  if (longest < 15) return undefined;

  const historyWindow = Math.max(14, Math.round(longest / 5));
  const annualWindow =
    periodsPerYear != null && Number.isFinite(periodsPerYear) && periodsPerYear > 0
      ? Math.max(14, Math.round(periodsPerYear))
      : 30;
  return Math.min(longest - 1, historyWindow, annualWindow);
}

/** Compact label for a Sharpe axis. */
function fmtSharpe(value: number): string {
  const magnitude = Math.abs(value);
  return value.toFixed(magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2);
}

/**
 * Rolling annualized Sharpe as a braille line with a dashed zero guide. Returns
 * '' when the curve cannot produce at least two finite rolling observations.
 * The default adaptive window is bar-count based, not calendar based, so short
 * backtests and different timeframes use the data they actually contain.
 */
export function rollingSharpeAscii(equity: number[], opts: RollingSharpeChartOptions = {}): string {
  const width = Math.max(16, opts.width ?? 64);
  const height = Math.max(2, opts.height ?? 4);
  const periodsPerYear =
    opts.periodsPerYear != null && Number.isFinite(opts.periodsPerYear) && opts.periodsPerYear > 0
      ? opts.periodsPerYear
      : 1;
  const adaptive = adaptiveRollingSharpeWindow(equity, opts.periodsPerYear);
  const window = Math.floor(opts.window ?? adaptive ?? 0);
  if (window < 2) return '';

  const annualRiskFree =
    opts.riskFreeRate != null && Number.isFinite(opts.riskFreeRate) ? opts.riskFreeRate : 0;
  const periodRiskFree =
    annualRiskFree > -1 ? Math.pow(1 + annualRiskFree, 1 / periodsPerYear) - 1 : 0;

  const values = new Array<number>(equity.length).fill(NaN);
  // A ring buffer keeps updates O(1). Intraday annualization can select tens of
  // thousands of observations; Array.shift() would move that entire window on
  // every bar and turn chart rendering quadratic.
  const queue = new Float64Array(window);
  let queueLength = 0;
  let queueIndex = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let i = 1; i < equity.length; i++) {
    const previous = equity[i - 1]!;
    const current = equity[i]!;
    if (!Number.isFinite(previous) || previous === 0 || !Number.isFinite(current)) {
      queueLength = 0;
      queueIndex = 0;
      sum = 0;
      sumSquares = 0;
      continue;
    }

    const excess = current / previous - 1 - periodRiskFree;
    if (queueLength < window) {
      queue[queueLength] = excess;
      queueLength += 1;
      sum += excess;
      sumSquares += excess * excess;
    } else {
      const removed = queue[queueIndex]!;
      sum -= removed;
      sumSquares -= removed * removed;
      queue[queueIndex] = excess;
      queueIndex = (queueIndex + 1) % window;
      sum += excess;
      sumSquares += excess * excess;
    }
    if (queueLength !== window) continue;

    const mean = sum / window;
    const variance = Math.max(0, (sumSquares - (sum * sum) / window) / (window - 1));
    if (variance > 1e-24) values[i] = (mean / Math.sqrt(variance)) * Math.sqrt(periodsPerYear);
  }

  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return '';
  let lo = Math.min(0, ...chunkedMinMax(finite, 'min'));
  let hi = Math.max(0, ...chunkedMinMax(finite, 'max'));
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }

  const grid = new Uint8Array(width * height);
  const slots = width * 2;
  const levels = height * 4;
  const lvl = (value: number): number =>
    Math.min(levels - 1, Math.max(0, Math.round(((hi - value) / (hi - lo)) * (levels - 1))));
  const set = (x: number, y: number): void => {
    const index = (y >> 2) * width + (x >> 1);
    grid[index] = grid[index]! | DOT[y & 3]![x & 1]!;
  };

  const zeroLevel = lvl(0);
  for (let x = 0; x < slots; x++) if (x % 6 < 2) set(x, zeroLevel);

  let previousLevel: number | null = null;
  for (let x = 0; x < slots; x++) {
    const value = values[Math.round((x * (values.length - 1)) / (slots - 1))]!;
    if (!Number.isFinite(value)) {
      previousLevel = null;
      continue;
    }
    const level = lvl(value);
    const from = previousLevel == null ? level : Math.min(previousLevel, level);
    const to = previousLevel == null ? level : Math.max(previousLevel, level);
    for (let y = from; y <= to; y++) set(x, y);
    previousLevel = level;
  }

  const labels = new Map<number, string>([
    [0, fmtSharpe(hi)],
    [height - 1, fmtSharpe(lo)],
  ]);
  const zeroRow = zeroLevel >> 2;
  if (!labels.has(zeroRow)) labels.set(zeroRow, '0.00');
  const gutterW = Math.max(...[...labels.values()].map((label) => label.length));
  const lines: string[] = [];
  for (let rowIndex = 0; rowIndex < height; rowIndex++) {
    let row = '';
    for (let column = 0; column < width; column++) {
      const bits = grid[rowIndex * width + column]!;
      row += bits === 0 ? ' ' : String.fromCharCode(0x2800 + bits);
    }
    lines.push(
      `${(labels.get(rowIndex) ?? '').padStart(gutterW)} ${labels.has(rowIndex) ? '┤' : '│'}${row}`,
    );
  }
  pushDateRow(lines, opts.times ?? [], equity.length, width, gutterW);
  return lines.join('\n');
}

/**
 * One-row ▁▂▃▄▅▆▇█ sparkline of any series, `width` characters wide. A flat
 * series renders as its baseline; NaN samples print a space.
 */
export function sparkline(values: number[], width = 40): string {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return ' '.repeat(width);
  const lo = Math.min(...chunkedMinMax(finite, 'min'));
  const hi = Math.max(...chunkedMinMax(finite, 'max'));
  const n = values.length;
  let out = '';
  for (let x = 0; x < width; x++) {
    const v = values[n === 1 ? 0 : Math.round((x * (n - 1)) / (width - 1))]!;
    if (!Number.isFinite(v)) {
      out += ' ';
      continue;
    }
    const t = hi === lo ? 0 : (v - lo) / (hi - lo);
    out += BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(t * BLOCKS.length))]!;
  }
  return out;
}

export interface OverlayChartOptions {
  /** Chart width in characters (default 64 → 128 x-samples). */
  width?: number;
  /** Chart height in characters (default 10 → 40 y-levels). */
  height?: number;
  /** Bar times (unix s or ms), shared by both series — enables the date row. */
  times?: number[];
  /** Draw a dashed guide at this level (e.g. 0 for the %-return baseline). */
  guide?: number;
  /**
   * Color series A cyan and series B yellow (cells both series cross stay
   * default). Without color the two lines merge into one monochrome shape —
   * callers that must stay pipe-safe should print two separate charts instead.
   */
  color?: boolean;
  /** Format a gutter label (default: fmtMoney). */
  fmtLabel?: (v: number) => string;
}

/**
 * Two series overlaid on one braille chart with a shared y-scale — the
 * comparison view (`pinerun compare`). Same layout contract as
 * `equityChartAscii`; returns '' when neither series has two finite points.
 */
export function overlayChartAscii(
  a: number[],
  b: number[],
  opts: OverlayChartOptions = {},
): string {
  const width = Math.max(16, opts.width ?? 64);
  const height = Math.max(4, opts.height ?? 10);
  const finite = [...a, ...b].filter((v) => Number.isFinite(v));
  if (finite.length < 2) return '';

  let lo = Math.min(...chunkedMinMax(finite, 'min'));
  let hi = Math.max(...chunkedMinMax(finite, 'max'));
  if (opts.guide != null && Number.isFinite(opts.guide)) {
    lo = Math.min(lo, opts.guide);
    hi = Math.max(hi, opts.guide);
  }
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }

  const grid = new Uint8Array(width * height);
  // Cell ownership bitmask: 1 = series A inked it, 2 = B, 3 = both.
  const owner = new Uint8Array(width * height);
  const slots = width * 2;
  const levels = height * 4;
  const lvl = (v: number): number =>
    Math.min(levels - 1, Math.max(0, Math.round(((hi - v) / (hi - lo)) * (levels - 1))));
  const set = (x: number, y: number, who: number): void => {
    const i = (y >> 2) * width + (x >> 1);
    grid[i] = grid[i]! | DOT[y & 3]![x & 1]!;
    owner[i] = owner[i]! | who;
  };

  if (opts.guide != null && Number.isFinite(opts.guide)) {
    const y = lvl(opts.guide);
    for (let x = 0; x < slots; x++) if (x % 6 < 2) set(x, y, 0);
  }

  const drawSeries = (series: number[], who: number): void => {
    const n = series.length;
    if (n < 2) return;
    let prev: number | null = null;
    for (let x = 0; x < slots; x++) {
      const v = series[Math.round((x * (n - 1)) / (slots - 1))]!;
      if (!Number.isFinite(v)) {
        prev = null;
        continue;
      }
      const y = lvl(v);
      const from = prev == null ? y : Math.min(prev, y);
      const to = prev == null ? y : Math.max(prev, y);
      for (let yy = from; yy <= to; yy++) set(x, yy, who);
      prev = y;
    }
  };
  drawSeries(a, 1);
  drawSeries(b, 2);

  const fmt = opts.fmtLabel ?? fmtMoney;
  const labels = new Map<number, string>([
    [0, fmt(hi)],
    [height - 1, fmt(lo)],
  ]);
  if (opts.guide != null && Number.isFinite(opts.guide)) {
    const row = lvl(opts.guide) >> 2;
    if (!labels.has(row)) labels.set(row, fmt(opts.guide));
  }
  const gutterW = Math.max(...[...labels.values()].map((l) => l.length));

  const CYAN = 36;
  const YELLOW = 33;
  const lines: string[] = [];
  for (let r = 0; r < height; r++) {
    const label = labels.get(r) ?? '';
    const rail = labels.has(r) ? '┤' : '│';
    let row = '';
    for (let c = 0; c < width; c++) {
      const bits = grid[r * width + c]!;
      if (bits === 0) {
        row += ' ';
        continue;
      }
      const ch = String.fromCharCode(0x2800 + bits);
      const who = owner[r * width + c]!;
      row +=
        opts.color === true && (who === 1 || who === 2)
          ? `\x1b[${who === 1 ? CYAN : YELLOW}m${ch}\x1b[39m`
          : ch;
    }
    lines.push(`${label.padStart(gutterW)} ${rail}${row}`);
  }

  pushDateRow(lines, opts.times ?? [], Math.max(a.length, b.length), width, gutterW);
  return lines.join('\n');
}

/** Price label: grouped whole ≥ 1000, cents ≥ 1, 4 significant digits below. */
function fmtPrice(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return fmtMoney(v);
  if (a >= 1) return v.toFixed(2);
  return v.toPrecision(4);
}

/** en-US-grouped whole number — deterministic across host locales. */
function fmtMoney(v: number): string {
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

/** min/max over a possibly huge array without spreading past the arg limit. */
function chunkedMinMax(values: number[], kind: 'min' | 'max'): number[] {
  const out: number[] = [];
  const f = kind === 'min' ? Math.min : Math.max;
  for (let i = 0; i < values.length; i += 4096) {
    out.push(f.apply(null, values.slice(i, i + 4096) as unknown as number[]));
  }
  return out;
}
