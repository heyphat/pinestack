/**
 * The modal key handler — the editor's whole keyboard.
 *
 * Why vim rather than a plain text field: the audience for a Pine editor inside a
 * terminal workbench already has these bindings in their fingers, and a modal
 * editor is the only kind that can share a keyboard with a TUI. `j` cannot mean
 * both "next flag" and "insert a j", so the mode has to say which — and once
 * there is a mode, the rest of the grammar (counts, operators, motions) is what
 * makes editing worth doing here at all.
 *
 * Two boundaries this file keeps:
 *  - **`ctrl-c` is never consumed.** Quitting pinetop must stay reachable from
 *    every surface, including a half-typed insert. `q` *is* consumed, with a
 *    message — an accidental app quit that discards an unwritten buffer is the
 *    one outcome this page must not have.
 *  - **Only `:w` touches the disk**, through the injected `EditorIo`. Everything
 *    else in this file is a pure transformation of the buffer.
 *
 * `.` (repeat), macros, marks and registers beyond the unnamed one are not
 * implemented. That is a boundary, not an oversight: the help overlay lists
 * exactly what is bound, so an unimplemented key says nothing happened rather
 * than doing something almost-right.
 */

import type { Key } from '../terminal.js';
import {
  bufferText,
  clampTo,
  currentLine,
  deleteBefore,
  deleteChars,
  deleteLines,
  deleteSpan,
  firstNonBlank,
  indentLines,
  insertNewline,
  insertText,
  joinLines,
  lineAt,
  newBuffer,
  openLine,
  orderCursors,
  pushUndo,
  put,
  redoEdit,
  replaceChar,
  replaceLines,
  spanText,
  undoEdit,
  type Cursor,
  type EditorBuffer,
} from './buffer.js';
import { editorIo, type EditorIo } from './io.js';
import * as move from './motion.js';
import type { EditorState } from './state.js';

/** One indent step. Pine's own convention, and what the docs' examples use. */
export const INDENT_WIDTH = 4;

/** Lines kept between the cursor and the window edge, as vim's `scrolloff`. */
const SCROLLOFF = 3;

export interface VimOutcome {
  consumed: boolean;
  /** `:q` — the page hands focus back to the FILES pane. */
  closed?: boolean;
  /** Path just written, so the caller can refresh file discovery. */
  wrote?: string;
}

const PASS: VimOutcome = { consumed: false };
const TOOK: VimOutcome = { consumed: true };

function setMessage(editor: EditorState, text: string, error = false): void {
  editor.message = text;
  editor.error = error;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ——————————————————————————————————————————————————————————— open / write

/**
 * Load a file into the buffer. A path with nothing behind it is not an error —
 * it is a new file, exactly as `vim newthing.pine` is, and `:w` creates it.
 */
export function openFile(editor: EditorState, path: string, io: EditorIo = editorIo()): void {
  let text = '';
  let isNew = false;
  try {
    text = io.read(path);
  } catch {
    isNew = true;
  }
  const buffer = newBuffer(path, text, isNew);
  editor.buffer = buffer;
  editor.mode = 'normal';
  editor.anchor = null;
  editor.operator = null;
  editor.pending = null;
  editor.count = '';
  editor.cmdline = '';
  setMessage(editor, isNew ? `"${path}" [New]` : `"${path}" ${buffer.lines.length}L`);
}

/** `:w [path]`. Returns the path written, so the caller can rescan the project. */
export function writeFile(
  editor: EditorState,
  path: string | undefined,
  io: EditorIo = editorIo(),
): string | undefined {
  const buffer = editor.buffer;
  if (buffer == null) return undefined;
  const target = path != null && path !== '' ? path : buffer.path;
  if (target === '') {
    setMessage(editor, 'E32: no file name', true);
    return undefined;
  }
  try {
    io.write(target, bufferText(buffer));
  } catch (err) {
    setMessage(editor, `E212: cannot write "${target}": ${reason(err)}`, true);
    return undefined;
  }
  buffer.path = target;
  buffer.modified = false;
  buffer.isNew = false;
  setMessage(editor, `"${target}" ${buffer.lines.length}L written`);
  return target;
}

// ——————————————————————————————————————————————————————— cursor + viewport

/**
 * Keep the cursor inside the window.
 *
 * §4.3.a forbids a scrolling viewport, and every other pane obeys it by paging
 * the selection. A text buffer is the one surface where that would be wrong: the
 * cursor *is* the position, and a window that jumped a page whenever it crossed a
 * boundary would move text out from under it mid-edit. So the editor scrolls, and
 * only the editor.
 */
function scrollIntoView(editor: EditorState): void {
  const buffer = editor.buffer;
  if (buffer == null) return;
  const height = Math.max(1, editor.viewHeight);
  const off = Math.min(SCROLLOFF, Math.floor(Math.max(0, height - 1) / 2));

  let top = buffer.top;
  if (buffer.line - off < top) top = buffer.line - off;
  if (buffer.line + off > top + height - 1) top = buffer.line + off - height + 1;
  top = Math.min(top, Math.max(0, buffer.lines.length - height));
  // At the buffer's edges the scrolloff cannot be honoured; the cursor being on
  // screen still must be.
  top = Math.min(top, buffer.line);
  top = Math.max(top, buffer.line - height + 1);
  buffer.top = Math.max(0, top);
}

function moveCursor(editor: EditorState, cursor: Cursor, vertical = false): void {
  const buffer = editor.buffer;
  if (buffer == null) return;
  buffer.line = cursor.line;
  buffer.col = cursor.col;
  if (!vertical) buffer.wantCol = cursor.col;
  clampTo(buffer, editor.mode === 'insert');
  scrollIntoView(editor);
}

function enterInsert(editor: EditorState, takeSnapshot = true): void {
  const buffer = editor.buffer;
  if (buffer == null) return;
  if (takeSnapshot) pushUndo(buffer);
  editor.mode = 'insert';
  editor.anchor = null;
  clampTo(buffer, true);
  scrollIntoView(editor);
  setMessage(editor, '');
}

function enterNormal(editor: EditorState): void {
  const buffer = editor.buffer;
  editor.mode = 'normal';
  editor.anchor = null;
  editor.operator = null;
  editor.pending = null;
  editor.count = '';
  if (buffer != null) clampTo(buffer);
  scrollIntoView(editor);
}

function takeCount(editor: EditorState): number {
  const count = editor.count === '' ? 1 : Number.parseInt(editor.count, 10);
  editor.count = '';
  return Number.isFinite(count) && count > 0 ? count : 1;
}

// ————————————————————————————————————————————————————————————— the router

export function handleKey(editor: EditorState, key: Key, io: EditorIo = editorIo()): VimOutcome {
  if (editor.buffer == null) return PASS;
  // Quitting the app is not the editor's to intercept — see the header.
  if (key.name === 'ctrl-c') return PASS;

  switch (editor.mode) {
    case 'command':
      return onCommandLine(editor, key, io);
    case 'insert':
      return onInsert(editor, key);
    case 'visual':
    case 'visual-line':
      return onVisual(editor, key);
    default:
      return onNormal(editor, key);
  }
}

// ————————————————————————————————————————————————————————————— insert mode

function onInsert(editor: EditorState, key: Key): VimOutcome {
  const buffer = editor.buffer!;

  switch (key.name) {
    case 'escape':
      // vim steps the cursor left on leaving insert, so the character you just
      // typed is the one under the cursor.
      buffer.col = Math.max(0, buffer.col - 1);
      enterNormal(editor);
      setMessage(editor, '');
      return TOOK;
    case 'enter':
      insertNewline(buffer);
      scrollIntoView(editor);
      return TOOK;
    case 'backspace':
      deleteBefore(buffer);
      scrollIntoView(editor);
      return TOOK;
    case 'delete':
      deleteChars(buffer, 1);
      return TOOK;
    case 'tab':
      insertText(buffer, ' '.repeat(INDENT_WIDTH));
      return TOOK;
    case 'ctrl-u': {
      // Clear to the start of the line's text, as it does in the flag fields.
      const indent = /^[ \t]*/.exec(currentLine(buffer))?.[0].length ?? 0;
      const from = buffer.col > indent ? indent : 0;
      deleteSpan(buffer, { line: buffer.line, col: from }, { line: buffer.line, col: buffer.col });
      clampTo(buffer, true);
      return TOOK;
    }
    case 'ctrl-w': {
      const to = move.wordBackward(buffer, { line: buffer.line, col: buffer.col }, 1).cursor;
      deleteSpan(buffer, to, { line: buffer.line, col: buffer.col });
      clampTo(buffer, true);
      return TOOK;
    }
    case 'left':
      moveCursor(editor, move.charLeft(buffer, cursorOf(buffer), 1).cursor);
      return TOOK;
    case 'right':
      moveCursor(editor, {
        line: buffer.line,
        col: Math.min(currentLine(buffer).length, buffer.col + 1),
      });
      return TOOK;
    case 'up':
      moveCursor(editor, move.lineUp(buffer, cursorOf(buffer), 1, buffer.wantCol).cursor, true);
      return TOOK;
    case 'down':
      moveCursor(editor, move.lineDown(buffer, cursorOf(buffer), 1, buffer.wantCol).cursor, true);
      return TOOK;
    case 'home':
      moveCursor(editor, { line: buffer.line, col: 0 });
      return TOOK;
    case 'end':
      moveCursor(editor, { line: buffer.line, col: currentLine(buffer).length });
      return TOOK;
    default:
      break;
  }

  if (key.text != null) {
    insertText(buffer, key.text);
    scrollIntoView(editor);
    return TOOK;
  }
  // Swallow anything else: a stray escape sequence must not reach the keymap and
  // switch pages out from under an open insert.
  return TOOK;
}

function cursorOf(buffer: EditorBuffer): Cursor {
  return { line: buffer.line, col: buffer.col };
}

// ————————————————————————————————————————————————————————————— normal mode

/**
 * A motion, if this key is one. `undefined` means "not a motion"; `null` means
 * "a motion that found nothing", which must leave the cursor alone.
 */
function resolveMotion(
  editor: EditorState,
  name: string,
  count: number,
  hadCount: boolean,
): { result: move.MotionResult; vertical: boolean } | null | undefined {
  const buffer = editor.buffer!;
  const at = cursorOf(buffer);
  const flat = (result: move.MotionResult): { result: move.MotionResult; vertical: boolean } => ({
    result,
    vertical: false,
  });

  switch (name) {
    case 'h':
    case 'left':
    case 'backspace':
      return flat(move.charLeft(buffer, at, count));
    case 'l':
    case 'right':
    case ' ':
      return flat(move.charRight(buffer, at, count));
    case 'j':
    case 'down':
      return { result: move.lineDown(buffer, at, count, buffer.wantCol), vertical: true };
    case 'k':
    case 'up':
      return { result: move.lineUp(buffer, at, count, buffer.wantCol), vertical: true };
    case '0':
    case 'home':
      return flat(move.lineStart(at));
    case '^':
      return flat(move.lineFirstNonBlank(buffer, at));
    case '$':
    case 'end':
      return flat(move.lineEnd(buffer, at, count));
    case 'w':
      return flat(move.wordForward(buffer, at, count));
    case 'W':
      return flat(move.wordForward(buffer, at, count, true));
    case 'b':
      return flat(move.wordBackward(buffer, at, count));
    case 'B':
      return flat(move.wordBackward(buffer, at, count, true));
    case 'e':
      return flat(move.wordEnd(buffer, at, count));
    case 'E':
      return flat(move.wordEnd(buffer, at, count, true));
    case 'G':
      // Bare `G` is the last line; `42G` is line 42.
      return {
        result: move.gotoLine(buffer, hadCount ? count : buffer.lines.length),
        vertical: true,
      };
    case '{':
      return { result: move.paragraph(buffer, at, false), vertical: true };
    case '}':
      return { result: move.paragraph(buffer, at, true), vertical: true };
    case 'n':
    case 'N': {
      const last = editor.lastSearch;
      if (last == null) {
        setMessage(editor, 'E35: no previous regular expression', true);
        return null;
      }
      const forward = name === 'n' ? last.forward : !last.forward;
      const found = move.search(buffer, at, last.needle, forward);
      if (found == null) {
        setMessage(editor, `E486: pattern not found: ${last.needle}`, true);
        return null;
      }
      return flat(found);
    }
    default:
      return undefined;
  }
}

/**
 * Keys that a pending operator survives: another operator (`d` after `y` retargets
 * it) and the keys that take an argument of their own, so `dfx` and `dgg` reach
 * their second half with the `d` still in hand. Anything else abandons the
 * operator, as it does in vim.
 */
const CARRIES_OPERATOR = new Set(['d', 'c', 'y', '>', '<', 'g', 'f', 'F', 't', 'T']);

function onNormal(editor: EditorState, key: Key): VimOutcome {
  const buffer = editor.buffer!;
  const name = key.name;

  // `tab` is how the user leaves the editor pane, so it belongs to the frame in
  // every mode but insert. Without this the buffer would be a keyboard trap.
  if (name === 'tab' || name === 'shift-tab') return PASS;

  if (editor.pending != null) return onPending(editor, key);

  // Counts accumulate; a bare `0` is the line-start motion, not a count digit.
  if (/^[1-9]$/.test(name) || (name === '0' && editor.count !== '')) {
    editor.count += name;
    return TOOK;
  }

  const pendingOperator = editor.operator;

  // The doubled form of an operator (`dd`, `yy`, `>>`) is linewise over `count`
  // lines, which is the one case that has no motion to resolve.
  if (pendingOperator != null && name === pendingOperator) {
    const lines = takeCount(editor) * editor.pendingCount;
    editor.operator = null;
    operate(
      editor,
      pendingOperator,
      { line: buffer.line, col: 0 },
      { line: Math.min(buffer.lines.length - 1, buffer.line + lines - 1), col: 0 },
      true,
      false,
    );
    return TOOK;
  }

  const hadCount = editor.count !== '';
  const count = takeCount(editor);

  // Motions come before commands, so a key that is both (`0`, `G`, `n`) resolves
  // once and behaves the same with and without a pending operator.
  const motion = resolveMotion(editor, name, count, hadCount);
  if (motion !== undefined) {
    if (motion == null) {
      editor.operator = null;
      return TOOK;
    }
    if (pendingOperator != null) {
      editor.operator = null;
      const range = forOperator(buffer, pendingOperator, name, count, motion.result);
      operate(
        editor,
        pendingOperator,
        cursorOf(buffer),
        range.cursor,
        range.linewise,
        range.inclusive,
      );
      return TOOK;
    }
    moveCursor(editor, motion.result.cursor, motion.vertical);
    return TOOK;
  }

  if (pendingOperator != null && !CARRIES_OPERATOR.has(name)) {
    editor.operator = null;
    if (name !== 'escape') return TOOK;
  }

  switch (name) {
    case 'i':
      enterInsert(editor);
      return TOOK;
    case 'I':
      buffer.col = firstNonBlank(currentLine(buffer));
      enterInsert(editor);
      return TOOK;
    case 'a':
      buffer.col = Math.min(currentLine(buffer).length, buffer.col + 1);
      enterInsert(editor);
      return TOOK;
    case 'A':
      buffer.col = currentLine(buffer).length;
      enterInsert(editor);
      return TOOK;
    case 'o':
      pushUndo(buffer);
      openLine(buffer, true);
      enterInsert(editor, false);
      return TOOK;
    case 'O':
      pushUndo(buffer);
      openLine(buffer, false);
      enterInsert(editor, false);
      return TOOK;

    case 'd':
    case 'c':
    case 'y':
    case '>':
    case '<':
      editor.operator = name;
      editor.pendingCount = count;
      return TOOK;

    case 'x':
      pushUndo(buffer);
      editor.register = { text: [deleteChars(buffer, count)], linewise: false };
      return TOOK;
    case 'X': {
      if (buffer.col === 0) return TOOK;
      pushUndo(buffer);
      const from = { line: buffer.line, col: Math.max(0, buffer.col - count) };
      editor.register = { text: spanText(buffer, from, cursorOf(buffer)), linewise: false };
      deleteSpan(buffer, from, cursorOf(buffer));
      clampTo(buffer);
      return TOOK;
    }
    case 's':
      pushUndo(buffer);
      editor.register = { text: [deleteChars(buffer, count)], linewise: false };
      enterInsert(editor, false);
      return TOOK;
    case 'D':
      operate(
        editor,
        'd',
        cursorOf(buffer),
        move.lineEnd(buffer, cursorOf(buffer), 1).cursor,
        false,
        true,
      );
      return TOOK;
    case 'C':
      operate(
        editor,
        'c',
        cursorOf(buffer),
        move.lineEnd(buffer, cursorOf(buffer), 1).cursor,
        false,
        true,
      );
      return TOOK;
    case 'Y':
      operate(
        editor,
        'y',
        { line: buffer.line, col: 0 },
        { line: Math.min(buffer.lines.length - 1, buffer.line + count - 1), col: 0 },
        true,
        false,
      );
      return TOOK;

    case 'p':
    case 'P':
      if (editor.register.text.length === 0) {
        setMessage(editor, 'nothing to put', true);
        return TOOK;
      }
      pushUndo(buffer);
      for (let i = 0; i < count; i++) put(buffer, editor.register, name === 'p');
      scrollIntoView(editor);
      return TOOK;

    case 'J':
      pushUndo(buffer);
      joinLines(buffer, count);
      return TOOK;

    case 'r':
    case 'f':
    case 'F':
    case 't':
    case 'T':
    case 'g':
    case 'z':
      editor.pending = name;
      editor.pendingCount = count;
      return TOOK;

    case 'v':
      editor.mode = 'visual';
      editor.anchor = cursorOf(buffer);
      return TOOK;
    case 'V':
      editor.mode = 'visual-line';
      editor.anchor = cursorOf(buffer);
      return TOOK;

    case 'u':
      setMessage(editor, undoEdit(buffer) ? '1 change; before' : 'already at oldest change');
      scrollIntoView(editor);
      return TOOK;
    case 'ctrl-r':
      setMessage(editor, redoEdit(buffer) ? '1 change; after' : 'already at newest change');
      scrollIntoView(editor);
      return TOOK;

    case ':':
    case '/':
    case '?':
      editor.mode = 'command';
      editor.cmdPrefix = name;
      editor.cmdline = '';
      setMessage(editor, '');
      return TOOK;

    case 'ctrl-d':
    case 'ctrl-u':
    case 'ctrl-f':
    case 'ctrl-b': {
      const page = Math.max(1, editor.viewHeight);
      const step =
        name === 'ctrl-d' || name === 'ctrl-u' ? Math.max(1, Math.floor(page / 2)) : page;
      const delta = name === 'ctrl-d' || name === 'ctrl-f' ? step : -step;
      // Move the window and the cursor together, so the line under the cursor
      // keeps its position on screen rather than snapping to an edge.
      buffer.top = Math.max(0, Math.min(buffer.top + delta, Math.max(0, buffer.lines.length - 1)));
      const line = Math.max(0, Math.min(buffer.lines.length - 1, buffer.line + delta));
      moveCursor(editor, { line, col: move.columnFor(buffer, line, buffer.wantCol) }, true);
      return TOOK;
    }

    case 'escape':
      editor.count = '';
      editor.operator = null;
      editor.pending = null;
      setMessage(editor, '');
      return TOOK;

    case 'q':
      // Consumed deliberately: `q` quits pinetop everywhere else, and doing that
      // from inside a modified buffer would discard it without asking.
      setMessage(editor, ':q closes the buffer · tab leaves the pane · ctrl-c quits pinetop', true);
      return TOOK;

    default:
      // Everything else in normal mode is swallowed rather than passed on: in a
      // buffer, an unbound key does nothing — it does not switch pages.
      return TOOK;
  }
}

/**
 * vim's two exceptions for `w` under an operator. Both exist because the plain
 * motion takes more than the user means, and both are things you notice
 * immediately if they are missing:
 *
 *  - **`cw` on a non-blank behaves like `ce`.** You are changing the word, not the
 *    space after it — otherwise `cw` on `fast = 12` leaves `slow= 12`.
 *  - **`dw` does not join lines.** A `w` that crossed a line break stops at the
 *    end of the line it started on, so `dw` at the end of a line clears the tail
 *    rather than pulling the next line up.
 */
function forOperator(
  buffer: EditorBuffer,
  operator: string,
  name: string,
  count: number,
  result: move.MotionResult,
): move.MotionResult {
  if (name !== 'w' && name !== 'W') return result;
  const from = cursorOf(buffer);
  let adjusted = result;

  if (operator === 'c') {
    const ch = lineAt(buffer, from.line)[from.col] ?? '';
    if (ch !== '' && !/\s/.test(ch)) adjusted = move.wordEnd(buffer, from, count, name === 'W');
  }
  if (adjusted.cursor.line > from.line) {
    return {
      cursor: { line: from.line, col: lineAt(buffer, from.line).length },
      linewise: false,
      inclusive: false,
    };
  }
  return adjusted;
}

/** The second key of `f<char>`, `r<char>`, `gg`, `zz`. */
function onPending(editor: EditorState, key: Key): VimOutcome {
  const buffer = editor.buffer!;
  const pending = editor.pending!;
  const count = editor.pendingCount;
  editor.pending = null;

  if (key.name === 'escape') {
    editor.operator = null;
    return TOOK;
  }

  if (pending === 'r') {
    if (key.text == null) return TOOK;
    pushUndo(buffer);
    replaceChar(buffer, key.text);
    return TOOK;
  }

  if (pending === 'g') {
    if (key.name !== 'g') {
      editor.operator = null;
      return TOOK;
    }
    const result = move.gotoLine(buffer, count > 1 ? count : 1);
    if (editor.operator != null) {
      const operator = editor.operator;
      editor.operator = null;
      operate(editor, operator, cursorOf(buffer), result.cursor, true, false);
      return TOOK;
    }
    moveCursor(editor, result.cursor, true);
    return TOOK;
  }

  if (pending === 'z') {
    if (key.name !== 'z' && key.name !== 't' && key.name !== 'b') return TOOK;
    const height = Math.max(1, editor.viewHeight);
    const top =
      key.name === 'z'
        ? buffer.line - Math.floor(height / 2)
        : key.name === 't'
          ? buffer.line
          : buffer.line - height + 1;
    buffer.top = Math.max(0, Math.min(top, Math.max(0, buffer.lines.length - 1)));
    return TOOK;
  }

  // f / F / t / T
  if (key.text == null) {
    editor.operator = null;
    return TOOK;
  }
  const found = move.findChar(buffer, cursorOf(buffer), key.text, {
    forward: pending === 'f' || pending === 't',
    till: pending === 't' || pending === 'T',
    count,
  });
  if (found == null) {
    editor.operator = null;
    setMessage(editor, `E486: not on this line: ${key.text}`, true);
    return TOOK;
  }
  if (editor.operator != null) {
    const operator = editor.operator;
    editor.operator = null;
    operate(editor, operator, cursorOf(buffer), found.cursor, false, found.inclusive);
    return TOOK;
  }
  moveCursor(editor, found.cursor);
  return TOOK;
}

// ————————————————————————————————————————————————————————————— visual mode

function onVisual(editor: EditorState, key: Key): VimOutcome {
  const buffer = editor.buffer!;
  const name = key.name;
  const linewise = editor.mode === 'visual-line';
  const anchor = editor.anchor ?? cursorOf(buffer);

  if (name === 'tab' || name === 'shift-tab') return PASS;
  if (editor.pending != null) return onPending(editor, key);

  if (name === 'escape') {
    enterNormal(editor);
    setMessage(editor, '');
    return TOOK;
  }
  if (/^[1-9]$/.test(name) || (name === '0' && editor.count !== '')) {
    editor.count += name;
    return TOOK;
  }

  const hadCount = editor.count !== '';
  const count = takeCount(editor);
  const motion = resolveMotion(editor, name, count, hadCount);
  if (motion !== undefined) {
    if (motion != null) moveCursor(editor, motion.result.cursor, motion.vertical);
    return TOOK;
  }

  switch (name) {
    case 'v':
      editor.mode = linewise ? 'visual' : 'normal';
      if (editor.mode === 'normal') editor.anchor = null;
      return TOOK;
    case 'V':
      editor.mode = linewise ? 'normal' : 'visual-line';
      if (editor.mode === 'normal') editor.anchor = null;
      return TOOK;
    case 'o': {
      // Swap ends, so a selection can be grown from either side.
      editor.anchor = cursorOf(buffer);
      moveCursor(editor, anchor);
      return TOOK;
    }
    case 'd':
    case 'x':
      finishVisual(editor, 'd', anchor, linewise);
      return TOOK;
    case 'c':
    case 's':
      finishVisual(editor, 'c', anchor, linewise);
      return TOOK;
    case 'y':
      finishVisual(editor, 'y', anchor, linewise);
      return TOOK;
    case '>':
    case '<':
      finishVisual(editor, name, anchor, true);
      return TOOK;
    case 'r':
    case 'f':
    case 'F':
    case 't':
    case 'T':
    case 'g':
    case 'z':
      editor.pending = name;
      editor.pendingCount = count;
      return TOOK;
    case ':':
    case '/':
    case '?':
      editor.mode = 'command';
      editor.cmdPrefix = name;
      editor.cmdline = '';
      editor.anchor = null;
      return TOOK;
    case 'q':
      setMessage(editor, 'esc leaves visual mode · ctrl-c quits pinetop', true);
      return TOOK;
    default:
      return TOOK;
  }
}

function finishVisual(
  editor: EditorState,
  operator: string,
  anchor: Cursor,
  linewise: boolean,
): void {
  const buffer = editor.buffer!;
  const to = cursorOf(buffer);
  editor.anchor = null;
  editor.mode = 'normal';
  // A visual selection includes the character under the cursor, which is what
  // makes it inclusive where the same operator with a motion would not be.
  operate(editor, operator, anchor, to, linewise, !linewise);
}

// ——————————————————————————————————————————————————————————————— operators

/**
 * Apply an operator over a range. Every edit in the editor funnels through here,
 * so "does this operation record an undo point and fill the register?" has one
 * answer rather than one per key.
 */
function operate(
  editor: EditorState,
  operator: string,
  from: Cursor,
  to: Cursor,
  linewise: boolean,
  inclusive: boolean,
): void {
  const buffer = editor.buffer!;
  const [head, tail] = orderCursors(from, to);

  if (linewise || operator === '>' || operator === '<') {
    const start = head.line;
    const count = tail.line - head.line + 1;

    if (operator === '>' || operator === '<') {
      pushUndo(buffer);
      indentLines(buffer, start, count, operator === '>' ? 1 : -1, INDENT_WIDTH);
      scrollIntoView(editor);
      return;
    }
    if (operator === 'y') {
      editor.register = { text: buffer.lines.slice(start, start + count), linewise: true };
      moveCursor(editor, { line: start, col: firstNonBlank(lineAt(buffer, start)) });
      setMessage(editor, `${count} line${count === 1 ? '' : 's'} yanked`);
      return;
    }
    pushUndo(buffer);
    if (operator === 'c') {
      // `cc` keeps the indent and opens the line for typing — the line is being
      // rewritten, not unindented.
      const indent = /^[ \t]*/.exec(lineAt(buffer, start))?.[0] ?? '';
      editor.register = { text: buffer.lines.slice(start, start + count), linewise: true };
      replaceLines(buffer, start, count, [indent]);
      buffer.line = Math.min(start, buffer.lines.length - 1);
      buffer.col = indent.length;
      enterInsert(editor, false);
      return;
    }
    editor.register = { text: deleteLines(buffer, start, count), linewise: true };
    buffer.col = firstNonBlank(currentLine(buffer));
    clampTo(buffer);
    scrollIntoView(editor);
    setMessage(editor, `${count} fewer line${count === 1 ? '' : 's'}`);
    return;
  }

  const end: Cursor = inclusive
    ? { line: tail.line, col: Math.min(lineAt(buffer, tail.line).length, tail.col + 1) }
    : tail;

  if (operator === 'y') {
    editor.register = { text: spanText(buffer, head, end), linewise: false };
    moveCursor(editor, head);
    return;
  }
  pushUndo(buffer);
  editor.register = { text: deleteSpan(buffer, head, end), linewise: false };
  if (operator === 'c') {
    enterInsert(editor, false);
    return;
  }
  clampTo(buffer);
  scrollIntoView(editor);
}

// ——————————————————————————————————————————————————————————— command line

function onCommandLine(editor: EditorState, key: Key, io: EditorIo): VimOutcome {
  switch (key.name) {
    case 'escape':
      editor.mode = 'normal';
      editor.cmdline = '';
      setMessage(editor, '');
      return TOOK;
    case 'backspace':
      if (editor.cmdline === '') {
        // Backspacing past the prompt leaves command mode, as it does in vim.
        editor.mode = 'normal';
        return TOOK;
      }
      editor.cmdline = editor.cmdline.slice(0, -1);
      return TOOK;
    case 'ctrl-u':
      editor.cmdline = '';
      return TOOK;
    case 'enter': {
      const line = editor.cmdline;
      const prefix = editor.cmdPrefix;
      editor.cmdline = '';
      editor.mode = 'normal';
      return prefix === ':'
        ? runExCommand(editor, line, io)
        : runSearch(editor, line, prefix === '/');
    }
    default:
      if (key.text != null) editor.cmdline += key.text;
      return TOOK;
  }
}

function runSearch(editor: EditorState, needle: string, forward: boolean): VimOutcome {
  const buffer = editor.buffer!;
  const pattern = needle === '' ? editor.lastSearch?.needle : needle;
  if (pattern == null || pattern === '') {
    setMessage(editor, 'E35: no previous regular expression', true);
    return TOOK;
  }
  editor.lastSearch = { needle: pattern, forward };
  const found = move.search(buffer, cursorOf(buffer), pattern, forward);
  if (found == null) {
    setMessage(editor, `E486: pattern not found: ${pattern}`, true);
    return TOOK;
  }
  moveCursor(editor, found.cursor);
  setMessage(editor, `${forward ? '/' : '?'}${pattern}`);
  return TOOK;
}

/**
 * The ex commands the editor implements. Anything else answers with vim's own
 * `E492`, so an unsupported command is a stated refusal rather than silence.
 */
function runExCommand(editor: EditorState, line: string, io: EditorIo): VimOutcome {
  const buffer = editor.buffer!;
  const text = line.trim();
  if (text === '') return TOOK;

  // `:42` — jump to a line. Common enough to be worth its own case.
  if (/^\d+$/.test(text)) {
    moveCursor(editor, move.gotoLine(buffer, Number.parseInt(text, 10)).cursor, true);
    return TOOK;
  }

  const match = /^([a-zA-Z]+)(!?)\s*(.*)$/.exec(text);
  if (match == null) {
    setMessage(editor, `E492: not an editor command: ${text}`, true);
    return TOOK;
  }
  const [, command = '', bang, argument = ''] = match;
  const force = bang === '!';

  switch (command) {
    case 'w':
    case 'write': {
      const wrote = writeFile(editor, argument, io);
      return wrote == null ? TOOK : { consumed: true, wrote };
    }
    case 'wq':
    case 'x':
    case 'xit': {
      const wrote = writeFile(editor, argument, io);
      if (wrote == null) return TOOK;
      return { consumed: true, wrote, closed: closeBuffer(editor, true) };
    }
    case 'q':
    case 'quit':
    case 'qa':
    case 'qall':
      return { consumed: true, closed: closeBuffer(editor, force) };
    case 'e':
    case 'edit': {
      if (argument === '') {
        // `:e` with no argument rereads the file, discarding unwritten changes
        // only when asked — a reload that silently dropped them would be exactly
        // the unexplained divergence §4.5.c rules out.
        if (buffer.modified && !force) {
          setMessage(editor, 'E37: no write since last change (add ! to override)', true);
          return TOOK;
        }
        openFile(editor, buffer.path, io);
        return TOOK;
      }
      if (buffer.modified && !force) {
        setMessage(editor, 'E37: no write since last change (add ! to override)', true);
        return TOOK;
      }
      openFile(editor, argument, io);
      return TOOK;
    }
    case 'set': {
      if (argument === 'number' || argument === 'nu') {
        editor.gutter = true;
        return TOOK;
      }
      if (argument === 'nonumber' || argument === 'nonu') {
        editor.gutter = false;
        return TOOK;
      }
      setMessage(editor, `E518: unknown option: ${argument}`, true);
      return TOOK;
    }
    case 'noh':
    case 'nohl':
    case 'nohlsearch':
      setMessage(editor, '');
      return TOOK;
    default:
      setMessage(editor, `E492: not an editor command: ${text}`, true);
      return TOOK;
  }
}

/** `:q` — drop the buffer. Refuses on unwritten changes unless forced. */
function closeBuffer(editor: EditorState, force: boolean): boolean {
  const buffer = editor.buffer;
  if (buffer == null) return true;
  if (buffer.modified && !force) {
    setMessage(editor, 'E37: no write since last change (add ! to override)', true);
    return false;
  }
  editor.buffer = null;
  editor.mode = 'normal';
  editor.anchor = null;
  setMessage(editor, `closed ${buffer.path}`);
  return true;
}
