/**
 * The app: router, event loop, and the one place a run is started.
 *
 * Two rules this file exists to enforce:
 *  - **Nothing runs without an explicit keypress** (§4.6). Editing a flag never
 *    schedules a spawn; `r` then `↵` does.
 *  - **Nothing mutates config without a keypress** (§4.5.c). The Ask layer can
 *    propose; only `↵` applies, and `ctrl-x` rejects.
 */

import { drawFrame, widthWarning, windowTitle } from './frame.js';
import { composeArgv, validate, withOverrides, type FlagValue, type Pair } from './flags/model.js';
import { readInputTitles } from './flags/pine-inputs.js';
import { COMMANDS, schemaFor, type CommandId, type PageId } from './flags/schema.js';
import { discoverScripts } from './scripts.js';
import { resolve, type Action } from './keymap.js';
import {
  askHeight,
  drawAsk,
  drawFilter,
  drawHelp,
  drawPalette,
  drawRunDialog,
  drawWelcome,
  filterPalette,
  paletteItems,
} from './overlays.js';
import { backtestPage } from './pages/backtest.js';
import { comparePage } from './pages/compare.js';
import { firstUnmetRow, isRunRow, runRowCount, visibleFlags } from './pages/config-pane.js';
import { editorPage, ensureEditorFile } from './pages/editor.js';
import type { Page } from './pages/page.js';
import { clampCursor } from './pages/page.js';
import { portfolioPage } from './pages/portfolio.js';
import { refreshScripts } from './scripts.js';
import { scanPage } from './pages/scan.js';
import { selectedCombo, sweepPage } from './pages/sweep.js';
import { tradesPage } from './pages/trades.js';
import { walkforwardPage } from './pages/walkforward.js';
import { saveFlags } from './persist.js';
import { Screen } from './render/screen.js';
import { appendSession } from './run/session-log.js';
import { runPinerun, type SpawnOptions } from './run/spawn.js';
import type { AppState, RunState } from './state.js';
import { applyProposal, nextRunId, overridesFor, revertOverrides } from './state.js';
import { groundReport, parseAskResponse, type AskProvider } from './ask/protocol.js';
import type { Key, Terminal } from './terminal.js';

/** Said once before `q` will discard an unwritten editor buffer. */
const QUIT_WARNING = 'unwritten changes in the editor — :w to write, or q again to discard';

export const PAGE_MAP: Record<PageId, Page> = {
  editor: editorPage,
  backtest: backtestPage,
  sweep: sweepPage,
  walkforward: walkforwardPage,
  scan: scanPage,
  portfolio: portfolioPage,
  compare: comparePage,
  trades: tradesPage,
};

/**
 * Make a bare `pinetop` a usable starting point.
 *
 * Two things happen here and nothing else: a project with exactly one `.pine`
 * has it loaded (there is no other script it could have meant), and a project
 * with nothing configured at all gets the welcome overlay. Anything ambiguous
 * is left alone — guessing a symbol or a provider would put numbers on screen
 * that the user never asked for.
 *
 * Returns what it did, so the caller can report it in the status line.
 */
export function bootstrap(state: AppState, cwd = process.cwd()): string | undefined {
  const anythingConfigured = COMMANDS.some(
    (command) =>
      state.flags[command].scripts.length > 0 ||
      Object.values(state.flags[command].values).some((v) => v != null && v !== '' && v !== false),
  );

  const found = discoverScripts(cwd);
  let loaded: string | undefined;

  if (found.length === 1) {
    const only = found[0]!;
    for (const command of COMMANDS) {
      if (state.flags[command].scripts.length > 0) continue;
      const schema = schemaFor(command);
      // compare needs two scripts; one candidate cannot fill both sides, but
      // seeding side A still saves a keystroke.
      state.flags[command].scripts = schema.scripts === 2 ? [only.path] : [only.path];
    }
    loaded = only.label;
  }

  if (!anythingConfigured) {
    state.overlay = { kind: 'welcome', buffer: '', cursor: 0 };
  }

  if (loaded != null) return `loaded the only strategy here: ${loaded}`;
  if (found.length === 0) return 'no .pine found here — set a script in the config pane (↵)';
  return `${found.length} strategies found — tab to STRATEGIES and press ↵`;
}

export interface AppOptions {
  terminal: Terminal;
  state: AppState;
  cwd?: string;
  spawn?: SpawnOptions;
  ask?: AskProvider;
  /** Test seam: render once and return instead of listening for keys. */
  headless?: boolean;
}

export class App {
  private readonly terminal: Terminal;
  private readonly state: AppState;
  private readonly cwd: string;
  private readonly spawnOptions: SpawnOptions;
  private readonly provider?: AskProvider;
  private abort?: AbortController;
  private disposers: (() => void)[] = [];

  constructor(opts: AppOptions) {
    this.terminal = opts.terminal;
    this.state = opts.state;
    this.cwd = opts.cwd ?? process.cwd();
    this.spawnOptions = opts.spawn ?? {};
    this.provider = opts.ask;
  }

  get page(): Page {
    return PAGE_MAP[this.state.page];
  }

  /** Render one frame into a fresh screen and return its lines. */
  render(cols = this.terminal.size.cols, rows = this.terminal.size.rows): string[] {
    const screen = new Screen(cols, rows);
    const page = this.page;
    this.state.widthWarning = widthWarning(page, cols);

    const askRows = askHeight(this.state);
    const body = drawFrame(screen, this.state, page, askRows);

    const focus = this.focusId();
    page.render({
      state: this.state,
      screen,
      body,
      focus,
      cursor: (paneId) => this.state.panes[this.state.page].cursor[paneId] ?? 0,
    });

    if (this.state.widthWarning != null) {
      screen.text(1, body.y + body.h - 1, this.state.widthWarning, '33');
    }

    if (this.state.ask.open) {
      drawAsk(
        screen,
        this.state,
        this.provider?.label ?? 'no ask provider',
        this.provider?.remote ?? false,
      );
    }

    switch (this.state.overlay.kind) {
      case 'help':
        drawHelp(screen, this.state);
        break;
      case 'palette':
        drawPalette(screen, this.state);
        break;
      case 'filter':
        drawFilter(screen, this.state);
        break;
      case 'run': {
        const command = page.command;
        if (command != null) drawRunDialog(screen, this.state, command);
        break;
      }
      case 'welcome':
        drawWelcome(screen, this.state);
        break;
      default:
        break;
    }

    return screen.render();
  }

  paint(): void {
    this.terminal.paint(this.render());
  }

  start(): void {
    this.terminal.open();
    if (this.state.page === 'editor') ensureEditorFile(this.state);
    process.stdout.write(`\x1b]2;${windowTitle(this.state)}\x07`);
    this.disposers.push(this.terminal.onKey((key) => this.onKey(key)));
    this.disposers.push(this.terminal.onResizeEvent(() => this.paint()));
    this.paint();
  }

  stop(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.abort?.abort();
    saveFlags(this.state.flags, this.cwd);
    this.terminal.close();
  }

  private focusId(): string {
    const panes = this.page.panes(this.state);
    const current = this.state.panes[this.state.page].focus;
    return panes.includes(current) ? current : (panes[0] ?? '');
  }

  private moveFocus(delta: number): void {
    const panes = this.page.panes(this.state);
    if (panes.length === 0) return;
    const index = Math.max(0, panes.indexOf(this.focusId()));
    const next = (index + delta + panes.length) % panes.length;
    this.state.panes[this.state.page].focus = panes[next]!;
  }

  private moveCursor(delta: number): void {
    const paneId = this.focusId();
    const count = this.page.rowCount(this.state, paneId);
    const panes = this.state.panes[this.state.page];
    const current = panes.cursor[paneId] ?? 0;
    panes.cursor[paneId] = clampCursor(current + delta, count);
  }

  // ————————————————————————————————————————————————————————— key handling

  onKey(key: Key): void {
    // A field being typed into outranks everything (§10.2's "text-input mode"):
    // a `j` typed into --symbol is a `j`, not a cursor move, whether the field
    // lives in the config pane or in the run dialog.
    if (this.state.edit != null) {
      this.onEditKey(key);
      this.paint();
      return;
    }
    // Overlays and the Ask prompt own the keyboard while they are open.
    if (this.state.overlay.kind !== 'none') {
      this.onOverlayKey(key);
      this.paint();
      return;
    }
    if (this.state.ask.open && this.onAskKey(key)) {
      this.paint();
      return;
    }
    // A page may claim the keyboard before the global keymap. Exactly one does —
    // EDITOR, where `j` is a character and `1` is a count (see `Page.onKey`).
    if (this.page.onKey?.(this.state, key) === true) {
      this.paint();
      return;
    }

    const action = resolve(key.name);
    if (action != null) this.dispatch(action);
    this.paint();
  }

  /**
   * Keys while a field is open. This is the whole of the text-input mode and the
   * escape story §10.2 asked for: `↵` commits, `esc` abandons, and nothing else
   * can be reached from here — so a half-typed symbol can never be mistaken for
   * a keymap action, and cannot start a run.
   */
  private onEditKey(key: Key): void {
    const state = this.state;
    const edit = state.edit;
    if (edit == null) return;

    if (key.name === 'escape') {
      state.edit = null;
      state.status = 'edit cancelled';
      return;
    }
    if (key.name === 'enter') {
      this.commitField(edit.command, edit.index, edit.buffer);
      state.edit = null;
      return;
    }
    if (key.name === 'backspace') {
      edit.buffer = edit.buffer.slice(0, -1);
      return;
    }
    if (key.name === 'ctrl-u') {
      edit.buffer = '';
      return;
    }
    if (key.text != null) edit.buffer += key.text;
  }

  private dispatch(action: Action): void {
    const state = this.state;
    switch (action.kind) {
      case 'page':
        state.page = action.page;
        // Arriving at EDITOR with nothing open is a blank screen beside a project
        // full of scripts; open the loaded one (see `ensureEditorFile`).
        if (action.page === 'editor') ensureEditorFile(state);
        process.stdout.write(`\x1b]2;${windowTitle(state)}\x07`);
        break;
      case 'focus-next':
        this.moveFocus(1);
        break;
      case 'focus-prev':
        this.moveFocus(-1);
        break;
      case 'move':
        this.moveCursor(action.delta);
        break;
      case 'first':
        state.panes[state.page].cursor[this.focusId()] = 0;
        break;
      case 'last': {
        const paneId = this.focusId();
        state.panes[state.page].cursor[paneId] = Math.max(0, this.page.rowCount(state, paneId) - 1);
        break;
      }
      case 'confirm': {
        // A pending proposal is what ↵ means whenever one exists (§4.5.c).
        if (state.ask.pending != null) {
          this.applyPending();
          break;
        }
        // ↵ on the config pane edits that flag in place (§10.2), so the whole
        // invocation can be built inside the page without a dialog.
        const command = this.page.command;
        if (command != null && this.focusId() === 'config') {
          const index = state.panes[state.page].cursor['config'] ?? 0;
          this.beginEdit(command, index, 'config');
          break;
        }
        const status = this.page.confirm?.(state);
        if (status != null) state.status = status;
        break;
      }
      case 'run-dialog': {
        if (this.page.command == null) {
          state.status = 'TRADES has no command — it shows the loaded run';
          break;
        }
        this.openRunDialog(this.page.command);
        break;
      }
      case 'sweep-dialog':
        state.page = 'sweep';
        this.openRunDialog('sweep');
        break;
      case 'walkforward':
        this.handoffToWalkforward();
        break;
      case 'filter':
        state.overlay = { kind: 'filter', buffer: state.tradeFilter, cursor: 0 };
        break;
      case 'toggle-advanced':
        state.showAdvanced = !state.showAdvanced;
        state.status = state.showAdvanced
          ? 'showing every flag — . hides the advanced ones again'
          : 'advanced flags hidden';
        break;
      case 'ask':
        state.ask.open = true;
        state.ask.error = undefined;
        break;
      case 'palette':
        state.overlay = { kind: 'palette', buffer: '', cursor: 0 };
        break;
      case 'help':
        state.overlay = { kind: 'help', buffer: '', cursor: 0 };
        break;
      case 'escape':
        this.onEscape();
        break;
      case 'reject-proposal':
        if (state.ask.pending != null) {
          state.ask.pending = null;
          state.status = 'proposal rejected';
        } else if (this.page.command != null && overridesFor(state, this.page.command).length > 0) {
          revertOverrides(state, this.page.command);
          state.status = 'pending edits reverted';
        }
        break;
      case 'quit': {
        // An unwritten buffer must not leave on one keystroke. `q` says so once
        // and quits on the second, which is the same two-step `:q` / `:q!` gives
        // inside the editor.
        const buffer = state.editor.buffer;
        if (buffer?.modified === true && state.status !== QUIT_WARNING) {
          state.status = QUIT_WARNING;
          break;
        }
        state.quit = true;
        this.stop();
        break;
      }
    }
  }

  /**
   * Open the run dialog with the cursor where the user's attention belongs: on
   * the first unmet requirement when something is missing, and on the RUN row
   * when the invocation already validates — so `r` `↵` runs, and `r` on an
   * incomplete config lands on the field that is blocking it.
   */
  private openRunDialog(command: CommandId): void {
    const state = this.state;
    const model = withOverrides(state.flags[command], overridesFor(state, command));
    const problems = validate(model);
    state.overlay = {
      kind: 'run',
      buffer: '',
      cursor:
        problems.length === 0 ? runRowCount(state, command) - 1 : firstUnmetRow(state, command),
    };
  }

  /** `esc`: abandon a field · dismiss overlay · clear filter · unscope log. */
  private onEscape(): void {
    const state = this.state;
    if (state.edit != null) {
      state.edit = null;
      return;
    }
    if (state.overlay.kind !== 'none') {
      state.overlay = { kind: 'none', buffer: '', cursor: 0 };
      return;
    }
    if (state.ask.open) {
      state.ask.open = false;
      return;
    }
    if (state.logScope != null) {
      state.logScope = null;
      state.status = 'log unscoped';
      return;
    }
    if (state.tradeFilter !== '') {
      state.tradeFilter = '';
      state.status = 'filter cleared';
    }
  }

  private onOverlayKey(key: Key): void {
    const state = this.state;
    const overlay = state.overlay;

    if (key.name === 'escape') {
      if (overlay.kind === 'filter') {
        state.tradeFilter = '';
        state.logScope = null;
      }
      state.overlay = { kind: 'none', buffer: '', cursor: 0 };
      return;
    }

    switch (overlay.kind) {
      case 'help':
      case 'welcome':
        // Both are read-only: any key dismisses them.
        state.overlay = { kind: 'none', buffer: '', cursor: 0 };
        return;

      case 'filter':
        if (key.name === 'enter') {
          state.tradeFilter = overlay.buffer;
          state.logScope = null;
          state.overlay = { kind: 'none', buffer: '', cursor: 0 };
          return;
        }
        if (key.name === 'backspace') overlay.buffer = overlay.buffer.slice(0, -1);
        else if (key.text != null) overlay.buffer += key.text;
        return;

      case 'palette': {
        const items = filterPalette(paletteItems(), overlay.buffer);
        if (key.name === 'enter') {
          const item = items[Math.min(overlay.cursor, Math.max(0, items.length - 1))];
          state.overlay = { kind: 'none', buffer: '', cursor: 0 };
          if (item != null) {
            const status = item.run(state);
            if (status != null) state.status = status;
          }
          return;
        }
        if (key.name === 'down' || key.name === 'ctrl-n') overlay.cursor += 1;
        else if (key.name === 'up' || key.name === 'ctrl-p') overlay.cursor -= 1;
        else if (key.name === 'backspace') overlay.buffer = overlay.buffer.slice(0, -1);
        else if (key.text != null) overlay.buffer += key.text;
        overlay.cursor = clampCursor(overlay.cursor, items.length);
        return;
      }

      case 'run':
        this.onRunDialogKey(key);
        return;

      default:
        return;
    }
  }

  private onRunDialogKey(key: Key): void {
    const state = this.state;
    const overlay = state.overlay;
    const command = this.page.command;
    if (command == null) return;

    const total = runRowCount(state, command);

    if (key.name === 'enter') {
      // ↵ on the RUN row runs; on any field row it opens that field. So an
      // already-valid config is `r` then `↵`, and an incomplete one lands the
      // cursor on the blocking field instead.
      if (isRunRow(state, command, overlay.cursor)) {
        this.runFromDialog(command);
        return;
      }
      this.beginEdit(command, overlay.cursor, 'dialog');
      return;
    }
    if (key.name === 'r') {
      this.runFromDialog(command);
      return;
    }
    if (key.name === 'j' || key.name === 'down') overlay.cursor += 1;
    else if (key.name === 'k' || key.name === 'up') overlay.cursor -= 1;
    else if (key.name === 'g') overlay.cursor = 0;
    else if (key.name === 'G') overlay.cursor = total - 1;
    overlay.cursor = clampCursor(overlay.cursor, total);
  }

  /** Validate, then spawn. Refuses with the reason rather than failing a run. */
  private runFromDialog(command: CommandId): void {
    const state = this.state;
    const model = withOverrides(state.flags[command], overridesFor(state, command));
    const problems = validate(model);
    if (problems.length > 0) {
      state.status = problems[0]!;
      state.overlay.cursor = firstUnmetRow(state, command);
      return;
    }
    state.overlay = { kind: 'none', buffer: '', cursor: 0 };
    void this.run(command);
  }

  /**
   * Open a field for typing, or toggle it when there is nothing to type.
   *
   * `origin` records which surface asked, so the renderer draws the buffer in
   * the right place and `esc` returns the user where they were.
   */
  private beginEdit(command: CommandId, index: number, origin: 'config' | 'dialog'): void {
    const state = this.state;
    const schema = schemaFor(command);
    const flags = visibleFlags(state, command);
    const model = state.flags[command];

    if (index < schema.scripts) {
      state.edit = { command, index, buffer: model.scripts[index] ?? '', origin };
      return;
    }
    const spec = flags[index - schema.scripts];
    if (spec == null) return;

    // Booleans and tristates have nothing to type: ↵ cycles them in place.
    if (spec.kind === 'bool') {
      model.values[spec.name] = model.values[spec.name] === true ? undefined : true;
      state.status = `--${spec.name} ${model.values[spec.name] === true ? 'on' : 'off'}`;
      return;
    }
    if (spec.kind === 'tristate') {
      const current = model.values[spec.name];
      model.values[spec.name] = current === 'on' ? 'off' : current === 'off' ? undefined : 'on';
      const next = model.values[spec.name];
      state.status = `--${spec.name} ${next == null ? 'unset (script decides)' : String(next)}`;
      return;
    }

    const value = model.values[spec.name];
    state.edit = {
      command,
      index,
      origin,
      buffer:
        value == null
          ? ''
          : Array.isArray(value)
            ? (value as (string | Pair)[])
                .map((v) => (typeof v === 'string' ? v : `${v.name}=${v.value}`))
                .join(' ')
            : String(value),
    };
  }

  /** Parse a typed value back into the FlagModel according to the flag's kind. */
  private commitField(command: CommandId, index: number, raw: string): void {
    const state = this.state;
    const schema = schemaFor(command);
    const flags = visibleFlags(state, command);
    const model = state.flags[command];
    const text = raw.trim();

    if (index < schema.scripts) {
      const next = [...model.scripts];
      if (text === '') next.splice(index, 1);
      else next[index] = text;
      model.scripts = next.filter((s) => s !== '');
      refreshScripts();
      return;
    }

    const spec = flags[index - schema.scripts];
    if (spec == null) return;

    if (text === '') {
      model.values[spec.name] = undefined;
      return;
    }

    let value: FlagValue;
    switch (spec.kind) {
      case 'number': {
        const parsed = Number(text);
        if (!Number.isFinite(parsed)) {
          state.status = `--${spec.name} needs a number`;
          return;
        }
        value = parsed;
        break;
      }
      case 'list':
        value = text.split(/[,\s]+/).filter((s) => s !== '');
        break;
      case 'pairs': {
        const pairs: Pair[] = [];
        for (const token of text.split(/\s+/)) {
          const eq = token.indexOf('=');
          if (eq <= 0) continue;
          pairs.push({ name: token.slice(0, eq), value: token.slice(eq + 1) });
        }
        value = pairs;
        break;
      }
      default:
        value = text;
    }
    model.values[spec.name] = value;
  }

  // ————————————————————————————————————————————————————————————— running

  /**
   * Spawn one run. This is the only place in the app that starts a process, so
   * "did anything run?" is answerable by reading one function.
   */
  async run(command: CommandId): Promise<RunState> {
    const state = this.state;
    const model = withOverrides(state.flags[command], overridesFor(state, command));
    const argv = composeArgv(model, { json: true });

    this.abort?.abort();
    this.abort = new AbortController();

    const run: RunState = {
      id: nextRunId(),
      command,
      status: 'running',
      progress: '',
      log: [],
      argv,
      startedAt: Date.now(),
    };
    state.run = run;
    state.status = `running ${command}…`;
    this.paint();

    const outcome = await runPinerun(argv, {
      ...this.spawnOptions,
      cwd: this.cwd,
      signal: this.abort.signal,
      onLog: (line) => {
        run.log.push(line);
      },
      onProgress: (text) => {
        run.progress = text;
        this.paint();
      },
    });

    run.status = outcome.ok ? 'ok' : 'failed';
    run.report = outcome.report;
    run.log = outcome.log;
    run.elapsedMs = outcome.elapsedMs;
    run.error = outcome.error;
    run.progress = '';

    state.history.push(run);
    // A fresh report is the answer to the pending edits, so they are no longer
    // pending: the numbers on screen now include them (§4.5.c's dirty banner
    // exists precisely for the window between apply and re-run).
    if (outcome.ok) revertOverrides(state, command);

    appendSession(
      {
        at: new Date(run.startedAt).toISOString(),
        command,
        argv: outcome.argv,
        exitCode: outcome.exitCode,
        elapsedMs: outcome.elapsedMs,
        ok: outcome.ok,
        runId: run.id,
        error: outcome.error,
      },
      this.cwd,
    );

    state.status = outcome.ok ? `${command} ok` : (outcome.error ?? `${command} failed`);
    saveFlags(state.flags, this.cwd);
    this.paint();
    return run;
  }

  /**
   * `w` — the sweep → walkforward edge (§2, §3 G3). A swept winner is exactly
   * what walkforward exists to distrust, so this carries the axes over rather
   * than making the user retype the grid.
   */
  private handoffToWalkforward(): void {
    const state = this.state;
    if (state.page === 'sweep') {
      const sweepModel = state.flags.sweep;
      const wf = state.flags.walkforward;
      wf.scripts = [...sweepModel.scripts];
      for (const key of [
        'symbol',
        'tf',
        'from',
        'to',
        'limit',
        'input',
        'rank',
        'max-combos',
      ] as const) {
        const value = sweepModel.values[key];
        if (value != null) wf.values[key] = value;
      }
      const combo = selectedCombo(state);
      state.status =
        combo == null
          ? 'carried the sweep grid into WALKFORWARD — press r'
          : 'carried the sweep grid into WALKFORWARD — press r to validate it';
    }
    state.page = 'walkforward';
  }

  // ————————————————————————————————————————————————————————————— the drawer

  /** Returns true when the drawer consumed the key. */
  private onAskKey(key: Key): boolean {
    const state = this.state;

    if (key.name === 'escape') {
      state.ask.open = false;
      return true;
    }
    if (key.name === 'ctrl-x') {
      if (state.ask.pending != null) {
        state.ask.pending = null;
        state.status = 'proposal rejected';
      }
      return true;
    }
    if (key.name === 'enter') {
      if (state.ask.pending != null) {
        this.applyPending();
        return true;
      }
      const question = state.ask.input.trim();
      if (question === '') return true;
      state.ask.input = '';
      void this.ask(question);
      return true;
    }
    if (key.name === 'backspace') {
      state.ask.input = state.ask.input.slice(0, -1);
      return true;
    }
    if (key.text != null) {
      state.ask.input += key.text;
      return true;
    }
    return false;
  }

  private applyPending(): void {
    const state = this.state;
    const proposal = state.ask.pending;
    const command = this.page.command;
    if (proposal == null || command == null) return;
    applyProposal(state, command, proposal);
    state.ask.pending = null;
    state.status = `applied ${proposal.edits.length} edit(s) — not yet re-run`;
  }

  async ask(question: string): Promise<void> {
    const state = this.state;
    if (this.provider == null) {
      state.ask.error = 'no ask provider configured — pass one to the App (§9: opt-in)';
      this.paint();
      return;
    }

    const command = this.page.command;
    const model =
      command == null
        ? undefined
        : withOverrides(state.flags[command], overridesFor(state, command));
    const script = command == null ? undefined : state.flags[command].scripts[0];
    const titles = script == null ? [] : readInputTitles(script);

    state.ask.busy = true;
    state.ask.error = undefined;
    this.paint();

    try {
      const raw = await this.provider.ask(question, {
        command: command ?? 'trades',
        invocation: model == null ? '' : composeArgv(model).join(' '),
        report: groundReport(state.run?.report),
        inputTitles: titles,
      });
      const parsed = parseAskResponse(raw, titles);
      state.ask.busy = false;

      if (parsed.error != null || parsed.response == null) {
        state.ask.error = parsed.error ?? 'ask: empty response';
        this.paint();
        return;
      }
      state.ask.transcript.push({
        question,
        answer: parsed.response.answer,
        at: Date.now(),
      });
      state.ask.pending = parsed.response.proposal ?? null;
      state.ask.action = parsed.response.action ?? null;
      if (parsed.warnings.length > 0) state.ask.error = parsed.warnings.join(' · ');
    } catch (err) {
      state.ask.busy = false;
      state.ask.error = `ask failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.paint();
  }
}
