/**
 * The fixed character grid (§4.3.a). Every page draws into a `Screen` of
 * exactly cols × rows cells; writes outside a cell's rectangle are clipped, not
 * wrapped and not scrolled — a terminal truncates lines, and so do we.
 *
 * Storing a char + style per cell (rather than composing escape-laden strings)
 * is what makes clipping and overlays exact: a dialog painted over a table
 * cannot leave a dangling colour, and a row that runs past the pane edge is cut
 * mid-cell without splitting an escape sequence.
 */

import { STYLE, sgr, type Style } from './theme.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Drop SGR sequences so measurement and clipping count printable cells only. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Printable width. Combining marks and zero-width joiners count 0; everything
 * else counts 1. pinetop's own glyph set (box drawing, braille U+2800–28FF,
 * the ▲▼●○ markers) is uniformly single-width, so a full east-asian width
 * table would buy nothing here — but symbol titles can carry anything, so
 * zero-width marks are handled rather than left to shear a row.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    const code = ch.codePointAt(0)!;
    if (code === 0x200d || (code >= 0x0300 && code <= 0x036f)) continue;
    width += 1;
  }
  return width;
}

/** Truncate to `max` printable cells, appending `ellipsis` when it cuts. */
export function truncate(text: string, max: number, ellipsis = '…'): string {
  const plain = stripAnsi(text);
  if (max <= 0) return '';
  if (displayWidth(plain) <= max) return plain;
  const chars = [...plain];
  const keep = Math.max(0, max - ellipsis.length);
  return chars.slice(0, keep).join('') + ellipsis;
}

export function padEnd(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? truncate(text, width) : text + ' '.repeat(width - w);
}

export function padStart(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? truncate(text, width) : ' '.repeat(width - w) + text;
}

interface Cell {
  ch: string;
  style: Style;
}

export class Screen {
  readonly cols: number;
  readonly rows: number;
  private readonly cells: Cell[];

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.cells = new Array(this.cols * this.rows);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = { ch: ' ', style: STYLE.none };
  }

  private put(x: number, y: number, ch: string, style: Style, clip?: Rect): void {
    if (y < 0 || y >= this.rows || x < 0 || x >= this.cols) return;
    if (clip) {
      if (x < clip.x || x >= clip.x + clip.w || y < clip.y || y >= clip.y + clip.h) return;
    }
    const cell = this.cells[y * this.cols + x]!;
    cell.ch = ch;
    cell.style = style;
  }

  /** Write one line of text. Never wraps; clipped at `clip` (default: screen). */
  text(x: number, y: number, value: string, style: Style = STYLE.none, clip?: Rect): void {
    let col = x;
    for (const ch of stripAnsi(value)) {
      const code = ch.codePointAt(0)!;
      if (code === 0x200d || (code >= 0x0300 && code <= 0x036f)) continue;
      if (col >= this.cols) break;
      if (clip && col >= clip.x + clip.w) break;
      this.put(col, y, ch, style, clip);
      col++;
    }
  }

  /** Write a multi-line block (e.g. a braille chart), each line clipped. */
  block(x: number, y: number, value: string, style: Style = STYLE.none, clip?: Rect): void {
    const lines = value.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const row = y + i;
      if (row >= this.rows) break;
      if (clip && row >= clip.y + clip.h) break;
      this.text(x, row, lines[i]!, style, clip);
    }
  }

  /**
   * Write a block that carries its own SGR codes, mapping them onto cell
   * styles instead of stripping them.
   *
   * `pinerun`'s overlay chart needs this: it says so itself — "without color the
   * two lines merge into one monochrome shape". Same for the price chart's
   * trade markers, where cyan/green/red distinguishes entry from winning and
   * losing exit. Parsing the codes back out is what lets the cell grid stay the
   * single source of truth for what is on screen (clipping, overlays, and the
   * run-coalescing in `render` all keep working).
   */
  styledBlock(x: number, y: number, value: string, base: Style = STYLE.none, clip?: Rect): void {
    const lines = value.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const row = y + i;
      if (row >= this.rows) break;
      if (clip && row >= clip.y + clip.h) break;

      let col = x;
      let style = base;
      const line = lines[i]!;
      let j = 0;
      while (j < line.length) {
        if (line[j] === '\x1b') {
          const match = /^\x1b\[([0-9;]*)m/.exec(line.slice(j));
          if (match) {
            const body = match[1] ?? '';
            // 0 / 39 / empty reset to the block's base style; anything else is
            // the literal SGR body, which is exactly what `sgr()` re-emits.
            style = body === '' || body === '0' || body === '39' ? base : body;
            j += match[0].length;
            continue;
          }
          // A non-SGR escape carries no colour; skip it rather than print it.
          const other = /^\x1b\[[0-9;]*[A-Za-z]/.exec(line.slice(j));
          if (other) {
            j += other[0].length;
            continue;
          }
        }
        if (col >= this.cols) break;
        if (clip && col >= clip.x + clip.w) break;
        const ch = String.fromCodePoint(line.codePointAt(j)!);
        this.put(col, row, ch, style, clip);
        col++;
        j += ch.length;
      }
    }
  }

  fill(rect: Rect, ch = ' ', style: Style = STYLE.none): void {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) this.put(x, y, ch, style);
    }
  }

  /** Render to one string per row, coalescing runs that share a style. */
  render(): string[] {
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      let line = '';
      let current: Style | null = null;
      let trailing = '';
      for (let x = 0; x < this.cols; x++) {
        const cell = this.cells[y * this.cols + x]!;
        // Defer blank default-styled cells: trailing spaces are dropped so a
        // frame does not repaint the full width of every row.
        if (cell.ch === ' ' && cell.style === STYLE.none) {
          trailing += ' ';
          continue;
        }
        if (trailing) {
          if (current !== STYLE.none) {
            line += sgr(STYLE.none);
            current = STYLE.none;
          }
          line += trailing;
          trailing = '';
        }
        if (cell.style !== current) {
          line += sgr(cell.style);
          current = cell.style;
        }
        line += cell.ch;
      }
      if (current != null && current !== STYLE.none) line += sgr(STYLE.none);
      lines.push(line);
    }
    return lines;
  }
}

export const BORDER = {
  tl: '┌',
  tr: '┐',
  bl: '└',
  br: '┘',
  h: '─',
  v: '│',
} as const;

/** A pane's own key, as drawn on its border (§4.2.h). */
export interface PaneKey {
  /** The keystrokes that focus this pane — `S`, `h`, `co`. */
  seq: string;
  /** A jump is half-typed and this pane is still one of its candidates. */
  armed?: boolean;
}

export interface PaneOptions {
  title: string;
  /** Right-hand status legend on the top border. Dropped when it will not fit. */
  legend?: string;
  /** Focused panes get an accent border and a ◆ before the title (§4.2.c). */
  focused?: boolean;
  /**
   * The pane's accelerator, drawn next to its title.
   *
   * The key has to be *on the pane* it focuses: a keymap the user has to open `?`
   * to read is a keymap they will keep pressing `tab` instead of (§4.2.h).
   */
  key?: PaneKey;
}

/**
 * Draw a bordered pane and return its interior rectangle.
 *
 * The title straddles the top border and is never clipped (§4.4) — the legend
 * is dropped first, and the title itself is only shortened when the pane is
 * narrower than the page's declared min-width, which the page guard prevents.
 */
export function drawPane(screen: Screen, rect: Rect, opts: PaneOptions): Rect {
  const style = opts.focused ? STYLE.accent : STYLE.muted;
  const { x, y, w, h } = rect;
  if (w < 2 || h < 2) return { x, y, w: 0, h: 0 };

  screen.text(x, y, BORDER.tl + BORDER.h.repeat(w - 2) + BORDER.tr, style);
  screen.text(x, y + h - 1, BORDER.bl + BORDER.h.repeat(w - 2) + BORDER.br, style);
  for (let row = y + 1; row < y + h - 1; row++) {
    screen.text(x, row, BORDER.v, style);
    screen.text(x + w - 1, row, BORDER.v, style);
  }

  const marker = opts.focused ? '◆ ' : '';
  const title = ` ${marker}${opts.title} `;
  const titleW = displayWidth(title);
  if (titleW <= w - 2) {
    screen.text(x + 1, y, title, opts.focused ? STYLE.accentBold : STYLE.title);
  } else {
    screen.text(x + 1, y, truncate(title, w - 2), opts.focused ? STYLE.accentBold : STYLE.title);
  }

  // The key to the pane you are already in is not a key you need, so the focused
  // pane keeps those four columns for its legend — which is where `1/2 · j/k` and
  // `2 axes · 12 combos` live, and those are about the pane you are reading. Every
  // pane you might want to *go to* carries its badge, and a half-typed jump lights
  // up all of its candidates, focused or not (§4.2.h).
  const badge =
    opts.key == null || (opts.focused === true && opts.key.armed !== true)
      ? ''
      : `[${opts.key.seq}] `;
  const badgeW = titleW + displayWidth(badge) <= w - 2 ? displayWidth(badge) : 0;
  if (badgeW > 0) {
    screen.text(
      x + 1 + titleW,
      y,
      badge,
      opts.key?.armed === true ? STYLE.accentBold : STYLE.accent,
    );
  }

  if (opts.legend) {
    const legend = ` ${opts.legend} `;
    const legendW = displayWidth(legend);
    // Only when it clears the title with a border segment left between them.
    if (titleW + badgeW + legendW + 3 <= w) {
      screen.text(x + w - 1 - legendW, y, legend, STYLE.muted);
    }
  }

  return { x: x + 1, y: y + 1, w: w - 2, h: h - 2 };
}
