/**
 * The page contract.
 *
 * A page owns its panes, its focus ring, and how its report renders. It does
 * not own the frame, the tab bar, the command line, or the status bar — those
 * are the same on every page and live in `frame.ts`, so a new command page
 * cannot accidentally invent its own chrome.
 */

import type { Rect, Screen } from '../render/screen.js';
import type { AppState } from '../state.js';
import type { CommandId, PageId } from '../flags/schema.js';
import type { Key } from '../terminal.js';

export interface PageContext {
  state: AppState;
  screen: Screen;
  /** The area a page may draw in: below the breadcrumb, above the command line. */
  body: Rect;
  /** Focused pane id (§4.2.c). */
  focus: string;
  /** Selected row within a pane. */
  cursor: (paneId: string) => number;
}

export interface Page {
  id: PageId;
  /** The command this page spawns; absent for TRADES, which is a view (§4.2.b). */
  command?: CommandId;
  /** Focus ring order for `tab` / `shift-tab`. */
  panes: (state: AppState) => string[];
  /** Selectable rows in a pane, so `j`/`k`/`g`/`G` clamp correctly. */
  rowCount: (state: AppState, paneId: string) => number;
  render: (ctx: PageContext) => void;
  /** `↵` on the focused pane. Returns a status line, or undefined. */
  confirm?: (state: AppState) => string | undefined;
  /** Columns this page needs before it degrades (§4.4). */
  minCols: number;
  /**
   * What actually happens below `minCols`, for the width warning. Defaults to
   * dropping the right rail, which is what the six command pages do — a page
   * without a rail must say what it really loses, or the warning describes a
   * degradation that did not happen (§6: a dropped column has to be visible as a
   * decision, which means naming the right one).
   */
  degradeNote?: string;
  /** The breadcrumb's left side: `pinetop / script / window / run`. */
  breadcrumb: (state: AppState) => string[];
  /**
   * Keys the page claims before the global keymap, returning true when it took
   * one.
   *
   * This exists for exactly one page. EDITOR is a modal text buffer, so `j` there
   * is a character and not a cursor move, and `1` is a count and not a page
   * switch — a page that owns the keyboard cannot be expressed by adding entries
   * to a global table. Every other page leaves this unset and is driven entirely
   * by `keymap.ts`, which is what keeps `?` an honest account of the bindings.
   *
   * A page that claims keys must leave a way out (EDITOR never takes `tab` in
   * normal mode, and never takes `ctrl-c` at all).
   */
  onKey?: (state: AppState, key: Key) => boolean;
  /** This page's hint strip. Defaults to the global `HINTS`. */
  hints?: (state: AppState) => readonly { key: string; label: string }[];
}

/**
 * Split a rect into columns. `widths` sizes the leading columns; one more
 * column is always appended that absorbs whatever is left, so N widths yield
 * N+1 rects. A width that would overrun the rect is clamped, and the trailing
 * rect is then zero-wide — which callers use as the signal to skip the right
 * rail rather than draw it off-screen (§6).
 */
export function columns(rect: Rect, widths: readonly number[]): Rect[] {
  const out: Rect[] = [];
  let x = rect.x;
  for (const requested of widths) {
    const w = Math.max(0, Math.min(requested, rect.x + rect.w - x));
    out.push({ x, y: rect.y, w, h: rect.h });
    x += w;
  }
  out.push({ x, y: rect.y, w: Math.max(0, rect.x + rect.w - x), h: rect.h });
  return out;
}

/** Split a rect into stacked rows, with the same absorb-the-rest contract. */
export function rows(rect: Rect, heights: readonly number[]): Rect[] {
  const out: Rect[] = [];
  let y = rect.y;
  for (const requested of heights) {
    const h = Math.max(0, Math.min(requested, rect.y + rect.h - y));
    out.push({ x: rect.x, y, w: rect.w, h });
    y += h;
  }
  out.push({ x: rect.x, y, w: rect.w, h: Math.max(0, rect.y + rect.h - y) });
  return out;
}

/** Clamp a cursor into `[0, count)`, returning 0 for an empty pane. */
export function clampCursor(cursor: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, cursor));
}

/**
 * The visible slice of a list under a fixed-height pane.
 *
 * §4.3.a forbids a scrolling viewport, but a selection that has moved past the
 * pane edge must still be visible or `j` stops doing anything. So: the list
 * pages by the selection — the window jumps, it does not scroll — and the pane
 * legend says which page you are on.
 */
export function windowFor(
  cursor: number,
  count: number,
  height: number,
): { from: number; to: number } {
  if (height <= 0 || count <= 0) return { from: 0, to: 0 };
  const page = Math.floor(cursor / height);
  const from = page * height;
  return { from, to: Math.min(count, from + height) };
}
