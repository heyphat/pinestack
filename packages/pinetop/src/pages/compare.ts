/**
 * COMPARE (§4.2, page 6) — two strategies on the same bars.
 *
 * This is the page that answers "did that help?", which §2 lists as the second
 * friction of the one-shot CLI: the previous run is in scrollback, or gone. The
 * A/B metric table puts both columns on one grid and the overlay puts both
 * curves on one axis, normalized, so the comparison is read rather than
 * remembered.
 */

import { overlayChartAscii } from '@heyphat/pinerun';
import type { StrategySummary } from '@heyphat/pinerun';
import { schemaFor } from '../flags/schema.js';
import { compactMoney, int, num, pct } from '../render/format.js';
import { drawPane, padEnd, padStart, truncate, type Rect } from '../render/screen.js';
import { STYLE, type Style } from '../render/theme.js';
import { scriptLabel } from '../scripts.js';
import type { AppState } from '../state.js';
import { profitFactor, type CompareJson } from '../views/report.js';
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

const PANES = [STRATEGIES_PANE, 'config', 'metrics', 'overlay', HISTORY_PANE] as const;

export function report(state: AppState): CompareJson | undefined {
  if (state.run?.command !== 'compare' || state.run.status !== 'ok') return undefined;
  return state.run.report as CompareJson | undefined;
}

interface CompareRow {
  label: string;
  a: string;
  b: string;
  /** +1 when higher is better, -1 when lower is better, 0 when neither. */
  better: number;
  /** Raw values, for deciding which side wins. */
  rawA: number;
  rawB: number;
}

function row(
  label: string,
  rawA: number | undefined,
  rawB: number | undefined,
  format: (v: number | undefined) => string,
  better: number,
): CompareRow {
  return {
    label,
    a: format(rawA),
    b: format(rawB),
    better,
    rawA: rawA ?? NaN,
    rawB: rawB ?? NaN,
  };
}

/** The metric rows, mirroring the columns `printCompare` puts side by side. */
export function compareRows(
  a: StrategySummary | undefined,
  b: StrategySummary | undefined,
): CompareRow[] {
  if (a == null || b == null) return [];
  const money = (v: number | undefined): string => compactMoney(v);
  const percent = (v: number | undefined): string => pct(v);
  const plain = (v: number | undefined): string => num(v);
  const count = (v: number | undefined): string => int(v);

  return [
    row('Net profit', a.netProfit, b.netProfit, money, 1),
    row('Net %', a.netProfitPercent, b.netProfitPercent, percent, 1),
    row('CAGR %', a.metrics?.cagrPercent, b.metrics?.cagrPercent, percent, 1),
    row('Sharpe', a.metrics?.sharpe, b.metrics?.sharpe, plain, 1),
    row('Sortino', a.metrics?.sortino, b.metrics?.sortino, plain, 1),
    row('Calmar', a.metrics?.calmar, b.metrics?.calmar, plain, 1),
    // Negated so it reads the same way it does on BACKTEST, which also makes
    // "higher is better" the right comparison (−1.9% beats −3.2%).
    row('Max DD %', -Math.abs(a.maxDrawdownPercent), -Math.abs(b.maxDrawdownPercent), percent, 1),
    row('Volatility %', a.metrics?.volatilityPercent, b.metrics?.volatilityPercent, percent, -1),
    row('Exposure %', a.metrics?.exposurePercent, b.metrics?.exposurePercent, percent, 0),
    row('Hit rate %', a.winRate * 100, b.winRate * 100, percent, 1),
    // profitFactor is Infinity when a side has no losing trade, and JSON writes
    // Infinity as null — so the sibling gross fields decide the ∞ case.
    {
      label: 'Profit factor',
      a: profitFactor(a),
      b: profitFactor(b),
      better: 1,
      rawA: Number.isFinite(a.profitFactor) ? a.profitFactor : Infinity,
      rawB: Number.isFinite(b.profitFactor) ? b.profitFactor : Infinity,
    },
    row('Expectancy', a.metrics?.expectancy, b.metrics?.expectancy, money, 1),
    row('Trades', a.closedTrades, b.closedTrades, count, 0),
    row('Commission', a.totalCommission, b.totalCommission, money, -1),
    row('Outperformance', a.metrics?.outperformance, b.metrics?.outperformance, money, 1),
  ];
}

function winnerStyles(entry: CompareRow): { a: Style; b: Style } {
  if (entry.better === 0 || !Number.isFinite(entry.rawA) || !Number.isFinite(entry.rawB)) {
    return { a: STYLE.none, b: STYLE.none };
  }
  if (entry.rawA === entry.rawB) return { a: STYLE.none, b: STYLE.none };
  const aWins = entry.better > 0 ? entry.rawA > entry.rawB : entry.rawA < entry.rawB;
  return aWins ? { a: STYLE.accentBold, b: STYLE.muted } : { a: STYLE.muted, b: STYLE.accentBold };
}

function drawMetrics(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const labelA = data?.a?.label ?? 'A';
  const labelB = data?.b?.label ?? 'B';

  const inner = drawPane(screen, rect, {
    title: 'A / B',
    focused: ctx.focus === 'metrics',
    key: ctx.paneKey('metrics'),
    legend: data?.symbol != null ? `${data.symbol} @ ${data.timeframe ?? ''}` : undefined,
  });
  if (inner.h <= 1) return;

  if (data == null) {
    const message =
      state.run?.status === 'running'
        ? state.run.progress || 'comparing…'
        : state.run?.status === 'failed'
          ? (state.run.error ?? 'compare failed')
          : 'press r to compare';
    screen.text(inner.x, inner.y, message, STYLE.muted, inner);
    return;
  }

  const labelW = Math.min(18, Math.max(12, Math.floor(inner.w * 0.34)));
  const colW = Math.max(10, Math.floor((inner.w - labelW) / 2));

  screen.text(inner.x, inner.y, padEnd('', labelW), STYLE.muted, inner);
  screen.text(
    inner.x + labelW,
    inner.y,
    padStart(truncate(`A: ${labelA}`, colW), colW),
    STYLE.title,
    inner,
  );
  screen.text(
    inner.x + labelW + colW,
    inner.y,
    padStart(truncate(`B: ${labelB}`, colW), colW),
    STYLE.title,
    inner,
  );

  const list = compareRows(data.a?.result?.strategy, data.b?.result?.strategy);
  const listRows = Math.max(0, inner.h - 1);
  const cursor = clampCursor(ctx.cursor('metrics'), list.length);
  const { from, to } = windowFor(cursor, list.length, listRows);

  for (let i = from; i < to; i++) {
    const entry = list[i]!;
    const y = inner.y + 1 + (i - from);
    if (y >= inner.y + inner.h) break;
    const selected = i === cursor && ctx.focus === 'metrics';
    const styles = winnerStyles(entry);

    if (selected) screen.text(inner.x, y, ' '.repeat(inner.w), STYLE.selected);
    screen.text(
      inner.x,
      y,
      padEnd(truncate(entry.label, labelW), labelW),
      selected ? STYLE.selected : STYLE.none,
      inner,
    );
    screen.text(
      inner.x + labelW,
      y,
      padStart(entry.a, colW),
      selected ? STYLE.selected : styles.a,
      inner,
    );
    screen.text(
      inner.x + labelW + colW,
      y,
      padStart(entry.b, colW),
      selected ? STYLE.selected : styles.b,
      inner,
    );
  }
}

function drawOverlay(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);

  const inner = drawPane(screen, rect, {
    title: 'EQUITY OVERLAY',
    focused: ctx.focus === 'overlay',
    key: ctx.paneKey('overlay'),
    legend: data == null ? undefined : 'normalized · A solid / B dotted',
  });
  if (inner.h <= 0) return;
  if (data == null) return;

  const a = data.a?.result?.equityCurve ?? [];
  const b = data.b?.result?.equityCurve ?? [];
  if (a.length < 2 || b.length < 2) {
    screen.text(inner.x, inner.y, 'no curves in this report', STYLE.muted, inner);
    return;
  }

  // color: true is required, not decorative — the builder's own note says the
  // two lines merge into one shape without it. styledBlock maps the codes onto
  // cells so clipping still works.
  screen.styledBlock(
    inner.x,
    inner.y + 1,
    overlayChartAscii(a, b, {
      width: Math.max(16, inner.w - 12),
      height: Math.max(4, inner.h - 3),
      times: data.a?.result?.barTimes,
      color: true,
    }),
    STYLE.none,
    inner,
  );

  const labelA = data.a?.label ?? 'A';
  const labelB = data.b?.label ?? 'B';
  screen.text(inner.x, inner.y, 'A ', STYLE.accent, inner);
  screen.text(
    inner.x + 2,
    inner.y,
    truncate(labelA, Math.floor(inner.w / 2) - 4),
    STYLE.muted,
    inner,
  );
  const bx = inner.x + Math.floor(inner.w / 2);
  screen.text(bx, inner.y, 'B ', STYLE.warn, inner);
  screen.text(bx + 2, inner.y, truncate(labelB, Math.floor(inner.w / 2) - 4), STYLE.muted, inner);
}

export const comparePage: Page = {
  id: 'compare',
  command: 'compare',
  minCols: schemaFor('compare').minCols,

  panes: () => [...PANES],

  rowCount: (state, paneId) => {
    if (paneId === HISTORY_PANE) return historyRowCount(state, 'compare');
    if (paneId === STRATEGIES_PANE) return strategyRowCount(state);
    if (paneId === 'config') return configRowCount(state, 'compare');
    if (paneId === 'metrics') {
      const data = report(state);
      return compareRows(data?.a?.result?.strategy, data?.b?.result?.strategy).length;
    }
    return 0;
  },

  breadcrumb: (state) => {
    const model = state.flags.compare;
    const crumbs = ['pinetop'];
    const a = model.scripts[0];
    const b = model.scripts[1];
    crumbs.push(
      a == null && b == null
        ? '(no scripts)'
        : `${a == null ? '—' : scriptLabel(a)} vs ${b == null ? '—' : scriptLabel(b)}`,
    );
    const data = report(state);
    if (data?.symbol) crumbs.push(`${data.symbol} @ ${data.timeframe ?? ''}`);
    if (state.run != null) crumbs.push(`run ${state.run.id}`);
    return crumbs;
  },

  // COMPARE's only ↵ is the script picker: A and B are the page, and the metric
  // table has nothing to load anywhere.
  confirm: (state) => {
    if (state.panes.compare.focus === HISTORY_PANE) return loadRun(state, 'compare');
    return state.panes.compare.focus === STRATEGIES_PANE
      ? loadStrategy(state, 'compare')
      : undefined;
  },

  render: (ctx) => {
    const { body, screen } = ctx;
    const leftW = Math.min(34, Math.max(26, Math.floor(screen.cols * 0.24)));
    const overlayH = Math.min(16, Math.max(0, Math.floor(body.h * 0.45)));

    const [leftCol, rightCol] = columns(body, [leftW]) as [Rect, Rect];
    const [metricsRect, overlayRect] = rows(rightCol, [rightCol.h - overlayH]) as [Rect, Rect];

    const stratH = strategiesHeight(leftCol.h);
    const histH = historyHeight(leftCol.h);
    const [stratRect, configRect, histRect] = rows(leftCol, [
      stratH,
      leftCol.h - stratH - histH,
    ]) as [Rect, Rect, Rect];
    drawStrategiesPane(ctx, stratRect, { command: 'compare' });
    drawConfigPane(ctx, configRect, { command: 'compare' });
    drawHistoryPane(ctx, histRect, 'compare');
    drawMetrics(ctx, metricsRect);
    if (overlayH > 0) drawOverlay(ctx, overlayRect);
  },
};
