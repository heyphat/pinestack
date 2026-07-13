/**
 * Trade / equity / sweep export — pure string builders (browser-safe, no I/O).
 *
 * `tradesToCsv` / `equityToCsv` / `sweepPointsToCsv` produce RFC 4180 CSV ready
 * for pandas / Excel; `equityPlotHtml` renders a self-contained HTML page
 * (inline SVG, no external assets) with the equity curve and an underwater
 * drawdown chart; `sweepHeatmap` renders the classic 2-axis optimization
 * surface as a text grid. The CLI writes these behind `--csv` / `--plot` /
 * `--points-csv` / `--heatmap`; programmatic callers get the strings.
 *
 * Times are emitted as ISO 8601 UTC. Inputs may carry unix seconds (pinery bars)
 * or milliseconds (piner trade fills) — both are detected and normalized.
 */
import type { RunResult, StrategyTrade } from './result.js';
import type { SweepPoint, SweepReport } from './sweep.js';

const TRADE_COLUMNS = [
  'symbol',
  'entryId',
  'dir',
  'qty',
  'entryPrice',
  'exitPrice',
  'entryBar',
  'exitBar',
  'entryTime',
  'exitTime',
  'profit',
  'cumProfit',
  'commission',
  'maxRunup',
  'maxDrawdown',
] as const;

/** Closed-trade ledger as CSV (header only when the result carries no trades). */
export function tradesToCsv(result: RunResult): string {
  const rows = (result.trades ?? []).map((t: StrategyTrade) =>
    [
      // portfolio-merged ledgers tag each row with its sleeve; plain runs fall
      // back to the result's own symbol
      csvCell(t.symbol ?? result.symbol),
      csvCell(t.entryId),
      String(t.dir),
      String(t.qty),
      String(t.entryPrice),
      String(t.exitPrice),
      String(t.entryBar),
      String(t.exitBar),
      isoTime(t.entryTime),
      isoTime(t.exitTime),
      String(t.profit),
      String(t.cumProfit),
      String(t.commission),
      String(t.maxRunup),
      String(t.maxDrawdown),
    ].join(','),
  );
  return [TRADE_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

/**
 * Per-bar equity curve as CSV: `bar,time,equity`. Every bar is emitted; bars
 * before the strategy activated (sparse holes in piner's curve) get an empty
 * equity cell, which pandas reads as NaN. `time` is empty when the result
 * carries no `barTimes`.
 */
export function equityToCsv(result: RunResult): string {
  const equity = result.equityCurve ?? [];
  const times = result.barTimes ?? [];
  const n = Math.max(equity.length, times.length);
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = times[i] != null ? isoTime(times[i]!) : '';
    const e = equity[i] != null && Number.isFinite(equity[i]!) ? String(equity[i]!) : '';
    rows.push(`${i},${t},${e}`);
  }
  return ['bar,time,equity', ...rows].join('\n') + '\n';
}

/**
 * Self-contained HTML page: equity curve (with initial-capital reference and
 * per-trade exit markers) over an underwater drawdown-percent chart. Pure
 * presentation — the drawdown series is the standard running-peak reduction of
 * the equity curve, no strategy math beyond what display requires.
 */
export function equityPlotHtml(result: RunResult, opts: { title?: string } = {}): string {
  const equity = result.equityCurve ?? [];
  const times = result.barTimes ?? [];
  const points: { bar: number; equity: number }[] = [];
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i];
    if (v != null && Number.isFinite(v)) points.push({ bar: i, equity: v });
  }

  const s = result.strategy;
  const title = opts.title ?? `${result.symbol} — equity`;
  // B&H is omitted when zero: a portfolio has no single-asset benchmark (piner
  // leaves `bars` unset → 0), and "B&H 0.00%" reads as data rather than absence.
  const bh = s?.metrics.buyHoldReturnPercent;
  const subtitle = s
    ? `net ${fmt(s.netProfitPercent)}%  ·  max DD ${fmt(s.maxDrawdownPercent)}%  ·  ` +
      `${s.closedTrades} trades  ·  Sharpe ${fmt(s.metrics.sharpe)}` +
      (bh != null && Number.isFinite(bh) && bh !== 0 ? `  ·  B&H ${fmt(bh)}%` : '')
    : '';

  if (points.length < 2) {
    return htmlShell(title, `<p class="empty">No equity data (fewer than 2 points).</p>`);
  }

  // Layout.
  const W = 960;
  const EQ_H = 320;
  const DD_H = 140;
  const M = { top: 16, right: 16, bottom: 26, left: 64 };
  const plotW = W - M.left - M.right;

  // Scales over bar index (x) shared by both charts.
  const x0 = points[0]!.bar;
  const x1 = points[points.length - 1]!.bar;
  const sx = (bar: number): number => M.left + ((bar - x0) / Math.max(1, x1 - x0)) * plotW;

  // Equity y-scale, padded, including the initial-capital reference when present.
  // Loop rather than spread: a multi-year curve can exceed the argument limit.
  let eqMin = Infinity;
  let eqMax = -Infinity;
  for (const p of points) {
    if (p.equity < eqMin) eqMin = p.equity;
    if (p.equity > eqMax) eqMax = p.equity;
  }
  if (s) {
    eqMin = Math.min(eqMin, s.initialCapital);
    eqMax = Math.max(eqMax, s.initialCapital);
  }
  const eqPad = (eqMax - eqMin || 1) * 0.06;
  eqMin -= eqPad;
  eqMax += eqPad;
  const syEq = (v: number): number =>
    M.top + (1 - (v - eqMin) / (eqMax - eqMin)) * (EQ_H - M.top - M.bottom);

  // Underwater drawdown % from the running equity peak (presentation-only).
  let peak = -Infinity;
  const dd = points.map((p) => {
    peak = Math.max(peak, p.equity);
    return { bar: p.bar, dd: peak > 0 ? (p.equity / peak - 1) * 100 : 0 };
  });
  let ddMin = 0;
  for (const d of dd) if (d.dd < ddMin) ddMin = d.dd;
  const ddFloor = ddMin === 0 ? -1 : ddMin * 1.08;
  const syDd = (v: number): number => (v / ddFloor) * (DD_H - M.bottom - 4) + 4;

  const eqPath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(sx(p.bar))},${fmt(syEq(p.equity))}`)
    .join('');
  const ddArea =
    `M${fmt(sx(dd[0]!.bar))},${fmt(syDd(0))}` +
    dd.map((d) => `L${fmt(sx(d.bar))},${fmt(syDd(d.dd))}`).join('') +
    `L${fmt(sx(dd[dd.length - 1]!.bar))},${fmt(syDd(0))}Z`;

  // Per-trade exit markers on the equity curve, green/red by profit sign.
  // Located by exit TIME against barTimes when present: a portfolio's merged
  // ledger carries sleeve-local exitBar values, which are NOT indices into the
  // master-clock curve (2026-07-09 audit #3). For a single-symbol result the
  // time lookup resolves to the same index as exitBar; empty barTimes falls
  // back to exitBar unchanged.
  const idxByTimeMs = new Map<number, number>();
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    idxByTimeMs.set(t >= 1e12 ? t : t * 1000, i);
  }
  const markerBar = (t: StrategyTrade): number =>
    idxByTimeMs.get(t.exitTime >= 1e12 ? t.exitTime : t.exitTime * 1000) ?? t.exitBar;
  const markers = (result.trades ?? [])
    .map((t) => ({ t, bar: markerBar(t) }))
    .filter(({ bar }) => bar >= x0 && bar <= x1 && Number.isFinite(equity[bar]))
    .map(({ t, bar }) => {
      const cy = syEq(equity[bar]!);
      const fill = t.profit >= 0 ? '#16a34a' : '#dc2626';
      return `<circle cx="${fmt(sx(bar))}" cy="${fmt(cy)}" r="3" fill="${fill}"><title>${esc(t.entryId)}: ${fmt(t.profit)}</title></circle>`;
    })
    .join('');

  // Axis ticks: 5 equity levels, 6 time labels (ISO date when times exist).
  const eqTicks = ticks(eqMin, eqMax, 5)
    .map((v) => {
      const y = fmt(syEq(v));
      return (
        `<line x1="${M.left}" y1="${y}" x2="${W - M.right}" y2="${y}" class="grid"/>` +
        `<text x="${M.left - 8}" y="${y}" class="ylabel">${fmt(v)}</text>`
      );
    })
    .join('');
  const xTicks = [...new Set(ticks(x0, x1, 6).map((bar) => Math.round(bar)))]
    .map((b) => {
      const t = times[b];
      const label = t != null ? isoTime(t).slice(0, 10) : `#${b}`;
      const x = sx(b);
      // Edge labels anchor inward — a centered date at the extremes would clip
      // half of itself outside the viewBox.
      const anchor = x > W - M.right - 36 ? 'end' : x < M.left + 36 ? 'start' : 'middle';
      const style = anchor === 'middle' ? '' : ` style="text-anchor:${anchor}"`;
      return `<text x="${fmt(x)}" y="${EQ_H - 8}" class="xlabel"${style}>${label}</text>`;
    })
    .join('');

  const initialCapital = s
    ? `<line x1="${M.left}" y1="${fmt(syEq(s.initialCapital))}" x2="${W - M.right}" y2="${fmt(syEq(s.initialCapital))}" class="capital"/>`
    : '';

  const body = `
<h1>${esc(title)}</h1>
${subtitle ? `<p class="sub">${esc(subtitle)}</p>` : ''}
<svg viewBox="0 0 ${W} ${EQ_H}" role="img" aria-label="equity curve">
  ${eqTicks}
  ${xTicks}
  ${initialCapital}
  <path d="${eqPath}" class="equity"/>
  ${markers}
</svg>
<p class="chart-label">drawdown %</p>
<svg viewBox="0 0 ${W} ${DD_H}" role="img" aria-label="drawdown">
  <line x1="${M.left}" y1="${fmt(syDd(0))}" x2="${W - M.right}" y2="${fmt(syDd(0))}" class="grid"/>
  <text x="${M.left - 8}" y="${fmt(syDd(ddMin))}" class="ylabel">${fmt(ddMin)}%</text>
  <path d="${ddArea}" class="drawdown"/>
</svg>`;
  return htmlShell(title, body);
}

/** Strategy summary columns attached to each point row (when any point has one). */
const POINT_STRATEGY_COLUMNS = [
  'netProfit',
  'netProfitPercent',
  'closedTrades',
  'winRate',
  'maxDrawdownPercent',
  'profitFactor',
  'sharpe',
] as const;

/**
 * The whole sweep grid as CSV, one row per run: symbol, one column per swept
 * axis, the ranked value, the strategy summary block (when the sweep ran a
 * strategy), and the error for failed runs. Rows are in `points` order (symbols
 * outermost, then cartesian order), so pandas can pivot the optimization
 * surface straight from the file.
 */
export function sweepPointsToCsv(report: SweepReport): string {
  const axisNames = report.axes.map((a) => a.name);
  const hasStrategy = report.points.some((p) => p.result.strategy);
  const header = [
    'symbol',
    ...axisNames,
    'value',
    ...(hasStrategy ? POINT_STRATEGY_COLUMNS : []),
    'error',
  ];
  const rows = report.points.map((p) => {
    const s = p.result.strategy;
    const strategyCells = hasStrategy
      ? s
        ? [
            numCell(s.netProfit),
            numCell(s.netProfitPercent),
            numCell(s.closedTrades),
            numCell(s.winRate),
            numCell(s.maxDrawdownPercent),
            numCell(s.profitFactor),
            numCell(s.metrics.sharpe),
          ]
        : POINT_STRATEGY_COLUMNS.map(() => '')
      : [];
    return [
      csvCell(p.symbol),
      ...axisNames.map((n) => csvCell(String(p.inputs[n] ?? ''))),
      numCell(p.value),
      ...strategyCells,
      p.result.error != null ? csvCell(p.result.error) : '',
    ].join(',');
  });
  return [header.map(csvCell).join(','), ...rows].join('\n') + '\n';
}

export interface SweepHeatmapOptions {
  /** Grade each cell red → yellow → default → green → bright green by its
   *  value's quintile within its grid (per symbol). ANSI wraps the padded
   *  cell, so layout is untouched and stripping the codes recovers the plain
   *  grid. Default false — pipe-safe. */
  color?: boolean;
}

/**
 * The 2-axis optimization surface as a text grid — first axis down the rows,
 * second axis across the columns, the ranked metric in each cell. A cell with
 * no point (a failed run, or a combo skipped by sampling) prints `·`. A
 * multi-symbol sweep renders one grid per symbol. Throws unless the sweep has
 * exactly two axes.
 */
export function sweepHeatmap(report: SweepReport, opts: SweepHeatmapOptions = {}): string {
  if (report.axes.length !== 2) {
    throw new Error(`heatmap: needs exactly two swept axes (got ${report.axes.length})`);
  }
  const [rowAxis, colAxis] = report.axes as [
    { name: string; values: unknown[] },
    { name: string; values: unknown[] },
  ];

  const bySymbol = new Map<string, Map<string, SweepPoint>>();
  for (const p of report.points) {
    let grid = bySymbol.get(p.symbol);
    if (!grid) bySymbol.set(p.symbol, (grid = new Map()));
    grid.set(`${String(p.inputs[rowAxis.name])} ${String(p.inputs[colAxis.name])}`, p);
  }

  const cell = (p: SweepPoint | undefined): string =>
    p == null ? '·' : Number.isFinite(p.value) ? fmt(p.value) : 'na';

  const blocks: string[] = [];
  for (const [symbol, grid] of bySymbol) {
    const points = rowAxis.values.map((rv) =>
      colAxis.values.map((cv) => grid.get(`${String(rv)} ${String(cv)}`)),
    );
    const rows = points.map((r) => r.map(cell));
    const rowW = Math.max(rowAxis.name.length, ...rowAxis.values.map((v) => String(v).length));
    const colW = colAxis.values.map((v, j) =>
      Math.max(String(v).length, ...rows.map((r) => r[j]!.length)),
    );

    // Quintile shading per grid: worst red, then yellow, plain middle, green,
    // best bright green. Applied to the PADDED cell so layout is untouched.
    const finiteVals = points
      .flat()
      .filter((p): p is SweepPoint => p != null && Number.isFinite(p.value))
      .map((p) => p.value);
    const min = Math.min(...finiteVals);
    const max = Math.max(...finiteVals);
    const shade = (v: number): number | null => {
      if (!(max > min)) return null;
      const t = (v - min) / (max - min);
      return t < 0.2 ? 31 : t < 0.4 ? 33 : t < 0.6 ? null : t < 0.8 ? 32 : 92;
    };
    const painted = (i: number, j: number): string => {
      const s = rows[i]![j]!.padStart(colW[j]!);
      const p = points[i]![j];
      if (opts.color !== true || p == null || !Number.isFinite(p.value)) return s;
      const ansi = shade(p.value);
      return ansi == null ? s : `\x1b[${ansi}m${s}\x1b[39m`;
    };
    const title =
      `${report.rank} by ${rowAxis.name} (rows) × ${colAxis.name} (cols)` +
      (bySymbol.size > 1 ? ` — ${symbol}` : '');
    const header = [
      rowAxis.name.padStart(rowW),
      ...colAxis.values.map((v, j) => String(v).padStart(colW[j]!)),
    ].join('  ');
    const body = rowAxis.values.map((rv, i) =>
      [String(rv).padStart(rowW), ...rows[i]!.map((_, j) => painted(i, j))].join('  '),
    );
    blocks.push([title, '', header, ...body].join('\n'));
  }
  return blocks.join('\n\n') + '\n';
}

// ── helpers ─────────────────────────────────────────────────

/** unix seconds OR milliseconds → ISO 8601 UTC. */
function isoTime(t: number): string {
  return new Date(t >= 1e12 ? t : t * 1000).toISOString();
}

/** RFC 4180: quote a cell when it contains a comma, quote, or newline. */
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;
}

/** Full-precision numeric cell; NaN → empty (pandas NaN), ±Infinity → ±inf. */
function numCell(v: number): string {
  if (Number.isFinite(v)) return String(v);
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  return '';
}

/** Round-numbered tick values across [min, max], endpoints included. */
function ticks(min: number, max: number, count: number): number[] {
  if (!(max > min)) return [min];
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(min + ((max - min) * i) / (count - 1));
  return out;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return 'na';
  const abs = Math.abs(v);
  return abs >= 1000 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : v.toFixed(2);
}

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function htmlShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<style>
  body { font: 14px/1.45 system-ui, sans-serif; margin: 24px auto; max-width: 1000px; color: #111; background: #fff; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #555; margin: 0 0 16px; }
  .chart-label { color: #555; margin: 12px 0 2px; font-size: 12px; }
  .empty { color: #777; }
  svg { width: 100%; height: auto; display: block; }
  .equity { fill: none; stroke: #2563eb; stroke-width: 1.6; }
  .drawdown { fill: #dc262633; stroke: #dc2626; stroke-width: 1; }
  .capital { stroke: #999; stroke-dasharray: 4 4; }
  .grid { stroke: #eee; }
  .ylabel { fill: #777; font-size: 11px; text-anchor: end; dominant-baseline: middle; }
  .xlabel { fill: #777; font-size: 11px; text-anchor: middle; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}
