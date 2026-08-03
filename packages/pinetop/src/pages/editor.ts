/**
 * EDITOR (§4.2, page 1) — the Pine source itself.
 *
 * This page reverses NG4 ("not a Pine editor"), and the reason is the loop the
 * whole app exists for. §2's premise is that a session is iterative: read the
 * report, decide the stop is wrong, change it, run again. Flags cover the half of
 * that which is a flag — but a stop that is wrong in the *script* sent the user
 * to another window, and coming back meant a stale report beside a changed file
 * with nothing on screen saying so. The `.pine` is part of the invocation; it now
 * has a page like every other part.
 *
 * It is still not a second engine or a second linter (§3 NG1 stands): the editor
 * writes bytes and colours tokens. Whether the script compiles is `piner`'s
 * answer, and you get it by running it.
 *
 * Layout follows §4.4 — the sidebar is the left column (the project's scripts,
 * and the `input()` titles of the open one), the buffer is the wide middle. The
 * one deliberate departure is documented on `scrollIntoView` in `editor/vim.ts`:
 * the buffer scrolls, because a text cursor defines its own viewport.
 */

import { inputTitles } from '../flags/pine-inputs.js';
import { HINTS } from '../keymap.js';
import { int } from '../render/format.js';
import { displayWidth, drawPane, truncate, type Rect } from '../render/screen.js';
import { STYLE, type Style } from '../render/theme.js';
import { cachedScripts, refreshScripts, scriptLabel } from '../scripts.js';
import type { AppState } from '../state.js';
import { bufferText, orderCursors, type Cursor } from '../editor/buffer.js';
import { highlight } from '../editor/syntax.js';
import { modeLabel, type EditorState } from '../editor/state.js';
import { handleKey, openFile } from '../editor/vim.js';
import { drawInputsPane } from './inputs-pane.js';
import { clampCursor, columns, rows, windowFor, type Page, type PageContext } from './page.js';

/**
 * Focus ring order, which is not the layout order on purpose: `tab` from FILES
 * lands in the buffer, because that is the pane you came here for. INPUTS is an
 * outline you glance at, so it sits last in the ring.
 */
const PANES = ['files', 'editor', 'inputs'] as const;

/**
 * Open something worth looking at the first time the page is shown.
 *
 * Reading a file is not a config mutation, so §4.6's "nothing without a keypress"
 * does not bind here — and an empty buffer beside a project full of scripts is a
 * puzzle, not a blank slate. The loaded strategy wins; failing that, the first
 * script in the project.
 */
export function ensureEditorFile(state: AppState): void {
  if (state.editor.buffer != null) return;
  const path = state.flags.backtest.scripts[0] ?? cachedScripts()[0]?.path;
  if (path == null) return;
  openFile(state.editor, path);
}

/** The `input()` titles of the buffer as it stands — not of the file on disk. */
export function bufferInputs(editor: EditorState): string[] {
  if (editor.buffer == null) return [];
  return inputTitles(bufferText(editor.buffer));
}

// ————————————————————————————————————————————————————————————— the sidebar

function drawFiles(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const list = cachedScripts();
  const open = state.editor.buffer?.path;

  const inner = drawPane(screen, rect, {
    title: 'FILES',
    focused: ctx.focus === 'files',
    key: ctx.paneKey('files'),
    legend: list.length > 0 ? `${list.length} .pine` : undefined,
  });
  if (inner.h <= 0) return;

  if (list.length === 0) {
    screen.text(inner.x, inner.y, 'no .pine found here', STYLE.muted, inner);
    screen.text(inner.x, inner.y + 1, ':e path.pine creates one', STYLE.muted, inner);
    return;
  }

  const cursor = clampCursor(ctx.cursor('files'), list.length);
  const listRows = Math.max(0, inner.h - 1);
  const { from, to } = windowFor(cursor, list.length, listRows);

  for (let i = from; i < to; i++) {
    const entry = list[i]!;
    const y = inner.y + (i - from);
    const selected = i === cursor && ctx.focus === 'files';
    const isOpen = entry.path === open;

    if (selected) screen.text(inner.x, y, ' '.repeat(inner.w), STYLE.selected);
    // The open file keeps its bar marker wherever the cursor is, so "which file
    // is in the buffer" never depends on where you last pressed j.
    screen.text(inner.x, y, isOpen ? '▌' : ' ', selected ? STYLE.selected : STYLE.accent);
    screen.text(
      inner.x + 1,
      y,
      truncate(entry.label, Math.max(0, inner.w - 3)),
      selected ? STYLE.selected : isOpen ? STYLE.none : STYLE.muted,
    );
    // An unwritten buffer is marked here too: the FILES list is where you look
    // before switching away from something you have not saved.
    if (isOpen && state.editor.buffer?.modified === true) {
      screen.text(inner.x + inner.w - 1, y, '+', selected ? STYLE.selected : STYLE.pending);
    }
  }

  screen.text(inner.x, inner.y + inner.h - 1, 'j/k move · ↵ open', STYLE.muted, inner);
}

/**
 * The `input()` titles the buffer declares, read from the buffer rather than
 * from disk — so the outline answers "did my rename land?" while you are still
 * typing it, and `--input` names can be checked against the source you have in
 * front of you (§4.5.e is the same list, validated).
 */
function drawInputs(ctx: PageContext, rect: Rect): void {
  const titles = bufferInputs(ctx.state.editor);
  drawInputsPane(ctx, rect, {
    paneId: 'inputs',
    rows: titles.map((title) => ({ title })),
    legend: titles.length > 0 ? String(titles.length) : undefined,
    empty: ctx.state.editor.buffer == null ? 'no file open' : 'no input() declared',
  });
}

// —————————————————————————————————————————————————————————————— the buffer

interface Selection {
  start: Cursor;
  end: Cursor;
  linewise: boolean;
}

/** The visual-mode selection, ordered and inclusive of the cursor's character. */
export function selection(editor: EditorState): Selection | null {
  const buffer = editor.buffer;
  if (buffer == null || editor.anchor == null) return null;
  if (editor.mode !== 'visual' && editor.mode !== 'visual-line') return null;
  const [start, end] = orderCursors(editor.anchor, { line: buffer.line, col: buffer.col });
  return { start, end, linewise: editor.mode === 'visual-line' };
}

/** The selected column range on one line, or null when the line is untouched. */
function selectedColumns(
  sel: Selection,
  line: number,
  length: number,
): { from: number; to: number } | null {
  if (line < sel.start.line || line > sel.end.line) return null;
  if (sel.linewise) return { from: 0, to: Math.max(1, length) };
  const from = line === sel.start.line ? sel.start.col : 0;
  const to = line === sel.end.line ? sel.end.col + 1 : Math.max(1, length);
  return { from, to: Math.max(from, to) };
}

function drawBuffer(ctx: PageContext, rect: Rect): void {
  const { screen, state } = ctx;
  const editor = state.editor;
  const buffer = editor.buffer;
  const focused = ctx.focus === 'editor';

  const legend =
    buffer == null
      ? undefined
      : `${buffer.line + 1}:${buffer.col + 1} · ${int(buffer.lines.length)}L${
          buffer.modified ? ' +' : ''
        }`;

  const inner = drawPane(screen, rect, {
    title: buffer == null ? 'EDITOR' : truncate(scriptLabel(buffer.path).toUpperCase(), 28),
    focused,
    key: ctx.paneKey('editor'),
    legend,
  });
  if (inner.h <= 0) return;

  // The last interior row is the vim status line; the rest is the window. The
  // key layer reads this back for ctrl-d, ctrl-f and zz.
  const textH = Math.max(1, inner.h - 1);
  const statusY = inner.y + inner.h - 1;
  editor.viewHeight = textH;

  if (buffer == null) {
    screen.text(inner.x, inner.y, 'no file open', STYLE.muted, inner);
    screen.text(
      inner.x,
      inner.y + 1,
      'tab to FILES and press ↵, or :e path.pine',
      STYLE.muted,
      inner,
    );
    drawStatus(ctx, inner, statusY);
    return;
  }

  const gutterW = editor.gutter ? Math.max(4, String(buffer.lines.length).length + 2) : 0;
  const textX = inner.x + gutterW;
  const textW = Math.max(1, inner.x + inner.w - textX);
  // One shared horizontal offset rather than per-line: the rows must stay on a
  // common grid, or the indentation stops meaning anything (§4.3.a).
  const hoff = Math.max(0, buffer.col - textW + 1);
  const top = Math.max(0, Math.min(buffer.top, Math.max(0, buffer.lines.length - 1)));
  const sel = selection(editor);

  for (let row = 0; row < textH; row++) {
    const index = top + row;
    const y = inner.y + row;

    if (index >= buffer.lines.length) {
      // vim's own marker for "past the end of the buffer" — an empty row and a
      // row that does not exist are different facts.
      screen.text(inner.x, y, '~', STYLE.muted, inner);
      continue;
    }

    const text = buffer.lines[index]!;

    if (gutterW > 0) {
      const label = String(index + 1);
      // Right-aligned, one space clear of the text column.
      screen.text(
        textX - 1 - label.length,
        y,
        label,
        index === buffer.line ? STYLE.none : STYLE.muted,
        inner,
      );
    }

    screen.text(textX, y, text.slice(hoff, hoff + textW), STYLE.none, inner);
    for (const span of highlight(text)) {
      const from = Math.max(span.start, hoff);
      const to = Math.min(span.start + span.length, hoff + textW);
      if (to <= from) continue;
      screen.text(textX + (from - hoff), y, text.slice(from, to), span.style, inner);
    }

    if (sel != null) {
      const range = selectedColumns(sel, index, text.length);
      if (range != null) {
        const from = Math.max(range.from, hoff);
        const to = Math.min(range.to, hoff + textW);
        for (let col = from; col < to; col++) {
          screen.text(textX + (col - hoff), y, text[col] ?? ' ', STYLE.selected, inner);
        }
      }
    }

    if (index === buffer.line) {
      // The terminal cursor is hidden (the app owns the grid), so the cursor is
      // a styled cell. Bold reverse, so it stays visible inside a selection.
      const cx = textX + (buffer.col - hoff);
      if (cx >= textX && cx < textX + textW) {
        const ch = text[buffer.col] ?? ' ';
        screen.text(cx, y, ch === '' ? ' ' : ch, focused ? STYLE.cursor : STYLE.selected, inner);
      }
    }
  }

  drawStatus(ctx, inner, statusY);
}

/**
 * The vim status line: the command being typed, or the last message, or the
 * mode. The partial command (`3d`, `f`) sits on the right the way vim shows it,
 * so a half-entered operator is visible rather than silently pending.
 */
function drawStatus(ctx: PageContext, inner: Rect, y: number): void {
  const { screen, state } = ctx;
  const editor = state.editor;
  const buffer = editor.buffer;

  let left = '';
  let style: Style = STYLE.muted;
  if (editor.mode === 'command') {
    left = `${editor.cmdPrefix}${editor.cmdline}█`;
    style = STYLE.accent;
  } else if (editor.message !== '') {
    left = editor.message;
    style = editor.error ? STYLE.error : STYLE.muted;
  } else {
    left = modeLabel(editor.mode);
    style = STYLE.accentBold;
  }
  screen.text(inner.x, y, truncate(left, inner.w), style, inner);

  const partial = `${editor.count}${editor.operator ?? ''}${editor.pending ?? ''}`;
  const ruler =
    buffer == null
      ? ''
      : `${buffer.line + 1},${buffer.col + 1}${partial === '' ? '' : `  ${partial}`}`;
  if (ruler !== '' && displayWidth(left) + displayWidth(ruler) + 2 <= inner.w) {
    screen.text(inner.x + inner.w - displayWidth(ruler), y, ruler, STYLE.muted, inner);
  }
}

// ———————————————————————————————————————————————————————————————— the page

const EDITOR_HINTS: readonly { key: string; label: string }[] = [
  { key: 'i', label: 'insert' },
  { key: 'esc', label: 'normal' },
  { key: ':w', label: 'write' },
  { key: ':q', label: 'close' },
  { key: 'tab', label: 'pane' },
  { key: '?', label: 'help' },
];

export const editorPage: Page = {
  id: 'editor',
  // The sidebar's 22 columns plus enough buffer to read a Pine line without the
  // indentation dominating. Narrower than the report pages on purpose: there is
  // no table here whose payoff column could fall off the edge.
  minCols: 72,
  degradeNote: 'the buffer loses columns',

  panes: () => [...PANES],

  rowCount: (state, paneId) => {
    switch (paneId) {
      case 'files':
        return cachedScripts().length;
      case 'inputs':
        return bufferInputs(state.editor).length;
      case 'editor':
        return state.editor.buffer?.lines.length ?? 0;
      default:
        return 0;
    }
  },

  hints: (state) => (state.panes.editor.focus === 'editor' ? EDITOR_HINTS : HINTS),

  breadcrumb: (state) => {
    const crumbs = ['pinetop'];
    const buffer = state.editor.buffer;
    if (buffer == null) return [...crumbs, '(no file open)'];
    crumbs.push(buffer.path);
    crumbs.push(`${int(buffer.lines.length)} lines`);
    if (buffer.isNew) crumbs.push('new file');
    else if (buffer.modified) crumbs.push('unwritten changes');
    return crumbs;
  },

  confirm: (state) => {
    const focus = state.panes.editor.focus;
    if (focus === 'inputs') return undefined;

    // ↵ on FILES opens the file. It does not load it as the strategy to run —
    // that is BACKTEST's own ↵, and doing both here would make one keypress
    // change what the next `r` would spawn.
    const list = cachedScripts();
    if (list.length === 0) return 'no .pine here — :e path.pine starts one';
    const entry = list[clampCursor(state.panes.editor.cursor['files'] ?? 0, list.length)];
    if (entry == null) return undefined;

    if (focus === 'editor' && state.editor.buffer != null) return undefined;
    if (state.editor.buffer?.modified === true && state.editor.buffer.path !== entry.path) {
      return 'unwritten changes — :w to write, or :e! to discard';
    }
    openFile(state.editor, entry.path);
    state.panes.editor.focus = 'editor';
    return `editing ${entry.label}.pine — i inserts, :w writes`;
  },

  /**
   * The buffer owns the keyboard whenever it has focus. `tab` and `ctrl-c` are
   * the exceptions the vim layer refuses to take, so the rest of the app is
   * always one keystroke away.
   */
  claimsKeyboard: (state) => state.panes.editor.focus === 'editor',

  onKey: (state, key) => {
    if (state.panes.editor.focus !== 'editor') return false;
    const outcome = handleKey(state.editor, key);
    // A file written for the first time has to appear in FILES, and in the
    // STRATEGIES pane that shares the same discovery cache.
    if (outcome.wrote != null) refreshScripts();
    if (outcome.closed === true) state.panes.editor.focus = 'files';
    return outcome.consumed;
  },

  render: (ctx) => {
    const { body, screen } = ctx;
    const sidebarW = Math.min(34, Math.max(22, Math.floor(screen.cols * 0.2)));
    const [sidebar, main] = columns(body, [sidebarW]) as [Rect, Rect];

    const inputsH = Math.min(12, Math.max(4, Math.floor(sidebar.h * 0.32)));
    const [filesRect, inputsRect] = rows(sidebar, [sidebar.h - inputsH]) as [Rect, Rect];

    drawFiles(ctx, filesRect);
    drawInputs(ctx, inputsRect);
    drawBuffer(ctx, main);
  },
};
