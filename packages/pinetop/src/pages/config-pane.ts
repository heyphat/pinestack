/**
 * The config pane, shared by all six command pages.
 *
 * §4.4 puts the config pane in the left column of every page, and §3 G2 requires
 * the flags be visible and editable at all times. One renderer for all six means
 * a flag added to a schema appears without touching a page, and the pending-edit
 * marking (§4.5.c) cannot be implemented six subtly different ways.
 *
 * Only real flags are listed. §5's last row records why: `universe`, `bar`, and
 * unmapped rows are not `--input` params, and listing them duplicated
 * `--symbol`/`--tf`, so the pane lists flags and nothing else.
 */

import { displayValue, isSet } from '../flags/model.js';
import { schemaFor, type CommandId, type FlagSpec } from '../flags/schema.js';
import { drawPane, truncate, type Rect } from '../render/screen.js';
import { drawLeader } from '../render/table.js';
import { STYLE } from '../render/theme.js';
import { scriptLabel } from '../scripts.js';
import type { AppState } from '../state.js';
import { overridesFor } from '../state.js';
import { clampCursor, windowFor, type PageContext } from './page.js';

/**
 * The flags a page shows: everything non-advanced, any advanced flag that is
 * already set, and — when `showAdvanced` is on — all of them.
 *
 * Both the config pane and the run dialog index their rows through this, so the
 * two surfaces always agree on what row 7 means and a shared edit cannot land on
 * the wrong flag.
 */
export function visibleFlags(state: AppState, command: CommandId): FlagSpec[] {
  const model = state.flags[command];
  return schemaFor(command).flags.filter((f) => {
    if (!f.advanced || state.showAdvanced || isSet(model.values[f.name])) return true;
    // An advanced flag that another flag's value has made relevant shows itself:
    // choosing `--provider csv` surfaces `--data-dir`, which csv requires.
    const reveal = f.revealWhen;
    if (reveal == null) return false;
    const trigger = model.values[reveal.flag];
    return typeof trigger === 'string' && reveal.equals.includes(trigger);
  });
}

/** Advanced flags currently hidden — the pane says so, so they are findable. */
export function hiddenFlagCount(state: AppState, command: CommandId): number {
  return schemaFor(command).flags.length - visibleFlags(state, command).length;
}

/** Rows the config pane offers to `j`/`k`: the scripts, then the flags. */
export function configRowCount(state: AppState, command: CommandId): number {
  return schemaFor(command).scripts + visibleFlags(state, command).length;
}

/** The run dialog adds one row after the config rows: RUN itself. */
export function runRowCount(state: AppState, command: CommandId): number {
  return configRowCount(state, command) + 1;
}

/** True when `index` is the dialog's RUN row rather than a field. */
export function isRunRow(state: AppState, command: CommandId, index: number): boolean {
  return index >= configRowCount(state, command);
}

/**
 * Which row is blocking a run.
 *
 * `validate` returns prose for the user; this maps the same conditions onto a
 * row so the dialog can put the cursor on the field that needs filling instead
 * of making them hunt for it. Falls back to row 0 — the script — because a
 * command with nothing set at all is blocked on that first.
 */
export function firstUnmetRow(state: AppState, command: CommandId): number {
  const schema = schemaFor(command);
  const model = state.flags[command];

  for (let i = 0; i < schema.scripts; i++) {
    if (model.scripts[i] == null || model.scripts[i] === '') return i;
  }

  const flags = visibleFlags(state, command);
  const rowOf = (name: string): number => {
    const at = flags.findIndex((f) => f.name === name);
    return at < 0 ? 0 : schema.scripts + at;
  };

  const required: Record<CommandId, readonly string[]> = {
    backtest: ['symbol'],
    walkforward: ['symbol', 'input'],
    compare: ['symbol'],
    sweep: ['input'],
    scan: ['symbols'],
    portfolio: ['symbols'],
  };
  // `scan`/`portfolio` accept --universe in place of --symbols, so a set
  // alternative clears the requirement rather than pointing at an empty field.
  const alternatives: Record<string, string> = { symbols: 'universe' };

  for (const name of required[command]) {
    if (isSet(model.values[name])) continue;
    const alternative = alternatives[name];
    if (alternative != null && isSet(model.values[alternative])) continue;
    return rowOf(name);
  }

  // Requirements another flag's value creates, checked after the fixed ones:
  // csv without a directory to read is the common way to get stuck.
  if (model.values['provider'] === 'csv' && !isSet(model.values['data-dir'])) {
    return rowOf('data-dir');
  }
  return 0;
}

export interface ConfigPaneOptions {
  command: CommandId;
  paneId?: string;
  title?: string;
  /** Action chips on the bottom row. Defaults to RUN / ASK / palette. */
  actions?: string[];
}

export function drawConfigPane(ctx: PageContext, rect: Rect, opts: ConfigPaneOptions): void {
  const { screen, state } = ctx;
  const { command } = opts;
  const paneId = opts.paneId ?? 'config';
  const schema = schemaFor(command);
  const model = state.flags[command];
  const overrides = overridesFor(state, command);

  const flags = visibleFlags(state, command);
  const total = schema.scripts + flags.length;

  // The legend carries whichever fact matters most: pending edits first, then
  // the count of advanced flags being withheld and the key that reveals them.
  const hidden = hiddenFlagCount(state, command);
  const legend =
    overrides.length > 0
      ? `${overrides.length} pending`
      : hidden > 0
        ? `+${hidden} advanced · .`
        : state.showAdvanced
          ? 'all flags · .'
          : undefined;

  const inner = drawPane(screen, rect, {
    title: opts.title ?? `${command.toUpperCase()} CONFIG`,
    focused: ctx.focus === paneId,
    key: ctx.paneKey(paneId),
    legend,
  });
  if (inner.h <= 0) return;

  const focused = ctx.focus === paneId;
  const cursor = clampCursor(ctx.cursor(paneId), total);
  // Reserve the last row for action chips, and one more for pending edits.
  const listRows = Math.max(0, inner.h - 1 - (overrides.length > 0 ? overrides.length : 0));
  const { from, to } = windowFor(cursor, total, listRows);

  // A field open for typing renders its buffer with a block cursor, in place,
  // so the value being edited stays in the row it belongs to (§10.2).
  const edit =
    state.edit?.command === command && state.edit.origin === 'config' ? state.edit : null;

  let y = inner.y;
  for (let i = from; i < to; i++) {
    if (y >= inner.y + listRows) break;
    const isScript = i < schema.scripts;
    const editing = edit != null && edit.index === i;

    if (isScript) {
      const path = model.scripts[i];
      const label = schema.scripts === 2 ? (i === 0 ? 'script A' : 'script B') : 'script';
      drawLeader(
        screen,
        inner,
        y,
        label,
        editing ? `${edit.buffer}█` : path == null ? '—' : `${scriptLabel(path)}.pine`,
        {
          labelStyle: focused && cursor === i ? STYLE.accentBold : STYLE.none,
          valueStyle: editing ? STYLE.accent : path == null ? STYLE.muted : STYLE.none,
        },
      );
      y += 1;
      continue;
    }

    const spec = flags[i - schema.scripts]!;
    const value = model.values[spec.name];
    drawLeader(
      screen,
      inner,
      y,
      spec.label ?? `--${spec.name}`,
      editing ? `${edit.buffer}█` : displayValue(spec, value),
      {
        labelStyle: focused && cursor === i ? STYLE.accentBold : STYLE.none,
        valueStyle: editing ? STYLE.accent : isSet(value) ? STYLE.none : STYLE.muted,
      },
    );
    y += 1;
  }

  // Pending `--input` edits: gold dot, old → new (§4.5.c).
  for (const override of overrides) {
    if (y >= inner.y + inner.h - 1) break;
    drawLeader(screen, inner, y, override.input, `${override.from} → ${override.to}`, {
      labelStyle: STYLE.pending,
      valueStyle: STYLE.pending,
      marker: '● ',
    });
    y += 1;
  }

  const actionsY = inner.y + inner.h - 1;
  // The hints a first-time user cannot guess: `↵` edits in place (§10.2), and
  // `.` reveals the flags being withheld. The pane is narrow enough that the
  // legend gets dropped by the title-first rule, so these live on the action
  // row, which always has room.
  const chips = opts.actions ?? [
    'RUN r',
    focused ? '↵ edit' : 'ASK a',
    hidden > 0 ? `. +${hidden}` : state.showAdvanced ? '. fewer' : ': cmd',
  ];
  let x = inner.x;
  for (let i = 0; i < chips.length; i++) {
    const chip = ` ${chips[i]} `;
    if (x + chip.length > inner.x + inner.w) break;
    screen.text(x, actionsY, chip, i === 0 ? STYLE.accentBold : STYLE.muted, inner);
    x += chip.length + 1;
  }

  if (total > listRows && listRows > 0) {
    const more = `${Math.floor(cursor / Math.max(1, listRows)) + 1}/${Math.ceil(total / Math.max(1, listRows))}`;
    screen.text(
      inner.x + inner.w - more.length,
      actionsY,
      truncate(more, inner.w),
      STYLE.muted,
      inner,
    );
  }
}
