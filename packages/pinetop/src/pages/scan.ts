/**
 * SCAN (§4.2, page 4) — screen one script across N symbols.
 *
 * §7 P3's exit criterion is that per-symbol fetch failures render without
 * aborting the page, and §8 says `fetchErrors` must be surfaced rather than
 * swallowed: `scan` reports and continues, and the UI has to show that
 * distinction. Hence a dedicated ERRORS pane that is drawn whenever the report
 * carries failures — a symbol that could not be fetched is a different fact from
 * a symbol that ranked last.
 */

import { sparkline } from '@heyphat/pinerun';
import { schemaFor } from '../flags/schema.js';
import { duration, int, num } from '../render/format.js';
import { drawPane, truncate, type Rect } from '../render/screen.js';
import { drawHeader, drawRow, fitColumns, type Column, type Row } from '../render/table.js';
import { STYLE } from '../render/theme.js';
import { scriptLabel } from '../scripts.js';
import type { AppState } from '../state.js';
import type { ScanJson, ScanRankedJson } from '../views/report.js';
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

const PANES = [STRATEGIES_PANE, 'config', 'universe', 'errors', HISTORY_PANE] as const;

export function report(state: AppState): ScanJson | undefined {
  if (state.run?.command !== 'scan' || state.run.status !== 'ok') return undefined;
  return state.run.report as ScanJson | undefined;
}

export function rankedRows(state: AppState): ScanRankedJson[] {
  return report(state)?.ranked ?? [];
}

interface Failure {
  symbol: string;
  error: string;
  kind: 'fetch' | 'run';
}

export function failures(state: AppState): Failure[] {
  const data = report(state);
  if (data == null) return [];
  return [
    ...(data.fetchErrors ?? []).map((e) => ({
      symbol: e.symbol,
      error: e.error,
      kind: 'fetch' as const,
    })),
    ...(data.errors ?? []).map((e) => ({
      symbol: e.symbol ?? '—',
      error: e.error ?? 'run failed',
      kind: 'run' as const,
    })),
  ];
}

function drawUniverse(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const list = data?.ranked ?? [];

  const legend: string[] = [];
  if (data?.rank) legend.push(`rank ${data.rank}`);
  if (data?.direction) legend.push(data.direction);
  if (data?.elapsedMs != null) legend.push(duration(data.elapsedMs));

  const inner = drawPane(screen, rect, {
    title: 'UNIVERSE',
    focused: ctx.focus === 'universe',
    key: ctx.paneKey('universe'),
    legend: legend.length > 0 ? legend.join(' · ') : undefined,
  });
  if (inner.h <= 1) return;

  if (data == null) {
    const message =
      state.run?.status === 'running'
        ? state.run.progress || 'scanning…'
        : state.run?.status === 'failed'
          ? (state.run.error ?? 'scan failed')
          : 'press r to scan';
    screen.text(inner.x, inner.y, message, STYLE.muted, inner);
    return;
  }

  const candidates: Column[] = [
    { key: 'n', header: '#', width: 3, align: 'right', priority: 90 },
    { key: 'symbol', header: 'SYMBOL', width: 16, priority: 100 },
    { key: 'value', header: 'VALUE', width: 12, align: 'right', priority: 95 },
    { key: 'net', header: 'NET%', width: 8, align: 'right', priority: 70 },
    { key: 'dd', header: 'MAXDD%', width: 8, align: 'right', priority: 60 },
    { key: 'sharpe', header: 'SHARPE', width: 7, align: 'right', priority: 65 },
    { key: 'hit', header: 'HIT%', width: 6, align: 'right', priority: 45 },
    { key: 'trades', header: 'TRADES', width: 7, align: 'right', priority: 40 },
    { key: 'bars', header: 'BARS', width: 8, align: 'right', priority: 20 },
    { key: 'equity', header: 'EQUITY', width: 18, priority: 75 },
  ];
  const { columns: cols, dropped } = fitColumns(candidates, inner.w);
  drawHeader(screen, inner, cols);

  const listRows = Math.max(0, inner.h - 2);
  const cursor = clampCursor(ctx.cursor('universe'), list.length);
  const { from, to } = windowFor(cursor, list.length, listRows);

  for (let i = from; i < to; i++) {
    const entry = list[i]!;
    const strategy = entry.strategy;
    const row: Row = {
      n: String(i + 1),
      symbol: entry.symbol ?? '—',
      value: { text: num(entry.value), style: STYLE.bold },
      net: {
        text: strategy == null ? '—' : strategy.netProfitPercent.toFixed(1),
        style: (strategy?.netProfitPercent ?? 0) >= 0 ? STYLE.positive : STYLE.negative,
      },
      dd: {
        text: strategy == null ? '—' : `-${Math.abs(strategy.maxDrawdownPercent).toFixed(1)}`,
        style: STYLE.negative,
      },
      sharpe: num(strategy?.metrics?.sharpe),
      hit: strategy == null ? '—' : (strategy.winRate * 100).toFixed(0),
      trades: strategy == null ? '—' : int(strategy.closedTrades),
      bars: entry.bars == null ? '—' : int(entry.bars),
      equity:
        entry.equityCurve != null && entry.equityCurve.length > 1
          ? sparkline(entry.equityCurve, 18)
          : '',
    };
    drawRow(screen, inner, inner.y + 1 + (i - from), cols, row, {
      selected: i === cursor && ctx.focus === 'universe',
    });
  }

  if (list.length === 0) {
    screen.text(inner.x, inner.y + 1, 'nothing ranked', STYLE.warn, inner);
  }
  if (dropped.length > 0) {
    screen.text(
      inner.x,
      inner.y + inner.h - 1,
      truncate(`dropped ${dropped.join(', ')} — widen the terminal`, inner.w),
      STYLE.warn,
      inner,
    );
  }
}

/** §8 — reported and continued is a distinct outcome and gets its own pane. */
function drawErrors(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const list = failures(state);

  const inner = drawPane(screen, rect, {
    title: 'NOT RANKED',
    focused: ctx.focus === 'errors',
    key: ctx.paneKey('errors'),
    legend: list.length > 0 ? `${list.length}` : undefined,
  });
  if (inner.h <= 0) return;

  if (list.length === 0) {
    screen.text(inner.x, inner.y, 'every symbol ran', STYLE.muted, inner);
    return;
  }

  const cursor = clampCursor(ctx.cursor('errors'), list.length);
  const { from, to } = windowFor(cursor, list.length, inner.h);
  for (let i = from; i < to; i++) {
    const failure = list[i]!;
    const y = inner.y + (i - from);
    const selected = i === cursor && ctx.focus === 'errors';
    if (selected) screen.text(inner.x, y, ' '.repeat(inner.w), STYLE.selected);
    const tag = failure.kind === 'fetch' ? 'fetch' : 'run';
    screen.text(
      inner.x,
      y,
      truncate(failure.symbol, 14).padEnd(15),
      selected ? STYLE.selected : STYLE.none,
      inner,
    );
    screen.text(inner.x + 15, y, tag.padEnd(6), selected ? STYLE.selected : STYLE.warn, inner);
    screen.text(
      inner.x + 21,
      y,
      truncate(failure.error, Math.max(0, inner.w - 21)),
      selected ? STYLE.selected : STYLE.muted,
      inner,
    );
  }
}

export const scanPage: Page = {
  id: 'scan',
  command: 'scan',
  minCols: schemaFor('scan').minCols,

  panes: () => [...PANES],

  rowCount: (state, paneId) => {
    if (paneId === HISTORY_PANE) return historyRowCount(state, 'scan');
    if (paneId === STRATEGIES_PANE) return strategyRowCount(state);
    if (paneId === 'config') return configRowCount(state, 'scan');
    if (paneId === 'universe') return rankedRows(state).length;
    if (paneId === 'errors') return failures(state).length;
    return 0;
  },

  breadcrumb: (state) => {
    const model = state.flags.scan;
    const crumbs = ['pinetop'];
    const script = model.scripts[0];
    crumbs.push(script == null ? '(no script)' : scriptLabel(script));
    const data = report(state);
    if (data?.ranked != null) crumbs.push(`${data.ranked.length} ranked`);
    const bad = failures(state).length;
    if (bad > 0) crumbs.push(`${bad} not ranked`);
    if (state.run != null) crumbs.push(`run ${state.run.id}`);
    return crumbs;
  },

  confirm: (state) => {
    if (state.panes.scan.focus === HISTORY_PANE) return loadRun(state, 'scan');
    if (state.panes.scan.focus === STRATEGIES_PANE) return loadStrategy(state, 'scan');
    // ↵ on a scanned symbol deep-dives it in BACKTEST.
    if (state.panes.scan.focus !== 'universe') return undefined;
    const list = rankedRows(state);
    const entry = list[clampCursor(state.panes.scan.cursor['universe'] ?? 0, list.length)];
    if (entry?.symbol == null) return undefined;

    state.flags.backtest.scripts = [...state.flags.scan.scripts];
    state.flags.backtest.values['symbol'] = entry.symbol;
    for (const key of ['tf', 'from', 'to', 'limit'] as const) {
      const value = state.flags.scan.values[key];
      if (value != null) state.flags.backtest.values[key] = value;
    }
    state.page = 'backtest';
    return `loaded ${entry.symbol} into BACKTEST — press r`;
  },

  render: (ctx) => {
    const { body, screen, state } = ctx;
    const leftW = Math.min(34, Math.max(26, Math.floor(screen.cols * 0.24)));
    const hasFailures = failures(state).length > 0;
    const errorsH = hasFailures ? Math.min(8, Math.max(4, Math.floor(body.h * 0.25))) : 0;

    const [leftCol, rightCol] = columns(body, [leftW]) as [Rect, Rect];
    const [universeRect, errorsRect] = rows(rightCol, [rightCol.h - errorsH]) as [Rect, Rect];

    const stratH = strategiesHeight(leftCol.h);
    const histH = historyHeight(leftCol.h);
    const [stratRect, configRect, histRect] = rows(leftCol, [
      stratH,
      leftCol.h - stratH - histH,
    ]) as [Rect, Rect, Rect];
    drawStrategiesPane(ctx, stratRect, { command: 'scan' });
    drawConfigPane(ctx, configRect, { command: 'scan' });
    drawHistoryPane(ctx, histRect, 'scan');
    drawUniverse(ctx, universeRect);
    if (errorsH > 0) drawErrors(ctx, errorsRect);
  },
};
