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
  tradeOutcomeSequenceAscii,
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
import { clampCursor, columns, rows, type Page, type PageContext } from './page.js';

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
  const periodsPerYear = data.strategy?.metrics?.periodsPerYear;
  const rollingWindow = adaptiveRollingSharpeWindow(equity, periodsPerYear);

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
        periodsPerYear,
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
const METRIC_GAP_COLS = 1;
const DISTRIBUTION_MIN_COLS = 28;
const TOP_DRAWDOWNS_COLS = 56;
/** Outer pane width needed for two full scalar-metric columns. */
const STRUCTURED_TEARSHEET_COLS = METRIC_RAIL_COLS * 2 + METRIC_GAP_COLS + 2;

/** Fit pinerun's histogram bars to the available rail width without changing its buckets. */
function profitDistribution(profits: number[], width: number): string {
  const initialBarWidth = Math.max(8, width - 8);
  const uncoloured = profitHistogramAscii(profits, { width: initialBarWidth });
  if (uncoloured === '') return '';
  const longest = Math.max(...uncoloured.split('\n').map((line) => line.length));
  const barWidth = Math.max(8, initialBarWidth - Math.max(0, longest - width));
  return profitHistogramAscii(profits, { width: barWidth, color: true });
}

/** Render full-width trade diagnostics in strict reading order. */
function drawTradeAnalysis(ctx: PageContext, rect: Rect, data: BacktestJson): number {
  const { screen } = ctx;
  if (rect.w < DISTRIBUTION_MIN_COLS || rect.h <= 1) return rect.y;

  const trades = data.trades ?? [];
  const profits = trades.map((trade) => trade.profit);
  const outcomes = tradeOutcomeSequenceAscii(trades, {
    width: rect.w,
    height: 7,
    color: true,
  });
  const distribution = profitDistribution(profits, rect.w);
  const bottom = rect.y + rect.h;
  let y = rect.y;

  const drawChart = (title: string, chart: string, emptyMessage?: string): boolean => {
    const body = chart === '' ? emptyMessage : chart;
    if (body == null) return true;

    const rows = body.split('\n').length;
    const sectionY = y + (y > rect.y ? 1 : 0);
    // Never draw a title without its complete plot or clip an axis. A section
    // that does not fit belongs on a taller terminal, not as a partial claim.
    if (sectionY + 1 + rows > bottom) return false;

    y = sectionY;
    screen.text(rect.x, y, title, STYLE.title, rect);
    y += 1;
    if (chart === '') screen.text(rect.x, y, body, STYLE.muted, rect);
    else screen.styledBlock(rect.x, y, body, STYLE.none, rect);
    y += rows;
    return true;
  };

  if (!drawChart('OUTCOMES & STREAKS', outcomes)) return y;
  if (!drawChart('TRADE P/L DISTRIBUTION', distribution, 'no closed trades in this report')) {
    return y;
  }

  const diagnostics = [
    {
      title: 'RETURN BY HOLD',
      chart: durationReturnAscii(trades, { width: rect.w, height: 6, color: true }),
    },
    {
      title: 'MFE / MAE DENSITY',
      chart: maeMfeAscii(trades, { width: rect.w, height: 9, color: true }),
    },
  ];
  for (const diagnostic of diagnostics) {
    if (!drawChart(diagnostic.title, diagnostic.chart)) break;
  }
  return y;
}

/** Render TOP DRAWDOWNS at `y` and return the first unused row. */
function drawTopDrawdowns(ctx: PageContext, rect: Rect, data: BacktestJson, y = rect.y): number {
  const { screen } = ctx;
  if (rect.w < TOP_DRAWDOWNS_COLS || y < rect.y || y >= rect.y + rect.h) return y;

  const drawdowns = topDrawdownsAscii(data.equityCurve ?? [], data.barTimes ?? [], { top: 5 });
  const drawdownRows = drawdowns === '' ? 1 : drawdowns.split('\n').length;
  if (y + 1 + drawdownRows > rect.y + rect.h) return y;

  screen.text(rect.x, y, 'TOP DRAWDOWNS', STYLE.title, rect);
  if (drawdowns === '') {
    screen.text(rect.x, y + 1, 'no drawdown periods in this report', STYLE.muted, rect);
  } else {
    screen.block(rect.x, y + 1, drawdowns, STYLE.none, rect);
  }
  return y + 1 + drawdownRows;
}

function drawMetricSection(
  screen: PageContext['screen'],
  rect: Rect,
  section: ReturnType<typeof tearsheetSections>[number] | undefined,
  y: number,
): number {
  if (section == null || y >= rect.y + rect.h) return y;

  screen.text(rect.x, y, section.title, STYLE.title, rect);
  y += 1;
  for (const row of section.rows) {
    if (y >= rect.y + rect.h) break;
    drawRailRow(screen, rect, y, row);
    y += 1;
  }
  return y;
}

function drawMetrics(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const focused = ctx.focus === 'metrics';
  const footer = tearsheetFooter(data?.strategy).join(' · ');

  const inner = drawPane(screen, rect, {
    title: 'TEARSHEET',
    focused,
    key: ctx.paneKey('metrics'),
    legend: fillModelNote(data?.strategy),
  });
  if (inner.h <= 0) return;

  if (data?.strategy == null) {
    screen.text(inner.x, inner.y, 'no run loaded', STYLE.muted, inner);
    return;
  }

  const sections = tearsheetSections(data.strategy);
  const returns = sections.find((section) => section.title === 'RETURNS');
  const risk = sections.find((section) => section.title === 'RISK');
  const trades = sections.find((section) => section.title === 'TRADES');
  const bottom = inner.y + inner.h;
  let metricsEndY: number;

  if (inner.w >= DISTRIBUTION_MIN_COLS * 2 + METRIC_GAP_COLS) {
    // RETURNS and RISK form the left reading track; the taller TRADES section
    // occupies the right. Both tracks finish before diagnostics take the full
    // pane width below them.
    const leftW = Math.min(METRIC_RAIL_COLS, Math.floor((inner.w - METRIC_GAP_COLS) / 2));
    const leftRect: Rect = { ...inner, w: leftW };
    const rightRect: Rect = {
      x: inner.x + leftW + METRIC_GAP_COLS,
      y: inner.y,
      w: inner.w - leftW - METRIC_GAP_COLS,
      h: inner.h,
    };

    let leftY = drawMetricSection(screen, leftRect, returns, leftRect.y);
    if (risk != null && leftY < bottom) leftY += 1;
    leftY = drawMetricSection(screen, leftRect, risk, leftY);
    const rightY = drawMetricSection(screen, rightRect, trades, rightRect.y);
    metricsEndY = Math.max(leftY, rightY);
  } else {
    // Extremely narrow panes cannot sustain two readable value columns. Keep
    // the same semantic order in one track instead of clipping both columns.
    let y = drawMetricSection(screen, inner, returns, inner.y);
    if (trades != null && y < bottom) y += 1;
    y = drawMetricSection(screen, inner, trades, y);
    if (risk != null && y < bottom) y += 1;
    metricsEndY = drawMetricSection(screen, inner, risk, y);
  }

  if (footer !== '' && metricsEndY + 1 < bottom) {
    metricsEndY += 1;
    screen.text(inner.x, metricsEndY, truncate(footer, inner.w), STYLE.muted, inner);
    metricsEndY += 1;
  }

  // Every diagnostic below the metric header owns the complete TEARSHEET
  // width, in the requested order. Stop if TOP DRAWDOWNS cannot fit so a later
  // section never jumps ahead of it.
  const drawdownsY = metricsEndY + (metricsEndY < bottom ? 1 : 0);
  const drawdownsEndY = drawTopDrawdowns(ctx, inner, data, drawdownsY);
  if (drawdownsEndY <= drawdownsY) return;

  const analysisY = drawdownsEndY + 1;
  drawTradeAnalysis(
    ctx,
    {
      ...inner,
      y: analysisY,
      h: Math.max(0, bottom - analysisY),
    },
    data,
  );
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

    const leftW = Math.min(32, Math.max(24, Math.floor(screen.cols * 0.21)));
    // Prefer two full 38-column metric tracks while retaining a useful center.
    // Smaller terminals keep the prior responsive rail and stack only if even
    // two compact metric columns cannot be read honestly.
    const baseRailW = Math.min(102, Math.max(70, Math.floor(screen.cols * 0.46)));
    const canFitStructuredTearsheet = screen.cols - leftW - STRUCTURED_TEARSHEET_COLS >= 32;
    const railW = narrow
      ? 0
      : canFitStructuredTearsheet
        ? Math.max(baseRailW, STRUCTURED_TEARSHEET_COLS)
        : baseRailW;
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
