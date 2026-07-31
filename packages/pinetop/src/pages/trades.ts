/**
 * TRADES (§4.2, page 7) — the ledger and the engine log for the loaded run.
 *
 * Decision 4.2.b — this is the one page that is not a command, and the reason is
 * that `--trades` output is consumed differently from a tearsheet: you scan
 * rows, then interrogate one. So selecting a fill scopes the log to that fill's
 * window, and `esc` restores it (§7 P4).
 *
 * The ledger comes from whichever run is loaded, whatever command produced it —
 * `backtest`, a ranked `sweep` combo, a `scan` row, or a merged `portfolio`
 * ledger, which is symbol-tagged.
 */

import type { StrategyTrade } from '@heyphat/pinerun';
import { compactMoney, duration, int, isoMinute, money, num } from '../render/format.js';
import { drawPane, truncate, type Rect } from '../render/screen.js';
import { drawHeader, drawRow, fitColumns, type Column, type Row } from '../render/table.js';
import { STYLE } from '../render/theme.js';
import type { AppState } from '../state.js';
import type { LogLine } from '../run/spawn.js';
import type { BacktestJson, PortfolioJson, ScanJson, SweepJson } from '../views/report.js';
import { clampCursor, rows, windowFor, type Page, type PageContext } from './page.js';

const PANES = ['ledger', 'log'] as const;

/**
 * The ledger of the loaded run, whatever produced it. Returns the trades and a
 * label saying where they came from, because "1,284 fills" means something
 * different for a portfolio than for one backtest.
 */
export function ledger(state: AppState): { trades: StrategyTrade[]; source: string } {
  const run = state.run;
  if (run == null || run.status !== 'ok' || run.report == null) return { trades: [], source: '' };

  switch (run.command) {
    case 'backtest': {
      const data = run.report as BacktestJson;
      return { trades: data.trades ?? [], source: data.symbol ?? 'backtest' };
    }
    case 'portfolio': {
      const data = run.report as PortfolioJson;
      return { trades: data.trades ?? [], source: `portfolio · ${data.mode ?? ''}` };
    }
    case 'sweep': {
      const data = run.report as SweepJson;
      const winner = data.ranked?.[0];
      return {
        trades: winner?.trades ?? [],
        source: winner == null ? 'sweep' : `sweep winner · ${winner.symbol ?? ''}`,
      };
    }
    case 'scan': {
      const data = run.report as ScanJson;
      const top = data.ranked?.[0];
      return {
        trades: top?.trades ?? [],
        source: top == null ? 'scan' : `scan top · ${top.symbol ?? ''}`,
      };
    }
    case 'compare':
      // Two ledgers have no single ordering; COMPARE's own page is the place
      // for A/B, so this page shows nothing rather than picking a side.
      return { trades: [], source: 'compare — open page 6' };
    default:
      return { trades: [], source: '' };
  }
}

/** `/` filters fills by symbol, direction, or exit reason text. */
export function filterTrades(trades: readonly StrategyTrade[], filter: string): StrategyTrade[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return [...trades];
  return trades.filter((t) => {
    const dir = t.dir < 0 ? 'short' : 'long';
    const win = t.profit >= 0 ? 'win' : 'loss';
    const haystack = `${t.symbol ?? ''} ${t.entryId} ${dir} ${win}`.toLowerCase();
    return haystack.includes(needle);
  });
}

function drawLedger(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const { trades, source } = ledger(state);
  const visible = filterTrades(trades, state.tradeFilter);

  const legend: string[] = [];
  if (source !== '') legend.push(source);
  legend.push(
    state.tradeFilter === ''
      ? `${int(trades.length)} fills`
      : `${int(visible.length)} of ${int(trades.length)} — /${state.tradeFilter}`,
  );

  const inner = drawPane(screen, rect, {
    title: 'LEDGER',
    focused: ctx.focus === 'ledger',
    legend: legend.join(' · '),
  });
  if (inner.h <= 1) return;

  if (trades.length === 0) {
    screen.text(
      inner.x,
      inner.y,
      state.run == null
        ? 'no run loaded'
        : source === 'compare — open page 6'
          ? source
          : 'this run carries no ledger — add --trades',
      STYLE.muted,
      inner,
    );
    return;
  }

  const multiSymbol = trades.some((t) => t.symbol != null);
  const candidates: Column[] = [
    { key: 'n', header: '#', width: 5, align: 'right', priority: 90 },
    ...(multiSymbol
      ? [{ key: 'symbol', header: 'SYMBOL', width: 12, priority: 85 } satisfies Column]
      : []),
    { key: 'dir', header: 'DIR', width: 5, priority: 80 },
    { key: 'qty', header: 'QTY', width: 10, align: 'right', priority: 40 },
    { key: 'entry', header: 'ENTRY', width: 17, priority: 60 },
    { key: 'entryPx', header: 'ENTRY PX', width: 11, align: 'right', priority: 55 },
    { key: 'exit', header: 'EXIT', width: 17, priority: 60 },
    { key: 'exitPx', header: 'EXIT PX', width: 11, align: 'right', priority: 55 },
    { key: 'profit', header: 'P/L', width: 12, align: 'right', priority: 100 },
    { key: 'cum', header: 'CUM', width: 12, align: 'right', priority: 50 },
    { key: 'mae', header: 'MAE', width: 10, align: 'right', priority: 30 },
    { key: 'commission', header: 'FEE', width: 9, align: 'right', priority: 20 },
  ];
  const { columns: cols, dropped } = fitColumns(candidates, inner.w);
  drawHeader(screen, inner, cols);

  const listRows = Math.max(0, inner.h - 2);
  const cursor = clampCursor(ctx.cursor('ledger'), visible.length);
  const { from, to } = windowFor(cursor, visible.length, listRows);

  for (let i = from; i < to; i++) {
    const trade = visible[i]!;
    const win = trade.profit >= 0;
    const row: Row = {
      n: String(i + 1),
      symbol: trade.symbol ?? '',
      dir: {
        text: trade.dir < 0 ? 'short' : 'long',
        style: trade.dir < 0 ? STYLE.warn : STYLE.none,
      },
      qty: num(trade.qty, 4),
      entry: isoMinute(trade.entryTime),
      entryPx: money(trade.entryPrice, 2),
      exit: isoMinute(trade.exitTime),
      exitPx: money(trade.exitPrice, 2),
      profit: { text: compactMoney(trade.profit), style: win ? STYLE.positive : STYLE.negative },
      cum: compactMoney(trade.cumProfit),
      mae: { text: compactMoney(-Math.abs(trade.maxDrawdown)), style: STYLE.muted },
      commission: { text: compactMoney(trade.commission), style: STYLE.muted },
    };
    drawRow(screen, inner, inner.y + 1 + (i - from), cols, row, {
      selected: i === cursor && ctx.focus === 'ledger',
    });
  }

  if (visible.length === 0) {
    screen.text(inner.x, inner.y + 1, `nothing matches /${state.tradeFilter}`, STYLE.warn, inner);
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

/**
 * The engine log (§8): resolve, fetch/cache, warmup, fills, artifact writes.
 * When a fill is selected the log scopes to the window around that fill's exit,
 * which is the "interrogate one row" half of this page.
 */
export function scopedLog(state: AppState): { lines: LogLine[]; scoped: boolean } {
  const all = state.run?.log ?? [];
  if (state.logScope == null) return { lines: all, scoped: false };

  const { trades } = ledger(state);
  const visible = filterTrades(trades, state.tradeFilter);
  const trade = visible[state.logScope];
  if (trade == null) return { lines: all, scoped: false };

  // The log is timestamped relative to the run, not to bar time, so scoping is
  // by the fill's identity rather than by clock: lines that name the entry id
  // or the symbol. A run whose engine log does not name fills simply shows
  // nothing here, which is honest — it is not a filter that invented matches.
  const needles = [trade.entryId, trade.symbol].filter((v): v is string => v != null && v !== '');
  const lines = all.filter((line) =>
    needles.some((needle) => line.text.toLowerCase().includes(needle.toLowerCase())),
  );
  return { lines, scoped: true };
}

function drawLog(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const { lines, scoped } = scopedLog(state);

  const counts = { warn: 0, error: 0 };
  for (const line of state.run?.log ?? []) {
    if (line.level === 'warn') counts.warn += 1;
    if (line.level === 'error') counts.error += 1;
  }
  const legend: string[] = [];
  if (scoped) legend.push('scoped to fill · esc restores');
  if (counts.warn > 0) legend.push(`${counts.warn} warn`);
  if (counts.error > 0) legend.push(`${counts.error} err`);
  if (state.run?.elapsedMs != null) legend.push(duration(state.run.elapsedMs));

  const inner = drawPane(screen, rect, {
    title: 'ENGINE LOG',
    focused: ctx.focus === 'log',
    legend: legend.length > 0 ? legend.join(' · ') : undefined,
  });
  if (inner.h <= 0) return;

  if (lines.length === 0) {
    screen.text(
      inner.x,
      inner.y,
      scoped ? 'the engine log does not name this fill' : 'no log for this run',
      STYLE.muted,
      inner,
    );
    return;
  }

  const cursor = clampCursor(ctx.cursor('log'), lines.length);
  const { from, to } = windowFor(cursor, lines.length, inner.h);
  for (let i = from; i < to; i++) {
    const line = lines[i]!;
    const y = inner.y + (i - from);
    const selected = i === cursor && ctx.focus === 'log';
    const style =
      line.level === 'error' ? STYLE.error : line.level === 'warn' ? STYLE.warn : STYLE.muted;
    if (selected) screen.text(inner.x, y, ' '.repeat(inner.w), STYLE.selected);
    const tag = line.level === 'info' ? '   ' : line.level === 'warn' ? 'WRN' : 'ERR';
    screen.text(inner.x, y, tag, selected ? STYLE.selected : style, inner);
    screen.text(
      inner.x + 4,
      y,
      truncate(line.text, Math.max(0, inner.w - 4)),
      selected ? STYLE.selected : line.level === 'info' ? STYLE.none : style,
      inner,
    );
  }
}

export const tradesPage: Page = {
  id: 'trades',
  minCols: 100,

  panes: () => [...PANES],

  rowCount: (state, paneId) => {
    if (paneId === 'ledger') return filterTrades(ledger(state).trades, state.tradeFilter).length;
    if (paneId === 'log') return scopedLog(state).lines.length;
    return 0;
  },

  breadcrumb: (state) => {
    const crumbs = ['pinetop'];
    const run = state.run;
    if (run == null) return [...crumbs, '(no run loaded)'];
    crumbs.push(run.command);
    const { trades } = ledger(state);
    crumbs.push(`${int(trades.length)} fills`);
    crumbs.push(`run ${run.id}`);
    return crumbs;
  },

  confirm: (state) => {
    // ↵ on a fill scopes the log to it (§7 P4).
    if (state.panes.trades.focus !== 'ledger') return undefined;
    const visible = filterTrades(ledger(state).trades, state.tradeFilter);
    if (visible.length === 0) return undefined;
    const index = clampCursor(state.panes.trades.cursor['ledger'] ?? 0, visible.length);
    state.logScope = index;
    return `log scoped to fill ${index + 1} — esc restores`;
  },

  render: (ctx) => {
    const { body } = ctx;
    const logH = Math.min(14, Math.max(5, Math.floor(body.h * 0.34)));
    const [ledgerRect, logRect] = rows(body, [body.h - logH]) as [Rect, Rect];
    drawLedger(ctx, ledgerRect);
    drawLog(ctx, logRect);
  },
};
