/**
 * `e` — hand the script to the user's real editor.
 *
 * The in-frame buffer (§4.8) is a deliberate subset: it exists so a one-line
 * tweak keeps the report and the INPUTS outline beside it. Anything that wants a
 * `.vimrc`, a plugin, `.` repeat or `:%s///` wants the actual binary, and the
 * honest way to provide that is to get out of the way — suspend the frame, give
 * the terminal to `$EDITOR`, and take it back when it exits.
 *
 * What this cannot do is run the editor *inside* a pane. That needs a pty plus a
 * terminal emulator to parse the editor's escape output into pinetop's cell grid,
 * and the pty means a native module — which would end the self-contained
 * single-binary build the installer depends on. So the frame goes away for the
 * duration, and comes back after. That is the whole trade.
 *
 * The two seams here — the launcher and `Suspendable` — exist so this is testable
 * without a TTY or a real editor. Same reasoning as `EditorIo`.
 */

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { isCommandPage } from '../flags/schema.js';
import { cachedScripts, refreshScripts } from '../scripts.js';
import type { AppState } from '../state.js';
import { editorIo, type EditorIo } from './io.js';
import { openFile } from './vim.js';

/** The two halves of the TTY boundary a hand-off needs. `Terminal` satisfies it. */
export interface Suspendable {
  close(): void;
  open(): void;
}

export interface LaunchResult {
  ok: boolean;
  /** Why it failed: not found, a signal, a non-zero exit. */
  error?: string;
}

export type Launcher = (command: string, args: readonly string[], cwd: string) => LaunchResult;

/**
 * The real thing: inherit stdio so the editor gets the actual terminal — its own
 * colours, its own alternate screen, its own raw mode. Synchronous on purpose;
 * pinetop is suspended and has nothing to do until the editor exits.
 */
export const spawnLauncher: Launcher = (command, args, cwd) => {
  const result = spawnSync(command, [...args], { stdio: 'inherit', cwd });
  if (result.error != null) return { ok: false, error: result.error.message };
  if (result.signal != null) return { ok: false, error: `killed by ${result.signal}` };
  if (result.status != null && result.status !== 0) {
    return { ok: false, error: `exited ${result.status}` };
  }
  return { ok: true };
};

let current: Launcher = spawnLauncher;

export function launcher(): Launcher {
  return current;
}

/** Test seam: swap the process launcher. Pass no argument to restore the real one. */
export function setLauncher(next: Launcher = spawnLauncher): void {
  current = next;
}

/**
 * `$VISUAL` wins over `$EDITOR` — that is the convention's own split, and a
 * full-screen editor is exactly what `VISUAL` is for. Falling back to `vim`
 * rather than refusing keeps the key useful on a machine where neither is set.
 *
 * The spec is split on whitespace so `EDITOR="nvim -u NONE"` works. It is not run
 * through a shell, deliberately — nothing here should be able to interpret `;` or
 * `$(…)` out of an environment variable. The cost is that an argument containing
 * spaces cannot be expressed; point `$EDITOR` at a wrapper script for that.
 */
export function resolveEditor(env: Record<string, string | undefined> = process.env): {
  command: string;
  args: string[];
} {
  const spec = (env['VISUAL'] ?? env['EDITOR'] ?? '').trim();
  const [command = 'vim', ...args] = spec === '' ? ['vim'] : spec.split(/\s+/);
  return { command, args };
}

/**
 * Editors that understand vi's `+<line>`. Anything else gets the path alone —
 * `code +42 file` would open a file named `+42`, which is worse than losing the
 * cursor position.
 */
const PLUS_LINE = new Set(['vi', 'vim', 'nvim', 'view', 'nano', 'emacs', 'kak', 'joe', 'ne']);

/**
 * Which file `e` edits.
 *
 * The page you are on decides, because that is what you were looking at: from a
 * command page it is that command's script ("edit the strategy I am running"),
 * and from EDITOR or TRADES it is the open buffer. Discovery is the last resort,
 * so `e` in a fresh project still does something.
 */
export function pathToEdit(state: AppState): string | undefined {
  if (isCommandPage(state.page)) {
    const script = state.flags[state.page].scripts[0];
    if (script != null && script !== '') return script;
  }
  const open = state.editor.buffer?.path;
  if (open != null && open !== '') return open;
  const loaded = state.flags.backtest.scripts[0];
  if (loaded != null && loaded !== '') return loaded;
  return cachedScripts()[0]?.path;
}

/**
 * Suspend, edit, resume. Returns the status line.
 *
 * Refuses when the in-frame buffer holds unwritten changes to the *same* file:
 * the editor would open the older version on disk and one of the two would lose.
 * That is the same answer `:e` and `:q` give, for the same reason (§4.5.c). An
 * unwritten buffer for some *other* file is left untouched and is not in the way.
 */
export function handOff(
  state: AppState,
  terminal: Suspendable,
  cwd: string = process.cwd(),
  run: Launcher = launcher(),
  io: EditorIo = editorIo(),
): string {
  const path = pathToEdit(state);
  if (path == null || path === '') {
    return 'no script to edit — pick one in FILES, or :e path.pine';
  }

  const buffer = state.editor.buffer;
  const open = buffer != null && buffer.path === path ? buffer : null;
  if (open?.modified === true) {
    return `unwritten changes in ${path} — :w first, or ${path} on disk would win`;
  }

  const { command, args } = resolveEditor();
  const argv = [...args];
  if (PLUS_LINE.has(basename(command))) argv.push(`+${(open?.line ?? 0) + 1}`);
  argv.push(path);

  const at = open?.line ?? 0;
  let result: LaunchResult;
  terminal.close();
  try {
    result = run(command, argv, cwd);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    // Whatever happened, the frame comes back. A throw here must not strand the
    // user outside the alternate screen with raw mode off.
    terminal.open();
  }

  // `Terminal.open` discards input typed while the editor owned the terminal, so
  // a `:wq` cannot be replayed into the keymap. This closes the residual race on
  // a byte that lands between the discard and the listener: no overlay can be
  // open when `e` is dispatched, so any overlay found here was opened by one.
  state.overlay = { kind: 'none', buffer: '', cursor: 0 };

  // The file may be new, or may have been renamed under us.
  refreshScripts();

  // Reload only what was handed over, so an unwritten buffer for another file
  // survives. The cursor returns to the line it left — pinetop cannot learn
  // where the editor actually left it, and guessing would be worse than this.
  if (open != null || buffer == null) {
    openFile(state.editor, path, io);
    const reloaded = state.editor.buffer;
    if (reloaded != null) reloaded.line = Math.min(at, reloaded.lines.length - 1);
  }

  if (!result.ok) return `${command}: ${result.error ?? 'failed'}`;
  return `back from ${command} — ${path} reloaded, press r to re-run`;
}
