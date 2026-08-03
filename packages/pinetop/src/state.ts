/**
 * AppState (§4.6).
 *
 * Two invariants this module exists to hold:
 *  - **Overrides are keyed by script**, so switching strategies cannot leak an
 *    edit from one into another.
 *  - **`run.report` is the parsed `--json` payload and the only source of
 *    numbers.** View models derive from it; nothing else may introduce a value.
 *
 * Config edits never auto-run (§4.6): a sweep can cost minutes, and a keystroke
 * should not spend them.
 */

import type { FlagModel, Override } from './flags/model.js';
import { emptyModel } from './flags/model.js';
import type { CommandId, PageId } from './flags/schema.js';
import { COMMANDS } from './flags/schema.js';
import type { EditorState } from './editor/state.js';
import { initialEditor } from './editor/state.js';
import type { LogLine } from './run/spawn.js';
import type { PineliveStatusListV1 } from './run/live-status.js';

export type RunStatus = 'idle' | 'running' | 'ok' | 'failed';

export interface RunState {
  id: string;
  command: CommandId;
  status: RunStatus;
  /** The engine's most recent narration line, shown in the status bar. */
  progress: string;
  /** The parsed `--json` payload. The only source of numbers on screen. */
  report?: unknown;
  log: LogLine[];
  elapsedMs?: number;
  error?: string;
  /** The process's exit status. `null` when it never started or was signalled. */
  exitCode?: number | null;
  argv: string[];
  startedAt: number;
  /**
   * The flags this run actually spawned with, overrides already merged.
   *
   * Kept so HISTORY can put a past run *and its config* back on screen together.
   * Restoring only the report would leave the config pane and the `$ pinerun …`
   * line describing a different invocation from the numbers beside them, and
   * §4.1.b calls exactly that a bug.
   */
  flags?: FlagModel;
  /**
   * Set once the user has dismissed this run's failure drawer. It lives on the
   * run rather than in `AppState` so a new run cannot inherit an acknowledgement
   * of an older one's error — the next failure announces itself.
   */
  errorDismissed?: boolean;
}

/** One AI turn: what was asked, what came back (§4.5.b). */
export interface AskTurn {
  question: string;
  answer: string;
  at: number;
}

export interface ProposalEdit {
  /** A real Pine `input()` title — never a display string (§4.5.e). */
  input: string;
  from: string;
  /** A bare value: `--input maxHoldH=18`, never `18 h`. */
  to: string;
  /** The human string, which never reaches argv. */
  display: string;
}

export interface Proposal {
  effect: string;
  note: string;
  edits: ProposalEdit[];
}

/** Returned instead of edits when a parameter change would be malpractice (§4.5.d). */
export interface AskAction {
  label: string;
  key: string;
}

export interface AskState {
  open: boolean;
  /** What the user is typing right now. */
  input: string;
  transcript: AskTurn[];
  pending: Proposal | null;
  action: AskAction | null;
  busy: boolean;
  error?: string;
}

export type OverlayKind = 'none' | 'help' | 'run' | 'palette' | 'filter' | 'welcome';

export interface Overlay {
  kind: OverlayKind;
  /** Free-text buffer for `palette` and `filter`. */
  buffer: string;
  /** Selected row inside the overlay. */
  cursor: number;
}

/**
 * A field being typed into, wherever it lives (§10.2).
 *
 * The design left "editing flags in place vs. a dialog" open, noting inline
 * editing "is faster but needs a text-input mode and an escape story". This is
 * that mode, shared by both surfaces: the config pane edits in place, the run
 * dialog edits the same rows through the same state, and `esc` always means
 * "abandon this field" before it means anything else.
 *
 * `index` addresses the command's rows the way the config pane numbers them:
 * the script paths first, then the visible flags.
 */
export interface EditState {
  command: CommandId;
  index: number;
  /** What has been typed so far. */
  buffer: string;
  /**
   * Where the edit was started, so `esc` and `↵` return focus there.
   *
   * `axis` is the third surface and the odd one: it edits a single `--input`
   * pair rather than a whole flag row. `--input` is repeatable, so the config
   * pane can only render it as one space-joined field — adding a second axis
   * meant retyping the first. On SWEEP's INPUTS pane each axis is its own row
   * with its own `↵`, and `index` is unused; `input` names the axis instead.
   */
  origin: 'config' | 'dialog' | 'axis';
  /** The Pine `input()` title this edit is an axis for (`origin: 'axis'`). */
  input?: string;
}

export interface PaneSelection {
  /** Focused pane id within the current page. */
  focus: string;
  /** Selected row per pane id. */
  cursor: Record<string, number>;
}

/** Dedicated, non-persisted state for the read-only Pinelive aggregate view. */
export interface LiveState {
  snapshot?: PineliveStatusListV1;
  selectedInstanceId?: string;
  /** Stable key for per-entry errors that do not carry a readable instance ID. */
  selectedItemKey?: string;
  lastSuccessAt?: string;
  inFlightGeneration?: number;
  error?: { code: string; message: string };
}

export interface AppState {
  page: PageId;
  /** Focus ring position and per-pane cursors, kept per page. */
  panes: Record<PageId, PaneSelection>;
  /** Poll snapshots are observational only and are never persisted with research flags. */
  live: LiveState;
  flags: Record<CommandId, FlagModel>;
  /** Keyed by script path, then by Pine input title (§4.6). */
  overrides: Record<string, Record<string, Override>>;
  run: RunState | null;
  /** Past runs this session, newest last, for COMPARE and the run picker. */
  history: RunState[];
  ask: AskState;
  overlay: Overlay;
  /** The field currently being typed into, in the pane or the dialog (§10.2). */
  edit: EditState | null;
  /**
   * The EDITOR page's buffer and vim mode. Not persisted — an unwritten buffer
   * restored from a previous session would be an unexplained divergence from the
   * file on disk, the same reason overrides are not persisted (§4.5.c).
   */
  editor: EditorState;
  /**
   * Reveal the rarely-touched flags (`--mintick`, `--data-dir`, the magnifier
   * overrides, …). Off by default so the config pane stays readable, but it must
   * be reachable: every flag has to be settable from the UI, or the user is back
   * to retyping the whole invocation in a shell — which is the friction §2 exists
   * to remove. One global toggle rather than per-pane, so the config pane and the
   * run dialog always number their rows the same way.
   */
  showAdvanced: boolean;
  /** Fill filter on the LOGS page (`/`). */
  tradeFilter: string;
  /** When a fill is selected, the log scopes to it; `esc` unscopes (§7 P4). */
  logScope: number | null;
  /** Set when the terminal is narrower than the current page's min-width. */
  widthWarning?: string;
  /**
   * Both halves of "what am I running": pinetop's own version, and the `pinerun`
   * it probed at startup. The second is not decoration — every number on screen
   * came out of that binary, so a stale one is a real explanation for a stale
   * number. Surfaced in the `?` overlay.
   */
  versions?: { pinetop: string; pinerun?: string };
  status: string;
  /** Set for one frame by an action that wants to say something. */
  flash?: string;
  quit: boolean;
}

export function initialPanes(): Record<PageId, PaneSelection> {
  const make = (focus: string): PaneSelection => ({ focus, cursor: {} });
  return {
    // EDITOR opens on FILES, not on the buffer. The buffer takes the whole
    // keyboard while it has focus — `1` there is a count, not page 1 — so
    // entering it is a deliberate `tab` or `↵`, never where you simply land.
    editor: make('files'),
    // Every command page opens on STRATEGIES, because picking the script is step
    // one on all of them — and because a pane that is in the same place and gets
    // focus at the same moment on six pages reads as one thing rather than six.
    backtest: make('strategies'),
    sweep: make('strategies'),
    walkforward: make('strategies'),
    scan: make('strategies'),
    portfolio: make('strategies'),
    compare: make('strategies'),
    logs: make('ledger'),
    live: make('runs'),
  };
}

export function initialState(flags?: Partial<Record<CommandId, FlagModel>>): AppState {
  const models = {} as Record<CommandId, FlagModel>;
  for (const command of COMMANDS) models[command] = flags?.[command] ?? emptyModel(command);

  return {
    page: 'backtest',
    panes: initialPanes(),
    live: {},
    flags: models,
    overrides: {},
    run: null,
    history: [],
    ask: { open: false, input: '', transcript: [], pending: null, action: null, busy: false },
    overlay: { kind: 'none', buffer: '', cursor: 0 },
    edit: null,
    editor: initialEditor(),
    showAdvanced: false,
    tradeFilter: '',
    logScope: null,
    status: 'idle',
    quit: false,
  };
}

/** The script an override set is keyed by: the first script of the page's command. */
export function scriptKey(state: AppState, command: CommandId): string {
  return state.flags[command].scripts[0] ?? '';
}

export function overridesFor(state: AppState, command: CommandId): Override[] {
  const key = scriptKey(state, command);
  if (key === '') return [];
  return Object.values(state.overrides[key] ?? {});
}

export function applyProposal(state: AppState, command: CommandId, proposal: Proposal): void {
  const key = scriptKey(state, command);
  if (key === '') return;
  const bucket = (state.overrides[key] ??= {});
  for (const edit of proposal.edits) {
    bucket[edit.input] = { input: edit.input, from: edit.from, to: edit.to };
  }
}

export function revertOverrides(state: AppState, command: CommandId): void {
  const key = scriptKey(state, command);
  if (key === '') return;
  delete state.overrides[key];
}

/** True when config has moved since the loaded run — the "not yet re-run" banner. */
export function isDirty(state: AppState, command: CommandId): boolean {
  return overridesFor(state, command).length > 0;
}

let runCounter = 0;

export function nextRunId(): string {
  runCounter += 1;
  return `#${400 + runCounter}`;
}

/** Test seam: reset the run counter so ids are deterministic. */
export function resetRunIds(): void {
  runCounter = 0;
}
