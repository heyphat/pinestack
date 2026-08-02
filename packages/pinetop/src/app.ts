/**
 * The app: router, event loop, and the one place a run is started.
 *
 * Two rules this file exists to enforce:
 *  - **Nothing runs without an explicit keypress** (§4.6). Editing a flag never
 *    schedules a spawn; `r` then `↵` does.
 *  - **Nothing mutates config without a keypress** (§4.5.c). The Ask layer can
 *    propose; only `↵` applies, and `ctrl-x` rejects.
 */

import { handOff } from './editor/handoff.js';
import { drawFrame, widthWarning, windowTitle } from './frame.js';
import {
  cloneModel,
  composeArgv,
  validate,
  withOverrides,
  type FlagValue,
  type Pair,
} from './flags/model.js';
import { readInputTitles } from './flags/pine-inputs.js';
import { COMMANDS, PAGES, schemaFor, type CommandId, type PageId } from './flags/schema.js';
import { discoverScripts } from './scripts.js';
import {
  matchSequence,
  paneAccelerators,
  paneForSequence,
  panesForPrefix,
  resolve,
  type Action,
} from './keymap.js';
import {
  askHeight,
  drawAsk,
  drawError,
  drawFilter,
  drawHelp,
  drawPalette,
  drawRunDialog,
  drawWelcome,
  errorHeight,
  filterPalette,
  paletteItems,
} from './overlays.js';
import { backtestPage } from './pages/backtest.js';
import { comparePage } from './pages/compare.js';
import { firstUnmetRow, isRunRow, runRowCount, visibleFlags } from './pages/config-pane.js';
import { editorPage, ensureEditorFile } from './pages/editor.js';
import { evictHistory } from './pages/history-pane.js';
import type { Page } from './pages/page.js';
import { clampCursor } from './pages/page.js';
import { portfolioPage } from './pages/portfolio.js';
import { refreshScripts } from './scripts.js';
import { scanPage } from './pages/scan.js';
import { selectedCombo, sweepPage } from './pages/sweep.js';
import { livePage, reconcileLiveSelection, selectLiveCursor } from './pages/live.js';
import { logsPage } from './pages/logs.js';
import { walkforwardPage } from './pages/walkforward.js';
import { saveFlags } from './persist.js';
import { Screen } from './render/screen.js';
import { appendSession } from './run/session-log.js';
import { runPinerun, type SpawnOptions } from './run/spawn.js';
import {
  LiveStatusPoller,
  type LiveStatusPollEvent,
  type LiveStatusPollerLike,
  type LiveStatusPollerOptions,
} from './run/live-status.js';
import type { AppState, EditState, RunState } from './state.js';
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
  logs: logsPage,
  live: livePage,
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

  if (!anythingConfigured && state.page !== 'live') {
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
  /** Options for the read-only Pinelive child poller; no process starts before `start()`. */
  live?: LiveStatusPollerOptions;
  /** Deterministic lifecycle/test seam for the LIVE status source. */
  livePoller?: LiveStatusPollerLike;
  /** Test seam: render once and return instead of listening for keys. */
  headless?: boolean;
}

export class App {
  private readonly terminal: Terminal;
  private readonly state: AppState;
  private readonly cwd: string;
  private readonly spawnOptions: SpawnOptions;
  private readonly provider?: AskProvider;
  private readonly livePoller: LiveStatusPollerLike;
  private liveUnsubscribe?: () => void;
  private liveGeneration = 0;
  private abort?: AbortController;
  private stopPromise?: Promise<void>;
  private disposers: (() => void)[] = [];
  /** `space` was pressed and the next digit picks a page (§4.2.f). */
  private pagePrefix = false;
  /** Letters typed so far toward a pane accelerator (§4.2.h). */
  private paneJump = '';

  constructor(opts: AppOptions) {
    this.terminal = opts.terminal;
    this.state = opts.state;
    this.cwd = opts.cwd ?? process.cwd();
    this.spawnOptions = opts.spawn ?? {};
    this.provider = opts.ask;
    this.livePoller =
      opts.livePoller ?? new LiveStatusPoller({ cwd: this.cwd, ...(opts.live ?? {}) });
  }

  get page(): Page {
    return PAGE_MAP[this.state.page];
  }

  /** Render one frame into a fresh screen and return its lines. */
  render(cols = this.terminal.size.cols, rows = this.terminal.size.rows): string[] {
    const screen = new Screen(cols, rows);
    const page = this.page;
    this.state.widthWarning = widthWarning(page, cols);

    // Both drawers displace the page rather than covering it: an error you have
    // to move something to read is an error you will misread.
    const askRows = askHeight(this.state);
    const errorRows = errorHeight(this.state);
    const body = drawFrame(screen, this.state, page, askRows + errorRows);

    const focus = this.focusId();
    const paneKeys = this.paneKeys();
    page.render({
      state: this.state,
      screen,
      body,
      focus,
      cursor: (paneId) => this.state.panes[this.state.page].cursor[paneId] ?? 0,
      paneKey: (paneId) => {
        const seq = paneKeys.get(paneId);
        if (seq == null) return undefined;
        return {
          seq,
          armed: this.paneJump !== '' && matchSequence(seq, this.paneJump) === 'partial',
        };
      },
    });

    if (this.state.widthWarning != null) {
      screen.text(1, body.y + body.h - 1, this.state.widthWarning, '33');
    }

    // Above the Ask drawer, which keeps the bottom row it has always had.
    drawError(screen, this.state, askRows);
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
        drawHelp(screen, this.state, paneKeys);
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
    if (this.state.page === 'live') this.livePoller.start();
    else this.livePoller.pause?.();
    this.terminal.paint(this.render());
  }

  start(): void {
    this.terminal.open();
    if (this.state.page === 'editor') ensureEditorFile(this.state);
    process.stdout.write(`\x1b]2;${windowTitle(this.state)}\x07`);
    this.disposers.push(this.terminal.onKey((key) => this.onKey(key)));
    this.disposers.push(this.terminal.onResizeEvent(() => this.paint()));
    this.liveUnsubscribe = this.livePoller.subscribe((event) => this.onLiveStatus(event));
    this.paint();
  }

  /** Stop input and work immediately, then await bounded LIVE child disposal before teardown. */
  stop(): Promise<void> {
    this.stopPromise ??= this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.liveUnsubscribe?.();
    this.liveUnsubscribe = undefined;
    this.abort?.abort();
    await this.livePoller.dispose();
    saveFlags(this.state.flags, this.cwd);
    this.terminal.close();
  }

  private onLiveStatus(event: LiveStatusPollEvent): void {
    if (event.generation < this.liveGeneration) return;
    this.liveGeneration = event.generation;
    if (event.type === 'started') {
      this.state.live.inFlightGeneration = event.generation;
    } else if (event.type === 'snapshot') {
      const previous = this.state.live.snapshot;
      this.state.live.snapshot = event.snapshot;
      this.state.live.lastSuccessAt = event.receivedAt;
      this.state.live.inFlightGeneration = undefined;
      this.state.live.error = undefined;
      reconcileLiveSelection(this.state, previous);
    } else {
      this.state.live.inFlightGeneration = undefined;
      this.state.live.error = event.error;
    }
    if (this.state.page === 'live') this.paint();
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

  /**
   * This page's pane accelerators (§4.2.h) — nothing while the page owns the
   * keyboard, because a badge on a pane whose key the EDITOR buffer is about to
   * eat would be a lie about what the key does.
   */
  private paneKeys(): Map<string, string> {
    const page = this.page;
    if (page.claimsKeyboard?.(this.state) === true) return new Map();
    return paneAccelerators(page.panes(this.state));
  }

  private moveCursor(delta: number): void {
    const paneId = this.focusId();
    const count = this.page.rowCount(this.state, paneId);
    const panes = this.state.panes[this.state.page];
    const current = panes.cursor[paneId] ?? 0;
    panes.cursor[paneId] = clampCursor(current + delta, count);
    if (this.state.page === 'live' && paneId === 'runs')
      selectLiveCursor(this.state, panes.cursor[paneId]);
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
    // An armed `space` outranks the page, so `space 3` reaches page 3 even inside
    // the EDITOR buffer, where a bare `3` is a vim count. This is what lets one
    // page-switch binding hold everywhere instead of the buffer needing its own.
    if (this.pagePrefix) {
      this.pagePrefix = false;
      const ordinal = /^[1-9]$/.test(key.name) ? Number.parseInt(key.name, 10) : 0;
      const page = PAGES[ordinal - 1];
      if (page != null) {
        this.dispatch({ kind: 'page', page });
        this.paint();
        return;
      }
      // Not a page digit: the prefix is abandoned and the key means what it
      // normally means, rather than being swallowed.
      this.state.status = 'page switch cancelled';
    }
    // A page may claim the keyboard before the global keymap. Exactly one does —
    // EDITOR, where `j` is a character and `1` is a count (see `Page.onKey`).
    if (this.page.onKey?.(this.state, key) === true) {
      this.paint();
      return;
    }
    // A pane accelerator (§4.2.h). It has to come after the page's own keys, so
    // the EDITOR buffer keeps every letter it needs. Whether it comes before or
    // after `resolve` makes no difference: the accelerators are derived from the
    // keys the global keymap has *not* claimed, so neither can shadow the other.
    if (this.onPaneKey(key)) {
      this.paint();
      return;
    }

    const action = resolve(key.name);
    if (action != null) this.dispatch(action);
    this.paint();
  }

  /**
   * A pane accelerator, or the first letter of one (§4.2.h).
   *
   * Returns true when the key was spent here — either focusing a pane or arming a
   * two-letter sequence. A key that can neither complete nor continue a sequence
   * is *tried as the start of a new one* before being handed back to the keymap,
   * so `co` typed on a page with no `co…` pane still reaches `c…`, and the ordinary
   * meaning of a key is never lost to a stale prefix.
   */
  private onPaneKey(key: Key): boolean {
    const state = this.state;
    const armed = this.paneJump;
    const keys = this.paneKeys();

    if (armed !== '' && (key.name === 'escape' || keys.size === 0)) {
      this.paneJump = '';
      state.status = 'pane jump cancelled';
      // `esc` was spent on the jump; anything else falls through to mean what it
      // normally means, exactly as an abandoned `space` prefix does.
      return key.name === 'escape';
    }
    if (keys.size === 0) return false;
    if (!/^[A-Za-z]$/.test(key.name)) {
      if (armed === '') return false;
      this.paneJump = '';
      state.status = 'pane jump cancelled';
      return false;
    }

    for (const typed of armed === '' ? [key.name] : [armed + key.name, key.name]) {
      const paneId = paneForSequence(keys, typed);
      if (paneId != null) {
        this.paneJump = '';
        state.panes[state.page].focus = paneId;
        state.status = `${paneId.toUpperCase()} focused`;
        return true;
      }
      const candidates = panesForPrefix(keys, typed);
      if (candidates.length > 0) {
        this.paneJump = typed;
        state.status = `pane ${typed}… · ${candidates
          .map((id) => `${keys.get(id)!} ${id}`)
          .join(' · ')}`;
        return true;
      }
    }

    if (armed !== '') {
      this.paneJump = '';
      state.status = 'pane jump cancelled';
    }
    return false;
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
      this.commitField(edit);
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
        // Pane accelerators are per page (§4.2.h), so a half-typed one does not
        // travel to a page where its letters mean something else.
        this.paneJump = '';
        // Arriving at EDITOR with nothing open is a blank screen beside a project
        // full of scripts; open the loaded one (see `ensureEditorFile`).
        if (action.page === 'editor') ensureEditorFile(state);
        process.stdout.write(`\x1b]2;${windowTitle(state)}\x07`);
        break;
      case 'page-prefix':
        this.pagePrefix = true;
        state.status = `page 1–${PAGES.length}…`;
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
      case 'first': {
        const paneId = this.focusId();
        state.panes[state.page].cursor[paneId] = 0;
        if (state.page === 'live' && paneId === 'runs') selectLiveCursor(state, 0);
        break;
      }
      case 'last': {
        const paneId = this.focusId();
        const cursor = Math.max(0, this.page.rowCount(state, paneId) - 1);
        state.panes[state.page].cursor[paneId] = cursor;
        if (state.page === 'live' && paneId === 'runs') selectLiveCursor(state, cursor);
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
          state.status =
            state.page === 'live'
              ? 'LIVE is read-only — it cannot launch or control Pinelive'
              : 'LOGS has no command — it shows the loaded research run';
          break;
        }
        this.openRunDialog(this.page.command);
        break;
      }
      case 'walkforward':
        this.handoffToWalkforward();
        break;
      case 'edit-external':
        if (state.page === 'live') {
          state.status = 'LIVE is read-only — no research script is attached to this view';
          break;
        }
        // The frame is torn down and rebuilt inside `handOff`, so the title bar
        // has to be reclaimed: the editor will have set its own (§4.8.g).
        state.status = handOff(state, this.terminal, this.cwd);
        process.stdout.write(`\x1b]2;${windowTitle(state)}\x07`);
        break;
      case 'filter':
        if (state.page !== 'logs') {
          state.status =
            state.page === 'live' ? 'LIVE has no mutable filter' : 'fill filtering is on LOGS';
          break;
        }
        state.overlay = { kind: 'filter', buffer: state.tradeFilter, cursor: 0 };
        break;
      case 'toggle-advanced':
        state.showAdvanced = !state.showAdvanced;
        state.status = state.showAdvanced
          ? 'showing every flag — . hides the advanced ones again'
          : 'advanced flags hidden';
        break;
      case 'ask':
        if (state.page === 'live') {
          state.status = 'LIVE is read-only — Ask does not receive Pinelive operational evidence';
          break;
        }
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
    if (state.page === 'live' && state.panes.live.focus === 'detail') {
      state.panes.live.focus = 'runs';
      state.status = 'LIVE run list';
      return;
    }
    // The failure drawer outranks the filter and the log scope: it is the newest
    // thing on screen and the one `esc` most likely meant.
    if (errorHeight(state) > 0 && state.run != null) {
      state.run.errorDismissed = true;
      state.status = 'dismissed — the engine log is on LOGS';
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
            // An item may name a keymap action instead of mutating state, which
            // is how the palette reaches the things that need the App itself —
            // the run dialog, the $EDITOR hand-off.
            if (item.action != null) this.dispatch(item.action);
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

  /**
   * One swept axis, committed on its own.
   *
   * An empty value removes the axis, which is what makes the INPUTS row a toggle:
   * `↵` on a swept input opens its grid, and clearing it drops the input from the
   * run. Nothing else in the model is touched, so the other axes survive — the
   * whole point of editing them one at a time.
   */
  private commitAxis(command: CommandId, name: string, spec: string): void {
    const model = this.state.flags[command];
    const key = command === 'compare' ? 'input-a' : 'input';
    const pairs = [...((model.values[key] as Pair[] | undefined) ?? [])];
    const at = pairs.findIndex((pair) => pair.name === name);

    if (spec === '') {
      if (at < 0) return;
      pairs.splice(at, 1);
    } else if (at >= 0) {
      pairs[at] = { name, value: spec };
    } else {
      pairs.push({ name, value: spec });
    }

    model.values[key] = pairs.length > 0 ? pairs : undefined;
    this.state.status =
      spec === ''
        ? `${name} dropped from the grid`
        : `${name} = ${spec} · ${pairs.length} ${pairs.length === 1 ? 'axis' : 'axes'}`;
  }

  /** Parse a typed value back into the FlagModel according to the flag's kind. */
  private commitField(edit: EditState): void {
    const state = this.state;
    const { command, index } = edit;
    const text = edit.buffer.trim();

    if (edit.origin === 'axis') {
      if (edit.input != null) this.commitAxis(command, edit.input, text);
      return;
    }

    const schema = schemaFor(command);
    const flags = visibleFlags(state, command);
    const model = state.flags[command];

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
      // Snapshot what is being spawned, so HISTORY can restore this run's config
      // alongside its report rather than showing one beside the other's numbers.
      flags: cloneModel(model),
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
    run.exitCode = outcome.exitCode;
    run.progress = '';

    state.history.push(run);
    // A RunState holds a whole report; keeping every run of a long session is a
    // leak, and HISTORY exists to encourage keeping them (§10.3).
    evictHistory(state, command);
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
   * The sweep → walkforward edge (§2, §3 G3). A swept winner is exactly what
   * walkforward exists to distrust, so this carries the axes over rather than
   * making the user retype the grid.
   *
   * Reached from the palette rather than from `w`: a letter that switched page was
   * the one exception to "pages are ordinals" (§4.2.i), and this was never only a
   * page switch — it writes walkforward's config, which is worth asking for by
   * name. From anywhere but SWEEP there is no grid to carry, and it says so
   * instead of pretending it moved something.
   */
  private handoffToWalkforward(): void {
    const state = this.state;
    if (state.page !== 'sweep') {
      state.status = 'no sweep grid to carry — build one on SWEEP first';
    } else {
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
    if (state.page === 'live') {
      state.ask.error = 'LIVE is read-only — operational evidence is not sent to Ask providers';
      state.ask.open = false;
      state.status = state.ask.error;
      this.paint();
      return;
    }
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
        command: command ?? state.page,
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
