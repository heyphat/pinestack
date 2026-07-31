/**
 * Tables and leader rows — the two row shapes every page is built from.
 *
 * Columns are fixed tracks (§4.4): widths are decided before the first row is
 * drawn, so every row lands on the same grid and a long cell is cut rather than
 * pushing its neighbours right. `fitColumns` is where a page's min-width claim
 * is actually enforced — it reports what it had to drop so the caller can
 * degrade deliberately instead of silently losing the payoff column.
 */

import { padEnd, padStart, truncate, type Rect, type Screen } from './screen.js';
import { STYLE, type Style } from './theme.js';

export interface Column {
  key: string;
  header: string;
  width: number;
  align?: 'left' | 'right';
  /** Columns are dropped lowest-priority-first when the pane is too narrow.
   *  The payoff column (EFF, OOS EQUITY, the equity sparkline) must be high. */
  priority?: number;
}

export interface Cell {
  text: string;
  style?: Style;
}

export type Row = Record<string, Cell | string>;

function cellOf(value: Cell | string | undefined): Cell {
  if (value == null) return { text: '' };
  return typeof value === 'string' ? { text: value } : value;
}

/**
 * Choose the columns that fit `width`, dropping the lowest priority first.
 * Returns the kept columns and the names of any that were dropped — never
 * truncate silently (§6: a dropped column must be visible as a decision).
 */
export function fitColumns(
  columns: readonly Column[],
  width: number,
  gap = 1,
): { columns: Column[]; dropped: string[] } {
  const kept = [...columns];
  const dropped: string[] = [];
  const total = (cols: Column[]): number =>
    cols.reduce((sum, c) => sum + c.width, 0) + Math.max(0, cols.length - 1) * gap;

  while (kept.length > 1 && total(kept) > width) {
    let worstIndex = 0;
    let worst = Infinity;
    for (let i = 0; i < kept.length; i++) {
      const priority = kept[i]!.priority ?? 0;
      if (priority < worst) {
        worst = priority;
        worstIndex = i;
      }
    }
    dropped.push(kept[worstIndex]!.header);
    kept.splice(worstIndex, 1);
  }
  return { columns: kept, dropped };
}

export function drawHeader(screen: Screen, rect: Rect, columns: readonly Column[], gap = 1): void {
  let x = rect.x;
  for (const col of columns) {
    const text =
      col.align === 'right' ? padStart(col.header, col.width) : padEnd(col.header, col.width);
    screen.text(x, rect.y, text, STYLE.muted, rect);
    x += col.width + gap;
  }
}

export interface RowOptions {
  selected?: boolean;
  style?: Style;
  gap?: number;
}

export function drawRow(
  screen: Screen,
  rect: Rect,
  y: number,
  columns: readonly Column[],
  row: Row,
  opts: RowOptions = {},
): void {
  const gap = opts.gap ?? 1;
  if (y < rect.y || y >= rect.y + rect.h) return;

  if (opts.selected) {
    // Paint the full track width so the selection reads as one bar, not as a
    // set of highlighted cells with gaps between them.
    const span = columns.reduce((sum, c) => sum + c.width, 0) + (columns.length - 1) * gap;
    screen.text(rect.x, y, ' '.repeat(Math.min(span, rect.w)), STYLE.selected, rect);
  }

  let x = rect.x;
  for (const col of columns) {
    const cell = cellOf(row[col.key]);
    const text = truncate(cell.text, col.width);
    const padded = col.align === 'right' ? padStart(text, col.width) : padEnd(text, col.width);
    const style = opts.selected ? STYLE.selected : (cell.style ?? opts.style ?? STYLE.none);
    screen.text(x, y, padded, style, rect);
    x += col.width + gap;
  }
}

/**
 * A `label ···· value` row — the config and metrics pane shape. Dot leaders
 * make a two-column read work without a vertical rule, and they absorb the
 * slack so the value column stays flush right at any pane width.
 */
export function drawLeader(
  screen: Screen,
  rect: Rect,
  y: number,
  label: string,
  value: string,
  opts: { labelStyle?: Style; valueStyle?: Style; leader?: string; marker?: string } = {},
): void {
  if (y < rect.y || y >= rect.y + rect.h) return;

  const marker = opts.marker ?? '';
  const head = marker + label;
  const headText = truncate(head, Math.max(0, rect.w - 4));
  const valueText = truncate(value, Math.max(0, rect.w - headText.length - 2));
  const fill = Math.max(1, rect.w - headText.length - valueText.length - 2);

  screen.text(rect.x, y, headText, opts.labelStyle ?? STYLE.none, rect);
  screen.text(
    rect.x + headText.length + 1,
    y,
    (opts.leader ?? '·').repeat(fill),
    STYLE.muted,
    rect,
  );
  screen.text(
    rect.x + rect.w - valueText.length,
    y,
    valueText,
    opts.valueStyle ?? STYLE.none,
    rect,
  );
}
