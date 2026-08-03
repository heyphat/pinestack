/**
 * SWEEP (§4.2, page 2) — optimize one script's input grid.
 *
 * The pane that matters is RANKED: it is what `walkforward` exists to distrust
 * (§2), so `w` from a selected winner is the workflow edge this page carries.
 * The EQUITY sparkline column is a payoff column and is priced accordingly in
 * `fitColumns` — §4.4 names it as one of the two columns that must not fall off
 * the right edge.
 */

import { sparkline } from '@heyphat/pinerun';
import type { Pair } from '../flags/model.js';
import { schemaFor } from '../flags/schema.js';
import { compactMoney, duration, int, num } from '../render/format.js';
import { drawPane, truncate, type Rect } from '../render/screen.js';
import { drawHeader, drawRow, fitColumns, type Column, type Row } from '../render/table.js';
import { STYLE } from '../render/theme.js';
import { scriptLabel } from '../scripts.js';
import type { AppState } from '../state.js';
import { buildHeatmap, heatmapLegend } from '../views/heatmap.js';
import type { SweepJson, SweepRankedJson } from '../views/report.js';
import { configRowCount, drawConfigPane } from './config-pane.js';
import {
  HISTORY_PANE,
  drawHistoryPane,
  historyHeight,
  historyRowCount,
  loadRun,
} from './history-pane.js';
import { axisRows, beginAxisEdit, drawAxisPane } from './inputs-pane.js';
import {
  STRATEGIES_PANE,
  drawStrategiesPane,
  loadStrategy,
  strategiesHeight,
  strategyRowCount,
} from './strategies-pane.js';
import { clampCursor, columns, rows, windowFor, type Page, type PageContext } from './page.js';

const PANES = [STRATEGIES_PANE, 'inputs', 'config', 'ranked', 'heatmap', HISTORY_PANE] as const;

export function report(state: AppState): SweepJson | undefined {
  if (state.run?.command !== 'sweep' || state.run.status !== 'ok') return undefined;
  return state.run.report as SweepJson | undefined;
}

export function rankedRows(state: AppState): SweepRankedJson[] {
  return report(state)?.ranked ?? [];
}

/** The combo selected in RANKED — what `w` hands to WALKFORWARD (§7 P6). */
export function selectedCombo(state: AppState): SweepRankedJson | undefined {
  const list = rankedRows(state);
  if (list.length === 0) return undefined;
  return list[clampCursor(state.panes.sweep.cursor['ranked'] ?? 0, list.length)];
}

function axisColumns(axes: readonly { name: string }[], width: number): Column[] {
  // Axis columns come first and are never dropped: without them a ranked row
  // does not say which combo it is.
  const axisWidth = Math.max(6, Math.min(11, Math.floor((width - 46) / Math.max(1, axes.length))));
  return axes.map((axis) => ({
    key: `axis:${axis.name}`,
    header: truncate(axis.name.toUpperCase(), axisWidth),
    width: axisWidth,
    align: 'right' as const,
    priority: 100,
  }));
}

function drawRanked(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const list = data?.ranked ?? [];
  const axes = data?.axes ?? [];

  const legendParts: string[] = [];
  if (data?.rank) legendParts.push(`rank ${data.rank}`);
  if (data?.total != null) legendParts.push(`${int(data.total)} runs`);
  if (data?.sample != null) legendParts.push(`sample ${int(data.sample)}/${int(data.gridTotal)}`);
  if (data?.elapsedMs != null) legendParts.push(duration(data.elapsedMs));

  const inner = drawPane(screen, rect, {
    title: 'RANKED',
    focused: ctx.focus === 'ranked',
    key: ctx.paneKey('ranked'),
    legend: legendParts.length > 0 ? legendParts.join(' · ') : undefined,
  });
  if (inner.h <= 1) return;

  if (data == null) {
    const message =
      state.run?.status === 'running'
        ? state.run.progress || 'sweeping…'
        : state.run?.status === 'failed'
          ? (state.run.error ?? 'sweep failed')
          : 'press r to sweep';
    screen.text(inner.x, inner.y, message, STYLE.muted, inner);
    return;
  }

  const multiSymbol = (data.symbols?.length ?? 0) > 1;
  const candidates: Column[] = [
    { key: 'n', header: '#', width: 3, align: 'right', priority: 90 },
    ...(multiSymbol
      ? [{ key: 'symbol', header: 'SYMBOL', width: 12, priority: 80 } satisfies Column]
      : []),
    ...axisColumns(axes, inner.w),
    { key: 'value', header: 'VALUE', width: 11, align: 'right', priority: 95 },
    { key: 'net', header: 'NET%', width: 8, align: 'right', priority: 70 },
    { key: 'dd', header: 'MAXDD%', width: 8, align: 'right', priority: 60 },
    { key: 'sharpe', header: 'SHARPE', width: 7, align: 'right', priority: 65 },
    { key: 'trades', header: 'TRADES', width: 7, align: 'right', priority: 40 },
    // The payoff column: it is why --trades was passed, so it outranks the
    // secondary metrics when width runs short (§4.4).
    { key: 'equity', header: 'EQUITY', width: 16, priority: 75 },
  ];

  const { columns: cols, dropped } = fitColumns(candidates, inner.w);
  drawHeader(screen, inner, cols);

  const listRows = Math.max(0, inner.h - 1);
  const cursor = clampCursor(ctx.cursor('ranked'), list.length);
  const { from, to } = windowFor(cursor, list.length, listRows);

  for (let i = from; i < to; i++) {
    const point = list[i]!;
    const strategy = point.strategy;
    const row: Row = {
      n: String(i + 1),
      symbol: point.symbol ?? '',
      value: { text: num(point.value), style: STYLE.bold },
      net: {
        text: strategy == null ? '—' : `${strategy.netProfitPercent.toFixed(1)}`,
        style: (strategy?.netProfitPercent ?? 0) >= 0 ? STYLE.positive : STYLE.negative,
      },
      dd: {
        text: strategy == null ? '—' : `-${Math.abs(strategy.maxDrawdownPercent).toFixed(1)}`,
        style: STYLE.negative,
      },
      sharpe: num(strategy?.metrics?.sharpe),
      trades: strategy == null ? '—' : int(strategy.closedTrades),
      equity:
        point.equityCurve != null && point.equityCurve.length > 1
          ? sparkline(point.equityCurve, 16)
          : '',
    };
    for (const axis of axes) row[`axis:${axis.name}`] = String(point.inputs?.[axis.name] ?? '');

    drawRow(screen, inner, inner.y + 1 + (i - from), cols, row, {
      selected: i === cursor && ctx.focus === 'ranked',
    });
  }

  if (list.length === 0) {
    screen.text(inner.x, inner.y + 1, 'no ranked combos — every run failed', STYLE.warn, inner);
  }

  // Dropped columns and fetch failures are stated, never swallowed (§6, §8).
  const notes: string[] = [];
  if (dropped.length > 0) notes.push(`dropped ${dropped.join(', ')} — widen the terminal`);
  const fetchErrors = data.fetchErrors ?? [];
  if (fetchErrors.length > 0) notes.push(`${fetchErrors.length} fetch failed`);
  const errors = data.errors ?? [];
  if (errors.length > 0) notes.push(`${errors.length} runs errored`);
  if (notes.length > 0) {
    const text = truncate(notes.join(' · '), inner.w);
    screen.text(inner.x, inner.y + inner.h - 1, text, STYLE.warn, inner);
  }
}

function drawHeatmap(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const map = buildHeatmap(data?.axes, data?.ranked, data?.symbol);
  const top =
    typeof state.flags.sweep.values['top'] === 'number'
      ? state.flags.sweep.values['top']
      : undefined;

  const inner = drawPane(screen, rect, {
    title: 'SURFACE',
    focused: ctx.focus === 'heatmap',
    key: ctx.paneKey('heatmap'),
    legend: map == null ? undefined : heatmapLegend(map, top),
  });
  if (inner.h <= 0) return;

  if (map == null) {
    screen.text(
      inner.x,
      inner.y,
      data == null ? 'no run loaded' : 'the surface needs exactly two --input axes',
      STYLE.muted,
      inner,
    );
    return;
  }

  const cellW = 7;
  const labelW = Math.max(6, ...map.yLabels.map((l) => l.length));
  screen.text(
    inner.x,
    inner.y,
    truncate(`${map.yAxis.name} ↓ / ${map.xAxis.name} →`, inner.w),
    STYLE.muted,
    inner,
  );

  // Column headers.
  let x = inner.x + labelW + 1;
  for (const label of map.xLabels) {
    if (x + cellW > inner.x + inner.w) break;
    screen.text(x, inner.y + 1, label.padStart(cellW), STYLE.muted, inner);
    x += cellW;
  }

  for (let r = 0; r < map.rows.length; r++) {
    const y = inner.y + 2 + r;
    if (y >= inner.y + inner.h) break;
    screen.text(inner.x, y, truncate(map.yLabels[r]!, labelW).padEnd(labelW), STYLE.muted, inner);
    let cx = inner.x + labelW + 1;
    for (const cell of map.rows[r]!) {
      if (cx + cellW > inner.x + inner.w) break;
      screen.text(cx, y, cell.text.padStart(cellW), cell.present ? cell.style : STYLE.muted, inner);
      cx += cellW;
    }
  }
}

export const sweepPage: Page = {
  id: 'sweep',
  command: 'sweep',
  minCols: schemaFor('sweep').minCols,

  panes: () => [...PANES],

  rowCount: (state, paneId) => {
    if (paneId === HISTORY_PANE) return historyRowCount(state, 'sweep');
    if (paneId === STRATEGIES_PANE) return strategyRowCount();
    if (paneId === 'inputs') return axisRows(state, 'sweep').length;
    if (paneId === 'config') return configRowCount(state, 'sweep');
    if (paneId === 'ranked') return rankedRows(state).length;
    return 0;
  },

  breadcrumb: (state) => {
    const model = state.flags.sweep;
    const crumbs = ['pinetop'];
    const script = model.scripts[0];
    crumbs.push(script == null ? '(no script)' : scriptLabel(script));
    const data = report(state);
    if (data?.symbol) crumbs.push(data.symbol);
    if (data?.combos != null) {
      crumbs.push(
        data.sample != null
          ? `${int(data.sample)} of ${int(data.gridTotal)} combos`
          : `${int(data.combos)} combos`,
      );
    }
    if (state.run != null) crumbs.push(`run ${state.run.id}`);
    return crumbs;
  },

  confirm: (state) => {
    if (state.panes.sweep.focus === HISTORY_PANE) return loadRun(state, 'sweep');
    if (state.panes.sweep.focus === STRATEGIES_PANE) return loadStrategy(state, 'sweep');
    // ↵ on an input opens that one axis for typing — see `beginAxisEdit`.
    if (state.panes.sweep.focus === 'inputs') return beginAxisEdit(state, 'sweep');
    // ↵ on a ranked row loads that combo into BACKTEST as fixed inputs — the
    // sweep → backtest deep-dive edge (§2, §4.2).
    if (state.panes.sweep.focus !== 'ranked') return undefined;
    const combo = selectedCombo(state);
    if (combo == null) return undefined;
    const pairs: Pair[] = Object.entries(combo.inputs ?? {}).map(([name, value]) => ({
      name,
      value: String(value),
    }));
    state.flags.backtest.scripts = [...state.flags.sweep.scripts];
    state.flags.backtest.values['input'] = pairs;
    if (combo.symbol != null) state.flags.backtest.values['symbol'] = combo.symbol;
    else if (state.flags.sweep.values['symbol'] != null) {
      state.flags.backtest.values['symbol'] = state.flags.sweep.values['symbol'];
    }
    for (const key of ['tf', 'from', 'to', 'limit'] as const) {
      const value = state.flags.sweep.values[key];
      if (value != null) state.flags.backtest.values[key] = value;
    }
    state.page = 'backtest';
    return `loaded combo into BACKTEST — press r to run`;
  },

  render: (ctx) => {
    const { body, screen } = ctx;
    const narrow = screen.cols < sweepPage.minCols;
    const leftW = Math.min(34, Math.max(26, Math.floor(screen.cols * 0.22)));
    // SURFACE sits under RANKED inside the right column rather than spanning the
    // frame, so the sidebar runs the full height and has room for HISTORY. The
    // cost is the sidebar's width: the heatmap loses those columns.
    const [leftCol, rightCol] = columns(body, [leftW]) as [Rect, Rect];
    const heatH = narrow ? 0 : Math.min(14, Math.max(0, Math.floor(rightCol.h * 0.42)));
    const [rankedCol, surfaceRect] = rows(rightCol, [rightCol.h - heatH]) as [Rect, Rect];
    // Three panes share the left column here, so the axes take their share of
    // what is left after STRATEGIES rather than of the whole column.
    const stratH = strategiesHeight(leftCol.h);
    const inputsH = Math.min(11, Math.max(5, Math.floor((leftCol.h - stratH) * 0.32)));
    const histH = historyHeight(leftCol.h);
    const [stratRect, inputsRect, configRect, histRect] = rows(leftCol, [
      stratH,
      inputsH,
      leftCol.h - stratH - inputsH - histH,
    ]) as [Rect, Rect, Rect, Rect];

    drawStrategiesPane(ctx, stratRect, { command: 'sweep' });
    drawAxisPane(ctx, inputsRect, 'sweep');
    // `WF w` was here until the walkforward hand-off moved into the palette
    // (§4.2.i): the chips name real keys, so it names the palette instead.
    drawConfigPane(ctx, configRect, { command: 'sweep', actions: ['RUN r', 'ASK a', ': WF'] });
    drawHistoryPane(ctx, histRect, 'sweep');
    drawRanked(ctx, rankedCol);
    if (heatH > 0) drawHeatmap(ctx, surfaceRect);
  },
};
