/**
 * The TERMINAL pane — a live shell in the frame.
 *
 * The pane owns three things the rest of the app does not have to know about:
 * blitting the emulator's grid into the cell grid, keeping the child's window
 * size reconciled with the rect it was given, and deciding which keystrokes are
 * the shell's and which are pinetop's.
 *
 * That last one is the whole design of this feature, and it is a departure from
 * the rule every other pane follows. A shell needs `ctrl-c`, `tab`, `space` and
 * `ctrl-p` — all four of which the app binds — so a pane that hands any of them
 * back is a pane you cannot use. So this one takes the keyboard completely, and
 * buys back one reserved control prefix plus a prompt-only shortcut:
 *
 *  - **`ctrl-t`** enters SCROLL/CONTROL mode and is reserved — the child never
 *    sees it. The mode is sticky rather than a one-shot prefix, because scrolling
 *    is repetitive by nature and re-arming a prefix for every line is the kind of
 *    friction that stops people using the scrollback at all. At a shell prompt
 *    `k j u d g G` move through xterm's retained history. A full-screen program
 *    has no such terminal history, so if it negotiated SGR mouse tracking
 *    `k j u d` become wheel gestures and the program scrolls its own content.
 *    `tab` advances to the next Pinetop pane, `shift-tab` moves to the previous
 *    pane, and `esc` or a second `ctrl-t` hands the keyboard back to the child.
 *
 *    A mode is a promise that keys mean something different, so it is stated on
 *    the border for as long as it lasts. It also falls out of the way: any key it
 *    does not define ends it *and reaches the child*, so resuming work costs
 *    nothing and no keystroke is lost — type `ls` while scrolled and you get `ls`,
 *    not `s`. The accepted cost is that a mistyped key ends the mode silently,
 *    which is the right way round for something you are in briefly.
 *  - **`esc`** returns to the frame too, *unless* the child is on the alternate
 *    screen — which is the signal that a full-screen program (vim, htop, less)
 *    is running and wants `esc` for itself. Without that carve-out `esc` would be
 *    swallowed before vim ever saw it; with it, the cheap exit still works at a
 *    shell prompt where `esc` does nothing anyway.
 *
 * The pane is entered with a bare `t` from the frame, or `ctrl-t` from the EDITOR
 * buffer where `t` is a motion. Once the shell has focus, `ctrl-t` is the control
 * prefix; `ctrl-t` then `tab`/`shift-tab` is the guaranteed path back to Pinetop.
 */

import { drawPane, type Rect, type Screen } from '../render/screen.js';
import { STYLE } from '../render/theme.js';
import type { PaneKey } from '../render/screen.js';
import type { TermSession } from './session.js';

/** The pane's id in the focus ring and the layout. */
export const TERMINAL_PANE = 'terminal';

/** The prefix that always reclaims the keyboard, even mid-full-screen app. */
export const ESCAPE_HATCH = 'ctrl-t';

/** The key that opens the pane from the frame, where a bare letter is free. */
export const TERMINAL_KEY = 't';

/** `ctrl-t` as the byte the raw input path actually sees (0x14). */
const ESCAPE_HATCH_BYTE = '\x14';
const ESC = '\x1b';

/** Focus-ring navigation, available after the reserved `ctrl-t` prefix. */
const TAB = '\t';
const SHIFT_TAB = '\x1b[Z';

/**
 * What each key does in SCROLL mode. Vim's motions where they exist, because this
 * pane sits beside a vim buffer and a second dialect on one page is one too many.
 */
const SCROLL_KEYS: Readonly<Record<string, (session: TermSession) => boolean>> = {
  k: (s) => s.scrollBy(-1),
  j: (s) => s.scrollBy(1),
  u: (s) => s.scrollByPage(-1),
  d: (s) => s.scrollByPage(1),
  g: (s) => s.scrollToTop(),
  G: (s) => s.scrollToBottom(),
};

/**
 * Alternate-screen programs have no emulator scrollback; when one negotiated SGR
 * mouse tracking, these commands become wheel gestures owned by the program.
 */
const APPLICATION_SCROLL_KEYS: Readonly<Record<string, (session: TermSession) => boolean>> = {
  k: (s) => s.scrollApplication(-1),
  j: (s) => s.scrollApplication(1),
  // A wheel detent commonly moves three rows. Send enough for approximately one
  // pane while leaving the exact movement to the full-screen application.
  u: (s) => s.scrollApplication(-Math.max(1, Math.ceil((s.rows - 1) / 3))),
  d: (s) => s.scrollApplication(Math.max(1, Math.ceil((s.rows - 1) / 3))),
};

/** One width command moves the outer pane by this many terminal columns. */
const TERMINAL_WIDTH_STEP = 4;

/** Widths computed by the last visible editor layout. */
export interface TerminalPaneWidth {
  automatic: number;
  minimum: number;
  maximum: number;
  rendered: number;
}

export interface TerminalPaneState {
  /**
   * Whether the pane exists at all. It is absent from the layout and the focus
   * ring when closed — a pane you cannot see should not be a `tab` stop.
   */
  open: boolean;
  /**
   * Whether the last frame actually drew the column — `open` *and* wide enough.
   *
   * The focus ring needs this and cannot measure the screen itself, and the
   * distinction is not cosmetic: this pane consumes every keystroke, so focus on a
   * column that was not drawn is a keyboard trap rather than a rendering glitch.
   */
  visible: boolean;
  session: TermSession | null;
  /**
   * User-selected outer pane width. Absent means the responsive default; keeping
   * it here makes the choice last for this Pinetop session without persisting it.
   */
  preferredWidth?: number;
  /**
   * Responsive default, bounds, and effective width from the last visible frame.
   * Raw input needs all four so coalesced commands behave like separate keypresses.
   */
  width?: TerminalPaneWidth;
  /**
   * The pane that had focus when the shell took it, restored on the way out.
   *
   * Leaving cannot simply go to the buffer. The buffer claims the whole keyboard,
   * so landing there turns every app shortcut into a vim command — `f` arms
   * find-char, `i` starts inserting into the Pine file. `state.ts` states the rule
   * this respects: entering the buffer is a deliberate `tab` or `↵`, never where
   * you merely end up. So the shell hands focus back where it took it from, and
   * you only return to the buffer if that is where you started.
   */
  returnTo: string;
  /**
   * SCROLL mode: the keyboard drives retained shell history, or asks a
   * mouse-aware full-screen child to move through the history it owns.
   *
   * Kept on the state rather than in a closure so the border can advertise it for as
   * long as it lasts. A mode nobody can see is a keyboard that has silently stopped
   * reaching the shell, which is the same reason pane accelerators are drawn on the
   * panes they focus.
   */
  scrolling?: boolean;
  /** Why a session could not start, shown in the pane instead of the grid. */
  error?: string;
}

/** Where focus goes when there is nothing better to restore. */
export const TERMINAL_DEFAULT_RETURN = 'files';

export function initialTerminalPane(): TerminalPaneState {
  return {
    open: false,
    visible: false,
    session: null,
    returnTo: TERMINAL_DEFAULT_RETURN,
  };
}

/**
 * What the raw input path decided to do with a chunk of stdin.
 *
 * `leave` is separate from `consumed` because focus is the app's state to
 * change, not this module's — it reports the verdict and the caller moves focus
 * and repaints.
 */
export type TerminalKeyVerdict =
  | { kind: 'sent' }
  | { kind: 'leave'; reason: 'hatch'; direction: 1 | -1 }
  | { kind: 'leave'; reason: 'escape' }
  /** Taken by the pane itself — arming the prefix, or scrolling. Repaint. */
  | { kind: 'pane' }
  | { kind: 'ignored' };

/**
 * Route one raw stdin chunk. Called only while the pane has focus.
 *
 * The chunk is matched whole rather than byte by byte, which is what makes a
 * lone `esc` distinguishable from an arrow key: a terminal delivers `\x1b[A` in
 * one chunk, so a chunk that is *exactly* `\x1b` was a real Escape keypress and
 * anything longer is a sequence the child should receive intact.
 */
export function routeRawKey(state: TerminalPaneState, chunk: string): TerminalKeyVerdict {
  const session = state.session;
  if (session == null) return { kind: 'ignored' };

  // A chunk is not a keystroke. Keys typed faster than the terminal drains, and
  // every pasted byte, arrive coalesced — so `ctrl-t g` can turn up as the single
  // chunk `\x14g`, and a held-down `j` as `jjjj`. Matching the chunk whole made the
  // mode work only when the reads happened to split it, which is most of the time
  // by hand and never under a paste. So the chunk is walked one key at a time.
  let rest = chunk;
  let took = false;
  let sent = false;
  let layoutChanged = false;
  const width = state.width;
  const clampWidth = (value: number): number =>
    width == null ? value : Math.min(width.maximum, Math.max(width.minimum, value));
  let workingWidth = width?.rendered ?? 0;
  let leaving: { reason: 'hatch'; direction: 1 | -1 } | { reason: 'escape' } | null = null;

  while (rest.length > 0 && leaving == null) {
    if (state.scrolling === true) {
      const key = nextKey(rest);
      rest = rest.slice(key.length);

      // Once the prefix has reclaimed the keyboard, Tab follows the same focus-ring
      // direction as every other pane. Keeping both directions here means a
      // full-screen child cannot trap focus without losing either Tab for itself.
      if (key === TAB || key === SHIFT_TAB) {
        state.scrolling = false;
        leaving = { reason: 'hatch', direction: key === TAB ? 1 : -1 };
        break;
      }
      if (key === ESCAPE_HATCH_BYTE || key === ESC) {
        // Back to the child, and back to the live view with it: leaving the mode
        // while still showing history would mean typing at output you cannot see.
        state.scrolling = false;
        session.scrollToBottom();
        took = true;
        continue;
      }
      if (key === '=') {
        state.preferredWidth = undefined;
        workingWidth = width?.automatic ?? workingWidth;
        layoutChanged = true;
        took = true;
        continue;
      }
      if (key === '<' || key === '>') {
        // Apply and clamp every byte as though it had rendered separately. Terminal
        // reads freely coalesce held keys, and chunk boundaries must not change the
        // final width — especially at a bound or after `=` rebases to the default.
        if (workingWidth > 0) {
          const delta = key === '<' ? -TERMINAL_WIDTH_STEP : TERMINAL_WIDTH_STEP;
          workingWidth = clampWidth(workingWidth + delta);
          state.preferredWidth = workingWidth;
        }
        layoutChanged = true;
        took = true;
        continue;
      }
      const scroll = SCROLL_KEYS[key];
      if (scroll != null) {
        const applicationScroll = APPLICATION_SCROLL_KEYS[key];
        if (session.applicationScrollAvailable === true && applicationScroll != null) {
          // An alternate buffer has no terminal history to move through. The
          // full-screen child owns that history, so deliver a wheel gesture and
          // wait for its redraw instead of repainting the same cells locally.
          if (applicationScroll(session)) sent = true;
          else took = true;
        } else {
          scroll(session);
          took = true;
        }
        continue;
      }
      // Undefined in this mode: the mode ends and the key goes through, so picking
      // up where you left off needs no deliberate exit. Dropping it instead would
      // eat the first character of whatever you were about to type.
      state.scrolling = false;
      session.scrollToBottom();
      if (session.running) {
        session.send(key);
        sent = true;
      } else {
        took = true;
      }
      continue;
    }

    const at = rest.indexOf(ESCAPE_HATCH_BYTE);
    if (at === -1) {
      // A chunk that is *exactly* one escape byte was the Escape key; anything
      // longer is a sequence (an arrow, a function key) the child should get whole.
      if (rest === ESC && !session.altScreen) {
        leaving = { reason: 'escape' };
        break;
      }
      if (!session.running) return took || sent ? { kind: 'pane' } : { kind: 'ignored' };
      session.send(rest);
      sent = true;
      break;
    }

    // Bytes ahead of `ctrl-t` are ordinary input and go to the child first, so
    // ordering within the chunk is preserved.
    const before = rest.slice(0, at);
    if (before !== '' && session.running) {
      session.send(before);
      sent = true;
    }
    // Entering is unconditional. A child that has wedged the terminal — raw mode,
    // mouse tracking on, alt screen — must not be able to take away the way out.
    state.scrolling = true;
    took = true;
    rest = rest.slice(at + 1);
  }

  if (leaving != null) return { kind: 'leave', ...leaving };
  // A width command needs a frame immediately: that frame computes the new layout
  // and resizes the child. This deliberately outranks sent bytes in a coalesced
  // chunk; the normal tick will still paint whatever response those bytes produce.
  if (layoutChanged) return { kind: 'pane' };
  // When bytes also went to the child the tick will paint anyway, so `sent` wins:
  // painting now would draw the grid as it was before the keystroke landed.
  if (sent) return { kind: 'sent' };
  if (took) return { kind: 'pane' };
  return { kind: 'ignored' };
}

/**
 * The next single keystroke at the head of a chunk.
 *
 * An escape sequence is one key, not one byte — `shift-tab` arrives as `\x1b[Z` and
 * taking it a byte at a time would read it as Escape followed by two letters, which
 * in this mode would leave the mode and then scroll.
 */
function nextKey(chunk: string): string {
  if (chunk[0] !== '\x1b' || chunk.length === 1) {
    return String.fromCodePoint(chunk.codePointAt(0)!);
  }
  const sequence = /^\x1b(\[[0-9;?]*[A-Za-z~]|O[A-Za-z]|.)/.exec(chunk);
  return sequence?.[0] ?? '\x1b';
}

export interface DrawTerminalOptions {
  focused: boolean;
  key: PaneKey | undefined;
}

/**
 * Draw the pane, and size the child to it.
 *
 * The resize happens here because this is the only place the interior rect is
 * known, and it is idempotent — `TermSession.resize` returns early when nothing
 * changed, so a repaint that did not move anything costs nothing. Same shape as
 * the EDITOR buffer publishing its `viewHeight` from inside its own draw.
 */
export function drawTerminal(
  screen: Screen,
  rect: Rect,
  state: TerminalPaneState,
  opts: DrawTerminalOptions,
): void {
  const session = state.session;

  const inner = drawPane(screen, rect, {
    title: 'TERMINAL',
    focused: opts.focused,
    key: opts.key,
    legend: legendFor(state, opts.focused),
  });
  if (inner.h <= 0 || inner.w <= 0) return;

  if (session == null) {
    const message = state.error ?? 'no shell running';
    screen.text(inner.x, inner.y, message, state.error != null ? STYLE.error : STYLE.muted, inner);
    if (state.error != null) {
      screen.text(inner.x, inner.y + 2, 'the rest of pinetop is unaffected', STYLE.muted, inner);
    }
    return;
  }

  session.resize(inner.h, inner.w);

  for (let row = 0; row < inner.h; row++) {
    for (let col = 0; col < inner.w; col++) {
      const cell = session.cellAt(col, row);
      screen.cell(inner.x + col, inner.y + row, cell.ch, cell.style, inner);
    }
  }

  // The child's cursor, drawn only when the pane has focus — an unfocused pane
  // showing a cursor would be claiming keystrokes it is not getting. Same
  // reasoning as the EDITOR buffer's styled cursor cell, and the same style, so
  // "where my typing goes" looks identical in both.
  if (opts.focused && session.running && session.atBottom && state.scrolling !== true) {
    const { x, y } = session.cursor;
    if (x >= 0 && x < inner.w && y >= 0 && y < inner.h) {
      const under = session.cellAt(x, y);
      screen.cell(inner.x + x, inner.y + y, under.ch === '' ? ' ' : under.ch, STYLE.cursor, inner);
    }
  }
}

/**
 * The top-border legend. It is the only place the two exits are advertised, and
 * which one it names depends on which one currently works — printing `esc` while
 * vim has it would be a lie about the keymap, which is the thing §4.2.h exists
 * to prevent.
 */
function legendFor(state: TerminalPaneState, focused: boolean): string | undefined {
  const session = state.session;
  if (session == null) return undefined;

  const exit = session.exitCode;
  if (exit != null) return exit === 0 ? 'exited' : `exited ${exit}`;

  if (state.scrolling === true) {
    // Alternate-screen history belongs to the child. A mouse-aware child redraws
    // after each synthetic wheel report, so there is no local line count to show.
    if (session.applicationScrollAvailable === true) return 'APP SCROLL';
    if (session.altScreen) return 'CONTROL';

    // Terse on purpose. The legend competes with the pane title for the top border
    // and is *dropped entirely* when it will not fit (`drawPane`), which for a mode
    // indicator is the worst possible failure — it disappears exactly when it is
    // load-bearing. The keys live on the hint strip, which is what that strip is for.
    const back = session.scrolledLines;
    return `SCROLL ${back > 0 ? `↑ ${back}` : 'live'}`;
  }

  // Scrolled away from the live bottom outranks everything else it could say: a
  // pane showing old output while the child keeps working looks frozen, and this
  // line is the only thing that distinguishes the two.
  const back = session.scrolledLines;
  if (back > 0) return `↑ ${back} · ${ESCAPE_HATCH} to scroll`;

  if (!focused) return `${session.cols}×${session.rows}`;
  if (!session.altScreen) return `esc leaves · ${ESCAPE_HATCH} then tab panes`;
  return session.applicationScrollAvailable === true
    ? `${ESCAPE_HATCH} app scroll · then tab panes`
    : `${ESCAPE_HATCH} control · then tab panes`;
}
