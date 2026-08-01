/**
 * WALKFORWARD (§4.2, page 3) — validate: does the swept edge survive OOS.
 *
 * §4.4 names EFF and OOS EQUITY as the two columns that must not fall off the
 * right edge on this page, because they are the entire point of it: WFE near 1
 * is a real edge, WFE well below 1 is overfit. Both carry a high `fitColumns`
 * priority, and the verdict is restated in the right rail so a narrow terminal
 * that drops the sparkline still shows the answer.
 */

import { schemaFor } from '../flags/schema.js';
import { duration, int, isoDay, num, pct } from '../render/format.js';
import { drawPane, truncate, type Rect } from '../render/screen.js';
import {
  drawHeader,
  drawLeader,
  drawRow,
  fitColumns,
  type Column,
  type Row,
} from '../render/table.js';
import { STYLE, type Style } from '../render/theme.js';
import { scriptLabel } from '../scripts.js';
import type { AppState } from '../state.js';
import type { WalkforwardJson, WalkforwardWindowJson } from '../views/report.js';
import { configRowCount, drawConfigPane } from './config-pane.js';
import { axisRows, beginAxisEdit, drawAxisPane } from './inputs-pane.js';
import {
  STRATEGIES_PANE,
  drawStrategiesPane,
  loadStrategy,
  strategiesHeight,
  strategyRowCount,
} from './strategies-pane.js';
import { clampCursor, columns, rows, windowFor, type Page, type PageContext } from './page.js';

const PANES = [STRATEGIES_PANE, 'inputs', 'config', 'windows', 'verdict'] as const;

export function report(state: AppState): WalkforwardJson | undefined {
  if (state.run?.command !== 'walkforward' || state.run.status !== 'ok') return undefined;
  return state.run.report as WalkforwardJson | undefined;
}

export function windowRows(state: AppState): WalkforwardWindowJson[] {
  return report(state)?.windows ?? [];
}

/**
 * The verdict, in the doc's own terms: "WFE (per-bar OOS/IS profit ratio) ~1 =
 * real edge, << 1 = overfit". The thresholds are presentation, not analysis —
 * the number is the engine's.
 */
export function verdict(wfe: number | undefined): { text: string; style: Style } {
  if (wfe == null || !Number.isFinite(wfe)) return { text: 'no verdict', style: STYLE.muted };
  if (wfe >= 0.8) return { text: 'edge survives OOS', style: STYLE.positive };
  if (wfe >= 0.5) return { text: 'partial — degraded OOS', style: STYLE.warn };
  return { text: 'overfit — OOS collapses', style: STYLE.negative };
}

/**
 * The CLI's OOS EQUITY column sparklines each window's out-of-sample curve. It
 * can: it holds the window's `RunResult` in process. The `--json` payload
 * deliberately strips those results for size — the emission site in `cli.ts`
 * says so — so there is no OOS curve on the wire to draw.
 *
 * Rather than fabricate one, this renders the field that *is* on the wire:
 * `oosProfitPercent`, as a signed bar scaled across the windows shown. Same
 * question answered ("did this fold make money out of sample"), from a number
 * the report actually contains.
 */
function oosBar(percent: number | undefined, maxAbs: number, width: number): string {
  if (percent == null || !Number.isFinite(percent) || maxAbs <= 0) return '';
  const half = Math.max(1, Math.floor((width - 1) / 2));
  const cells = Math.min(half, Math.max(1, Math.round((Math.abs(percent) / maxAbs) * half)));
  if (percent >= 0) return `${' '.repeat(half)}│${'█'.repeat(cells)}`;
  return `${' '.repeat(half - cells)}${'█'.repeat(cells)}│`;
}

function drawWindows(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const list = data?.windows ?? [];

  const legend: string[] = [];
  if (data != null) {
    legend.push(data.anchored === true ? 'anchored' : 'rolling');
    if (data.isBars != null) legend.push(`IS ${int(data.isBars)} → OOS ${int(data.oosBars)} bars`);
    if (data.rank) legend.push(`rank ${data.rank}`);
    if (data.elapsedMs != null) legend.push(duration(data.elapsedMs));
  }

  const inner = drawPane(screen, rect, {
    title: 'WINDOWS',
    focused: ctx.focus === 'windows',
    legend: legend.length > 0 ? legend.join(' · ') : undefined,
  });
  if (inner.h <= 1) return;

  if (data == null) {
    const message =
      state.run?.status === 'running'
        ? state.run.progress || 'walking forward…'
        : state.run?.status === 'failed'
          ? (state.run.error ?? 'walkforward failed')
          : 'press r to validate';
    screen.text(inner.x, inner.y, message, STYLE.muted, inner);
    return;
  }

  const candidates: Column[] = [
    { key: 'n', header: '#', width: 3, align: 'right', priority: 90 },
    { key: 'isSpan', header: 'IS FROM', width: 11, priority: 30 },
    { key: 'oosSpan', header: 'OOS FROM → TO', width: 24, priority: 50 },
    { key: 'winner', header: 'WINNER', width: 22, priority: 60 },
    { key: 'isPct', header: 'IS%', width: 8, align: 'right', priority: 70 },
    { key: 'oosPct', header: 'OOS%', width: 8, align: 'right', priority: 85 },
    { key: 'trades', header: 'TRD', width: 5, align: 'right', priority: 40 },
    // §4.4: EFF is the payoff column on this page. It is dropped last.
    { key: 'eff', header: 'EFF', width: 7, align: 'right', priority: 99 },
    { key: 'oosEquity', header: 'OOS ±%', width: 15, priority: 80 },
  ];

  const { columns: cols, dropped } = fitColumns(candidates, inner.w);
  drawHeader(screen, inner, cols);

  const maxAbsOos = Math.max(
    1e-9,
    ...list.map((w) => Math.abs(w.oosProfitPercent ?? 0)).filter(Number.isFinite),
  );

  const listRows = Math.max(0, inner.h - 2);
  const cursor = clampCursor(ctx.cursor('windows'), list.length);
  const { from, to } = windowFor(cursor, list.length, listRows);

  for (let i = from; i < to; i++) {
    const w = list[i]!;
    const winnerText = Object.entries(w.winner ?? {})
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(' ');

    const row: Row = {
      n: String((w.index ?? i) + 1),
      isSpan: isoDay(w.isFromTime),
      oosSpan: `${isoDay(w.oosFromTime)} → ${isoDay(w.oosToTime)}`,
      winner: w.error != null ? { text: 'failed', style: STYLE.error } : winnerText,
      isPct: {
        text: w.isProfitPercent == null ? '—' : w.isProfitPercent.toFixed(1),
        style: (w.isProfitPercent ?? 0) >= 0 ? STYLE.positive : STYLE.negative,
      },
      oosPct: {
        text: w.oosProfitPercent == null ? '—' : w.oosProfitPercent.toFixed(1),
        style: (w.oosProfitPercent ?? 0) >= 0 ? STYLE.positive : STYLE.negative,
      },
      trades: w.oosTrades == null ? '—' : int(w.oosTrades),
      eff: {
        text: num(w.efficiency),
        style:
          w.efficiency == null
            ? STYLE.muted
            : w.efficiency >= 0.8
              ? STYLE.positive
              : w.efficiency >= 0.5
                ? STYLE.warn
                : STYLE.negative,
      },
      oosEquity: {
        text: oosBar(w.oosProfitPercent, maxAbsOos, 15),
        style: (w.oosProfitPercent ?? 0) >= 0 ? STYLE.positive : STYLE.negative,
      },
    };

    drawRow(screen, inner, inner.y + 1 + (i - from), cols, row, {
      selected: i === cursor && ctx.focus === 'windows',
    });
  }

  const notes: string[] = [];
  if (dropped.length > 0) notes.push(`dropped ${dropped.join(', ')} — widen the terminal`);
  for (const warning of data.warnings ?? []) notes.push(warning);
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

function drawVerdict(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const data = report(state);
  const aggregate = data?.aggregate;

  const inner = drawPane(screen, rect, {
    title: 'VERDICT',
    focused: ctx.focus === 'verdict',
  });
  if (inner.h <= 0) return;

  if (aggregate == null) {
    screen.text(inner.x, inner.y, 'no run loaded', STYLE.muted, inner);
    return;
  }

  const wfe = aggregate.walkForwardEfficiency;
  const call = verdict(wfe);

  let y = inner.y;
  screen.text(inner.x, y, truncate(call.text, inner.w), call.style, inner);
  y += 2;

  drawLeader(screen, inner, y++, 'WFE', num(wfe), { valueStyle: call.style });
  drawLeader(screen, inner, y++, 'windows', int(aggregate.windows));
  drawLeader(screen, inner, y++, 'failed', int(aggregate.failed), {
    valueStyle: (aggregate.failed ?? 0) > 0 ? STYLE.negative : STYLE.none,
  });
  drawLeader(
    screen,
    inner,
    y++,
    'OOS positive',
    `${int(aggregate.oosPositive)} / ${int(aggregate.windows)}`,
    {
      valueStyle:
        (aggregate.oosPositive ?? 0) * 2 >= (aggregate.windows ?? 0) ? STYLE.positive : STYLE.warn,
    },
  );
  drawLeader(screen, inner, y++, 'mean IS%', pct(aggregate.meanIsProfitPercent), {
    valueStyle: (aggregate.meanIsProfitPercent ?? 0) >= 0 ? STYLE.positive : STYLE.negative,
  });
  drawLeader(screen, inner, y++, 'mean OOS%', pct(aggregate.meanOosProfitPercent), {
    valueStyle: (aggregate.meanOosProfitPercent ?? 0) >= 0 ? STYLE.positive : STYLE.negative,
  });

  y += 1;
  if (y < inner.y + inner.h) {
    screen.text(inner.x, y, truncate('WFE ≈1 real edge · ≪1 overfit', inner.w), STYLE.muted, inner);
  }
}

export const walkforwardPage: Page = {
  id: 'walkforward',
  command: 'walkforward',
  minCols: schemaFor('walkforward').minCols,

  panes: () => [...PANES],

  rowCount: (state, paneId) => {
    if (paneId === STRATEGIES_PANE) return strategyRowCount();
    if (paneId === 'inputs') return axisRows(state, 'walkforward').length;
    if (paneId === 'config') return configRowCount(state, 'walkforward');
    if (paneId === 'windows') return windowRows(state).length;
    return 0;
  },

  breadcrumb: (state) => {
    const model = state.flags.walkforward;
    const crumbs = ['pinetop'];
    const script = model.scripts[0];
    crumbs.push(script == null ? '(no script)' : scriptLabel(script));
    const data = report(state);
    if (data?.symbol) crumbs.push(data.symbol);
    if (data?.windows != null) {
      crumbs.push(
        `${data.windows.length} ${data.anchored === true ? 'anchored' : 'rolling'} windows`,
      );
    }
    if (state.run != null) crumbs.push(`run ${state.run.id}`);
    return crumbs;
  },

  confirm: (state) => {
    if (state.panes.walkforward.focus === STRATEGIES_PANE)
      return loadStrategy(state, 'walkforward');
    // Same grammar as SWEEP, and an axis is mandatory here — `validate` refuses a
    // walkforward without one — so this page needs the picker at least as much.
    if (state.panes.walkforward.focus === 'inputs') return beginAxisEdit(state, 'walkforward');
    // ↵ on a window loads its winner into BACKTEST: the natural next question
    // after "which fold won" is "what did that fold actually do".
    if (state.panes.walkforward.focus !== 'windows') return undefined;
    const list = windowRows(state);
    const w = list[clampCursor(state.panes.walkforward.cursor['windows'] ?? 0, list.length)];
    if (w?.winner == null) return undefined;

    state.flags.backtest.scripts = [...state.flags.walkforward.scripts];
    state.flags.backtest.values['input'] = Object.entries(w.winner).map(([name, value]) => ({
      name,
      value: String(value),
    }));
    for (const key of ['symbol', 'tf', 'limit'] as const) {
      const value = state.flags.walkforward.values[key];
      if (value != null) state.flags.backtest.values[key] = value;
    }
    // The window's own OOS span, so the backtest looks at what was validated.
    if (w.oosFromTime != null) state.flags.backtest.values['from'] = isoDay(w.oosFromTime);
    if (w.oosToTime != null) state.flags.backtest.values['to'] = isoDay(w.oosToTime);
    state.page = 'backtest';
    return `loaded window ${(w.index ?? 0) + 1} winner into BACKTEST — press r`;
  },

  render: (ctx) => {
    const { body, screen } = ctx;
    const narrow = screen.cols < walkforwardPage.minCols;
    const leftW = Math.min(34, Math.max(26, Math.floor(screen.cols * 0.22)));
    const railW = narrow ? 0 : Math.min(30, Math.floor(screen.cols * 0.2));

    const [leftCol, midCol, rightCol] = columns(body, [leftW, body.w - leftW - railW]) as [
      Rect,
      Rect,
      Rect,
    ];

    const stratH = strategiesHeight(leftCol.h);
    const inputsH = Math.min(11, Math.max(5, Math.floor((leftCol.h - stratH) * 0.35)));
    const [stratRect, inputsRect, configRect] = rows(leftCol, [stratH, inputsH]) as [
      Rect,
      Rect,
      Rect,
    ];

    drawStrategiesPane(ctx, stratRect, { command: 'walkforward' });
    drawAxisPane(ctx, inputsRect, 'walkforward');
    drawConfigPane(ctx, configRect, {
      command: 'walkforward',
      actions: ['RUN r', 'ASK a', ': cmd'],
    });
    drawWindows(ctx, midCol);
    if (railW > 0) drawVerdict(ctx, rightCol);
  },
};
