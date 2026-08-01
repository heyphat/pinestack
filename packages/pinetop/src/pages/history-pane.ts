/**
 * The HISTORY pane — this session's runs for the page you are on.
 *
 * §10.3 was open: `AppState.history` had been accumulating every run since the
 * build, nothing read it, and nothing evicted. This is the reading half.
 *
 * Two decisions are load-bearing here.
 *
 * **A run carries the flags it ran with, and `↵` restores them.** Swapping only
 * `state.run` would put one invocation's numbers on screen beside another's
 * config, and the `$ pinerun …` line composes from the config — so the line would
 * no longer reproduce what you are looking at, which §4.1.b calls a bug outright.
 * Restoring both keeps the page, the line and the report describing one thing,
 * and makes `r` re-run exactly what you loaded.
 *
 * **The history is capped.** A `RunState` holds a whole report — equity curves,
 * trades, the engine log — so keeping every run of a long session is a leak, and
 * a pane that invites you to keep them makes it a worse one.
 */

import { cloneModel } from '../flags/model.js';
import type { CommandId } from '../flags/schema.js';
import { duration, isoMinute } from '../render/format.js';
import { drawPane, truncate, type Rect } from '../render/screen.js';
import { STYLE, type Style } from '../render/theme.js';
import type { AppState, RunState } from '../state.js';
import { revertOverrides } from '../state.js';
import { clampCursor, windowFor, type PageContext } from './page.js';

export const HISTORY_PANE = 'history';

/**
 * Runs kept per command. Enough that a session's worth of comparison is there,
 * few enough that the reports behind them are not a memory problem.
 */
export const HISTORY_LIMIT = 20;

/** This page's runs, newest first — the order a picker is read in. */
export function historyFor(state: AppState, command: CommandId): RunState[] {
  return state.history.filter((run) => run.command === command).reverse();
}

/** Drop the oldest runs of a command once it is over the cap. */
export function evictHistory(state: AppState, command: CommandId): void {
  const mine = state.history.filter((run) => run.command === command);
  if (mine.length <= HISTORY_LIMIT) return;
  const drop = new Set(mine.slice(0, mine.length - HISTORY_LIMIT));
  state.history = state.history.filter((run) => !drop.has(run));
}

export function historyRowCount(state: AppState, command: CommandId): number {
  return historyFor(state, command).length;
}

/** Rows to give the pane, so it is the same slab on every page. */
export function historyHeight(available: number): number {
  return Math.min(8, Math.max(4, Math.floor(available * 0.22)));
}

function statusStyle(run: RunState): Style {
  switch (run.status) {
    case 'ok':
      return STYLE.positive;
    case 'failed':
      return STYLE.error;
    case 'running':
      return STYLE.accent;
    default:
      return STYLE.muted;
  }
}

/**
 * What distinguishes one run from another, from the flags it ran with: the
 * target and the timeframe. Without them the pane is a list of ids, and "the one
 * on ETH" is not a question it can answer.
 */
export function runLabel(run: RunState): string {
  const values = run.flags?.values;
  if (values == null) return run.command;
  const symbol = values['symbol'];
  const symbols = values['symbols'];
  const target =
    typeof symbol === 'string' && symbol !== ''
      ? symbol
      : Array.isArray(symbols) && symbols.length > 0
        ? `${symbols.length} symbols`
        : typeof values['universe'] === 'string'
          ? 'universe'
          : '—';
  const tf = typeof values['tf'] === 'string' ? values['tf'] : '';
  return tf === '' ? target : `${target} ${tf}`;
}

export function drawHistoryPane(ctx: PageContext, rect: Rect, command: CommandId): void {
  const { screen, state } = ctx;
  const runs = historyFor(state, command);
  const focused = ctx.focus === HISTORY_PANE;

  const inner = drawPane(screen, rect, {
    title: 'HISTORY',
    focused,
    legend: runs.length > 0 ? String(runs.length) : undefined,
  });
  if (inner.h <= 0) return;

  if (runs.length === 0) {
    screen.text(inner.x, inner.y, 'no runs yet — press r', STYLE.muted, inner);
    return;
  }

  // The hint yields to content, as it does in the other list panes.
  const showHint = runs.length + 1 <= inner.h;
  const listRows = Math.max(1, inner.h - (showHint ? 1 : 0));
  const cursor = clampCursor(ctx.cursor(HISTORY_PANE), runs.length);
  const { from, to } = windowFor(cursor, runs.length, listRows);

  for (let i = from; i < to; i++) {
    const run = runs[i]!;
    const y = inner.y + (i - from);
    const selected = i === cursor && focused;
    // The loaded run keeps its marker wherever the cursor is: this pane's whole
    // job is saying which run the numbers on screen came from.
    const loaded = state.run === run;

    if (selected) screen.text(inner.x, y, ' '.repeat(inner.w), STYLE.selected);
    screen.text(inner.x, y, loaded ? '▌' : ' ', selected ? STYLE.selected : STYLE.accent);

    const right = run.elapsedMs == null ? isoMinute(run.startedAt / 1000) : duration(run.elapsedMs);
    screen.text(
      inner.x + 1,
      y,
      truncate(`${run.id} ${runLabel(run)}`, Math.max(0, inner.w - 2 - right.length)),
      selected ? STYLE.selected : loaded ? STYLE.none : STYLE.muted,
      inner,
    );
    screen.text(
      inner.x + inner.w - right.length,
      y,
      right,
      selected ? STYLE.selected : statusStyle(run),
      inner,
    );
  }

  if (showHint) {
    screen.text(inner.x, inner.y + inner.h - 1, 'j/k move · ↵ load', STYLE.muted, inner);
  }
}

/**
 * `↵` on a history row: put that run back on screen, config and all.
 *
 * Pending overrides go with it — the snapshot already has the ones that were in
 * effect baked in, so keeping the current ones would apply them twice.
 */
export function loadRun(state: AppState, command: CommandId): string | undefined {
  const runs = historyFor(state, command);
  if (runs.length === 0) return 'no runs yet — press r';

  const run = runs[clampCursor(state.panes[command].cursor[HISTORY_PANE] ?? 0, runs.length)];
  if (run == null) return undefined;
  if (state.run === run) return `run ${run.id} is already loaded`;

  state.run = run;
  if (run.flags == null) return `loaded run ${run.id}`;

  revertOverrides(state, command);
  state.flags[command] = cloneModel(run.flags);
  return `loaded run ${run.id} — the config that produced it is back, press r to repeat`;
}
