/**
 * The text buffer and its edit primitives.
 *
 * A buffer is plain data — an array of lines plus a cursor — and every operation
 * here is a function over it, the way `AppState` and its helpers are. That is
 * what lets the vim layer be tested by pressing keys at a value rather than by
 * driving a terminal, and what keeps "what is on screen" answerable from state
 * alone.
 *
 * Two rules the rest of the editor relies on:
 *  - **`lines` is never empty.** An empty file is one empty line, so `line`/`col`
 *    always address a real position and no caller needs a null check.
 *  - **Undo is snapshot-based, one snapshot per user-visible change.** A source
 *    file is small enough that copying the line array is cheaper than an edit
 *    journal, and a snapshot cannot drift from the text the way a replayed diff
 *    can.
 */

/** A position in the buffer. Both are 0-based; `col` is a character index. */
export interface Cursor {
  line: number;
  col: number;
}

export interface Snapshot {
  lines: string[];
  line: number;
  col: number;
}

export interface EditorBuffer {
  /** Path as it would appear in argv — relative to cwd when it is below it. */
  path: string;
  lines: string[];
  line: number;
  col: number;
  /**
   * The column the cursor is reaching for across vertical moves (vim's
   * `curswant`): `j` down a short line and back up returns to where you were,
   * instead of sticking to the short line's end.
   */
  wantCol: number;
  /** First visible line. The editor is the one pane that scrolls — see §4.3.a. */
  top: number;
  modified: boolean;
  /** True when the path has no file behind it yet; `:w` creates it. */
  isNew: boolean;
  undo: Snapshot[];
  redo: Snapshot[];
}

/** Snapshots kept per buffer. Deep history is not worth unbounded memory. */
const UNDO_DEPTH = 200;

export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  // A trailing newline is the POSIX line terminator, not an extra empty line —
  // reading and writing must round-trip, so it is dropped here and re-added by
  // `bufferText`.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.length === 0 ? [''] : lines;
}

export function newBuffer(path: string, text = '', isNew = false): EditorBuffer {
  return {
    path,
    lines: splitLines(text),
    line: 0,
    col: 0,
    wantCol: 0,
    top: 0,
    modified: false,
    isNew,
    undo: [],
    redo: [],
  };
}

/** The buffer as it goes to disk: newline-terminated, like every other tool. */
export function bufferText(buffer: EditorBuffer): string {
  return `${buffer.lines.join('\n')}\n`;
}

export function lineAt(buffer: EditorBuffer, index: number): string {
  return buffer.lines[index] ?? '';
}

export function currentLine(buffer: EditorBuffer): string {
  return lineAt(buffer, buffer.line);
}

/**
 * Clamp the cursor into the buffer.
 *
 * `allowEnd` is the normal/insert difference: insert mode may sit one past the
 * last character (that is where you type), normal mode may not — a normal-mode
 * cursor is always *on* a character.
 */
export function clampTo(buffer: EditorBuffer, allowEnd = false): void {
  buffer.line = Math.min(Math.max(0, buffer.line), buffer.lines.length - 1);
  const length = currentLine(buffer).length;
  const max = allowEnd ? length : Math.max(0, length - 1);
  buffer.col = Math.min(Math.max(0, buffer.col), max);
}

export function snapshot(buffer: EditorBuffer): Snapshot {
  return { lines: [...buffer.lines], line: buffer.line, col: buffer.col };
}

/**
 * Record the state an `u` should return to. Call once per change group — before
 * the first keystroke of an insert, not once per typed character, so undoing an
 * insert removes the whole insert.
 */
export function pushUndo(buffer: EditorBuffer): void {
  buffer.undo.push(snapshot(buffer));
  if (buffer.undo.length > UNDO_DEPTH) buffer.undo.shift();
  // A new edit invalidates the redo branch, as it does in vim.
  buffer.redo = [];
}

export function undoEdit(buffer: EditorBuffer): boolean {
  const previous = buffer.undo.pop();
  if (previous == null) return false;
  buffer.redo.push(snapshot(buffer));
  buffer.lines = previous.lines;
  buffer.line = previous.line;
  buffer.col = previous.col;
  buffer.modified = true;
  clampTo(buffer);
  return true;
}

export function redoEdit(buffer: EditorBuffer): boolean {
  const next = buffer.redo.pop();
  if (next == null) return false;
  buffer.undo.push(snapshot(buffer));
  buffer.lines = next.lines;
  buffer.line = next.line;
  buffer.col = next.col;
  buffer.modified = true;
  clampTo(buffer);
  return true;
}

// ————————————————————————————————————————————————————————————————— editing

function setLine(buffer: EditorBuffer, index: number, text: string): void {
  buffer.lines[index] = text;
  buffer.modified = true;
}

/** Insert printable text at the cursor, which ends up after it. */
export function insertText(buffer: EditorBuffer, text: string): void {
  const line = currentLine(buffer);
  const col = Math.min(buffer.col, line.length);
  setLine(buffer, buffer.line, line.slice(0, col) + text + line.slice(col));
  buffer.col = col + text.length;
  buffer.wantCol = buffer.col;
}

/** Split the line at the cursor, carrying the indent of the line being left. */
export function insertNewline(buffer: EditorBuffer, autoIndent = true): void {
  const line = currentLine(buffer);
  const col = Math.min(buffer.col, line.length);
  const indent = autoIndent ? (/^[ \t]*/.exec(line)?.[0] ?? '') : '';
  setLine(buffer, buffer.line, line.slice(0, col));
  buffer.lines.splice(buffer.line + 1, 0, indent + line.slice(col));
  buffer.line += 1;
  buffer.col = indent.length;
  buffer.wantCol = buffer.col;
  buffer.modified = true;
}

/** Backspace: join with the line above when the cursor is at column 0. */
export function deleteBefore(buffer: EditorBuffer): void {
  if (buffer.col > 0) {
    const line = currentLine(buffer);
    setLine(buffer, buffer.line, line.slice(0, buffer.col - 1) + line.slice(buffer.col));
    buffer.col -= 1;
    buffer.wantCol = buffer.col;
    return;
  }
  if (buffer.line === 0) return;
  const above = lineAt(buffer, buffer.line - 1);
  const joined = above + currentLine(buffer);
  buffer.lines.splice(buffer.line, 1);
  buffer.line -= 1;
  setLine(buffer, buffer.line, joined);
  buffer.col = above.length;
  buffer.wantCol = buffer.col;
}

/** `x` — delete `count` characters at the cursor. Returns what was removed. */
export function deleteChars(buffer: EditorBuffer, count = 1): string {
  const line = currentLine(buffer);
  if (line.length === 0) return '';
  const to = Math.min(line.length, buffer.col + count);
  const removed = line.slice(buffer.col, to);
  setLine(buffer, buffer.line, line.slice(0, buffer.col) + line.slice(to));
  clampTo(buffer);
  return removed;
}

/** `dd` — remove whole lines. Returns them, for the register. */
export function deleteLines(buffer: EditorBuffer, from: number, count: number): string[] {
  const start = Math.max(0, Math.min(from, buffer.lines.length - 1));
  const removed = buffer.lines.splice(start, Math.max(1, count));
  if (buffer.lines.length === 0) buffer.lines.push('');
  buffer.line = Math.min(start, buffer.lines.length - 1);
  buffer.col = 0;
  buffer.modified = true;
  return removed;
}

/** Replace whole lines with `text`, the `cc` half of a linewise change. */
export function replaceLines(
  buffer: EditorBuffer,
  from: number,
  count: number,
  text: string[],
): void {
  buffer.lines.splice(Math.max(0, from), Math.max(0, count), ...text);
  if (buffer.lines.length === 0) buffer.lines.push('');
  buffer.modified = true;
  clampTo(buffer);
}

/**
 * Delete `[start, end)` as a character span, which may cross lines — the
 * characterwise half of every operator. The two lines at the ends are joined,
 * exactly as `dw` across a line break does in vim. Returns the removed text as
 * one entry per line, which is the shape the register wants.
 */
export function deleteSpan(buffer: EditorBuffer, start: Cursor, end: Cursor): string[] {
  const from = orderCursors(start, end);
  const [head, tail] = from;

  if (head.line === tail.line) {
    const line = lineAt(buffer, head.line);
    const a = Math.max(0, Math.min(head.col, line.length));
    const b = Math.max(a, Math.min(tail.col, line.length));
    const removed = line.slice(a, b);
    setLine(buffer, head.line, line.slice(0, a) + line.slice(b));
    buffer.line = head.line;
    buffer.col = a;
    clampTo(buffer, true);
    return [removed];
  }

  const first = lineAt(buffer, head.line);
  const last = lineAt(buffer, tail.line);
  const removed = [
    first.slice(head.col),
    ...buffer.lines.slice(head.line + 1, tail.line),
    last.slice(0, tail.col),
  ];
  buffer.lines.splice(
    head.line,
    tail.line - head.line + 1,
    first.slice(0, head.col) + last.slice(tail.col),
  );
  buffer.line = head.line;
  buffer.col = head.col;
  buffer.modified = true;
  clampTo(buffer, true);
  return removed;
}

/** The text of `[start, end)` without touching the buffer — what `y` copies. */
export function spanText(buffer: EditorBuffer, start: Cursor, end: Cursor): string[] {
  const [head, tail] = orderCursors(start, end);
  if (head.line === tail.line) return [lineAt(buffer, head.line).slice(head.col, tail.col)];
  return [
    lineAt(buffer, head.line).slice(head.col),
    ...buffer.lines.slice(head.line + 1, tail.line),
    lineAt(buffer, tail.line).slice(0, tail.col),
  ];
}

/** The two cursors in buffer order, so callers never have to check which is first. */
export function orderCursors(a: Cursor, b: Cursor): [Cursor, Cursor] {
  if (a.line < b.line || (a.line === b.line && a.col <= b.col)) return [a, b];
  return [b, a];
}

/** `o` / `O` — open a blank line below or above, indented like its neighbour. */
export function openLine(buffer: EditorBuffer, below: boolean): void {
  const indent = /^[ \t]*/.exec(currentLine(buffer))?.[0] ?? '';
  const at = below ? buffer.line + 1 : buffer.line;
  buffer.lines.splice(at, 0, indent);
  buffer.line = at;
  buffer.col = indent.length;
  buffer.wantCol = buffer.col;
  buffer.modified = true;
}

/** `J` — join the next line onto this one, with a single separating space. */
export function joinLines(buffer: EditorBuffer, count = 1): void {
  for (let i = 0; i < Math.max(1, count); i++) {
    if (buffer.line >= buffer.lines.length - 1) return;
    const line = currentLine(buffer);
    const next = lineAt(buffer, buffer.line + 1).replace(/^[ \t]+/, '');
    const separator = line === '' || /\s$/.test(line) || next === '' ? '' : ' ';
    buffer.lines.splice(buffer.line + 1, 1);
    buffer.col = line.length;
    setLine(buffer, buffer.line, line + separator + next);
  }
  clampTo(buffer);
}

/** `r<char>` — overwrite the character under the cursor. */
export function replaceChar(buffer: EditorBuffer, ch: string): void {
  const line = currentLine(buffer);
  if (line.length === 0) return;
  setLine(buffer, buffer.line, line.slice(0, buffer.col) + ch + line.slice(buffer.col + 1));
}

/** `>>` / `<<` — shift lines by one `width`-space step. */
export function indentLines(
  buffer: EditorBuffer,
  from: number,
  count: number,
  delta: number,
  width = 4,
): void {
  const step = ' '.repeat(width);
  for (let i = from; i < Math.min(buffer.lines.length, from + Math.max(1, count)); i++) {
    const line = lineAt(buffer, i);
    if (delta > 0) {
      setLine(buffer, i, line === '' ? '' : step + line);
      continue;
    }
    const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
    const drop = Math.min(indent.length, width);
    setLine(buffer, i, line.slice(drop));
  }
  buffer.line = Math.max(0, Math.min(from, buffer.lines.length - 1));
  buffer.col = firstNonBlank(lineAt(buffer, buffer.line));
  clampTo(buffer);
}

/** `p` / `P` — put the register, linewise or characterwise. */
export function put(
  buffer: EditorBuffer,
  register: { text: string[]; linewise: boolean },
  after: boolean,
): void {
  if (register.text.length === 0) return;
  if (register.linewise) {
    const at = after ? buffer.line + 1 : buffer.line;
    buffer.lines.splice(at, 0, ...register.text);
    buffer.line = at;
    buffer.col = firstNonBlank(lineAt(buffer, at));
    buffer.modified = true;
    return;
  }
  const line = currentLine(buffer);
  const at = Math.min(line.length, after && line.length > 0 ? buffer.col + 1 : buffer.col);
  const [head = '', ...rest] = register.text;
  if (rest.length === 0) {
    setLine(buffer, buffer.line, line.slice(0, at) + head + line.slice(at));
    buffer.col = at + Math.max(0, head.length - 1);
    return;
  }
  const tail = rest[rest.length - 1]!;
  const middle = rest.slice(0, -1);
  setLine(buffer, buffer.line, line.slice(0, at) + head);
  buffer.lines.splice(buffer.line + 1, 0, ...middle, tail + line.slice(at));
  buffer.line += middle.length + 1;
  buffer.col = Math.max(0, tail.length - 1);
  clampTo(buffer);
}

export function firstNonBlank(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return Math.min(match == null ? 0 : match[0].length, Math.max(0, line.length - 1));
}
