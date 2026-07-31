/**
 * The INPUTS pane — the `input()` titles a script declares.
 *
 * EDITOR grew it first, as an outline of the buffer. SWEEP needs the same list
 * for a different reason: you cannot choose axes for a grid you cannot see, and
 * the axis names are validated against exactly these titles before anything runs
 * (§4.5.e). So it is one renderer, and the two pages differ only in what they put
 * beside a row — nothing on EDITOR, the axis grid on SWEEP.
 *
 * On SWEEP the pane is also the *editor* for the grid. `--input` is one repeatable
 * flag, which the config pane can only show as a single space-joined field: adding
 * a second axis meant retyping the first. Here each axis is its own row with its
 * own `↵`, which is the whole reason a sweep of more than one input was awkward.
 */

import { inputTitles } from '../flags/pine-inputs.js';
import { bufferText } from '../editor/buffer.js';
import { drawPane, truncate, type Rect } from '../render/screen.js';
import { drawLeader } from '../render/table.js';
import { STYLE } from '../render/theme.js';
import { cachedInputTitles } from '../scripts.js';
import type { AppState } from '../state.js';
import { clampCursor, windowFor, type PageContext } from './page.js';

export interface InputRow {
  title: string;
  /** The axis grid, when this input is being swept. Absent on EDITOR. */
  value?: string;
  /** True when this input is part of the run — SWEEP's axis marker. */
  marked?: boolean;
  /** Configured but not declared by the script: `pinerun` will reject it. */
  unknown?: boolean;
  /** The buffer being typed into this row, when it is the one being edited. */
  editing?: string;
}

export interface InputsPaneOptions {
  paneId: string;
  rows: readonly InputRow[];
  legend?: string;
  /** Shown in place of the list when there is nothing to show. */
  empty: string;
  /** Bottom-row hint, dropped when the pane is too short to spare the line. */
  hint?: string;
  /** A refusal to show on the last row, e.g. SWEEP's `--max-combos` guard. */
  warning?: string;
}

/**
 * The titles a script declares.
 *
 * The open editor buffer wins over the file when it holds the same script, so an
 * input renamed on page 1 is selectable on page 3 before it has been written —
 * the same live-outline property the EDITOR pane has, extended to the page that
 * consumes it. Otherwise the read is cached (`refreshScripts` clears it), because
 * this is called once per frame and a file read per frame is not.
 */
export function declaredInputs(state: AppState, path: string | undefined): string[] {
  if (path == null || path === '') return [];
  const buffer = state.editor.buffer;
  if (buffer != null && buffer.path === path) return inputTitles(bufferText(buffer));
  return cachedInputTitles(path);
}

export function drawInputsPane(ctx: PageContext, rect: Rect, opts: InputsPaneOptions): void {
  const { screen } = ctx;
  const focused = ctx.focus === opts.paneId;

  const inner = drawPane(screen, rect, { title: 'INPUTS', focused, legend: opts.legend });
  if (inner.h <= 0) return;

  if (opts.rows.length === 0) {
    screen.text(inner.x, inner.y, truncate(opts.empty, inner.w), STYLE.muted, inner);
    return;
  }

  // The hint is the first thing to go, and it goes as soon as it would cost an
  // input a row: this is the pane you pick inputs from, so a hidden input is a
  // worse failure than a hidden keybinding — which `?` documents anyway. The
  // warning always keeps its row; it is a refusal, not a nicety.
  const warningRows = opts.warning != null ? 1 : 0;
  const showHint = opts.hint != null && opts.rows.length + warningRows + 1 <= inner.h;
  const listRows = Math.max(1, inner.h - warningRows - (showHint ? 1 : 0));

  const cursor = clampCursor(ctx.cursor(opts.paneId), opts.rows.length);
  const { from, to } = windowFor(cursor, opts.rows.length, listRows);

  for (let i = from; i < to; i++) {
    const row = opts.rows[i]!;
    const y = inner.y + (i - from);
    const selected = i === cursor && focused;
    const editing = row.editing != null;

    if (selected && !editing) screen.text(inner.x, y, ' '.repeat(inner.w), STYLE.selected);

    const titleStyle =
      selected && !editing ? STYLE.selected : row.unknown ? STYLE.warn : STYLE.none;

    // A row with nothing beside it is a plain line, which is what EDITOR wants;
    // a row carrying a grid is a leader row, which is how every other value in
    // the app is shown. Same pane, and neither page gets a shape of its own.
    if (row.value == null && !editing) {
      screen.text(inner.x, y, truncate(row.title, inner.w), titleStyle, inner);
      continue;
    }

    drawLeader(screen, inner, y, row.title, editing ? `${row.editing!}█` : (row.value ?? ''), {
      labelStyle: titleStyle,
      valueStyle: editing ? STYLE.accent : row.unknown ? STYLE.warn : STYLE.none,
      marker: row.marked === true ? '▌' : '',
    });
  }

  let y = inner.y + inner.h - 1;
  if (opts.warning != null) {
    screen.text(inner.x, y, truncate(opts.warning, inner.w), STYLE.error, inner);
    y -= 1;
  }
  if (showHint) screen.text(inner.x, y, truncate(opts.hint!, inner.w), STYLE.muted, inner);
}
