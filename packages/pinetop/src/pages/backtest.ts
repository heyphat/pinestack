/**
 * BACKTEST (§4.2, page 1) — analyze one strategy on one symbol.
 *
 * P1 is the vertical slice that proves the architecture (§7): the numbers here
 * must match `pinerun backtest` in a plain shell byte for byte, which is why
 * every value comes from the parsed report and the charts and monthly grids are
 * `pinerun`'s own renderers rather than reimplementations.
 *
 * Layout follows §4.4: config on the left, the primary result in the wide
 * middle, the metric rail on the right, full-width tables beneath.
 */

import {
  adaptiveRollingSharpeWindow,
  drawdownChartAscii,
  durationReturnAscii,
  equityChartAscii,
  maeMfeAscii,
  monthlyReturnsAscii,
  monthlyTradesAscii,
  priceChartAscii,
  profitHistogramAscii,
  rollingSharpeAscii,
  topDrawdownsAscii,
} from '@heyphat/pinerun';
import { isSet } from '../flags/model.js';
import { schemaFor } from '../flags/schema.js';
import { int, isoDay, isoMonth } from '../render/format.js';
import { drawPane, truncate, type Rect } from '../render/screen.js';
import { drawLeader } from '../render/table.js';
import { STYLE, type Style } from '../render/theme.js';
import { cachedScripts, refreshScripts, scriptLabel, type ScriptEntry } from '../scripts.js';
import type { AppState } from '../state.js';
import {
  fillModelNote,
  tearsheetFooter,
  tearsheetSections,
  type BacktestJson,
  type MetricRow,
} from '../views/report.js';
import { configRowCount, drawConfigPane } from './config-pane.js';
import {
  HISTORY_PANE,
  drawHistoryPane,
  historyHeight,
  historyRowCount,
  loadRun,
} from './history-pane.js';
import {
  STRATEGIES_PANE,
  drawStrategiesPane,
  loadStrategy,
  strategiesHeight,
  strategyRowCount,
  type StrategiesPaneOptions,
} from './strategies-pane.js';
import { clampCursor, columns, rows, windowFor, type Page, type PageContext } from './page.js';

/** The shared discovery cache — see `scripts.ts`; the editor reads the same one. */
export function scripts(): ScriptEntry[] {
  return cachedScripts();
}

export { refreshScripts };

export function report(state: AppState): BacktestJson | undefined {
  if (state.run?.command !== 'backtest' || state.run.status !== 'ok') return undefined;
  return state.run.report as BacktestJson | undefined;
}

const PANES = ['strategies', 'config', 'charts', 'metrics', 'monthly', HISTORY_PANE] as const;

/** The risk-chart slot views, in `j`/`k` order while CHARTS is focused. */
export const CHART_VIEWS = ['drawdown', 'rolling-sharpe'] as const;

/** Style for a signed metric: losses never read as accent (§4.7 deviation 2). */
function signStyleOf(sign: number): Style {
  if (sign > 0) return STYLE.positive;
  if (sign < 0) return STYLE.negative;
  return STYLE.none;
}

/**
 * The rail value beside a script: the loaded run's Sharpe, and only for the
 * loaded script. A number beside a script we have not run would be a claim the
 * report does not make.
 */
function sharpeRail(state: AppState): StrategiesPaneOptions['rail'] {
  return (_entry, loaded) => {
    if (!loaded) return undefined;
    const value = report(state)?.strategy?.metrics?.sharpe;
    return value == null || !Number.isFinite(value) ? undefined : value.toFixed(2);
  };
}

function drawCharts(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const net = data?.strategy?.netProfitPercent;
  const legend =
    data == null
      ? undefined
      : `net ${net == null ? '—' : `${net.toFixed(0)}%`} · ${data.bars?.toLocaleString('en-US') ?? '—'} bars`;

  const inner = drawPane(screen, rect, {
    title: 'CHARTS',
    focused: ctx.focus === 'charts',
    key: ctx.paneKey('charts'),
    legend,
  });
  if (inner.h <= 0 || inner.w <= 4) return;

  if (data == null) {
    const message =
      state.run?.status === 'running'
        ? 'running…'
        : state.run?.status === 'failed'
          ? (state.run.error ?? 'run failed')
          : 'press r to run';
    screen.text(inner.x, inner.y + 1, message, STYLE.muted, inner);
    return;
  }

  const equity = data.equityCurve ?? [];
  const times = data.barTimes ?? [];
  const closes = data.closes ?? [];

  // Three stacked panels (§4.3.b). The gutter and date row belong to the chart
  // builder, so the width handed over leaves room for both.
  const chartW = Math.max(16, inner.w - 12);
  const panels = rows(inner, [Math.floor((inner.h - 2) * 0.42), Math.floor((inner.h - 2) * 0.34)]);
  const [priceRect, equityRect, riskRect] = panels as [Rect, Rect, Rect];

  screen.text(priceRect.x, priceRect.y, 'PRICE', STYLE.title, inner);
  screen.text(
    priceRect.x + 6,
    priceRect.y,
    '(close · ▲ long / ▼ short entry · ● win / ○ loss exit)',
    STYLE.muted,
    inner,
  );
  if (closes.length >= 2) {
    // color marks entries cyan and exits green/red. The ▲▼●○ glyphs carry the
    // same information uncoloured, so this is reinforcement, not the only cue.
    screen.styledBlock(
      priceRect.x,
      priceRect.y + 1,
      priceChartAscii(closes, {
        width: chartW,
        height: Math.max(4, priceRect.h - 2),
        times,
        trades: data.trades ?? [],
        color: true,
      }),
      STYLE.none,
      priceRect,
    );
  }

  screen.text(equityRect.x, equityRect.y, 'EQUITY', STYLE.title, inner);
  screen.text(equityRect.x + 7, equityRect.y, '(dashed = initial capital)', STYLE.muted, inner);
  if (equity.length >= 2) {
    screen.block(
      equityRect.x,
      equityRect.y + 1,
      equityChartAscii(equity, {
        width: chartW,
        height: Math.max(4, equityRect.h - 2),
        times,
        capital: data.strategy?.initialCapital,
      }),
      STYLE.none,
      equityRect,
    );
  }

  const riskView = CHART_VIEWS[clampCursor(ctx.cursor('charts'), CHART_VIEWS.length)]!;
  const showingDrawdown = riskView === 'drawdown';
  const rollingWindow = adaptiveRollingSharpeWindow(equity);

  screen.text(
    riskRect.x,
    riskRect.y,
    showingDrawdown ? 'DRAWDOWN' : 'ROLLING SHARPE',
    STYLE.title,
    inner,
  );
  screen.text(
    riskRect.x + (showingDrawdown ? 9 : 16),
    riskRect.y,
    showingDrawdown
      ? '(close-to-close · j/k → Sharpe)'
      : `(${rollingWindow == null ? 'needs 15+ returns' : `${rollingWindow}-bar · annualized`} · j/k → DD)`,
    STYLE.muted,
    inner,
  );

  if (showingDrawdown && equity.length >= 2) {
    // §4.3.e — 0% at the top, magnitude increasing downward. The builder owns
    // that orientation; pinetop must not flip it.
    screen.block(
      riskRect.x,
      riskRect.y + 1,
      drawdownChartAscii(equity, { width: chartW, height: Math.max(2, riskRect.h - 2) }),
      STYLE.negative,
      riskRect,
    );
  } else if (rollingWindow != null) {
    screen.block(
      riskRect.x,
      riskRect.y + 1,
      rollingSharpeAscii(equity, {
        width: chartW,
        height: Math.max(2, riskRect.h - 2),
        times,
        window: rollingWindow,
        periodsPerYear: data.strategy?.metrics?.periodsPerYear,
      }),
      STYLE.none,
      riskRect,
    );
  } else {
    screen.text(
      riskRect.x,
      riskRect.y + 1,
      'needs at least 15 contiguous equity returns',
      STYLE.muted,
      riskRect,
    );
  }
}

/**
 * Flatten the sections into one addressable list so `j`/`k` can page the rail
 * when the terminal is too short for all three at once — §4.3.a forbids a
 * scrolling viewport, but a metric that is simply unreachable is worse.
 * A `null` entry is a section break: a blank line then the section title.
 */
type RailLine =
  { kind: 'blank' } | { kind: 'title'; text: string } | { kind: 'row'; row: MetricRow };

/**
 * Blank separators are real entries rather than something inserted at draw
 * time, so one display row is one list entry. Paging then cannot be off by the
 * number of section breaks on the page.
 */
export function railLines(strategy: BacktestJson['strategy']): RailLine[] {
  const out: RailLine[] = [];
  for (const section of tearsheetSections(strategy)) {
    if (out.length > 0) out.push({ kind: 'blank' });
    out.push({ kind: 'title', text: section.title });
    for (const row of section.rows) out.push({ kind: 'row', row });
  }
  return out;
}

const METRIC_RAIL_COLS = 38;
const ANALYSIS_GAP_COLS = 1;
const DISTRIBUTION_MIN_COLS = 28;
const TOP_DRAWDOWNS_COLS = 56;

/** Fit pinerun's histogram bars to the available rail width without changing its buckets. */
function profitDistribution(profits: number[], width: number): string {
  const initialBarWidth = Math.max(8, width - 8);
  const uncoloured = profitHistogramAscii(profits, { width: initialBarWidth });
  if (uncoloured === '') return '';
  const longest = Math.max(...uncoloured.split('\n').map((line) => line.length));
  const barWidth = Math.max(8, initialBarWidth - Math.max(0, longest - width));
  return profitHistogramAscii(profits, { width: barWidth, color: true });
}

/** Render trade diagnostics in the analysis column and return its first unused row. */
function drawTradeAnalysis(ctx: PageContext, rect: Rect, data: BacktestJson): number {
  const { screen } = ctx;
  if (rect.w < DISTRIBUTION_MIN_COLS || rect.h <= 1) return rect.y;

  const trades = data.trades ?? [];
  const profits = trades.map((trade) => trade.profit);
  const distribution = profitDistribution(profits, rect.w);
  let y = rect.y;

  screen.text(rect.x, y, 'TRADE P/L DISTRIBUTION', STYLE.title, rect);
  y += 1;
  if (distribution === '') {
    screen.text(rect.x, y, 'no closed trades in this report', STYLE.muted, rect);
    y += 1;
  } else {
    screen.styledBlock(rect.x, y, distribution, STYLE.none, rect);
    y += distribution.split('\n').length;
  }

  const chartRows = 6;
  const diagnostics = [
    {
      title: 'RETURN BY HOLD · med / win% / n',
      chart: durationReturnAscii(trades, { width: rect.w, height: chartRows, color: true }),
    },
    {
      title: 'MFE / MAE DENSITY · p95 clipped',
      chart: maeMfeAscii(trades, { width: rect.w, height: chartRows, color: true }),
    },
  ];
  for (const diagnostic of diagnostics) {
    if (diagnostic.chart === '') continue;
    const rows = diagnostic.chart.split('\n').length;
    // One blank separator, one title, then the complete plot. Never clip an
    // axis: a partially visible excursion scale is worse than omitting it.
    if (y + 2 + rows > rect.y + rect.h) break;
    y += 1;
    screen.text(rect.x, y, diagnostic.title, STYLE.title, rect);
    y += 1;
    screen.styledBlock(rect.x, y, diagnostic.chart, STYLE.none, rect);
    y += rows;
  }
  return y;
}

/** Use the full-width space below the upper tearsheet columns for drawdowns. */
function drawTopDrawdowns(ctx: PageContext, rect: Rect, data: BacktestJson, y: number): void {
  const { screen } = ctx;
  if (rect.w < TOP_DRAWDOWNS_COLS) return;

  const drawdowns = topDrawdownsAscii(data.equityCurve ?? [], data.barTimes ?? [], { top: 5 });
  const drawdownRows = drawdowns === '' ? 1 : drawdowns.split('\n').length;
  if (y + 1 + drawdownRows > rect.y + rect.h) return;

  screen.text(rect.x, y, 'TOP DRAWDOWNS', STYLE.title, rect);
  if (drawdowns === '') {
    screen.text(rect.x, y + 1, 'no drawdown periods in this report', STYLE.muted, rect);
  } else {
    screen.block(rect.x, y + 1, drawdowns, STYLE.none, rect);
  }
}

function drawMetrics(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const focused = ctx.focus === 'metrics';

  const lines = railLines(data?.strategy);
  // One compact footer line, not four: every row it costs is a metric that
  // would otherwise be pushed onto a second page.
  // Bars and timeframe already sit in the CHARTS legend and the breadcrumb, so
  // the footer carries only what has no other home.
  const footer = tearsheetFooter(data?.strategy).join(' · ');

  const interiorH = Math.max(0, rect.h - 2);
  const listRows = Math.max(1, interiorH - (footer === '' ? 0 : 1));
  const cursor = clampCursor(ctx.cursor('metrics'), lines.length);
  const { from, to } = windowFor(cursor, lines.length, listRows);
  const paged = lines.length > listRows;

  const inner = drawPane(screen, rect, {
    title: 'TEARSHEET',
    focused,
    key: ctx.paneKey('metrics'),
    legend: paged
      ? `${Math.floor(cursor / listRows) + 1}/${Math.ceil(lines.length / listRows)} · j/k`
      : fillModelNote(data?.strategy),
  });
  if (inner.h <= 0) return;

  if (data?.strategy == null) {
    screen.text(inner.x, inner.y, 'no run loaded', STYLE.muted, inner);
    return;
  }

  const analysisW = inner.w - METRIC_RAIL_COLS - ANALYSIS_GAP_COLS;
  const showAnalysis = analysisW >= DISTRIBUTION_MIN_COLS;
  const metricRect: Rect = showAnalysis ? { ...inner, w: METRIC_RAIL_COLS } : inner;
  const analysisRect: Rect | undefined = showAnalysis
    ? {
        x: inner.x + METRIC_RAIL_COLS + ANALYSIS_GAP_COLS,
        y: inner.y,
        w: analysisW,
        h: inner.h,
      }
    : undefined;

  let y = metricRect.y;
  for (let i = from; i < to; i++) {
    if (y >= metricRect.y + listRows) break;
    const line = lines[i]!;
    if (line.kind === 'blank') {
      y += 1;
      continue;
    }
    if (line.kind === 'title') {
      screen.text(metricRect.x, y, line.text, STYLE.title, metricRect);
      y += 1;
      continue;
    }
    drawRailRow(screen, metricRect, y, line.row);
    y += 1;
  }

  let metricEndY = y;
  if (footer !== '') {
    // Sit one line under the last row rather than pinned to the pane floor: a
    // short history leaves the rail with slack, and a footer stranded six blank
    // rows below the metrics reads as belonging to something else.
    const footerY = Math.min(y + 1, metricRect.y + metricRect.h - 1);
    screen.text(metricRect.x, footerY, truncate(footer, metricRect.w), STYLE.muted, metricRect);
    metricEndY = footerY + 1;
  }

  const analysisEndY = analysisRect == null ? inner.y : drawTradeAnalysis(ctx, analysisRect, data);
  // Both upper columns may have different heights. Start below whichever one
  // extends farther, then use the complete rail width for the 56-column table.
  drawTopDrawdowns(ctx, inner, data, Math.max(metricEndY, analysisEndY) + 1);
}

/**
 * One tearsheet row: `label ···· money   percent`, mirroring the CLI's three
 * columns. The percent column is right-aligned in a fixed track so the rates
 * line up down the pane even when the money column is blank.
 */
function drawRailRow(screen: PageContext['screen'], inner: Rect, y: number, row: MetricRow): void {
  const style = signStyleOf(row.sign);
  const percent = row.percent ?? '';
  // Exactly what the percent needs, plus a gap. Capping this was a bug: a wide
  // parenthetical like `(704W 580L 0E)` reserved 9 columns but was drawn at its
  // own full width, overwriting the money column — `closed trades` lost its count.
  const pctW = percent === '' ? 0 : percent.length + 1;

  if (row.value === '') {
    // Percent-only rows (buy & hold, CAGR, win rate, exposure) read as a leader.
    drawLeader(screen, inner, y, row.label, percent, { valueStyle: style });
    return;
  }

  const track: Rect = { ...inner, w: Math.max(0, inner.w - pctW) };
  drawLeader(screen, track, y, row.label, row.value, { valueStyle: style });
  if (percent !== '') {
    screen.text(
      inner.x + inner.w - percent.length,
      y,
      percent,
      // A parenthetical breakdown like `(7W 0L 0E)` is a fact, not a gain/loss.
      percent.startsWith('(') ? STYLE.muted : style,
      inner,
    );
  }
}

/**
 * Both monthly grids are 99 characters wide — `JAN … DEC` plus the `YEAR`
 * total — so showing them side by side needs 202 columns plus borders. Below
 * that they would each lose DEC and YEAR, and YEAR is the payoff column §4.4
 * says must not fall off the right edge.
 *
 * So: side by side when there is room for both, and otherwise one grid at full
 * width with `j`/`k` swapping which. That keeps every column of whichever grid
 * you are reading, at the cost of one keystroke to see the other — strictly
 * better than clipping the year total off both.
 */
const MONTHLY_GRID_COLS = 99;

/** Calendar years the monthly grids will have a row for. */
function monthlyYearCount(data: BacktestJson | undefined): number {
  const times = data?.barTimes;
  if (times == null || times.length === 0) return 1;
  const years = new Set<number>();
  for (const t of times) {
    if (Number.isFinite(t)) years.add(new Date(t > 1e11 ? t : t * 1000).getUTCFullYear());
  }
  return Math.max(1, years.size);
}

/** The two grids the monthly strip can show, in `j`/`k` order. */
export const MONTHLY_VIEWS = ['returns', 'trades'] as const;

function drawMonthly(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const focused = ctx.focus === 'monthly';

  const span =
    data?.barTimes == null || data.barTimes.length === 0
      ? undefined
      : `${isoMonth(data.barTimes[0])} → ${isoMonth(data.barTimes[data.barTimes.length - 1])}`;

  const equity = data?.equityCurve ?? [];
  const times = data?.barTimes ?? [];
  const trades = data?.trades ?? [];
  // `color: true` gives the CLI's own grading: green gains / brick losses in
  // MONTHLY RETURNS, green wins / red losses per tally in MONTHLY TRADES. Both
  // builders pad *before* painting, so the escapes never disturb the column
  // tracks — and `styledBlock` maps them onto cells rather than printing them,
  // which is what keeps clipping exact (§4.3.a).
  const returnsGrid =
    equity.length >= 2 && times.length === equity.length
      ? monthlyReturnsAscii(equity, times, { color: true })
      : '';
  const tradesGrid = trades.length > 0 ? monthlyTradesAscii(trades, { color: true }) : '';

  const sideBySide = rect.w >= (MONTHLY_GRID_COLS + 2) * 2;

  if (sideBySide) {
    const [left, right] = columns(rect, [Math.floor(rect.w / 2)]) as [Rect, Rect];
    // Two boxes, one pane: both carry the focus marker and both carry the same
    // key. Marking only the left one said MONTHLY TRADES was a pane of its own
    // that no keystroke could reach — when in fact it is already on screen, and
    // `mo` lands on the pane that owns both halves.
    const leftInner = drawPane(screen, left, {
      title: 'MONTHLY RETURNS %',
      focused,
      key: ctx.paneKey('monthly'),
      legend: span,
    });
    const rightInner = drawPane(screen, right, {
      title: 'MONTHLY TRADES',
      focused,
      key: ctx.paneKey('monthly'),
      legend: 'win / loss · even in year',
    });
    if (returnsGrid !== '')
      screen.styledBlock(leftInner.x, leftInner.y, returnsGrid, STYLE.none, leftInner);
    if (tradesGrid !== '')
      screen.styledBlock(rightInner.x, rightInner.y, tradesGrid, STYLE.none, rightInner);
    return;
  }

  const view = MONTHLY_VIEWS[clampCursor(ctx.cursor('monthly'), MONTHLY_VIEWS.length)]!;
  const showingReturns = view === 'returns';
  const inner = drawPane(screen, rect, {
    title: showingReturns ? 'MONTHLY RETURNS %' : 'MONTHLY TRADES',
    focused,
    key: ctx.paneKey('monthly'),
    // The legend names the key and the grid it reveals, so the other half of
    // the tearsheet is discoverable rather than merely absent.
    legend: `${showingReturns ? (span ?? '') : 'win / loss · even in year'} · j/k → ${
      showingReturns ? 'MONTHLY TRADES' : 'MONTHLY RETURNS %'
    }`,
  });
  const grid = showingReturns ? returnsGrid : tradesGrid;
  if (grid !== '') screen.styledBlock(inner.x, inner.y, grid, STYLE.none, inner);
  else if (data != null) {
    screen.text(
      inner.x,
      inner.y,
      showingReturns ? 'no equity curve in this report' : 'no closed trades in this report',
      STYLE.muted,
      inner,
    );
  }
}

export const backtestPage: Page = {
  id: 'backtest',
  command: 'backtest',
  minCols: schemaFor('backtest').minCols,

  panes: () => [...PANES],

  rowCount: (state, paneId) => {
    if (paneId === HISTORY_PANE) return historyRowCount(state, 'backtest');
    switch (paneId) {
      case 'strategies':
        return strategyRowCount(state);
      case 'config':
        return configRowCount(state, 'backtest');
      case 'charts':
        // Risk views share the third chart slot; j/k cycles through them.
        return CHART_VIEWS.length;
      case 'monthly':
        // Two "rows": the two grids, so j/k swaps which one the strip shows.
        return MONTHLY_VIEWS.length;
      case 'metrics':
        // The flattened tearsheet, so a short terminal can page the rail.
        return railLines(report(state)?.strategy).length;
      default:
        return 0;
    }
  },

  // CHARTS is a view carousel, not a list: moving past either end continues at
  // the other. Other BACKTEST panes retain normal clamped list navigation.
  wrapCursor: (_state, paneId) => paneId === 'charts',

  breadcrumb: (state) => {
    const model = state.flags.backtest;
    const crumbs = ['pinetop'];
    const script = model.scripts[0];
    crumbs.push(script == null ? '(no script)' : scriptLabel(script));
    const data = report(state);
    const times = data?.barTimes;
    if (times != null && times.length > 0) {
      crumbs.push(`${isoDay(times[0])} → ${isoDay(times[times.length - 1])}`);
    } else {
      const from = model.values['from'];
      const to = model.values['to'];
      if (isSet(from) || isSet(to)) crumbs.push(`${String(from ?? '…')} → ${String(to ?? '…')}`);
    }
    if (state.run != null) crumbs.push(`run ${state.run.id}`);
    return crumbs;
  },

  confirm: (state) => {
    if (state.panes.backtest.focus === HISTORY_PANE) return loadRun(state, 'backtest');
    // ↵ on STRATEGIES loads the selected script; elsewhere it is the run dialog's
    // job, so the page says nothing rather than guessing (§4.6: no auto-run).
    if (state.panes.backtest.focus !== STRATEGIES_PANE) return undefined;
    return loadStrategy(state, 'backtest');
  },

  render: (ctx) => {
    const { body, screen, state } = ctx;
    const narrow = screen.cols < backtestPage.minCols;

    // Widen the right rail enough to keep the 38-column scalar tearsheet and a
    // responsive analysis column resident together. At ordinary widths the
    // analysis column holds the P/L distribution; at wider widths its 56
    // columns also preserve the CLI's top-drawdowns table without clipping.
    const railW = narrow ? 0 : Math.min(102, Math.max(70, Math.floor(screen.cols * 0.46)));
    const leftW = Math.min(32, Math.max(24, Math.floor(screen.cols * 0.21)));
    // Size the monthly strip to what it actually has to show — one header row
    // plus a row per year — instead of a fixed slab. A one-year backtest then
    // hands six rows back to the tearsheet rail, which is what lets all three
    // sections sit on one page.
    const monthlyH = Math.min(11, Math.max(5, monthlyYearCount(report(state)) + 4));

    const [top, bottom] = rows(body, [body.h - monthlyH]) as [Rect, Rect];
    const [leftCol, midCol, rightCol] = columns(top, [leftW, top.w - leftW - railW]) as [
      Rect,
      Rect,
      Rect,
    ];

    const stratH = strategiesHeight(leftCol.h);
    const histH = historyHeight(leftCol.h);
    const [stratRect, configRect, histRect] = rows(leftCol, [
      stratH,
      leftCol.h - stratH - histH,
    ]) as [Rect, Rect, Rect];

    drawStrategiesPane(ctx, stratRect, { command: 'backtest', rail: sharpeRail(state) });
    drawConfigPane(ctx, configRect, { command: 'backtest' });
    drawHistoryPane(ctx, histRect, 'backtest');
    drawCharts(ctx, midCol);
    if (railW > 0) drawMetrics(ctx, rightCol);
    drawMonthly(ctx, bottom);
  },
};
