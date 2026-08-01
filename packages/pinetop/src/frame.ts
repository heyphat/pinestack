/**
 * The frame: everything that is identical on all eight pages.
 *
 * Top to bottom — tab bar (§4.2), breadcrumb, the page's body, the composed
 * `$ pinerun …` line (§3 G2: always shown verbatim, always copy-pasteable), and
 * the hint strip. The prototype draws a macOS window chrome above the tab bar;
 * a TTY has no such thing, so the window title goes to the terminal via OSC and
 * the grid size to the right of the tab bar.
 */

import { commandLine, withOverrides } from './flags/model.js';
import { PAGES, PAGE_TITLES, type PageId } from './flags/schema.js';
import { HINTS } from './keymap.js';
import { displayWidth, truncate, type Rect, type Screen } from './render/screen.js';
import { STYLE } from './render/theme.js';
import { duration } from './render/format.js';
import type { AppState } from './state.js';
import { isDirty, overridesFor } from './state.js';
import type { Page } from './pages/page.js';

/** OSC 2 — the terminal's own title bar, the honest home for the window title. */
export function windowTitle(state: AppState): string {
  return `pinetop — ${PAGE_TITLES[state.page].toLowerCase()} workbench`;
}

function statusGlyph(state: AppState): { text: string; style: string } {
  const run = state.run;
  if (run == null) return { text: '◆ idle', style: STYLE.muted };
  switch (run.status) {
    case 'running':
      return { text: '◆ running', style: STYLE.accentBold };
    case 'failed':
      return { text: '◆ failed', style: STYLE.error };
    case 'ok':
      return { text: '◆ ready', style: STYLE.positive };
    default:
      return { text: '◆ idle', style: STYLE.muted };
  }
}

/** Columns the full tab bar wants: `1 EDITOR  2 BACKTEST  …`. */
function tabBarWidth(): number {
  return PAGES.reduce((sum, page, i) => sum + `${i + 1} `.length + PAGE_TITLES[page].length + 2, 1);
}

function drawTabs(screen: Screen, state: AppState, y: number): void {
  const status = statusGlyph(state);
  const grid = `${screen.cols}×${screen.rows}`;
  // The right side is drawn first so the tabs know how much room they actually
  // have. With eight pages the full bar no longer fits an 80-column terminal, and
  // a tab bar overprinted by the grid size is worse than a compact one.
  const rightW = displayWidth(grid) + 3 + displayWidth(status.text);
  const room = screen.cols - 2 - rightW;
  const compact = tabBarWidth() > room;

  let x = 1;
  for (let i = 0; i < PAGES.length; i++) {
    const page = PAGES[i]!;
    const active = page === state.page;
    const ordinal = `${i + 1} `;
    screen.text(x, y, ordinal, active ? STYLE.accent : STYLE.muted);
    x += ordinal.length;
    // Compact form names only the page you are on. Its ordinal sits immediately
    // to its left, so which tab the title belongs to is never ambiguous.
    if (compact && !active) {
      x += 1;
      continue;
    }
    const title = PAGE_TITLES[page];
    screen.text(x, y, title, active ? STYLE.accentBold : STYLE.muted);
    x += title.length + 2;
  }

  // Right side: run status, then the grid the page is being drawn at.
  screen.text(screen.cols - 1 - displayWidth(grid), y, grid, STYLE.muted);
  const statusX = screen.cols - 3 - displayWidth(grid) - displayWidth(status.text);
  if (statusX > x) screen.text(statusX, y, status.text, status.style);
}

function drawBreadcrumb(screen: Screen, state: AppState, page: Page, y: number): void {
  const crumbs = page.breadcrumb(state);
  let x = 1;
  for (let i = 0; i < crumbs.length; i++) {
    if (i > 0) {
      screen.text(x, y, ' / ', STYLE.muted);
      x += 3;
    }
    const last = i === crumbs.length - 1;
    const text = truncate(crumbs[i]!, Math.max(0, screen.cols - x - 2));
    screen.text(x, y, text, last ? STYLE.none : STYLE.muted);
    x += displayWidth(text);
  }

  // Right side: the flags that are true of the whole run but not worth a pane.
  const command = page.command;
  if (command != null) {
    const model = state.flags[command];
    const notes: string[] = [];
    const backend = model.values['backend'];
    if (backend) notes.push(`--backend ${String(backend)}`);
    const mintick = model.values['mintick'];
    if (mintick != null) notes.push(`--mintick ${String(mintick)}`);
    const minQty = model.values['min-qty'];
    if (minQty != null) notes.push(`--min-qty ${String(minQty)}`);
    const right = notes.join(' · ');
    if (right !== '' && x + 2 + displayWidth(right) < screen.cols) {
      screen.text(screen.cols - 1 - displayWidth(right), y, right, STYLE.muted);
    }
  }
}

/**
 * The dirty banner (§4.5.c): applied edits have not been re-run, so every number
 * on screen predates them. This is drawn over the breadcrumb row because it must
 * not be possible to read the report without seeing it.
 */
function drawDirtyBanner(screen: Screen, state: AppState, page: Page, y: number): boolean {
  const command = page.command;
  if (command == null || !isDirty(state, command)) return false;

  const edits = overridesFor(state, command);
  const summary = edits.map((e) => `${e.input} ${e.from}→${e.to}`).join('  ');
  const label = ` ● not yet re-run — ${edits.length} pending edit${edits.length === 1 ? '' : 's'}: `;
  screen.text(1, y, ' '.repeat(Math.max(0, screen.cols - 2)), STYLE.pending);
  screen.text(1, y, label, STYLE.pending);
  screen.text(
    1 + displayWidth(label),
    y,
    truncate(summary, Math.max(0, screen.cols - 3 - displayWidth(label) - 18)),
    STYLE.pending,
  );
  const hint = 'r rerun · ctrl-x revert ';
  screen.text(screen.cols - 1 - displayWidth(hint), y, hint, STYLE.pending);
  return true;
}

function drawCommandLine(screen: Screen, state: AppState, page: Page, y: number): void {
  const command = page.command;
  if (command == null) {
    // TRADES has no command of its own; it shows the run that produced the
    // ledger, so the line still reproduces what is on screen.
    const run = state.run;
    const text = run == null ? '$ (no run loaded)' : `$ pinerun ${run.argv.join(' ')}`;
    screen.text(1, y, '$', STYLE.accent);
    screen.text(3, y, truncate(text.slice(2), screen.cols - 4), STYLE.none);
    return;
  }

  const model = withOverrides(state.flags[command], overridesFor(state, command));
  const line = commandLine(model);
  screen.text(1, y, '$', STYLE.accent);
  screen.text(3, y, truncate(line, screen.cols - 4), STYLE.none);
}

function drawHints(screen: Screen, state: AppState, page: Page, y: number): void {
  let x = 1;
  for (const hint of page.hints?.(state) ?? HINTS) {
    screen.text(x, y, hint.key, STYLE.accent);
    x += hint.key.length + 1;
    screen.text(x, y, hint.label, STYLE.muted);
    x += hint.label.length + 2;
  }

  const right: string[] = [];
  if (state.run?.progress) right.push(state.run.progress);
  else if (state.status) right.push(state.status);
  if (state.run?.elapsedMs != null) right.push(duration(state.run.elapsedMs));
  if (state.run != null) right.push(`run ${state.run.id}`);
  const text = truncate(right.join(' · '), Math.max(0, screen.cols - x - 2));
  if (text !== '') screen.text(screen.cols - 1 - displayWidth(text), y, text, STYLE.muted);
}

/**
 * Draw the chrome and return the body rectangle the page may use.
 *
 * `askRows` reserves space at the bottom for the Ask drawer, which overlays the
 * frame rather than displacing the page (§4.5.a).
 */
export function drawFrame(screen: Screen, state: AppState, page: Page, askRows = 0): Rect {
  const tabsY = 0;
  const crumbY = 1;
  const hintsY = screen.rows - 1;
  const cmdY = screen.rows - 2;

  drawTabs(screen, state, tabsY);
  const dirty = drawDirtyBanner(screen, state, page, crumbY);
  if (!dirty) drawBreadcrumb(screen, state, page, crumbY);
  drawCommandLine(screen, state, page, cmdY);
  drawHints(screen, state, page, hintsY);

  const bodyTop = crumbY + 1;
  const bodyBottom = cmdY - askRows;
  return {
    x: 0,
    y: bodyTop,
    w: screen.cols,
    h: Math.max(0, bodyBottom - bodyTop),
  };
}

/**
 * The width guard (§6). Below a page's min-width the right rail is dropped
 * before any table is truncated, and the user is told once — a column that
 * silently vanished is indistinguishable from a column that never existed.
 */
export function widthWarning(page: Page, cols: number): string | undefined {
  if (cols >= page.minCols) return undefined;
  const note = page.degradeNote ?? 'right rail dropped';
  return `terminal is ${cols} cols; ${PAGE_TITLES[page.id]} wants ${page.minCols} — ${note}`;
}

export function pageOrdinal(page: PageId): number {
  return PAGES.indexOf(page) + 1;
}
