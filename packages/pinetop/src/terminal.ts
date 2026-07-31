/**
 * The TTY boundary: alternate screen, raw mode, cursor, resize, and key
 * decoding. Everything above this module works in characters and never touches
 * stdin/stdout directly.
 *
 * pinetop is a terminal program (§3 G5): the terminal owns the cell grid, so
 * unlike the HTML prototype we emit plain U+0020 for blanks and let the
 * emulator advance one cell per character (§4.3.c exempts a native TTY from the
 * uniform-braille-stream rule).
 */

/** A decoded keypress. `name` is normalized; `text` is set for printable keys. */
export interface Key {
  /**
   * One of: a single printable character, or a named key —
   * `up` `down` `left` `right` `enter` `escape` `tab` `shift-tab` `backspace`
   * `delete` `home` `end` `pageup` `pagedown`, or `ctrl-<letter>`.
   */
  name: string;
  /** The printable text this key produced, if any (never set for named keys). */
  text?: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

const ESC = '\x1b';

/** Named escape sequences, longest-match-first at decode time. */
const SEQUENCES = new Map<string, string>([
  ['\x1b[A', 'up'],
  ['\x1b[B', 'down'],
  ['\x1b[C', 'right'],
  ['\x1b[D', 'left'],
  ['\x1bOA', 'up'],
  ['\x1bOB', 'down'],
  ['\x1bOC', 'right'],
  ['\x1bOD', 'left'],
  ['\x1b[H', 'home'],
  ['\x1b[F', 'end'],
  ['\x1b[1~', 'home'],
  ['\x1b[4~', 'end'],
  ['\x1b[5~', 'pageup'],
  ['\x1b[6~', 'pagedown'],
  ['\x1b[3~', 'delete'],
  ['\x1b[Z', 'shift-tab'],
]);

/**
 * Decode one chunk of raw stdin into keys. A chunk can carry several keys (fast
 * typing, or a paste), so this returns a list rather than a single key.
 */
export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;

  while (i < chunk.length) {
    // Escape sequences first — longest match wins, so \x1b[1~ is not read as
    // \x1b[ followed by "1~".
    if (chunk[i] === ESC) {
      let matched = false;
      for (let len = 4; len >= 3; len--) {
        const candidate = chunk.slice(i, i + len);
        const name = SEQUENCES.get(candidate);
        if (name != null) {
          keys.push({ name });
          i += len;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      // A lone ESC (or an unrecognized sequence): report escape and skip the
      // rest of the CSI so its parameter bytes are not typed into a text field.
      keys.push({ name: 'escape' });
      i++;
      if (chunk[i] === '[' || chunk[i] === 'O') {
        i++;
        while (i < chunk.length && !/[A-Za-z~]/.test(chunk[i]!)) i++;
        if (i < chunk.length) i++;
      }
      continue;
    }

    const ch = chunk[i]!;
    const code = ch.charCodeAt(0);

    if (ch === '\r' || ch === '\n') keys.push({ name: 'enter' });
    else if (ch === '\t') keys.push({ name: 'tab' });
    else if (code === 127 || code === 8) keys.push({ name: 'backspace' });
    else if (code < 32) keys.push({ name: `ctrl-${String.fromCharCode(code + 96)}` });
    else keys.push({ name: ch, text: ch });
    i++;
  }

  return keys;
}

export interface TerminalOptions {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

/**
 * Owns the terminal for the lifetime of the app. `open()` switches to the
 * alternate screen and raw mode; `close()` always restores, including on a
 * crash or a signal, so a failed run never leaves the user's shell in raw mode.
 */
export class Terminal {
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly keyHandlers = new Set<(key: Key) => void>();
  private readonly resizeHandlers = new Set<(size: TerminalSize) => void>();
  private opened = false;
  /** False for one tick after `open()`, while a stale input backlog flushes. */
  private accepting = false;
  private onData?: (data: Buffer | string) => void;
  private onResize?: () => void;
  private onExit?: () => void;

  constructor(opts: TerminalOptions = {}) {
    this.stdin = opts.stdin ?? process.stdin;
    this.stdout = opts.stdout ?? process.stdout;
  }

  get size(): TerminalSize {
    return {
      cols: this.stdout.columns ?? 80,
      rows: this.stdout.rows ?? 24,
    };
  }

  get isTTY(): boolean {
    return this.stdout.isTTY === true && this.stdin.isTTY === true;
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;

    this.stdout.write('\x1b[?1049h'); // alternate screen
    this.stdout.write('\x1b[?25l'); // hide cursor
    this.stdout.write('\x1b[2J\x1b[H'); // clear, home

    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.setEncoding('utf8');

    // Input that arrived while we were not listening belongs to whatever owned the
    // terminal then — the shell before startup, or the editor `e` suspended us
    // for. `pause()` does not discard it and `resume()` flushes the backlog to the
    // next listener, which replayed a vim `:wq` into the keymap: `:` opens the
    // command palette and `wq` lands in its filter.
    //
    // The backlog is flushed on the nextTick that `resume()` schedules, so a gate
    // released on the following `setImmediate` drops exactly that and nothing
    // else. Deliberately NOT done by reading stdin here: a read on this handle is
    // a read on the terminal, and one issued on the way in can still be armed on
    // the way out — where it competes with the editor for the user's keystrokes.
    // Losing `:q` to that race is far worse than a stray palette.
    this.accepting = false;
    setImmediate(() => {
      this.accepting = true;
    });

    this.onData = (data) => {
      if (!this.accepting) return;
      for (const key of decodeKeys(String(data))) {
        for (const handler of [...this.keyHandlers]) handler(key);
      }
    };
    this.stdin.on('data', this.onData);

    this.onResize = () => {
      for (const handler of [...this.resizeHandlers]) handler(this.size);
    };
    this.stdout.on('resize', this.onResize);

    // Restore on the ways out that bypass close(): an uncaught throw, a signal.
    this.onExit = () => this.close();
    process.once('exit', this.onExit);
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;

    if (this.onData) this.stdin.off('data', this.onData);
    if (this.onResize) this.stdout.off('resize', this.onResize);
    if (this.onExit) process.off('exit', this.onExit);

    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();

    this.stdout.write('\x1b[?25h'); // show cursor
    this.stdout.write('\x1b[?1049l'); // leave alternate screen
  }

  onKey(handler: (key: Key) => void): () => void {
    this.keyHandlers.add(handler);
    return () => this.keyHandlers.delete(handler);
  }

  onResizeEvent(handler: (size: TerminalSize) => void): () => void {
    this.resizeHandlers.add(handler);
    return () => this.resizeHandlers.delete(handler);
  }

  /** Paint a full frame. Cursor home + per-line clear beats a full 2J erase,
   *  which flickers on every redraw. */
  paint(lines: string[]): void {
    let out = '\x1b[H';
    for (let i = 0; i < lines.length; i++) {
      out += `\x1b[${i + 1};1H\x1b[2K${lines[i]}`;
    }
    out += '\x1b[J'; // clear anything below the frame
    this.stdout.write(out);
  }
}
