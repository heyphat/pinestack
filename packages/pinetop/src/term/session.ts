/**
 * A live shell, parsed into cells.
 *
 * `pty.ts` gets bytes out of a child; this turns those bytes into a grid the
 * frame can draw. The parsing is `@xterm/headless` — the same VT implementation
 * xterm.js ships, minus the DOM. Writing our own was the alternative and it is
 * the wrong trade: the interesting escape sequences are not the ones you think
 * of (they are DECSTBM scroll regions, DECAWM deferred wrap, the alt-screen
 * save/restore dance), they are exactly what full-screen programs lean on, and a
 * subtly wrong emulator shows up as a corrupted pane rather than a missing
 * feature. It is pure JavaScript, so it bundles into the compiled binary and the
 * single-binary install is untouched.
 *
 * The grid is read per frame rather than pushed: `poll()` drains the pty and
 * hands the bytes to the emulator, `cellAt` reads whatever the emulator settled
 * on. That keeps this module free of any opinion about when the frame repaints,
 * which is the app's business.
 */

import { Terminal as Emulator } from '@xterm/headless';
import type { Style } from '../render/theme.js';
import { spawnPty, type Pty, type PtySize } from './pty.js';

export interface TermSessionOptions {
  argv: readonly string[];
  cwd?: string;
  rows: number;
  cols: number;
}

export interface TermCell {
  /** The character, or `''` for the trailing half of a double-width glyph. */
  ch: string;
  style: Style;
}

/**
 * Keep `@xterm/headless` from writing to stderr.
 *
 * Its write queue schedules a timer whose duration comes out NaN under Bun,
 * which trips Node's `TimeoutNaNWarning`. The warning is harmless and fires once
 * — but the default handler prints it to **stderr**, and pinetop is sitting in
 * the alternate screen owning every cell. One stray line there corrupts the
 * frame until the next full repaint.
 *
 * Installed when the first session opens, because that is when the risk starts.
 * Warnings are counted rather than dropped silently so `--debug` has something
 * to report if one ever turns out to matter.
 */
let warningsSwallowed = 0;
let warningSinkInstalled = false;

function installWarningSink(): void {
  if (warningSinkInstalled) return;
  warningSinkInstalled = true;
  process.removeAllListeners('warning');
  process.on('warning', () => {
    warningsSwallowed++;
  });
}

export function swallowedWarningCount(): number {
  return warningsSwallowed;
}

export class TermSession {
  private readonly pty: Pty;
  private readonly emulator: Emulator;
  /** Emulator subscriptions to release on dispose. */
  private readonly subscriptions: { dispose(): void }[] = [];
  private size: PtySize;
  private changed = true;
  private closed = false;
  /** Set once the child is gone, so the pane can say so instead of looking idle. */
  private finishedWith: number | null = null;
  /**
   * The absolute buffer line drawn at the top of the pane, or null to follow the
   * live bottom.
   *
   * Absolute rather than an offset-from-bottom on purpose. The bottom moves every
   * time the child prints a line, so an offset would slide the view out from under
   * a reader mid-scroll; an absolute anchor keeps the same text on screen while
   * output continues underneath it.
   */
  private anchor: number | null = null;
  /** Alt-screen state as of the last poll, to spot the transition out of it. */
  private wasAltScreen = false;
  /** Whether the child selected SGR (1006) mouse reports. */
  private sgrMouse = false;

  constructor(opts: TermSessionOptions) {
    installWarningSink();
    const rows = Math.max(1, opts.rows);
    const cols = Math.max(1, opts.cols);
    this.size = { rows, cols };
    this.emulator = new Emulator({
      rows,
      cols,
      allowProposedApi: true,
      // Scrollback exists but is not reachable from the pane: the frame draws the
      // viewport and nothing else. A shell that has scrolled keeps its history
      // for the child's own sake (`clear`, a full-screen app restoring), not for
      // a scrollbar this app does not have.
      scrollback: 1000,
    });
    this.pty = spawnPty({ argv: opts.argv, cwd: opts.cwd, size: this.size });

    // Full-screen programs own their history rather than putting it in xterm's
    // normal scrollback. Modern TUIs can still be scrolled by a terminal wheel,
    // but a wheel report is only valid in the encoding the child negotiated.
    // Track SGR mouse mode (1006) alongside xterm's public tracking mode so the
    // pane can synthesize protocol-correct wheel gestures without guessing.
    for (const final of ['h', 'l']) {
      this.subscriptions.push(
        this.emulator.parser.registerCsiHandler({ prefix: '?', final }, (params) => {
          const modes = params.flatMap((value) => (Array.isArray(value) ? value : [value]));
          if (final === 'h' && modes.includes(1006)) this.sgrMouse = true;
          if (final === 'l' && (modes.includes(1006) || modes.includes(1049))) {
            this.sgrMouse = false;
          }
          // Observe only. Returning false lets xterm's built-in DECSET/DECRST
          // handler update the buffer and its public mode state as usual.
          return false;
        }),
      );
    }
    this.subscriptions.push(
      this.emulator.parser.registerEscHandler({ final: 'c' }, () => {
        // RIS resets every terminal mode, including the mouse protocol.
        this.sgrMouse = false;
        return false;
      }),
    );

    // The reply channel, and it is not optional.
    //
    // A terminal is not a one-way sink: programs *ask it questions* and block
    // until it answers. `\x1b[6n` asks where the cursor is, `\x1b[c` asks what the
    // terminal is, and capability probing on startup is how a modern TUI decides
    // what it may draw. The emulator knows all these answers and emits them
    // through `onData` — but nothing happens unless they are written back to the
    // child. Without this, `claude`, `nvim` and anything else that probes simply
    // hangs, waiting for a reply that is being computed and dropped on the floor.
    //
    // KNOWN LIMITATION, and it is a real one. A reply is addressed to the program
    // that asked, but there is no way here to check that it still is. `claude` polls
    // `\x1b[?6n` continuously and fires one last query shortly before exiting; the
    // answer, 1-2ms later, can arrive to find the shell in its place, which echoes it
    // and leaves `35;3R` sitting on the prompt — so the next command comes out as
    // `35;3Recho …` and `command not found: 35`. A hardware terminal answers in
    // microseconds and wins this race; software answering in milliseconds does not
    // always.
    //
    // Three signals were tried and none is sufficient: the pty's foreground process
    // group (it reports 0 forever — see below), flushing the write queue at the
    // hand-over (the successor can read first), and invalidating replies when the
    // alternate screen is torn down (the query can precede the teardown by more than
    // one poll). A fully addressable reply channel needs the slave to be the session's
    // controlling terminal. The detached spawn in `pty.ts` creates the session and,
    // critically, prevents the child from inheriting pinetop's outer terminal, but
    // adopting the slave would still require `TIOCSCTTY` — the variadic `ioctl` that
    // `pty.ts` documents as unusable on Apple arm64. With no controlling terminal
    // there is no job control, every job runs in the shell's own process group, and
    // `tcgetpgrp` cannot tell them apart.
    this.subscriptions.push(this.emulator.onData((data) => this.pty.write(data)));
    this.subscriptions.push(
      this.emulator.onBinary((data) => {
        // `onBinary` is Latin-1 bytes rather than UTF-8 text (xterm's own split),
        // so it must not be re-encoded on the way out.
        let out = '';
        for (let i = 0; i < data.length; i++) out += String.fromCharCode(data.charCodeAt(i) & 0xff);
        this.pty.write(out);
      }),
    );
  }

  /**
   * Move the child's output into the emulator. Returns true when the grid may
   * have changed and the frame is worth repainting.
   *
   * Also notices the child exiting, which is not something the pty reports as an
   * event — the exit code simply becomes non-null.
   */
  poll(): boolean {
    if (this.closed) return false;

    // A full-screen program leaving the alternate screen is one occupant of the pane
    // being replaced by another. Bytes written toward the child that it never read
    // would otherwise be read by its successor, so they are discarded here.
    //
    // This narrows a race it cannot close — see the note on query replies in the
    // constructor. It fires only on the transition, so it cannot eat steady-state
    // input.
    const altScreen = this.altScreen;
    if (this.wasAltScreen && !altScreen) this.pty.flushPendingWrites();
    this.wasAltScreen = altScreen;

    const data = this.pty.read();
    if (data !== '') {
      this.emulator.write(data, () => {
        this.changed = true;
      });
      this.changed = true;
    }

    if (this.finishedWith == null) {
      const code = this.pty.exitCode();
      if (code != null) {
        this.finishedWith = code;
        this.changed = true;
      }
    }

    const dirty = this.changed;
    this.changed = false;
    return dirty;
  }

  /**
   * Whether the program that asked is still the one listening.
   *
   * Unknown groups (-1, when the fd cannot be read) are treated as "still wanted":
   * a dropped reply is worse than a late one for any program that *is* waiting, and
   * this only ever aims to catch the unambiguous case of the asker having exited.
   */
  /** Send keystrokes to the child. Raw bytes — the pane does not interpret them. */
  send(data: string): void {
    if (this.closed || this.finishedWith != null) return;
    // Typing returns to the live view, the way every terminal behaves: input you
    // cannot see the result of is worse than losing your place in the history.
    this.scrollToBottom();
    this.pty.write(data);
  }

  // ————————————————————————————————————————————————————————————— scrollback

  /**
   * The top line of the live view — the anchor when following, and the ceiling any
   * anchor is clamped to.
   */
  private get liveTop(): number {
    return this.emulator.buffer.active.baseY;
  }

  /**
   * Lines of history above the live view.
   *
   * Zero on the alternate screen: a full-screen program owns every cell and keeps
   * no history, so there is nothing there to scroll back through. That is not a
   * limitation of this pane — it is what the alternate screen *is*, and real
   * terminals disable their scrollbars for it too.
   */
  get scrollbackLines(): number {
    return this.altScreen ? 0 : this.liveTop;
  }

  /** How far above the live bottom the view currently sits, in lines. */
  get scrolledLines(): number {
    if (this.anchor == null) return 0;
    return Math.max(0, this.liveTop - this.anchor);
  }

  get atBottom(): boolean {
    return this.scrolledLines === 0;
  }

  /**
   * Whether a full-screen child asked for SGR mouse reports and can therefore
   * receive synthetic wheel gestures from the pane's SCROLL mode.
   */
  get applicationScrollAvailable(): boolean {
    return (
      !this.closed &&
      this.finishedWith == null &&
      this.altScreen &&
      this.sgrMouse &&
      this.emulator.modes.mouseTrackingMode !== 'none'
    );
  }

  /**
   * Ask a full-screen child to scroll using SGR mouse-wheel reports.
   *
   * Negative steps move up and positive steps move down. Coordinates target the
   * middle of the pane rather than the prompt at its bottom, which matters to TUIs
   * with independently scrollable regions. The cap keeps a coalesced or malformed
   * input chunk from flooding the child with an unbounded report burst.
   */
  scrollApplication(steps: number): boolean {
    if (!this.applicationScrollAvailable || !Number.isFinite(steps) || steps === 0) return false;
    const count = Math.min(64, Math.max(1, Math.floor(Math.abs(steps))));
    const button = steps < 0 ? 64 : 65;
    const x = Math.max(1, Math.ceil(this.size.cols / 2));
    const y = Math.max(1, Math.ceil(this.size.rows / 2));
    this.pty.write(`\x1b[<${button};${x};${y}M`.repeat(count));
    return true;
  }

  /**
   * Move the view by `lines` (negative scrolls back into history).
   *
   * Returns true when the view actually moved, so a key that could not do anything
   * — already at the top, or on the alternate screen — can say so rather than
   * looking like it was dropped.
   */
  scrollBy(lines: number): boolean {
    if (this.closed || this.scrollbackLines === 0) return false;
    const from = this.anchor ?? this.liveTop;
    return this.scrollToLine(from + lines);
  }

  /** A page is the pane's height less one line of overlap, as `less` pages. */
  scrollByPage(pages: number): boolean {
    return this.scrollBy(pages * Math.max(1, this.size.rows - 1));
  }

  scrollToTop(): boolean {
    if (this.closed || this.scrollbackLines === 0) return false;
    return this.scrollToLine(0);
  }

  scrollToBottom(): boolean {
    if (this.anchor == null) return false;
    this.anchor = null;
    this.changed = true;
    return true;
  }

  private scrollToLine(line: number): boolean {
    const target = Math.max(0, Math.min(line, this.liveTop));
    // Landing on the live top is *following*, not anchoring there — otherwise the
    // view would silently stop tracking new output.
    const next = target >= this.liveTop ? null : target;
    if (next === this.anchor) return false;
    this.anchor = next;
    this.changed = true;
    return true;
  }

  resize(rows: number, cols: number): void {
    if (this.closed) return;
    const next = { rows: Math.max(1, rows), cols: Math.max(1, cols) };
    if (next.rows === this.size.rows && next.cols === this.size.cols) return;
    this.size = next;
    this.emulator.resize(next.cols, next.rows);
    this.pty.resize(next);
    this.changed = true;
  }

  get rows(): number {
    return this.size.rows;
  }

  get cols(): number {
    return this.size.cols;
  }

  /**
   * True while the child is on the alternate screen — which is the honest signal
   * for "a full-screen program is running in here". The key layer uses it to
   * decide who `esc` belongs to.
   */
  get altScreen(): boolean {
    return this.emulator.buffer.active.type === 'alternate';
  }

  /** The child's exit code once it has gone, else null. */
  get exitCode(): number | null {
    return this.finishedWith;
  }

  get running(): boolean {
    return !this.closed && this.finishedWith == null;
  }

  /** Where the child's cursor sits, in pane-relative cells. */
  get cursor(): { x: number; y: number } {
    const buffer = this.emulator.buffer.active;
    return { x: buffer.cursorX, y: buffer.cursorY };
  }

  /**
   * One cell of the visible viewport. Out-of-range reads come back blank rather
   * than throwing: the pane's rect and the emulator's size are reconciled on
   * resize, and a frame drawn in between must not crash the app.
   */
  cellAt(x: number, y: number): TermCell {
    const buffer = this.emulator.buffer.active;
    // Clamped on every read rather than on scroll: `baseY` grows as the child
    // prints, so an anchor that was valid can drift past the end of the history.
    const top =
      this.anchor == null ? buffer.baseY : Math.max(0, Math.min(this.anchor, buffer.baseY));
    const line = buffer.getLine(top + y);
    if (line == null) return { ch: ' ', style: '' };
    const cell = line.getCell(x);
    if (cell == null) return { ch: ' ', style: '' };

    // Width 0 is the trailing half of a double-width glyph. The leading cell
    // already carries the character and a terminal advances two columns for it,
    // so this cell must contribute nothing at all — a space here would shift the
    // rest of the row right by one.
    if (cell.getWidth() === 0) return { ch: '', style: '' };

    const chars = cell.getChars();
    return { ch: chars === '' ? ' ' : chars, style: cellStyle(cell) };
  }

  /**
   * Kill the child and release the pty. `SIGHUP` rather than `SIGKILL`: a shell
   * that gets a hangup runs its own exit path, which is what writes the history
   * file the user would otherwise lose.
   */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.subscriptions.length = 0;
    this.pty.kill('SIGHUP');
    this.pty.dispose();
    // `emulator.dispose()` is deliberately NOT called, and this is not laziness.
    //
    // `@xterm/headless`'s dispose never returns under Bun when its write queue still
    // holds un-parsed bytes — the queue is drained by a timer whose duration comes
    // out NaN here (the same defect behind the `TimeoutNaNWarning` above), so the
    // work it is waiting for never completes. Disposing a session immediately after
    // a burst of output therefore hangs, and `App.stop` disposes on quit, so this
    // was a hang between the user pressing `q` and pinetop exiting.
    //
    // Nothing leaks by skipping it. The emulator owns no OS resource — the pty does,
    // and that is closed above — and the only listeners attached to it are the two
    // reply subscriptions, already released. What is left is a JavaScript object with
    // no references to it, which is the garbage collector's business.
  }
}

/** The subset of `IBufferCell` this module reads. Narrowed so it can be faked in tests. */
export interface StyledCell {
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isInverse(): number;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  getFgColor(): number;
  getBgColor(): number;
}

/**
 * An emulator cell's attributes as an SGR body — the same shape as `STYLE`'s
 * entries, so a shell's colours land in the cell grid the way every other
 * pane's do and `Screen.render` coalesces them without knowing where they
 * came from.
 *
 * Palette colours are emitted as `38;5;N` across the whole range rather than
 * the `30`–`37` short forms. The long form is what the 256-colour cube needs
 * anyway, and one code path means the low eight cannot drift from the rest.
 */
export function cellStyle(cell: StyledCell): Style {
  const parts: string[] = [];
  if (cell.isBold()) parts.push('1');
  if (cell.isDim()) parts.push('2');
  if (cell.isItalic()) parts.push('3');
  if (cell.isUnderline()) parts.push('4');
  if (cell.isInverse()) parts.push('7');

  if (cell.isFgRGB()) {
    const rgb = cell.getFgColor();
    parts.push(`38;2;${(rgb >> 16) & 0xff};${(rgb >> 8) & 0xff};${rgb & 0xff}`);
  } else if (cell.isFgPalette()) {
    parts.push(`38;5;${cell.getFgColor()}`);
  }

  if (cell.isBgRGB()) {
    const rgb = cell.getBgColor();
    parts.push(`48;2;${(rgb >> 16) & 0xff};${(rgb >> 8) & 0xff};${rgb & 0xff}`);
  } else if (cell.isBgPalette()) {
    parts.push(`48;5;${cell.getBgColor()}`);
  }

  return parts.join(';');
}
