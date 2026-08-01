/**
 * The editor's own state.
 *
 * It lives beside `AppState` rather than inside `state.ts` so the vim layer can
 * be exercised without an `App`, a page, or a terminal: a test builds an
 * `EditorState`, presses keys at it, and reads the buffer. `AppState` holds one
 * of these under `editor`.
 *
 * Deliberately **not** persisted. `.pinetop/flags.json` carries flags, and a
 * half-typed buffer restored from a previous session would be an unexplained
 * divergence from the file on disk — the same reasoning that keeps pending
 * parameter edits out of it (§4.5.c).
 */

import type { Cursor, EditorBuffer } from './buffer.js';

export type VimMode = 'normal' | 'insert' | 'visual' | 'visual-line' | 'command';

/** The unnamed register. `linewise` decides whether `p` puts above or inline. */
export interface Register {
  text: string[];
  linewise: boolean;
}

export interface EditorState {
  /** The open buffer, or null before a file has been picked. */
  buffer: EditorBuffer | null;
  mode: VimMode;
  /** The `:` / `/` / `?` line being typed, without its prefix. */
  cmdline: string;
  cmdPrefix: ':' | '/' | '?';
  /** Digits typed so far (`3` in `3dd`), as text so `30` is not `3` then `0`. */
  count: string;
  /** An operator waiting for a motion: `d`, `c`, `y`, `>`, `<`. */
  operator: string | null;
  /** A key waiting for an argument: `f` `F` `t` `T` `r` `g` `z`. */
  pending: string | null;
  /** The count that was in effect when `operator` / `pending` was set. */
  pendingCount: number;
  /** Where a visual selection started. */
  anchor: Cursor | null;
  register: Register;
  /** The last `/` or `?`, so `n` / `N` repeat it. */
  lastSearch: { needle: string; forward: boolean } | null;
  /** The line under the buffer: `-- INSERT --`, `"x.pine" 214L written`, errors. */
  message: string;
  /** True when `message` is a refusal, so the pane colours it as one. */
  error: boolean;
  /** `:set number` — the line-number gutter. On, because a stack trace cites lines. */
  gutter: boolean;
  /**
   * Text rows the buffer pane last had. `ctrl-d`, `ctrl-f` and `zz` are defined
   * in terms of the window, so the layer that moves the cursor has to know how
   * tall the window turned out to be; the renderer writes it each frame.
   */
  viewHeight: number;
}

export function initialEditor(): EditorState {
  return {
    buffer: null,
    mode: 'normal',
    cmdline: '',
    cmdPrefix: ':',
    count: '',
    operator: null,
    pending: null,
    pendingCount: 1,
    anchor: null,
    register: { text: [], linewise: false },
    lastSearch: null,
    message: '',
    error: false,
    gutter: true,
    viewHeight: 20,
  };
}

/** How the mode reads on the status line, in vim's own words. */
export function modeLabel(mode: VimMode): string {
  switch (mode) {
    case 'insert':
      return '-- INSERT --';
    case 'visual':
      return '-- VISUAL --';
    case 'visual-line':
      return '-- VISUAL LINE --';
    default:
      return '';
  }
}
