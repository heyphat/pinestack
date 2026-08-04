/**
 * Overlays: help, the run dialog, the command palette, and the filter line.
 *
 * They paint over the frame rather than displacing it: width is the scarce
 * resource on this surface, and a panel that permanently costs columns changes
 * what the page can show even when it is closed.
 */

import { commandLine, displayValue, isSet, validate, withOverrides } from './flags/model.js';
import {
  commandForPage,
  isCommandPage,
  schemaFor,
  PAGE_PURPOSE,
  PAGES,
  PAGE_TITLES,
  type CommandId,
} from './flags/schema.js';
import { BINDINGS, EDITOR_KEYS, type Action } from './keymap.js';
import { duration } from './render/format.js';
import { displayWidth, drawPane, truncate, type Rect, type Screen } from './render/screen.js';
import { drawLeader } from './render/table.js';
import { STYLE, type Style } from './render/theme.js';
import type { AppState, RunState } from './state.js';
import { overridesFor } from './state.js';
import { visibleFlags } from './pages/config-pane.js';
import { ensureEditorFile } from './pages/editor.js';

/** Centre a box of the given size in the screen. */
function centred(screen: Screen, w: number, h: number): Rect {
  const width = Math.min(w, screen.cols - 4);
  const height = Math.min(h, screen.rows - 4);
  return {
    x: Math.max(0, Math.floor((screen.cols - width) / 2)),
    y: Math.max(0, Math.floor((screen.rows - height) / 2)),
    w: width,
    h: height,
  };
}

/** Blank the box first so the page underneath does not bleed through. */
function clear(screen: Screen, rect: Rect): void {
  screen.fill(rect, ' ', STYLE.none);
}

const GROUP_TITLES: Record<string, string> = {
  navigate: 'NAVIGATE',
  select: 'SELECT',
  act: 'ACT',
  overlay: 'OVERLAY',
};

const GROUPS = ['navigate', 'select', 'act', 'overlay'] as const;

/** Rows a group costs: its title, its bindings, and a blank line after it. */
function groupHeight(group: string): number {
  return 2 + BINDINGS.filter((binding) => binding.group === group).length;
}

/**
 * §7 P0's exit criterion: `?` documents the real keymap. It is generated.
 *
 * Which means the box is sized from the table, never hard-coded. A fixed height
 * silently dropped the last two bindings the moment one was added — a generated
 * help that loses entries is worse than a hand-written one, because it still
 * reads as complete. So: one column when the terminal is tall enough, two when it
 * is not, and the height comes from what there is to show.
 */
export function drawHelp(
  screen: Screen,
  state: AppState,
  paneKeys: ReadonlyMap<string, string> = new Map(),
): void {
  // On EDITOR the buffer's own bindings are the ones you need, and there are more
  // of them than the app's — so that page gets a two-column box wide enough to
  // hold both keyboards at once rather than a truncated version of either.
  if (state.page === 'editor') {
    drawEditorHelp(screen, state, paneKeys);
    return;
  }

  const tall = GROUPS.reduce((sum, group) => sum + groupHeight(group), 0);
  const columnGroups: string[][] =
    tall + 3 <= screen.rows - 4 ? [[...GROUPS]] : [GROUPS.slice(0, 2), GROUPS.slice(2)];
  const columnHeight = Math.max(
    ...columnGroups.map((c) => c.reduce((sum, g) => sum + groupHeight(g), 0)),
  );
  const height = columnHeight + 3 + (paneKeys.size > 0 ? 1 : 0);

  // The pane row is one long line, so the one-column box widens to hold a
  // six-pane page rather than eliding half of it (the `…` still says when a
  // narrow terminal clips it).
  const width = columnGroups.length > 1 ? 104 : paneKeys.size > 0 ? 86 : 76;
  const rect = centred(screen, width, height);
  clear(screen, rect);
  // The legend answers "what am I running" — both halves of it, since every
  // number on screen came out of that pinerun, so a stale one explains a stale
  // number. The keymap fills the body, which is why this cannot live there.
  const versions = state.versions;
  const legend =
    versions == null
      ? `pinetop · ${PAGE_TITLES[state.page]}`
      : versions.pinerun != null
        ? `${versions.pinetop} · driving ${versions.pinerun}`
        : `${versions.pinetop} · pinerun not found`;
  const inner = drawPane(screen, rect, { title: 'KEYS', focused: true, legend });
  if (inner.h <= 1) return;

  // The bindings keep every row they need; the pane line gets what is left over
  // (see below), which at 80×24 is nothing.
  const paneRow = paneKeys.size > 0 && inner.h >= columnHeight + 2 ? 1 : 0;
  const bodyBottom = inner.y + inner.h - 1 - paneRow;

  const columnW = Math.floor(inner.w / columnGroups.length);
  for (let column = 0; column < columnGroups.length; column++) {
    const x = inner.x + column * columnW;
    let y = inner.y;
    for (const group of columnGroups[column]!) {
      if (y >= bodyBottom) break;
      screen.text(x, y, GROUP_TITLES[group]!, STYLE.title, inner);
      y += 1;
      for (const binding of BINDINGS) {
        if (binding.group !== group) continue;
        if (y >= bodyBottom) break;
        screen.text(x + 2, y, binding.display.padEnd(12), STYLE.accent, inner);
        screen.text(
          x + 15,
          y,
          truncate(binding.description, Math.max(0, columnW - 16)),
          STYLE.none,
          inner,
        );
        y += 1;
      }
      y += 1;
    }
  }

  // This page's pane keys, on the row above the footnote, and only when the box
  // has one to spare: they are drawn on the panes themselves, so `?` dropping them
  // at 24 rows costs nothing — while a *binding* pushed off the box would cost the
  // overlay its one claim (§7 P0) to be the real keymap.
  if (paneRow > 0) drawPaneKeys(screen, inner, inner.y + inner.h - 2, paneKeys);

  const note =
    '⌘K is listed in the design as the palette key; a terminal cannot see it — ctrl-p is the binding.';
  screen.text(inner.x, inner.y + inner.h - 1, truncate(note, inner.w), STYLE.muted, inner);
}

/**
 * `PANES  S strategies · c config · ch charts …` — one line, generated from the
 * accelerators the app actually resolved, so it cannot advertise a key that a
 * collision moved or that the page never got (§4.2.h).
 */
function drawPaneKeys(
  screen: Screen,
  inner: Rect,
  y: number,
  paneKeys: ReadonlyMap<string, string>,
): void {
  if (paneKeys.size === 0) return;
  const label = 'PANES';
  screen.text(inner.x, y, label, STYLE.title, inner);
  let x = inner.x + label.length + 2;
  for (const [paneId, seq] of paneKeys) {
    const width = displayWidth(`${seq} ${paneId}`);
    // A pane that will not fit is said to be missing rather than dropped in
    // silence: the badges on the panes themselves are the complete list.
    if (x + width > inner.x + inner.w) {
      screen.text(inner.x + inner.w - 1, y, '…', STYLE.muted, inner);
      return;
    }
    screen.text(x, y, seq, STYLE.accent, inner);
    screen.text(x + seq.length + 1, y, paneId, STYLE.muted, inner);
    x += width + 2;
  }
}

/**
 * `?` on the EDITOR page.
 *
 * Both keyboards, side by side: the buffer's bindings on the left (the ones in
 * play while it has focus) and the app's on the right (the ones `tab` gets you
 * back to). Generated from `EDITOR_KEYS` and `BINDINGS`, so neither column can
 * drift from what the keys actually do.
 */
function drawEditorHelp(
  screen: Screen,
  state: AppState,
  paneKeys: ReadonlyMap<string, string>,
): void {
  // Sized from the two lists plus the footer, and one more row for the pane keys
  // when the page has any — a fixed height silently dropped the tail of whichever
  // keyboard grew, which is the failure `?` exists to not have.
  const contentH = Math.max(EDITOR_KEYS.length, BINDINGS.length) + 1;
  const rect = centred(screen, 116, contentH + 3 + (paneKeys.size > 0 ? 1 : 0));
  clear(screen, rect);
  const buffer = state.editor.buffer;
  const inner = drawPane(screen, rect, {
    title: 'KEYS — EDITOR',
    focused: true,
    legend:
      buffer == null ? 'no file open' : `${buffer.path}${buffer.modified ? ' · unwritten' : ''}`,
  });
  if (inner.h <= 1) return;

  const leftW = Math.min(62, Math.max(30, inner.w - 48));
  const keyW = 10;
  const paneRow = paneKeys.size > 0 && inner.h >= contentH + 2 ? 1 : 0;
  const bodyBottom = inner.y + inner.h - 1 - paneRow;

  screen.text(inner.x, inner.y, 'IN THE BUFFER', STYLE.title, inner);
  let y = inner.y + 1;
  for (const key of EDITOR_KEYS) {
    if (y >= bodyBottom) break;
    screen.text(inner.x + 1, y, key.display.padEnd(keyW), STYLE.accent, inner);
    screen.text(
      inner.x + 1 + keyW + 1,
      y,
      truncate(key.description, Math.max(0, leftW - keyW - 3)),
      STYLE.none,
      inner,
    );
    y += 1;
  }

  const rightX = inner.x + leftW;
  screen.text(rightX, inner.y, 'ELSEWHERE IN PINETOP', STYLE.title, inner);
  let ry = inner.y + 1;
  for (const binding of BINDINGS) {
    if (ry >= bodyBottom) break;
    screen.text(rightX + 1, ry, binding.display.padEnd(11), STYLE.accent, inner);
    screen.text(
      rightX + 13,
      ry,
      truncate(binding.description, Math.max(0, inner.x + inner.w - rightX - 14)),
      STYLE.none,
      inner,
    );
    ry += 1;
  }

  if (paneRow > 0) drawPaneKeys(screen, inner, inner.y + inner.h - 2, paneKeys);

  screen.text(
    inner.x,
    inner.y + inner.h - 1,
    truncate(
      'The buffer takes every key while it has focus, except tab (leave the pane) and ctrl-c (quit pinetop).',
      inner.w,
    ),
    STYLE.muted,
    inner,
  );
}

/**
 * The first-launch overlay.
 *
 * `pinetop` with no arguments has to be a usable starting point, not a screen
 * that assumes you already know the keymap — so on a project with no saved
 * state it names the three things to do and gets out of the way on any key.
 * Once `.pinetop/flags.json` exists this is never shown again.
 */
export function drawWelcome(screen: Screen, state: AppState): void {
  const command = commandForPage(state.page);
  const model = state.flags[command];
  const scriptSet = model.scripts[0] != null;
  const targetFlag = command === 'scan' || command === 'portfolio' ? '--symbols' : '--symbol';
  const targetSet = isSet(model.values[targetFlag.slice(2)]);

  const rect = centred(screen, 68, 17);
  clear(screen, rect);
  const inner = drawPane(screen, rect, { title: 'PINETOP', focused: true });
  if (inner.h <= 0) return;

  const done = (ok: boolean): string => (ok ? '✓' : '·');
  const lines: [string, Style][] = [
    ['A terminal UI over pinerun. Everything is configured here —', STYLE.none],
    ['you never have to retype the command.', STYLE.none],
    ['', STYLE.none],
    [
      `${done(scriptSet)} 1. pick a strategy    tab to STRATEGIES, ↵ to load`,
      scriptSet ? STYLE.positive : STYLE.none,
    ],
    [
      `${done(targetSet)} 2. set ${targetFlag.padEnd(14)} tab to CONFIG, j/k to the row, ↵ to edit`,
      targetSet ? STYLE.positive : STYLE.none,
    ],
    ['· 3. run                r, then ↵ on RUN', STYLE.none],
    ['', STYLE.none],
    [`1–${PAGES.length} switch pages · 1 EDITOR edits the .pine · ? shows every key`, STYLE.muted],
    ['Flags are saved per project, so next time this is already set.', STYLE.muted],
  ];

  let y = inner.y;
  for (const [text, style] of lines) {
    if (y >= inner.y + inner.h - 1) break;
    screen.text(inner.x, y, truncate(text, inner.w), style, inner);
    y += 1;
  }
  screen.text(inner.x, inner.y + inner.h - 1, 'any key to begin', STYLE.accent, inner);
}

/** The pages, as the palette lists them, plus the verbs that are not pages. */
export interface PaletteItem {
  label: string;
  hint: string;
  run: (state: AppState) => string | undefined;
  /**
   * A keymap action to dispatch after `run`, for the verbs that need the App and
   * not just the state — suspending the terminal for `$EDITOR`, opening a dialog.
   * `run` alone cannot express those: it is handed a state, not a program.
   */
  action?: Action;
}

export function paletteItems(): PaletteItem[] {
  const items: PaletteItem[] = PAGES.map((page) => ({
    label: `go ${page}`,
    hint: PAGE_PURPOSE[page],
    run: (state) => {
      state.page = page;
      // The same courtesy `1` gets: EDITOR opens the loaded script rather than
      // showing an empty buffer.
      if (page === 'editor') ensureEditorFile(state);
      return undefined;
    },
  }));

  items.push(
    {
      label: 'edit in $EDITOR',
      hint: 'suspend the frame and open this page’s script in vim',
      run: () => undefined,
      action: { kind: 'edit-external' },
    },
    {
      // This used to be `w`. Pages are reached by their ordinal now (§4.2.i), and
      // this was never merely a page switch: it copies the sweep's axes into
      // walkforward, which is an edit, and an edit belongs somewhere it has to be
      // asked for by name.
      label: 'carry the sweep grid into walkforward',
      hint: 'copy the axes, symbol and span, then open WALKFORWARD',
      run: () => undefined,
      action: { kind: 'walkforward' },
    },
    {
      label: 'revert pending edits',
      hint: 'discard AI/user overrides for this script',
      run: (state) => {
        const page = state.page;
        if (!isCommandPage(page)) return 'no config on this page';
        const key = state.flags[page].scripts[0] ?? '';
        if (key === '') return 'no script loaded';
        delete state.overrides[key];
        return 'reverted pending edits';
      },
    },
    {
      // Dismissing an error should not lose it: `esc` hides the drawer, this
      // brings it back, and the engine log on LOGS was never gone.
      label: 'show the last error',
      hint: 'reopen the drawer for the loaded run',
      run: (state) => {
        const run = state.run;
        if (run == null) return 'no run loaded';
        run.errorDismissed = false;
        return runTrouble(state) == null ? 'the loaded run reported no errors' : undefined;
      },
    },
    {
      label: 'clear filter',
      hint: 'drop the fill filter',
      run: (state) => {
        state.tradeFilter = '';
        state.logScope = null;
        return 'filter cleared';
      },
    },
    {
      // Discoverable without knowing the key, since these flags are the ones a
      // user would otherwise have to go back to the shell for.
      label: 'show all flags',
      hint: 'reveal --data-dir, --mintick, the magnifier overrides, …',
      run: (state) => {
        state.showAdvanced = !state.showAdvanced;
        return state.showAdvanced ? 'showing every flag' : 'advanced flags hidden';
      },
    },
  );
  return items;
}

export function filterPalette(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...items];
  return items.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(needle));
}

export function drawPalette(screen: Screen, state: AppState): void {
  const rect = centred(screen, 68, 18);
  clear(screen, rect);
  const items = filterPalette(paletteItems(), state.overlay.buffer);
  const inner = drawPane(screen, rect, { title: 'COMMAND', focused: true });

  screen.text(inner.x, inner.y, ':', STYLE.accent, inner);
  screen.text(inner.x + 2, inner.y, state.overlay.buffer, STYLE.none, inner);
  screen.text(inner.x + 2 + displayWidth(state.overlay.buffer), inner.y, '█', STYLE.accent, inner);

  const cursor = Math.min(Math.max(0, state.overlay.cursor), Math.max(0, items.length - 1));
  for (let i = 0; i < items.length && i < inner.h - 2; i++) {
    const item = items[i]!;
    const y = inner.y + 2 + i;
    const selected = i === cursor;
    if (selected) screen.text(inner.x, y, ' '.repeat(inner.w), STYLE.selected);
    screen.text(
      inner.x,
      y,
      truncate(item.label, 24).padEnd(25),
      selected ? STYLE.selected : STYLE.none,
      inner,
    );
    screen.text(
      inner.x + 25,
      y,
      truncate(item.hint, Math.max(0, inner.w - 25)),
      selected ? STYLE.selected : STYLE.muted,
      inner,
    );
  }
  if (items.length === 0) screen.text(inner.x, inner.y + 2, 'no match', STYLE.muted, inner);
}

/**
 * The run dialog.
 *
 * §10.2 asked whether flags should be edited in place or in a dialog. Both, as
 * it turns out: the config pane edits in place for the one-flag tweak, and this
 * dialog exists for the "set up a run from nothing" case, where seeing every
 * field and the composed line together is worth the modal. They share one
 * text-input mode, so a value typed here behaves exactly as it does there.
 *
 * The last row is RUN, so the dialog can be finished with `↵` rather than a
 * second `r` — and nothing runs until one of those (§4.6).
 */
export function drawRunDialog(screen: Screen, state: AppState, command: CommandId): void {
  const schema = schemaFor(command);
  const flags = visibleFlags(state, command);
  const fieldRows = schema.scripts + flags.length;
  const total = fieldRows + 1; // + RUN
  const rect = centred(screen, 74, Math.min(screen.rows - 4, total + 10));
  clear(screen, rect);

  const model = withOverrides(state.flags[command], overridesFor(state, command));
  const problems = validate(model);
  const edit =
    state.edit?.command === command && state.edit.origin === 'dialog' ? state.edit : null;

  const inner = drawPane(screen, rect, {
    title: `RUN ${command.toUpperCase()}`,
    focused: true,
    legend: problems.length === 0 ? 'ready · ↵ on RUN' : `${problems.length} to fix`,
  });

  const cursor = Math.min(Math.max(0, state.overlay.cursor), Math.max(0, total - 1));
  const listRows = Math.max(0, inner.h - 4);
  const from = Math.max(
    0,
    Math.min(cursor - Math.floor(listRows / 2), Math.max(0, total - listRows)),
  );

  for (let i = from; i < Math.min(total, from + listRows); i++) {
    const y = inner.y + (i - from);
    const selected = i === cursor;
    const editing = edit != null && edit.index === i;

    if (i === fieldRows) {
      // The RUN row: styled as the action it is, and dimmed while blocked.
      const label = problems.length === 0 ? ' RUN ▸ ' : ' RUN ▸ (blocked) ';
      screen.text(
        inner.x,
        y,
        label,
        problems.length > 0 ? STYLE.muted : selected ? STYLE.selected : STYLE.accentBold,
        inner,
      );
      continue;
    }

    if (i < schema.scripts) {
      const label = schema.scripts === 2 ? (i === 0 ? 'script A' : 'script B') : 'script';
      const value = editing ? `${edit.buffer}█` : (model.scripts[i] ?? '—');
      drawLeader(screen, inner, y, label, value, {
        labelStyle: selected ? STYLE.accentBold : STYLE.none,
        valueStyle: editing ? STYLE.accent : model.scripts[i] == null ? STYLE.muted : STYLE.none,
      });
      continue;
    }

    const spec = flags[i - schema.scripts]!;
    const raw = model.values[spec.name];
    const value = editing ? `${edit.buffer}█` : displayValue(spec, raw);
    drawLeader(screen, inner, y, spec.label ?? `--${spec.name}`, value, {
      labelStyle: selected ? STYLE.accentBold : STYLE.none,
      valueStyle: editing ? STYLE.accent : isSet(raw) ? STYLE.none : STYLE.muted,
    });
  }

  // The help for the selected flag, then the composed line, then the problems.
  const helpY = inner.y + inner.h - 3;
  const selectedSpec =
    cursor >= schema.scripts && cursor < fieldRows ? flags[cursor - schema.scripts] : undefined;
  const help =
    edit != null
      ? 'type a value · ↵ accept · esc cancel · ctrl-u clear'
      : cursor === fieldRows
        ? 'j/k move · ↵ run · esc cancel'
        : (selectedSpec?.help ?? 'j/k move · ↵ edit · r run · esc cancel');
  screen.text(inner.x, helpY, truncate(help, inner.w), STYLE.muted, inner);

  screen.text(inner.x, helpY + 1, truncate(`$ ${commandLine(model)}`, inner.w), STYLE.none, inner);

  screen.text(
    inner.x,
    helpY + 2,
    truncate(problems.length === 0 ? 'ready to run' : problems[0]!, inner.w),
    problems.length === 0 ? STYLE.positive : STYLE.error,
    inner,
  );
}

export function drawFilter(screen: Screen, state: AppState): void {
  const y = screen.rows - 3;
  screen.text(1, y, ' '.repeat(Math.max(0, screen.cols - 2)), STYLE.none);
  screen.text(1, y, '/', STYLE.accent);
  screen.text(2, y, state.overlay.buffer, STYLE.none);
  screen.text(2 + displayWidth(state.overlay.buffer), y, '█', STYLE.accent);
  const hint = '↵ apply · esc clear';
  screen.text(screen.cols - 1 - hint.length, y, hint, STYLE.muted);
}

// ————————————————————————————————————————————————————————— the failure drawer

/**
 * The per-symbol failures inside a report that otherwise succeeded.
 *
 * `scan` and `portfolio` report and continue when a symbol's history cannot be
 * fetched, and `sweep` does the same for a combo that errored — §8 says that
 * distinction must be shown, not swallowed. Only three report shapes carry these
 * fields; the rest read as absent, which is why this narrows `unknown` rather
 * than switching on the command.
 */
interface PartialReport {
  fetchErrors?: { symbol: string; error: string }[];
  errors?: { symbol?: string; id?: string; error?: string }[];
}

export function partialFailures(run: RunState | null | undefined): string[] {
  const report = run?.report as PartialReport | undefined;
  if (report == null) return [];
  return [
    ...(report.fetchErrors ?? []).map((e) => `${e.symbol}: ${e.error}`),
    ...(report.errors ?? []).map(
      (e) => `${e.symbol ?? e.id ?? '—'}: ${e.error ?? 'the run errored'}`,
    ),
  ];
}

/** What the drawer is announcing, or null when there is nothing to announce. */
export interface RunTrouble {
  /** `failed` — the process; `incomplete` — it finished, but parts of it did not. */
  kind: 'failed' | 'incomplete';
  title: string;
  legend: string;
  lines: string[];
  style: Style;
  hint: string;
}

export function runTrouble(state: AppState): RunTrouble | null {
  const run = state.run;
  if (run == null || run.errorDismissed === true) return null;
  const elapsed = run.elapsedMs == null ? undefined : duration(run.elapsedMs);
  const tail = [elapsed, `run ${run.id}`].filter((part): part is string => part != null);

  if (run.status === 'failed') {
    // `pinerun`'s own error-level stderr, which is the engine speaking for
    // itself — falling back to the summary the spawn layer derived when the
    // process said nothing gradeable (bad JSON, empty stdout, no binary).
    const errors = run.log.filter((line) => line.level === 'error').map((line) => line.text);
    return {
      kind: 'failed',
      title: `${run.command.toUpperCase()} FAILED`,
      legend: [run.exitCode == null ? 'did not start' : `exit ${run.exitCode}`, ...tail].join(
        ' · ',
      ),
      lines: errors.length > 0 ? errors : run.error == null ? [] : [run.error],
      style: STYLE.error,
      hint: 'esc dismiss · the full engine log is on LOGS · r retries',
    };
  }

  if (run.status !== 'ok') return null;
  const lines = partialFailures(run);
  if (lines.length === 0) return null;

  return {
    kind: 'incomplete',
    title: `${run.command.toUpperCase()} — INCOMPLETE`,
    legend: [`${lines.length} produced no result`, ...tail].join(' · '),
    lines,
    style: STYLE.warn,
    // The part that matters and that a per-page error list does not say: the
    // report on screen was computed over what is left, so the numbers are for a
    // smaller universe than the one that was asked for.
    hint: 'esc dismiss · the numbers on this page exclude these',
  };
}

/** Kept as the narrow question the drawer used to answer: what will it print? */
export function errorLines(state: AppState): string[] {
  return runTrouble(state)?.lines ?? [];
}

/** Rows the drawer needs, so the frame can reserve them. */
export function errorHeight(state: AppState): number {
  const trouble = runTrouble(state);
  if (trouble == null) return 0;
  // Border, the lines (capped), and the footer.
  return Math.min(9, 3 + Math.max(1, trouble.lines.length));
}

/**
 * A failed run, stated where it happened.
 *
 * §8 says failures are surfaced rather than swallowed, and until now this one was
 * only half kept: the last error line went to the status strip, where it was
 * truncated to whatever space the hints left, and the rest sat in the engine log
 * on a page you had to know to open. A run that exits non-zero is the one thing
 * the user most needs to read, so it gets a drawer of its own over the bottom of
 * the frame: width is scarce and a permanent panel would cost columns even when
 * nothing has failed.
 *
 * It appears on its own, because an error you have to ask for is an error you
 * will miss, and it stays until `esc` — unlike the read-only overlays, which any
 * key dismisses.
 */
export function drawError(screen: Screen, state: AppState, offset = 0): void {
  const trouble = runTrouble(state);
  const height = errorHeight(state);
  if (trouble == null || height === 0) return;

  const rect: Rect = { x: 0, y: screen.rows - 2 - offset - height, w: screen.cols, h: height };
  clear(screen, rect);

  const inner = drawPane(screen, rect, {
    // `drawPane` supplies the ◆ for a focused pane; a second one here was a
    // stutter in the title.
    title: trouble.title,
    focused: true,
    legend: trouble.legend,
  });
  if (inner.h <= 0) return;

  const { lines } = trouble;
  const room = Math.max(1, inner.h - 1);
  // The tail, not the head: the last thing said before giving up is the thing
  // that explains it, and the last symbols to fail are the newest news.
  const shown = lines.slice(Math.max(0, lines.length - room));

  for (let i = 0; i < shown.length && i < room; i++) {
    screen.text(inner.x, inner.y + i, truncate(shown[i]!, inner.w), trouble.style, inner);
  }
  if (lines.length === 0) {
    screen.text(inner.x, inner.y, 'no error output — see the engine log', STYLE.muted, inner);
  }

  const hidden = lines.length - shown.length;
  const hint =
    hidden > 0
      ? `esc dismiss · ${hidden} more ${trouble.kind === 'failed' ? 'in the engine log (LOGS)' : 'not shown'}`
      : trouble.hint;
  screen.text(inner.x, inner.y + inner.h - 1, truncate(hint, inner.w), STYLE.muted, inner);
}
