/**
 * The shell pane.
 *
 * Two halves, tested differently. The key routing and the cell/style mapping are
 * pure and get ordinary unit tests. The pty is not pure — it needs a libc, a
 * `stty` and a real child — so it gets one integration test that skips itself
 * where a pty cannot be had, rather than being mocked into agreement with
 * itself.
 */

import { describe, expect, test } from 'bun:test';
import { App } from '../src/app.js';
import type { AppState } from '../src/state.js';
import { Screen, stripAnsi } from '../src/render/screen.js';
import { editorPage, TERMINAL_MIN_BODY, terminalVisible } from '../src/pages/editor.js';
import { initialState } from '../src/state.js';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFile, syncWithDisk, writeFile } from '../src/editor/vim.js';

import { decodeKeys, Terminal, type Key, type TerminalSize } from '../src/terminal.js';
import { cellStyle, TermSession, type StyledCell } from '../src/term/session.js';
import {
  drawTerminal,
  ESCAPE_HATCH,
  initialTerminalPane,
  routeRawKey,
  TERMINAL_PANE,
  type TerminalPaneState,
} from '../src/term/pane.js';

/** A Terminal that renders nowhere: the App only needs size and the hooks. */
type StubTerminal = Terminal & { emitRaw(chunk: string): boolean };

function stubTerminal(cols = 168, rows = 46): StubTerminal {
  const keyHandlers = new Set<(key: Key) => void>();
  const rawHandlers = new Set<(chunk: string) => boolean>();
  return {
    size: { cols, rows } as TerminalSize,
    isTTY: true,
    open() {},
    close() {},
    paint() {},
    onKey(handler: (key: Key) => void) {
      keyHandlers.add(handler);
      return () => keyHandlers.delete(handler);
    },
    onRaw(handler: (chunk: string) => boolean) {
      rawHandlers.add(handler);
      return () => rawHandlers.delete(handler);
    },
    emitRaw(chunk: string) {
      for (const handler of rawHandlers) {
        if (handler(chunk)) return true;
      }
      return false;
    },
    onResizeEvent() {
      return () => {};
    },
  } as unknown as StubTerminal;
}

/** A session stand-in for the routing tests, which care about three booleans. */
function fakePane(opts: { altScreen?: boolean; running?: boolean } = {}): {
  pane: TerminalPaneState;
  sent: string[];
} {
  const sent: string[] = [];
  const pane: TerminalPaneState = {
    open: true,
    visible: true,
    returnTo: 'files',
    session: {
      altScreen: opts.altScreen ?? false,
      running: opts.running ?? true,
      send: (data: string) => sent.push(data),
      // The prefix commands are dispatched against the session, so the stand-in has
      // to answer them — otherwise a routing test fails on a missing method rather
      // than on the routing.
      scrollBy: () => true,
      scrollByPage: () => true,
      scrollToTop: () => true,
      scrollToBottom: () => true,
    } as unknown as TermSession,
  };
  return { pane, sent };
}

describe('who owns a keystroke in the shell pane', () => {
  test('ctrl-t then tab always leaves, even mid-full-screen-app', () => {
    for (const altScreen of [false, true]) {
      const { pane, sent } = fakePane({ altScreen });
      expect(routeRawKey(pane, '\x14')).toEqual({ kind: 'pane' });
      expect(routeRawKey(pane, '\t')).toEqual({ kind: 'leave', reason: 'hatch', direction: 1 });
      // The child must never see either, or a program binding them could make the
      // pane inescapable.
      expect(sent).toEqual([]);
    }
  });

  test('esc leaves at a shell prompt', () => {
    const { pane, sent } = fakePane({ altScreen: false });
    expect(routeRawKey(pane, '\x1b')).toEqual({ kind: 'leave', reason: 'escape' });
    expect(sent).toEqual([]);
  });

  test('esc belongs to the child once it is on the alternate screen', () => {
    // This is the carve-out that keeps vim usable. Without it `esc` never
    // reaches the editor and normal mode is unreachable.
    const { pane, sent } = fakePane({ altScreen: true });
    expect(routeRawKey(pane, '\x1b')).toEqual({ kind: 'sent' });
    expect(sent).toEqual(['\x1b']);
  });

  test('the keys the app normally binds all go to the child', () => {
    const { pane, sent } = fakePane();
    // ctrl-c is quit, tab/shift-tab move focus, space is the page prefix, ctrl-p
    // is the palette, and `t` is the key that opened this pane. A shell needs all.
    for (const chunk of ['\x03', '\t', '\x1b[Z', ' ', '\x10', 'q', '1', 'j', 't']) {
      expect(routeRawKey(pane, chunk)).toEqual({ kind: 'sent' });
    }
    expect(sent).toEqual(['\x03', '\t', '\x1b[Z', ' ', '\x10', 'q', '1', 'j', 't']);
  });

  test('an escape sequence is forwarded whole, not read as a bare esc', () => {
    // The chunk is matched entire, which is what separates a real Escape keypress
    // from the first byte of an arrow key.
    const { pane, sent } = fakePane({ altScreen: false });
    expect(routeRawKey(pane, '\x1b[A')).toEqual({ kind: 'sent' });
    expect(sent).toEqual(['\x1b[A']);
  });

  test('a dead child takes no more input, but the hatch still works', () => {
    const { pane, sent } = fakePane({ running: false });
    expect(routeRawKey(pane, 'x')).toEqual({ kind: 'ignored' });
    expect(sent).toEqual([]);
    routeRawKey(pane, '\x14');
    expect(routeRawKey(pane, '\t')).toEqual({ kind: 'leave', reason: 'hatch', direction: 1 });
  });

  test('no session means nothing is routed', () => {
    expect(routeRawKey(initialTerminalPane(), 'x')).toEqual({ kind: 'ignored' });
  });
});

describe('raw stdin bypasses key decoding', () => {
  test('a raw consumer stops the chunk becoming Keys', () => {
    const terminal = new Terminal({
      stdin: {
        isTTY: false,
        on() {},
        off() {},
        resume() {},
        pause() {},
        setEncoding() {},
      } as never,
      stdout: { isTTY: false, on() {}, off() {}, write() {}, columns: 80, rows: 24 } as never,
    });
    const keys: string[] = [];
    const raw: string[] = [];
    let claim = false;
    terminal.onKey((key) => keys.push(key.name));
    terminal.onRaw((chunk) => {
      raw.push(chunk);
      return claim;
    });

    // The handler is consulted on every chunk and claims conditionally, so focus
    // moving does not have to subscribe and unsubscribe.
    terminal.open();
    const feed = (data: string) => {
      // Reach the private handler the way stdin would.
      (terminal as unknown as { onData: (d: string) => void }).onData(data);
    };
    (terminal as unknown as { accepting: boolean }).accepting = true;

    feed('a');
    expect(keys).toEqual(['a']);
    expect(raw).toEqual(['a']);

    claim = true;
    feed('\x03');
    // Still just the one key: the claimed chunk never reached decodeKeys.
    expect(keys).toEqual(['a']);
    expect(raw).toEqual(['a', '\x03']);
    terminal.close();
  });

  test('decodeKeys really is lossy, which is why raw exists', () => {
    // A shift-F5 style sequence has no name in the table; it decodes to a bare
    // escape and the parameter bytes are dropped. A shell needs the original.
    expect(decodeKeys('\x1b[15;2~').map((k) => k.name)).toEqual(['escape']);
  });
});

describe('emulator cells become pinetop styles', () => {
  const base: StyledCell = {
    isBold: () => 0,
    isDim: () => 0,
    isItalic: () => 0,
    isUnderline: () => 0,
    isInverse: () => 0,
    isFgDefault: () => true,
    isBgDefault: () => true,
    isFgPalette: () => false,
    isBgPalette: () => false,
    isFgRGB: () => false,
    isBgRGB: () => false,
    getFgColor: () => 0,
    getBgColor: () => 0,
  };

  test('a plain cell has no style at all', () => {
    expect(cellStyle(base)).toBe('');
  });

  test('attributes come out in SGR order', () => {
    expect(cellStyle({ ...base, isBold: () => 1, isUnderline: () => 1 })).toBe('1;4');
  });

  test('palette colours use the long form across the whole range', () => {
    // Including the low eight, so one code path covers 0–255 and the short forms
    // cannot drift from the cube.
    expect(cellStyle({ ...base, isFgPalette: () => true, getFgColor: () => 2 })).toBe('38;5;2');
    expect(cellStyle({ ...base, isFgPalette: () => true, getFgColor: () => 213 })).toBe('38;5;213');
    expect(cellStyle({ ...base, isBgPalette: () => true, getBgColor: () => 17 })).toBe('48;5;17');
  });

  test('truecolour is unpacked into its channels', () => {
    expect(cellStyle({ ...base, isFgRGB: () => true, getFgColor: () => 0x1e90ff })).toBe(
      '38;2;30;144;255',
    );
  });

  test('inverse survives, because that is how a shell draws its own selection', () => {
    expect(cellStyle({ ...base, isInverse: () => 1 })).toBe('7');
  });
});

describe('a double-width glyph does not shear the row', () => {
  test("Screen.cell writes '' where text() cannot", () => {
    const screen = new Screen(6, 1);
    screen.text(0, 0, 'abcdef');
    // The trailing half of a wide glyph must contribute no bytes: the emulator
    // already advanced two columns for the leading cell.
    screen.cell(2, 0, '');
    expect(stripAnsi(screen.render()[0]!)).toBe('abdef');
  });

  test('a space there would push the row right instead', () => {
    const screen = new Screen(6, 1);
    screen.text(0, 0, 'abcdef');
    screen.cell(2, 0, ' ');
    // Six cells wide, so the row keeps its width and everything after the glyph
    // sits one column late — which is exactly the shear the '' case avoids.
    expect(stripAnsi(screen.render()[0]!)).toBe('ab def');
  });
});

describe('the pane in the page', () => {
  test('it joins the focus ring only while it is open', () => {
    const state = initialState();
    expect(editorPage.panes(state)).toEqual(['files', 'editor', 'inputs']);
    state.terminal.open = true;
    state.terminal.visible = true;
    expect(editorPage.panes(state)).toEqual(['files', 'editor', 'inputs', TERMINAL_PANE]);
  });

  test('an open-but-undrawn column is not a tab stop', () => {
    // The trap this closes: the pane takes every keystroke, so `tab`ing onto a
    // column too narrow to have been drawn means typing into an invisible shell.
    const state = initialState();
    state.terminal.open = true;
    state.terminal.visible = false;
    expect(editorPage.panes(state)).toEqual(['files', 'editor', 'inputs']);
  });

  test('the width gate and the page render agree', () => {
    const state = initialState();
    state.terminal.open = true;
    // Rendering is what publishes `visible`, and it must match the gate exactly —
    // the app refuses to open a column below the same number.
    const screen = new Screen(TERMINAL_MIN_BODY - 1, 24);
    editorPage.render({
      state,
      screen,
      body: { x: 0, y: 2, w: screen.cols, h: 20 },
      focus: 'editor',
      cursor: () => 0,
      paneKey: () => undefined,
    });
    expect(state.terminal.visible).toBe(false);

    const wide = new Screen(TERMINAL_MIN_BODY, 24);
    editorPage.render({
      state,
      screen: wide,
      body: { x: 0, y: 2, w: wide.cols, h: 20 },
      focus: 'editor',
      cursor: () => 0,
      paneKey: () => undefined,
    });
    expect(state.terminal.visible).toBe(true);
  });

  test('it claims the keyboard, so no pane badges are advertised', () => {
    const state = initialState();
    state.terminal.open = true;
    state.terminal.visible = true;
    state.panes.editor.focus = TERMINAL_PANE;
    expect(editorPage.claimsKeyboard?.(state)).toBe(true);
    // ↵ must not fall through to FILES' open-a-file path.
    expect(editorPage.confirm?.(state)).toBeUndefined();
  });

  test('the column is dropped rather than crushing the buffer', () => {
    const state = initialState();
    state.terminal.open = true;
    expect(terminalVisible(state, 200)).toBe(true);
    expect(terminalVisible(state, 100)).toBe(false);
    // Closed is closed at any width.
    state.terminal.open = false;
    expect(terminalVisible(state, 200)).toBe(false);
  });

  test('a pane that could not start says so and draws no grid', () => {
    const screen = new Screen(40, 8);
    const pane = initialTerminalPane();
    pane.open = true;
    pane.error = 'no shell: pty unavailable';
    drawTerminal(screen, { x: 0, y: 0, w: 40, h: 8 }, pane, { focused: false, key: undefined });
    const text = screen.render().join('\n');
    expect(text).toContain('no shell: pty unavailable');
    expect(text).toContain('the rest of pinetop is unaffected');
  });
});

// ————————————————————————————————————————————————————— the real thing

/**
 * One end-to-end test over an actual pty. Skipped rather than mocked where a pty
 * cannot be had: a fake would only prove the fake agrees with itself, and the
 * whole reason this feature exists is that the FFI route turned out to work.
 */
const ptyWorks = (() => {
  try {
    const probe = new TermSession({ argv: ['true'], rows: 4, cols: 20 });
    probe.dispose();
    return true;
  } catch {
    return false;
  }
})();

describe.if(ptyWorks)('a real child on a real pty', () => {
  async function settle(session: TermSession, want: RegExp, ms = 4000): Promise<string> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      session.poll();
      const text = grid(session);
      if (want.test(text)) return text;
      await Bun.sleep(25);
    }
    return grid(session);
  }

  function grid(session: TermSession): string {
    const lines: string[] = [];
    for (let y = 0; y < session.rows; y++) {
      let line = '';
      for (let x = 0; x < session.cols; x++) line += session.cellAt(x, y).ch;
      lines.push(line.trimEnd());
    }
    return lines.join('\n').trimEnd();
  }

  test('output reaches the grid', async () => {
    const session = new TermSession({
      argv: ['sh', '-c', 'printf "hello-pane\\n"'],
      rows: 6,
      cols: 30,
    });
    try {
      expect(await settle(session, /hello-pane/)).toContain('hello-pane');
    } finally {
      session.dispose();
    }
  });

  test('the child is sized to the pane, and resizing tells it so', async () => {
    const session = new TermSession({
      argv: ['sh', '-c', 'stty size; sleep 0.6; stty size'],
      rows: 9,
      cols: 44,
    });
    try {
      expect(await settle(session, /9 44/)).toContain('9 44');
      session.resize(7, 31);
      expect(await settle(session, /7 31/)).toContain('7 31');
    } finally {
      session.dispose();
    }
  });

  test('keystrokes reach the child', async () => {
    const session = new TermSession({
      argv: ['sh', '-c', 'read line; printf "got:%s\\n" "$line"'],
      rows: 6,
      cols: 30,
    });
    try {
      session.poll();
      session.send('ping\r');
      expect(await settle(session, /got:ping/)).toContain('got:ping');
    } finally {
      session.dispose();
    }
  });

  test('colour survives the round trip into cell styles', async () => {
    const session = new TermSession({
      argv: ['sh', '-c', 'printf "\\033[32mgreen\\033[0m\\n"'],
      rows: 4,
      cols: 20,
    });
    try {
      await settle(session, /green/);
      // Palette green, in the long form the mapper emits.
      expect(session.cellAt(0, 0).style).toContain('38;5;2');
    } finally {
      session.dispose();
    }
  });

  test('an exit is noticed, and the code is kept', async () => {
    const session = new TermSession({ argv: ['sh', '-c', 'exit 3'], rows: 4, cols: 20 });
    try {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && session.exitCode == null) {
        session.poll();
        await Bun.sleep(25);
      }
      expect(session.exitCode).toBe(3);
      expect(session.running).toBe(false);
      // A dead child takes no more input rather than throwing.
      session.send('ignored');
    } finally {
      session.dispose();
    }
  });

  test('the alternate screen is what the esc rule reads', async () => {
    const session = new TermSession({
      argv: ['sh', '-c', 'printf "\\033[?1049h"; sleep 1'],
      rows: 5,
      cols: 20,
    });
    try {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !session.altScreen) {
        session.poll();
        await Bun.sleep(25);
      }
      expect(session.altScreen).toBe(true);
      // And with it set, esc goes to the child.
      const pane: TerminalPaneState = { open: true, visible: true, returnTo: 'files', session };
      expect(routeRawKey(pane, '\x1b')).toEqual({ kind: 'sent' });
    } finally {
      session.dispose();
    }
  });

  test('the terminal answers questions the child asks it', async () => {
    // Without a reply channel this hangs forever: `\033[6n` asks where the cursor
    // is and the child blocks on the answer. Capability probing on startup is how
    // a modern TUI decides what it may draw, so a terminal that never answers is
    // one that such programs cannot run in at all.
    const session = new TermSession({
      argv: ['sh', '-c', 'printf "\\033[6n"; IFS= read -r -d R reply; printf "ANSWERED\\n"'],
      rows: 8,
      cols: 30,
    });
    try {
      expect(await settle(session, /ANSWERED/)).toContain('ANSWERED');
    } finally {
      session.dispose();
    }
  });

  test('a character split across two reads is not corrupted', async () => {
    // Deliberately deterministic: the child writes the first two bytes of U+2500
    // (─ is e2 94 80), pauses so the read definitely returns, then writes the
    // third. A per-read decode turns the incomplete tail into U+FFFD and the
    // trailing byte into a second one; a carried-over decoder reassembles them.
    const session = new TermSession({
      argv: ['sh', '-c', 'printf "\\342\\224"; sleep 0.4; printf "\\200 SPLIT-OK\\n"'],
      rows: 6,
      cols: 24,
    });
    try {
      const text = await settle(session, /SPLIT-OK/, 5000);
      expect(text).not.toContain('\ufffd');
      expect(text).toContain('\u2500 SPLIT-OK');
    } finally {
      session.dispose();
    }
  });

  test('killing the session takes the program running inside it too', async () => {
    // Signalling the pane's own child is not enough — whatever it started has to go
    // with it, or `claude` and `vim` outlive a pane that is already gone.
    //
    // Deliberately not an interactive shell. `sh -i` was the first attempt and it is
    // the wrong instrument twice over: `exec -a NAME` for a recognisable process is a
    // bash/zsh builtin that dash does not have (so on CI, where `$SHELL` is unset and
    // `/bin/sh` is dash, the setup silently did nothing and the assertion failed
    // against a process that never existed), and an interactive shell defers `SIGHUP`
    // while it waits on a foreground job, which left the grandchild alive and hung the
    // whole test run. A plain `sh -c` needs neither and tests the same thing.
    const dir = mkdtempSync(join(tmpdir(), 'pinetop-orphan-'));
    const pidFile = join(dir, 'child.pid');
    const session = new TermSession({
      // `echo $$` then `exec` is POSIX in every sh, and `exec` means the recorded pid
      // is the long-lived process rather than a wrapper that exits immediately.
      argv: ['sh', '-c', `sh -c 'echo $$ > ${pidFile}; exec sleep 60' & wait`],
      rows: 8,
      cols: 30,
    });

    const childPid = (): number | null => {
      try {
        const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      } catch {
        return null;
      }
    };
    const alive = (pid: number): boolean =>
      Bun.spawnSync(['ps', '-p', String(pid), '-o', 'pid='])
        .stdout.toString()
        .trim() !== '';

    let pid: number | null = null;
    try {
      for (let i = 0; i < 60 && pid == null; i++) {
        session.poll();
        await Bun.sleep(50);
        pid = childPid();
      }
      expect(pid).not.toBeNull();
      expect(alive(pid!)).toBe(true);

      session.dispose();
      let gone = false;
      for (let i = 0; i < 60 && !gone; i++) {
        await Bun.sleep(50);
        gone = !alive(pid!);
      }
      expect(gone).toBe(true);
    } finally {
      session.dispose();
      // Never leave the runner holding a `sleep 60`: a survivor keeps Bun's loop
      // open and the suite would hang after the last assertion rather than fail.
      if (pid != null && alive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dispose is idempotent and kills the child', async () => {
    const session = new TermSession({ argv: ['sh', '-c', 'sleep 30'], rows: 4, cols: 20 });
    session.poll();
    session.dispose();
    session.dispose();
    expect(session.running).toBe(false);
  });
});

/**
 * Leaving the shell must not dump focus into the buffer.
 *
 * This is the regression these tests exist for. The buffer claims the whole
 * keyboard, so focus landing there silently converts every app shortcut into a vim
 * command — `f` arms find-char, `i` starts inserting into the Pine source. The
 * symptom is "the shortcuts stopped working on the editor page", and the cause is
 * two panes away from it.
 */
describe('leaving or navigating away from the shell', () => {
  function appOn(focus: string, cols = 168): { app: App; state: AppState; terminal: StubTerminal } {
    const state = initialState();
    state.page = 'editor';
    state.panes.editor.focus = focus;
    // A session is not needed for focus logic, but `t` is refused without one and
    // the real render path reads the grid — so the stand-in has to answer all of it.
    state.terminal = {
      open: true,
      visible: true,
      returnTo: focus,
      session: {
        running: true,
        altScreen: false,
        exitCode: null,
        cols: 60,
        rows: 30,
        cursor: { x: 0, y: 0 },
        cellAt: () => ({ ch: ' ', style: '' }),
        resize() {},
        poll: () => false,
        send() {},
        dispose() {},
      } as never,
    };
    const terminal = stubTerminal(cols);
    const app = new App({ terminal, state, cwd: '/tmp/pinetop-test' });
    app.start();
    return { app, state, terminal };
  }

  test('from FILES, ctrl-t then tab wraps to FILES through the raw path', () => {
    const { app, state, terminal } = appOn('files');
    app.onKey({ name: 't', text: 't' });
    expect(state.panes.editor.focus).toBe(TERMINAL_PANE);
    expect(terminal.emitRaw('\x14\t')).toBe(true);
    // Not 'editor': landing in the buffer is what broke every other shortcut.
    expect(state.panes.editor.focus).toBe('files');
  });

  test('from the terminal, ctrl-t then shift-tab moves backward to INPUTS', () => {
    const { app, state, terminal } = appOn('inputs');
    app.onKey({ name: 't', text: 't' });
    expect(state.panes.editor.focus).toBe(TERMINAL_PANE);
    expect(terminal.emitRaw('\x14\x1b[Z')).toBe(true);
    expect(state.panes.editor.focus).toBe('inputs');
  });

  test('prompt esc still returns to the pane that deliberately opened the shell', () => {
    const { app, state, terminal } = appOn('editor');
    // `ctrl-t`, because a bare `t` in the buffer is the till motion.
    app.onKey({ name: 'ctrl-t' });
    expect(state.panes.editor.focus).toBe(TERMINAL_PANE);
    expect(terminal.emitRaw('\x1b')).toBe(true);
    expect(state.panes.editor.focus).toBe('editor');
  });

  test('prefix navigation cannot make the shell its own return target', () => {
    const { app, state, terminal } = appOn('files');
    app.onKey({ name: 't', text: 't' });
    expect(state.terminal.returnTo).toBe('files');
    // Leave and re-enter twice; the remembered pane must not drift to 'terminal'.
    terminal.emitRaw('\x14\t');
    app.onKey({ name: 't', text: 't' });
    expect(state.terminal.returnTo).toBe('files');
    terminal.emitRaw('\x14\t');
    expect(state.panes.editor.focus).toBe('files');
  });

  test('pane accelerators work again after prefix navigation', () => {
    // The user-visible symptom, end to end: leave the shell, then press the
    // INPUTS accelerator and land on INPUTS rather than typing into the buffer.
    const { app, state, terminal } = appOn('files');
    app.onKey({ name: 't', text: 't' });
    terminal.emitRaw('\x14\t');
    app.onKey({ name: 'i', text: 'i' });
    expect(state.panes.editor.focus).toBe('inputs');
    // And the buffer is untouched — nothing was typed into the Pine source.
    expect(state.editor.buffer?.modified ?? false).toBe(false);
  });

  test('a dead session is cleared away, not left on screen', async () => {
    // `ctrl-d` / `exit` ends the shell, and that is the user closing the pane. The
    // column goes and focus returns where the shell took it from.
    const { app, state } = appOn('inputs');
    app.onKey({ name: 't', text: 't' });
    expect(state.panes.editor.focus).toBe(TERMINAL_PANE);
    (state.terminal.session as unknown as { running: boolean }).running = false;
    app.onKey({ name: 'ctrl-t' });
    expect(state.terminal.open).toBe(false);
    expect(state.terminal.session).toBeNull();
    expect(state.panes.editor.focus).toBe('inputs');
    // And the column is gone from the ring, so `tab` cannot reach it.
    expect(editorPage.panes(state)).not.toContain(TERMINAL_PANE);
  });

  test('a shell open on a too-narrow terminal never holds focus', () => {
    const { app, state } = appOn('files', 80);
    app.onKey({ name: 't', text: 't' });
    // Below the gate the column is not drawn, so focus must not be there.
    expect(state.panes.editor.focus).not.toBe(TERMINAL_PANE);
  });
});

test('the escape hatch is the key the hints advertise', () => {
  // Guards against the binding and the pane's own legend drifting apart.
  expect(ESCAPE_HATCH).toBe('ctrl-t');
  const state = initialState();
  state.terminal.open = true;
  state.panes.editor.focus = TERMINAL_PANE;
  expect(editorPage.hints?.(state).some((h) => h.key === ESCAPE_HATCH)).toBe(true);
});

// ————————————————————————————————— the buffer against the file on disk

/**
 * The shell pane put a terminal next to the buffer, which made it possible to
 * change the open file from inside the frame — so a buffer that keeps showing the
 * old bytes is now a routine outcome rather than an exotic one.
 */
describe('an external change to the open file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pinetop-disk-'));

  function openTemp(body: string): { state: AppState; path: string } {
    const path = join(dir, `s-${Math.round(performance.now() * 1000)}.pine`);
    writeFileSync(path, body, 'utf8');
    const state = initialState();
    openFile(state.editor, path);
    return { state, path };
  }

  /** Write and force a distinguishable stamp, so the test never races mtime. */
  function rewrite(path: string, body: string): void {
    writeFileSync(path, body, 'utf8');
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
  }

  test('a clean buffer picks the change up', () => {
    const { state, path } = openTemp('one\ntwo\n');
    expect(state.editor.buffer?.lines).toEqual(['one', 'two']);
    rewrite(path, 'one\ntwo\nthree\n');
    expect(syncWithDisk(state.editor)).toBe(true);
    expect(state.editor.buffer?.lines).toEqual(['one', 'two', 'three']);
    expect(state.editor.message).toContain('reloaded');
  });

  test('the cursor stays where the reader left it', () => {
    const { state, path } = openTemp('a\nb\nc\nd\n');
    state.editor.buffer!.line = 2;
    state.editor.buffer!.col = 1;
    rewrite(path, 'a\nb\nc\nd\ne\n');
    syncWithDisk(state.editor);
    expect(state.editor.buffer?.line).toBe(2);
    expect(state.editor.buffer?.col).toBe(1);
  });

  test('the cursor is clamped when the file shrank under it', () => {
    const { state, path } = openTemp('a\nb\nc\nd\ne\n');
    state.editor.buffer!.line = 4;
    rewrite(path, 'a\n');
    syncWithDisk(state.editor);
    expect(state.editor.buffer?.lines).toEqual(['a']);
    expect(state.editor.buffer?.line).toBe(0);
  });

  test('an unwritten buffer is flagged, never overwritten', () => {
    const { state, path } = openTemp('mine\n');
    state.editor.buffer!.lines = ['my edit'];
    state.editor.buffer!.modified = true;
    rewrite(path, 'theirs\n');

    expect(syncWithDisk(state.editor)).toBe(true);
    // The edit survives — losing it to fix a display problem is the worse bug.
    expect(state.editor.buffer?.lines).toEqual(['my edit']);
    expect(state.editor.buffer?.staleOnDisk).toBe(true);
    expect(state.editor.message).toContain(':e! to reload');
    // Said once, not on every poll.
    expect(syncWithDisk(state.editor)).toBe(false);
  });

  test('an unchanged file costs nothing and says nothing', () => {
    const { state } = openTemp('same\n');
    state.editor.message = '';
    expect(syncWithDisk(state.editor)).toBe(false);
    expect(state.editor.message).toBe('');
  });

  test("our own `:w` does not read back as someone else's change", () => {
    const { state } = openTemp('before\n');
    state.editor.buffer!.lines = ['after'];
    state.editor.buffer!.modified = true;
    writeFile(state.editor, undefined);
    expect(syncWithDisk(state.editor)).toBe(false);
    expect(state.editor.buffer?.staleOnDisk).toBeFalsy();
  });

  test('a deleted file leaves the buffer as the only copy', () => {
    const { state, path } = openTemp('precious\n');
    rmSync(path);
    expect(syncWithDisk(state.editor)).toBe(true);
    expect(state.editor.buffer?.lines).toEqual(['precious']);
    expect(state.editor.buffer?.isNew).toBe(true);
    expect(state.editor.message).toContain('no longer on disk');
  });

  test('an io that cannot stat opts out instead of throwing', () => {
    const { state } = openTemp('x\n');
    expect(
      syncWithDisk(state.editor, { read: () => 'x\n', write: () => {}, exists: () => true }),
    ).toBe(false);
  });
});

// ————————————————————————————————————————————————— scrollback in the pane

describe('SCROLL mode', () => {
  const PREFIX = '\x14';

  test('ctrl-t enters the mode rather than leaving', () => {
    const { pane, sent } = fakePane();
    expect(routeRawKey(pane, PREFIX)).toEqual({ kind: 'pane' });
    expect(pane.scrolling).toBe(true);
    // Reserved: the child never sees it.
    expect(sent).toEqual([]);
  });

  test('the mode is sticky — scroll keys repeat without re-arming', () => {
    const { pane, sent } = fakePane();
    routeRawKey(pane, PREFIX);
    for (const key of ['k', 'k', 'j', 'u', 'd', 'g', 'G', 'k']) {
      expect(routeRawKey(pane, key)).toEqual({ kind: 'pane' });
      expect(pane.scrolling).toBe(true);
    }
    // None of it reached the shell.
    expect(sent).toEqual([]);
  });

  test('a held-down key arriving as one chunk scrolls repeatedly', () => {
    const { pane, sent } = fakePane();
    routeRawKey(pane, PREFIX);
    expect(routeRawKey(pane, 'kkkk')).toEqual({ kind: 'pane' });
    expect(pane.scrolling).toBe(true);
    expect(sent).toEqual([]);
  });

  test('esc resumes the child without leaving the pane', () => {
    const { pane, sent } = fakePane();
    routeRawKey(pane, PREFIX);
    expect(routeRawKey(pane, '\x1b')).toEqual({ kind: 'pane' });
    expect(pane.scrolling).toBe(false);
    // An explicit exit is not typed at the child.
    expect(sent).toEqual([]);
  });

  test('ctrl-t also resumes the child', () => {
    const { pane } = fakePane();
    routeRawKey(pane, PREFIX);
    expect(routeRawKey(pane, PREFIX)).toEqual({ kind: 'pane' });
    expect(pane.scrolling).toBe(false);
  });

  test('tab leaves the pane, which is what tab means everywhere else', () => {
    const { pane } = fakePane({ altScreen: true });
    routeRawKey(pane, PREFIX);
    expect(routeRawKey(pane, '\t')).toEqual({ kind: 'leave', reason: 'hatch', direction: 1 });
    expect(pane.scrolling).toBe(false);
  });

  test('shift-tab is one key, not esc followed by letters', () => {
    const { pane, sent } = fakePane();
    routeRawKey(pane, PREFIX);
    expect(routeRawKey(pane, '\x1b[Z')).toEqual({
      kind: 'leave',
      reason: 'hatch',
      direction: -1,
    });
    expect(sent).toEqual([]);
  });

  test('any other key ends the mode and is not swallowed', () => {
    const { pane, sent } = fakePane();
    routeRawKey(pane, PREFIX);
    expect(routeRawKey(pane, 'l')).toEqual({ kind: 'sent' });
    expect(pane.scrolling).toBe(false);
    // `ls` must not arrive as `s`.
    expect(sent).toEqual(['l']);
    expect(routeRawKey(pane, 's')).toEqual({ kind: 'sent' });
    expect(sent).toEqual(['l', 's']);
  });

  test('without the prefix, those same keys are the child’s', () => {
    const { pane, sent } = fakePane();
    for (const key of ['k', 'j', 'u', 'd', 'g', 'G']) {
      expect(routeRawKey(pane, key)).toEqual({ kind: 'sent' });
    }
    expect(sent).toEqual(['k', 'j', 'u', 'd', 'g', 'G']);
  });

  test('entering and leaving in one chunk nets out to neither', () => {
    // Keys typed fast, and every paste, arrive coalesced.
    const { pane, sent } = fakePane();
    expect(routeRawKey(pane, '\x14\x14')).toEqual({ kind: 'pane' });
    expect(pane.scrolling).toBe(false);
    expect(sent).toEqual([]);
  });

  test('ordinary bytes ahead of the prefix reach the child, in order', () => {
    const { pane, sent } = fakePane();
    expect(routeRawKey(pane, 'ls\x14')).toEqual({ kind: 'sent' });
    expect(sent).toEqual(['ls']);
    expect(pane.scrolling).toBe(true);
  });

  test('a coalesced scroll command is not typed at the child', () => {
    const { pane, sent } = fakePane();
    routeRawKey(pane, '\x14g');
    // `g` was the mode's, so nothing was typed — and the mode is still on.
    expect(sent).toEqual([]);
    expect(pane.scrolling).toBe(true);
  });

  test('esc still leaves in one keystroke at a prompt', () => {
    const { pane } = fakePane({ altScreen: false });
    expect(routeRawKey(pane, '\x1b')).toEqual({ kind: 'leave', reason: 'escape' });
  });
});

describe.if(ptyWorks)('scrolling a real session', () => {
  async function withLines(count: number, rows = 8): Promise<TermSession> {
    const session = new TermSession({
      argv: ['sh', '-c', `i=1; while [ $i -le ${count} ]; do echo "line-$i"; i=$((i+1)); done`],
      rows,
      cols: 24,
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      session.poll();
      if (session.exitCode != null && session.scrollbackLines > 0) break;
      await Bun.sleep(25);
    }
    return session;
  }
  function topLine(session: TermSession): string {
    let line = '';
    for (let x = 0; x < session.cols; x++) line += session.cellAt(x, 0).ch;
    return line.trim();
  }

  test('history is kept and reachable', async () => {
    const session = await withLines(60);
    try {
      expect(session.scrollbackLines).toBeGreaterThan(40);
      expect(session.atBottom).toBe(true);
      expect(session.scrollToTop()).toBe(true);
      expect(topLine(session)).toBe('line-1');
      expect(session.scrolledLines).toBeGreaterThan(40);
    } finally {
      session.dispose();
    }
  });

  test('line and page moves land where they say', async () => {
    const session = await withLines(60, 8);
    try {
      session.scrollToTop();
      session.scrollBy(1);
      expect(topLine(session)).toBe('line-2');
      // A page is the pane height less one line of overlap.
      session.scrollByPage(1);
      expect(topLine(session)).toBe('line-9');
      expect(session.scrollToBottom()).toBe(true);
      expect(session.atBottom).toBe(true);
    } finally {
      session.dispose();
    }
  });

  test('scrolling past either end clamps instead of running off', async () => {
    const session = await withLines(60);
    try {
      session.scrollToTop();
      // Already at the top: nothing left to do, and it says so.
      expect(session.scrollBy(-50)).toBe(false);
      expect(topLine(session)).toBe('line-1');
      session.scrollByPage(100);
      expect(session.atBottom).toBe(true);
    } finally {
      session.dispose();
    }
  });

  test('typing returns to the live view', async () => {
    const session = new TermSession({
      argv: [process.env['SHELL'] ?? '/bin/sh', '-i'],
      rows: 8,
      cols: 30,
    });
    try {
      for (let i = 0; i < 20; i++) {
        session.poll();
        await Bun.sleep(25);
      }
      session.send('i=1; while [ $i -le 40 ]; do echo "l-$i"; i=$((i+1)); done\r');
      for (let i = 0; i < 60; i++) {
        session.poll();
        await Bun.sleep(25);
      }
      session.scrollToTop();
      expect(session.atBottom).toBe(false);
      // Input you cannot see the result of is worse than losing your place.
      session.send('echo back\r');
      expect(session.atBottom).toBe(true);
    } finally {
      session.dispose();
    }
  });

  test('the alternate screen has no scrollback to offer', async () => {
    const session = new TermSession({
      argv: ['sh', '-c', 'printf "\\033[?1049h"; sleep 1'],
      rows: 6,
      cols: 20,
    });
    try {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && !session.altScreen) {
        session.poll();
        await Bun.sleep(25);
      }
      expect(session.altScreen).toBe(true);
      // Not a limitation of the pane — it is what the alternate screen is.
      expect(session.scrollbackLines).toBe(0);
      expect(session.scrollBy(-5)).toBe(false);
      expect(session.scrollToTop()).toBe(false);
    } finally {
      session.dispose();
    }
  });
});
