/**
 * The STRATEGIES pane, shared by all six command pages.
 *
 * It began on BACKTEST alone, which made picking a script a BACKTEST-only verb:
 * to sweep a different strategy you went to page 2, loaded it there, then came
 * back. But every command takes a `.pine` — it is the first positional argument
 * of all six — so every command page owes you a way to choose one. Same reasoning
 * as `config-pane.ts`: one renderer, so a page cannot invent its own dialect for a
 * thing all of them do (§4.4).
 *
 * TRADES has no pane of its own because it has no command: it shows the ledger of
 * whichever run is loaded, and a script picker there would imply it could run
 * something (§4.2.b). EDITOR's FILES pane is this pane's sibling — same list, but
 * `↵` there opens a buffer rather than loading an argument.
 */

import { schemaFor, type CommandId } from '../flags/schema.js';
import { drawPane, truncate, type Rect } from '../render/screen.js';
import { STYLE } from '../render/theme.js';
import { cachedScripts, type ScriptEntry } from '../scripts.js';
import type { AppState } from '../state.js';
import { clampCursor, windowFor, type PageContext } from './page.js';

/** The pane id every command page uses, so the focus ring reads the same. */
export const STRATEGIES_PANE = 'strategies';

export interface StrategiesPaneOptions {
  command: CommandId;
  paneId?: string;
  /**
   * Right-aligned value per row. BACKTEST puts the loaded run's Sharpe here; a
   * page with no single headline number leaves it unset rather than inventing one.
   */
  rail?: (entry: ScriptEntry, loaded: boolean) => string | undefined;
}

export function strategyRowCount(): number {
  return cachedScripts().length;
}

/**
 * Rows to give the pane. Shared so all six pages size it identically — the pane
 * being the same shape everywhere is most of what makes it read as one thing.
 */
export function strategiesHeight(available: number): number {
  // The floor is 5 — two borders, a title-less row for the hint, and two scripts.
  // Below that the pane can show one script, which is indistinguishable from
  // being broken. SWEEP is the binding case: it puts three panes in this column.
  return Math.min(8, Math.max(5, Math.floor(available * 0.36)));
}

/**
 * The marker for a script that is loaded: a bar for the five one-script commands,
 * and `A` / `B` for `compare`, which takes two and needs to say which is which.
 */
function slotMarker(scripts: readonly string[], path: string, slots: number): string | undefined {
  const at = scripts.indexOf(path);
  if (at < 0) return undefined;
  return slots === 2 ? ['A', 'B'][at] : '▌';
}

export function drawStrategiesPane(
  ctx: PageContext,
  rect: Rect,
  opts: StrategiesPaneOptions,
): void {
  const { screen, state } = ctx;
  const paneId = opts.paneId ?? STRATEGIES_PANE;
  const list = cachedScripts();
  const model = state.flags[opts.command];
  const slots = schemaFor(opts.command).scripts;
  const focused = ctx.focus === paneId;

  const interior = Math.max(0, rect.h - 2);
  const inner = drawPane(screen, rect, {
    title: 'STRATEGIES',
    focused,
    legend: slots === 2 ? 'A vs B' : list.length > interior ? String(list.length) : undefined,
  });
  if (inner.h <= 0) return;

  if (list.length === 0) {
    screen.text(inner.x, inner.y, 'no .pine found here', STYLE.muted, inner);
    screen.text(inner.x, inner.y + 1, '1 EDITOR · :e path.pine', STYLE.muted, inner);
    return;
  }

  // In a short column the hint line is the first thing to go: a row spent saying
  // `↵ load` is a row not spent showing a script, and the key is in `?` anyway.
  const hint = inner.h >= 3;
  const cursor = clampCursor(ctx.cursor(paneId), list.length);
  const listRows = Math.max(1, inner.h - (hint ? 1 : 0));
  const { from, to } = windowFor(cursor, list.length, listRows);

  for (let i = from; i < to; i++) {
    const entry = list[i]!;
    const y = inner.y + (i - from);
    const selected = i === cursor && focused;
    const marker = slotMarker(model.scripts, entry.path, slots);

    if (selected) screen.text(inner.x, y, ' '.repeat(inner.w), STYLE.selected);
    // A loaded script keeps its marker wherever the cursor is, so "what will run"
    // never depends on where you last pressed j.
    screen.text(inner.x, y, marker ?? ' ', selected ? STYLE.selected : STYLE.accent);

    const value = opts.rail?.(entry, marker != null) ?? '';
    screen.text(
      inner.x + 1,
      y,
      truncate(entry.label, Math.max(0, inner.w - 2 - value.length)),
      selected ? STYLE.selected : marker != null ? STYLE.none : STYLE.muted,
    );
    if (value !== '') {
      screen.text(
        inner.x + inner.w - value.length,
        y,
        value,
        selected ? STYLE.selected : STYLE.none,
      );
    }
  }

  if (hint) {
    screen.text(
      inner.x,
      inner.y + inner.h - 1,
      slots === 2 ? 'j/k · ↵ fills A then B' : 'j/k move · ↵ load',
      STYLE.muted,
      inner,
    );
  }
}

/**
 * `↵` on the pane: load the selection as the command's script argument.
 *
 * `compare` fills the first free slot and then replaces A, which is the order the
 * work actually happens in — pick one, pick the other, then keep swapping the
 * left-hand side. The pane's markers say where everything landed, and the config
 * pane can still set either slot directly (§10.2).
 */
export function loadStrategy(state: AppState, command: CommandId): string | undefined {
  const list = cachedScripts();
  if (list.length === 0) return 'no .pine here — 1 EDITOR, then :e path.pine';

  const cursor = clampCursor(state.panes[command].cursor[STRATEGIES_PANE] ?? 0, list.length);
  const entry = list[cursor];
  if (entry == null) return undefined;

  const model = state.flags[command];
  if (schemaFor(command).scripts === 1) {
    // Overrides are keyed by script, so switching cannot leak an edit (§4.6).
    model.scripts = [entry.path];
    return `loaded ${entry.label} — press r to run`;
  }

  const next = [...model.scripts];
  const slot = next[0] == null || next[0] === '' ? 0 : next[1] == null || next[1] === '' ? 1 : 0;
  next[slot] = entry.path;
  model.scripts = next.slice(0, 2);
  return `script ${slot === 0 ? 'A' : 'B'} = ${entry.label} — press r to run`;
}
