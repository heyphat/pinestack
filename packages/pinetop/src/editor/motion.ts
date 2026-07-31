/**
 * Motions.
 *
 * Every motion is a pure function `(buffer, cursor, count) → MotionResult`, and
 * that shape is the whole reason operators work: `dw` is "run the `w` motion,
 * then delete from the cursor to where it landed", so a motion added here is
 * immediately available to `d`, `c`, `y`, `>` and `<` without touching them.
 *
 * The two flags on a result are vim's own distinctions, and both change what an
 * operator removes:
 *  - **linewise** (`j`, `gg`, `G`, `{`, `}`) — the operator takes whole lines.
 *  - **inclusive** (`e`, `$`, `f`) — the character the motion lands on is part of
 *    the range. `dw` stops before the next word; `de` eats the word's last
 *    character. Getting this wrong is an off-by-one the user feels on every edit.
 */

import { lineAt, type Cursor, type EditorBuffer } from './buffer.js';

export interface MotionResult {
  cursor: Cursor;
  linewise: boolean;
  inclusive: boolean;
}

const BLANK = 0;
const KEYWORD = 1;
const PUNCT = 2;

/**
 * vim's three character classes. A "word" is a run of one class; a WORD (`W`,
 * `B`, `E`) collapses keyword and punctuation into one, which is why `big`
 * folds both onto KEYWORD.
 */
function classOf(ch: string, big: boolean): number {
  if (ch === '' || ch === '\n' || ch === ' ' || ch === '\t') return BLANK;
  if (big) return KEYWORD;
  return /[A-Za-z0-9_]/.test(ch) ? KEYWORD : PUNCT;
}

/**
 * The character at a position, where `col === line.length` is the line's own
 * newline. Treating the line break as a real, blank character is what lets word
 * motions cross lines without a special case at every step.
 */
function charAt(buffer: EditorBuffer, pos: Cursor): string {
  const line = lineAt(buffer, pos.line);
  return pos.col >= line.length ? '\n' : line[pos.col]!;
}

function next(buffer: EditorBuffer, pos: Cursor): Cursor | null {
  const length = lineAt(buffer, pos.line).length;
  if (pos.col < length) return { line: pos.line, col: pos.col + 1 };
  if (pos.line + 1 < buffer.lines.length) return { line: pos.line + 1, col: 0 };
  return null;
}

function prev(buffer: EditorBuffer, pos: Cursor): Cursor | null {
  if (pos.col > 0) return { line: pos.line, col: pos.col - 1 };
  if (pos.line > 0) return { line: pos.line - 1, col: lineAt(buffer, pos.line - 1).length };
  return null;
}

function isEmptyLine(buffer: EditorBuffer, line: number): boolean {
  return lineAt(buffer, line).length === 0;
}

function lastPosition(buffer: EditorBuffer): Cursor {
  const line = buffer.lines.length - 1;
  return { line, col: Math.max(0, lineAt(buffer, line).length - 1) };
}

// ————————————————————————————————————————————————————————————————— by word

function wordForwardOnce(buffer: EditorBuffer, from: Cursor, big: boolean): Cursor {
  let pos = from;
  const startClass = classOf(charAt(buffer, pos), big);

  if (startClass !== BLANK) {
    while (classOf(charAt(buffer, pos), big) === startClass) {
      const step = next(buffer, pos);
      if (step == null) return lastPosition(buffer);
      pos = step;
    }
  }
  while (classOf(charAt(buffer, pos), big) === BLANK) {
    // An empty line is a word of its own for `w`, so a paragraph break is a
    // place the cursor can land rather than something it skims over.
    if (pos.line !== from.line && isEmptyLine(buffer, pos.line)) return pos;
    const step = next(buffer, pos);
    if (step == null) return lastPosition(buffer);
    pos = step;
  }
  return pos;
}

function wordBackwardOnce(buffer: EditorBuffer, from: Cursor, big: boolean): Cursor {
  let pos = prev(buffer, from);
  if (pos == null) return { line: 0, col: 0 };

  while (classOf(charAt(buffer, pos), big) === BLANK) {
    if (pos.line !== from.line && isEmptyLine(buffer, pos.line)) return pos;
    const step = prev(buffer, pos);
    if (step == null) return { line: 0, col: 0 };
    pos = step;
  }
  const wordClass = classOf(charAt(buffer, pos), big);
  for (;;) {
    const step = prev(buffer, pos);
    if (step == null || classOf(charAt(buffer, step), big) !== wordClass) return pos;
    pos = step;
  }
}

function wordEndOnce(buffer: EditorBuffer, from: Cursor, big: boolean): Cursor {
  let pos = next(buffer, from);
  if (pos == null) return lastPosition(buffer);

  while (classOf(charAt(buffer, pos), big) === BLANK) {
    const step = next(buffer, pos);
    if (step == null) return lastPosition(buffer);
    pos = step;
  }
  const wordClass = classOf(charAt(buffer, pos), big);
  for (;;) {
    const step = next(buffer, pos);
    if (step == null || classOf(charAt(buffer, step), big) !== wordClass) return pos;
    pos = step;
  }
}

function repeat(count: number, from: Cursor, step: (pos: Cursor) => Cursor): Cursor {
  let pos = from;
  for (let i = 0; i < Math.max(1, count); i++) pos = step(pos);
  return pos;
}

export function wordForward(
  buffer: EditorBuffer,
  cursor: Cursor,
  count = 1,
  big = false,
): MotionResult {
  return {
    cursor: repeat(count, cursor, (pos) => wordForwardOnce(buffer, pos, big)),
    linewise: false,
    inclusive: false,
  };
}

export function wordBackward(
  buffer: EditorBuffer,
  cursor: Cursor,
  count = 1,
  big = false,
): MotionResult {
  return {
    cursor: repeat(count, cursor, (pos) => wordBackwardOnce(buffer, pos, big)),
    linewise: false,
    inclusive: false,
  };
}

export function wordEnd(
  buffer: EditorBuffer,
  cursor: Cursor,
  count = 1,
  big = false,
): MotionResult {
  return {
    cursor: repeat(count, cursor, (pos) => wordEndOnce(buffer, pos, big)),
    linewise: false,
    inclusive: true,
  };
}

// ————————————————————————————————————————————————————————— within the line

export function charLeft(buffer: EditorBuffer, cursor: Cursor, count = 1): MotionResult {
  return {
    cursor: { line: cursor.line, col: Math.max(0, cursor.col - Math.max(1, count)) },
    linewise: false,
    inclusive: false,
  };
}

export function charRight(buffer: EditorBuffer, cursor: Cursor, count = 1): MotionResult {
  const length = lineAt(buffer, cursor.line).length;
  return {
    cursor: {
      line: cursor.line,
      col: Math.min(Math.max(0, length - 1), cursor.col + Math.max(1, count)),
    },
    linewise: false,
    inclusive: false,
  };
}

export function lineStart(cursor: Cursor): MotionResult {
  return { cursor: { line: cursor.line, col: 0 }, linewise: false, inclusive: false };
}

export function lineFirstNonBlank(buffer: EditorBuffer, cursor: Cursor): MotionResult {
  const line = lineAt(buffer, cursor.line);
  const indent = /^[ \t]*/.exec(line)?.[0].length ?? 0;
  return {
    cursor: { line: cursor.line, col: Math.min(indent, Math.max(0, line.length - 1)) },
    linewise: false,
    inclusive: false,
  };
}

export function lineEnd(buffer: EditorBuffer, cursor: Cursor, count = 1): MotionResult {
  const line = Math.min(buffer.lines.length - 1, cursor.line + Math.max(1, count) - 1);
  return {
    cursor: { line, col: Math.max(0, lineAt(buffer, line).length - 1) },
    linewise: false,
    inclusive: true,
  };
}

/**
 * `f` / `F` / `t` / `T` — line-local character search. Returns null when the
 * character is not on the line, so the caller can leave the cursor alone rather
 * than moving it somewhere the user did not ask for.
 */
export function findChar(
  buffer: EditorBuffer,
  cursor: Cursor,
  ch: string,
  opts: { forward: boolean; till: boolean; count?: number },
): MotionResult | null {
  const line = lineAt(buffer, cursor.line);
  const count = Math.max(1, opts.count ?? 1);
  let col = cursor.col;

  for (let i = 0; i < count; i++) {
    let at = -1;
    if (opts.forward) {
      at = line.indexOf(ch, col + 1);
    } else {
      at = line.lastIndexOf(ch, col - 1);
      if (at >= col) at = -1;
    }
    if (at < 0) return null;
    col = at;
  }

  const landing = opts.till ? (opts.forward ? col - 1 : col + 1) : col;
  if (landing < 0 || landing >= line.length) return null;
  return {
    cursor: { line: cursor.line, col: landing },
    linewise: false,
    // Forward searches are inclusive (`dfx` eats the x); backward ones are not.
    inclusive: opts.forward,
  };
}

// ——————————————————————————————————————————————————————————— across lines

export function lineDown(buffer: EditorBuffer, cursor: Cursor, count = 1, want = 0): MotionResult {
  const line = Math.min(buffer.lines.length - 1, cursor.line + Math.max(1, count));
  return { cursor: { line, col: columnFor(buffer, line, want) }, linewise: true, inclusive: false };
}

export function lineUp(buffer: EditorBuffer, cursor: Cursor, count = 1, want = 0): MotionResult {
  const line = Math.max(0, cursor.line - Math.max(1, count));
  return { cursor: { line, col: columnFor(buffer, line, want) }, linewise: true, inclusive: false };
}

/** Land a vertical move on the column it was reaching for, clamped to the line. */
export function columnFor(buffer: EditorBuffer, line: number, want: number): number {
  return Math.min(Math.max(0, want), Math.max(0, lineAt(buffer, line).length - 1));
}

/** `gg` / `G` / `:<n>` — 1-based line, clamped. Linewise, and lands on text. */
export function gotoLine(buffer: EditorBuffer, oneBased: number): MotionResult {
  const line = Math.min(Math.max(0, oneBased - 1), buffer.lines.length - 1);
  const text = lineAt(buffer, line);
  const indent = /^[ \t]*/.exec(text)?.[0].length ?? 0;
  return {
    cursor: { line, col: Math.min(indent, Math.max(0, text.length - 1)) },
    linewise: true,
    inclusive: false,
  };
}

/** `{` / `}` — the nearest blank line in that direction, else the buffer edge. */
export function paragraph(buffer: EditorBuffer, cursor: Cursor, forward: boolean): MotionResult {
  const step = forward ? 1 : -1;
  let line = cursor.line + step;
  // Step off a blank run first, so repeated presses advance a paragraph at a
  // time instead of sticking to the boundary the cursor already sits on.
  while (line > 0 && line < buffer.lines.length - 1 && isEmptyLine(buffer, line)) line += step;
  while (line > 0 && line < buffer.lines.length - 1 && !isEmptyLine(buffer, line)) line += step;
  return {
    cursor: { line: Math.max(0, Math.min(buffer.lines.length - 1, line)), col: 0 },
    linewise: true,
    inclusive: false,
  };
}

/**
 * `/` and `?` — plain substring search, wrapping at the buffer edge. Returns
 * null when the pattern is nowhere, so the caller reports "not found" instead
 * of silently leaving the cursor where it was.
 */
export function search(
  buffer: EditorBuffer,
  cursor: Cursor,
  needle: string,
  forward: boolean,
): MotionResult | null {
  if (needle === '') return null;
  const total = buffer.lines.length;
  const found = (line: number, col: number): MotionResult => ({
    cursor: { line, col },
    linewise: false,
    inclusive: false,
  });

  // The rest of the current line first: `n` must reach a second match on the
  // line it is already on before it looks anywhere else.
  const current = lineAt(buffer, cursor.line);
  const near = forward
    ? current.indexOf(needle, cursor.col + 1)
    : cursor.col > 0
      ? current.lastIndexOf(needle, cursor.col - 1)
      : -1;
  if (near >= 0 && (forward ? near > cursor.col : near < cursor.col)) {
    return found(cursor.line, near);
  }

  // Then every other line in order, wrapping at the buffer edge and finishing
  // on the current line's other half.
  for (let i = 1; i <= total; i++) {
    const line = (((forward ? cursor.line + i : cursor.line - i) % total) + total) % total;
    const text = lineAt(buffer, line);
    const at = forward ? text.indexOf(needle) : text.lastIndexOf(needle);
    if (at < 0) continue;
    if (line === cursor.line && (forward ? at > cursor.col : at < cursor.col)) continue;
    return found(line, at);
  }
  return null;
}
