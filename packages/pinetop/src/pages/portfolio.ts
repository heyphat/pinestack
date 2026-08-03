/**
 * PORTFOLIO (§4.2, page 5) — combine N symbols against one pot.
 *
 * The mode is load-bearing and is shown at every altitude: `isolated` is N
 * sub-accounts summed, `shared` is one pot whose sizing, funds checks and margin
 * read portfolio equity, so trades can differ from any per-symbol run. The
 * sleeve correlation column is NaN under shared mode by construction (spec S2 —
 * sleeve curves sample pot equity there), so the pane says `shared` rather than
 * printing a column of `na` and letting it read as missing data.
 */

import { correlationMatrixAscii, equityChartAscii } from '@heyphat/pinerun';
import { schemaFor } from '../flags/schema.js';
import { compactMoney, duration, int, num, pct } from '../render/format.js';
import { drawPane, truncate, type Rect } from '../render/screen.js';
import {
  drawHeader,
  drawLeader,
  drawRow,
  fitColumns,
  type Column,
  type Row,
} from '../render/table.js';
import { STYLE } from '../render/theme.js';
import { scriptLabel } from '../scripts.js';
import type { AppState } from '../state.js';
import type { PortfolioJson, SleeveJson } from '../views/report.js';
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
} from './strategies-pane.js';
import { clampCursor, columns, rows, windowFor, type Page, type PageContext } from './page.js';

const PANES = [STRATEGIES_PANE, 'config', 'sleeves', 'summary', HISTORY_PANE] as const;

export function report(state: AppState): PortfolioJson | undefined {
  if (state.run?.command !== 'portfolio' || state.run.status !== 'ok') return undefined;
  return state.run.report as PortfolioJson | undefined;
}

export function sleeves(state: AppState): SleeveJson[] {
  return report(state)?.sleeves ?? [];
}

function drawSleeves(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const list = data?.sleeves ?? [];
  const shared = data?.mode === 'shared';

  const legend: string[] = [];
  if (data?.mode) legend.push(data.mode);
  if (data?.initialCapital != null) legend.push(`pot ${compactMoney(data.initialCapital)}`);
  if (data?.elapsedMs != null) legend.push(duration(data.elapsedMs));

  const inner = drawPane(screen, rect, {
    title: 'SLEEVES',
    focused: ctx.focus === 'sleeves',
    key: ctx.paneKey('sleeves'),
    legend: legend.length > 0 ? legend.join(' · ') : undefined,
  });
  if (inner.h <= 1) return;

  if (data == null) {
    const message =
      state.run?.status === 'running'
        ? state.run.progress || 'running sleeves…'
        : state.run?.status === 'failed'
          ? (state.run.error ?? 'portfolio failed')
          : 'press r to run';
    screen.text(inner.x, inner.y, message, STYLE.muted, inner);
    return;
  }

  const candidates: Column[] = [
    { key: 'symbol', header: 'SYMBOL', width: 14, priority: 100 },
    { key: 'funding', header: 'FUNDING', width: 11, align: 'right', priority: 50 },
    { key: 'net', header: 'NET', width: 12, align: 'right', priority: 90 },
    { key: 'contrib', header: 'CONTRIB%', width: 9, align: 'right', priority: 95 },
    { key: 'trades', header: 'TRADES', width: 7, align: 'right', priority: 60 },
    { key: 'margin', header: 'MCALL', width: 6, align: 'right', priority: 70 },
    { key: 'corr', header: 'CORR', width: 7, align: 'right', priority: 80 },
    { key: 'bars', header: 'BARS', width: 8, align: 'right', priority: 20 },
  ];
  const { columns: cols, dropped } = fitColumns(candidates, inner.w);
  drawHeader(screen, inner, cols);

  const listRows = Math.max(0, inner.h - 2);
  const cursor = clampCursor(ctx.cursor('sleeves'), list.length);
  const { from, to } = windowFor(cursor, list.length, listRows);

  for (let i = from; i < to; i++) {
    const sleeve = list[i]!;
    const row: Row = {
      symbol: sleeve.symbol ?? '—',
      funding: shared ? { text: 'pot', style: STYLE.muted } : compactMoney(sleeve.funding),
      net: {
        text: compactMoney(sleeve.netProfit),
        style: (sleeve.netProfit ?? 0) >= 0 ? STYLE.positive : STYLE.negative,
      },
      // Already a percent on the wire (65.75, not 0.6575) — the field's own
      // doc comment describes the ratio, but the emitted value is scaled.
      contrib: {
        text: sleeve.contributionPercent == null ? '—' : sleeve.contributionPercent.toFixed(1),
        style: (sleeve.contributionPercent ?? 0) >= 0 ? STYLE.none : STYLE.negative,
      },
      trades: int(sleeve.closedTrades),
      margin: {
        text: int(sleeve.marginCalls),
        style: (sleeve.marginCalls ?? 0) > 0 ? STYLE.error : STYLE.muted,
      },
      // NaN here is a property of shared mode, not a gap in the data (spec S2).
      corr: shared ? { text: 'shared', style: STYLE.muted } : num(sleeve.returnCorrelation),
      bars: int(sleeve.barsProcessed),
    };
    drawRow(screen, inner, inner.y + 1 + (i - from), cols, row, {
      selected: i === cursor && ctx.focus === 'sleeves',
    });
  }

  const notes: string[] = [];
  if (dropped.length > 0) notes.push(`dropped ${dropped.join(', ')}`);
  const droppedSymbols = data.fetchErrors ?? [];
  if (droppedSymbols.length > 0) {
    // Under shared mode a smaller basket is a DIFFERENT backtest — say so.
    notes.push(
      shared
        ? `${droppedSymbols.length} symbol(s) dropped — shared mode: this is a different basket`
        : `${droppedSymbols.length} symbol(s) dropped: ${droppedSymbols.map((e) => e.symbol).join(', ')}`,
    );
  }
  if (notes.length > 0) {
    screen.text(
      inner.x,
      inner.y + inner.h - 1,
      truncate(notes.join(' · '), inner.w),
      STYLE.warn,
      inner,
    );
  }
}

function drawSummary(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);

  const inner = drawPane(screen, rect, {
    title: 'PORTFOLIO',
    focused: ctx.focus === 'summary',
    key: ctx.paneKey('summary'),
  });
  if (inner.h <= 0) return;

  if (data?.summary == null) {
    screen.text(inner.x, inner.y, 'no run loaded', STYLE.muted, inner);
    return;
  }

  const s = data.summary;
  const m = data.metrics;
  let y = inner.y;
  drawLeader(screen, inner, y++, 'mode', data.mode ?? '—');
  drawLeader(screen, inner, y++, 'capital', compactMoney(data.initialCapital));
  drawLeader(screen, inner, y++, 'net', compactMoney(s.netProfit), {
    valueStyle: s.netProfit >= 0 ? STYLE.positive : STYLE.negative,
  });
  drawLeader(screen, inner, y++, 'net %', pct(s.netProfitPercent), {
    valueStyle: s.netProfitPercent >= 0 ? STYLE.positive : STYLE.negative,
  });
  drawLeader(screen, inner, y++, 'max DD %', pct(-Math.abs(s.maxDrawdownPercent)), {
    valueStyle: STYLE.negative,
  });
  drawLeader(screen, inner, y++, 'Sharpe', num(m?.sharpe));
  drawLeader(screen, inner, y++, 'Sortino', num(m?.sortino));
  drawLeader(screen, inner, y++, 'CAGR', pct(m?.cagrPercent));
  drawLeader(screen, inner, y++, 'trades', int(s.closedTrades));

  // The combined equity curve, small — the sleeve detail is the table's job.
  const equity = data.equityCurve ?? [];
  const remaining = inner.y + inner.h - y - 1;
  if (equity.length >= 2 && remaining >= 5) {
    y += 1;
    screen.text(inner.x, y, 'EQUITY', STYLE.title, inner);
    screen.block(
      inner.x,
      y + 1,
      equityChartAscii(equity, {
        width: Math.max(16, inner.w - 10),
        height: Math.max(3, remaining - 3),
        times: data.times,
        capital: data.initialCapital,
      }),
      STYLE.none,
      inner,
    );
  }
}

/**
 * The isolated-mode sleeve return correlation matrix, which the CLI prints
 * unconditionally on a portfolio tearsheet. Omitted under shared mode for the
 * same reason the column is (spec S2).
 */
function drawCorrelation(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const inner = drawPane(screen, rect, {
    title: 'SLEEVE RETURN CORRELATION',
    focused: ctx.focus === 'correlation',
  });
  if (inner.h <= 0) return;

  if (data == null) return;
  if (data.mode === 'shared') {
    screen.text(
      inner.x,
      inner.y,
      'shared mode: sleeve curves sample pot equity, so correlation is identically 1',
      STYLE.muted,
      inner,
    );
    return;
  }

  const items = (data.sleeves ?? [])
    .filter((s) => s.symbol != null && (s.equityCurve?.length ?? 0) > 1)
    .map((s) => ({ label: s.symbol!, series: s.equityCurve! }));
  if (items.length < 2) {
    screen.text(inner.x, inner.y, 'needs two sleeves with curves', STYLE.muted, inner);
    return;
  }
  screen.block(inner.x, inner.y, correlationMatrixAscii(items), STYLE.none, inner);
}

export const portfolioPage: Page = {
  id: 'portfolio',
  command: 'portfolio',
  minCols: schemaFor('portfolio').minCols,

  panes: (state) => (report(state)?.mode === 'isolated' ? [...PANES, 'correlation'] : [...PANES]),

  rowCount: (state, paneId) => {
    if (paneId === HISTORY_PANE) return historyRowCount(state, 'portfolio');
    if (paneId === STRATEGIES_PANE) return strategyRowCount();
    if (paneId === 'config') return configRowCount(state, 'portfolio');
    if (paneId === 'sleeves') return sleeves(state).length;
    return 0;
  },

  breadcrumb: (state) => {
    const model = state.flags.portfolio;
    const crumbs = ['pinetop'];
    const script = model.scripts[0];
    crumbs.push(script == null ? '(no script)' : scriptLabel(script));
    const data = report(state);
    if (data?.symbols != null) crumbs.push(`${data.symbols.length} sleeves`);
    if (data?.mode) crumbs.push(data.mode);
    if (state.run != null) crumbs.push(`run ${state.run.id}`);
    return crumbs;
  },

  confirm: (state) => {
    if (state.panes.portfolio.focus === HISTORY_PANE) return loadRun(state, 'portfolio');
    if (state.panes.portfolio.focus === STRATEGIES_PANE) return loadStrategy(state, 'portfolio');
    if (state.panes.portfolio.focus !== 'sleeves') return undefined;
    const list = sleeves(state);
    const sleeve = list[clampCursor(state.panes.portfolio.cursor['sleeves'] ?? 0, list.length)];
    if (sleeve?.symbol == null) return undefined;

    state.flags.backtest.scripts = [...state.flags.portfolio.scripts];
    state.flags.backtest.values['symbol'] = sleeve.symbol;
    for (const key of ['tf', 'from', 'to', 'limit'] as const) {
      const value = state.flags.portfolio.values[key];
      if (value != null) state.flags.backtest.values[key] = value;
    }
    state.page = 'backtest';
    return `loaded sleeve ${sleeve.symbol} into BACKTEST — press r`;
  },

  render: (ctx) => {
    const { body, screen, state } = ctx;
    const narrow = screen.cols < portfolioPage.minCols;
    const leftW = Math.min(34, Math.max(26, Math.floor(screen.cols * 0.22)));
    const railW = narrow ? 0 : Math.min(32, Math.floor(screen.cols * 0.22));
    const isolated = report(state)?.mode === 'isolated';
    const corrH = isolated && !narrow ? Math.min(12, Math.max(0, Math.floor(body.h * 0.34))) : 0;

    const [leftCol, midCol, rightCol] = columns(body, [leftW, body.w - leftW - railW]) as [
      Rect,
      Rect,
      Rect,
    ];
    const [sleeveRect, corrRect] = rows(midCol, [midCol.h - corrH]) as [Rect, Rect];

    const stratH = strategiesHeight(leftCol.h);
    const histH = historyHeight(leftCol.h);
    const [stratRect, configRect, histRect] = rows(leftCol, [
      stratH,
      leftCol.h - stratH - histH,
    ]) as [Rect, Rect, Rect];
    drawStrategiesPane(ctx, stratRect, { command: 'portfolio' });
    drawConfigPane(ctx, configRect, { command: 'portfolio' });
    drawHistoryPane(ctx, histRect, 'portfolio');
    drawSleeves(ctx, sleeveRect);
    if (corrH > 0) drawCorrelation(ctx, corrRect);
    if (railW > 0) drawSummary(ctx, rightCol);
  },
};
