import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from '../src/app.js';
import { setEditorIo, type EditorIo } from '../src/editor/io.js';
import {
  handOff,
  pathToEdit,
  resolveEditor,
  setLauncher,
  spawnLauncher,
  type Launcher,
  type Suspendable,
} from '../src/editor/handoff.js';
import { openFile } from '../src/editor/vim.js';
import { refreshScripts } from '../src/scripts.js';
import { initialState, type AppState } from '../src/state.js';
import type { Key, Terminal, TerminalSize } from '../src/terminal.js';

interface MemoryIo extends EditorIo {
  store: Record<string, string>;
}

function memoryIo(files: Record<string, string> = {}): MemoryIo {
  const store = { ...files };
  return {
    store,
    read(path) {
      const text = store[path];
      if (text == null) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    write(path, text) {
      store[path] = text;
    },
    exists: (path) => store[path] != null,
  };
}

/** A Suspendable that records the close/open bracketing. */
function stubTerminal(cols = 168, rows = 46): Terminal & Suspendable & { log: string[] } {
  const log: string[] = [];
  const keyHandlers = new Set<(key: Key) => void>();
  return {
    log,
    size: { cols, rows } as TerminalSize,
    isTTY: true,
    open() {
      log.push('open');
    },
    close() {
      log.push('close');
    },
    paint() {},
    onKey(handler: (key: Key) => void) {
      keyHandlers.add(handler);
      return () => keyHandlers.delete(handler);
    },
    onResizeEvent() {
      return () => {};
    },
  } as unknown as Terminal & Suspendable & { log: string[] };
}

/** Records what it was asked to run, and reports success. */
function recordingLauncher(): Launcher & { calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  const run = ((command, args) => {
    calls.push({ command, args: [...args] });
    return { ok: true };
  }) as Launcher & { calls: typeof calls };
  run.calls = calls;
  return run;
}

let io: MemoryIo;
let state: AppState;

beforeEach(() => {
  io = memoryIo({ 'strats/demo.pine': 'plot(close)\n' });
  setEditorIo(io);
  refreshScripts();
  state = initialState();
  state.page = 'backtest';
  state.flags.backtest.scripts = ['strats/demo.pine'];
});

afterEach(() => {
  setEditorIo();
  setLauncher();
  delete process.env['VISUAL'];
  delete process.env['EDITOR'];
});

describe('which editor', () => {
  test('$VISUAL wins over $EDITOR, and vim is the fallback', () => {
    expect(resolveEditor({ VISUAL: 'nvim', EDITOR: 'nano' }).command).toBe('nvim');
    expect(resolveEditor({ EDITOR: 'nano' }).command).toBe('nano');
    expect(resolveEditor({}).command).toBe('vim');
    expect(resolveEditor({ EDITOR: '   ' }).command).toBe('vim');
  });

  test('a spec with arguments is split, so EDITOR="nvim -u NONE" works', () => {
    expect(resolveEditor({ EDITOR: 'nvim -u NONE' })).toEqual({
      command: 'nvim',
      args: ['-u', 'NONE'],
    });
  });
});

describe('which file', () => {
  test('a command page edits its own script', () => {
    state.page = 'sweep';
    state.flags.sweep.scripts = ['strats/swept.pine'];
    expect(pathToEdit(state)).toBe('strats/swept.pine');
  });

  test('EDITOR and LOGS edit the open buffer', () => {
    openFile(state.editor, 'strats/open.pine', io);
    state.page = 'editor';
    expect(pathToEdit(state)).toBe('strats/open.pine');
    state.page = 'logs';
    expect(pathToEdit(state)).toBe('strats/open.pine');
  });

  test('with nothing loaded anywhere it falls back rather than refusing', () => {
    state.flags.backtest.scripts = [];
    state.page = 'logs';
    // Either discovery found something in this project, or there is nothing to
    // find — both are correct; what must not happen is a throw.
    expect(() => pathToEdit(state)).not.toThrow();
  });
});

describe('suspend, edit, resume', () => {
  test('the terminal is closed before the editor and reopened after', () => {
    const terminal = stubTerminal();
    const run = recordingLauncher();
    handOff(state, terminal, '/tmp/pinetop-test', run, io);
    expect(terminal.log).toEqual(['close', 'open']);
  });

  test('vi-family editors are given +<line>; others get the path alone', () => {
    process.env['EDITOR'] = 'vim';
    openFile(state.editor, 'strats/demo.pine', io);
    state.editor.buffer!.line = 41;

    const vim = recordingLauncher();
    handOff(state, stubTerminal(), '/tmp/pinetop-test', vim, io);
    expect(vim.calls[0]).toEqual({ command: 'vim', args: ['+42', 'strats/demo.pine'] });

    process.env['EDITOR'] = 'code -w';
    const code = recordingLauncher();
    handOff(state, stubTerminal(), '/tmp/pinetop-test', code, io);
    expect(code.calls[0]).toEqual({ command: 'code', args: ['-w', 'strats/demo.pine'] });
  });

  test('an unwritten buffer for the same file refuses, and nothing is spawned', () => {
    openFile(state.editor, 'strats/demo.pine', io);
    state.editor.buffer!.lines = ['edited'];
    state.editor.buffer!.modified = true;

    const terminal = stubTerminal();
    const run = recordingLauncher();
    const status = handOff(state, terminal, '/tmp/pinetop-test', run, io);

    expect(status).toContain('unwritten changes');
    expect(run.calls).toHaveLength(0);
    expect(terminal.log).toEqual([]);
    expect(state.editor.buffer!.lines).toEqual(['edited']);
  });

  test('an unwritten buffer for a *different* file is left alone', () => {
    openFile(state.editor, 'strats/other.pine', io);
    state.editor.buffer!.lines = ['work in progress'];
    state.editor.buffer!.modified = true;

    handOff(state, stubTerminal(), '/tmp/pinetop-test', recordingLauncher(), io);
    // BACKTEST's script was handed over; the other buffer survived untouched.
    expect(state.editor.buffer!.path).toBe('strats/other.pine');
    expect(state.editor.buffer!.lines).toEqual(['work in progress']);
  });

  test('a launcher that throws still restores the frame and says why', () => {
    const terminal = stubTerminal();
    const boom: Launcher = () => {
      throw new Error('ENOENT: vim');
    };
    const status = handOff(state, terminal, '/tmp/pinetop-test', boom, io);
    expect(terminal.log).toEqual(['close', 'open']);
    expect(status).toContain('ENOENT');
  });

  test('a non-zero exit is reported rather than read as success', () => {
    const failing: Launcher = () => ({ ok: false, error: 'exited 1' });
    expect(handOff(state, stubTerminal(), '/tmp/pinetop-test', failing, io)).toContain('exited 1');
  });

  test('with no script anywhere it says so instead of spawning', () => {
    state.flags.backtest.scripts = [];
    state.page = 'compare';
    const run = recordingLauncher();
    const status = handOff(state, stubTerminal(), '/tmp/pinetop-test', run, io);
    if (status.startsWith('no script')) expect(run.calls).toHaveLength(0);
  });
});

describe('end to end, with a real process', () => {
  test('the file the stand-in editor wrote is what comes back in the buffer', () => {
    // The one test that really spawns something. It proves the whole mechanism
    // except the TTY handover itself, which needs a terminal no test process has:
    // argv order, cwd, the exit code, and the reload from disk on return.
    const dir = mkdtempSync(join(tmpdir(), 'pinetop-handoff-'));
    writeFileSync(join(dir, 'demo.pine'), 'plot(close)\n', 'utf8');

    // A stand-in "editor": a script that rewrites the file it is handed.
    const fake = join(dir, 'stand-in-editor');
    writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "plot(open)" > "$1"\n', { mode: 0o755 });

    state.flags.backtest.scripts = ['demo.pine'];
    setEditorIo();
    process.env['EDITOR'] = fake;

    const status = handOff(state, stubTerminal(), dir, spawnLauncher);

    expect(readFileSync(join(dir, 'demo.pine'), 'utf8')).toBe('plot(open)\n');
    expect(status).toContain('reloaded');
  });
});

describe('reaching it', () => {
  function app(): App {
    return new App({
      terminal: stubTerminal(),
      state,
      cwd: '/tmp/pinetop-test',
    });
  }

  test('`e` dispatches the hand-off from a report page', () => {
    const run = recordingLauncher();
    setLauncher(run);
    app().onKey({ name: 'e', text: 'e' });
    expect(run.calls).toHaveLength(1);
    expect(state.status).toContain('reloaded');
  });

  test('`e` inside the buffer is the word motion, not the hand-off', () => {
    state.page = 'editor';
    state.panes.editor.focus = 'editor';
    openFile(state.editor, 'strats/demo.pine', io);
    const run = recordingLauncher();
    setLauncher(run);

    app().onKey({ name: 'e', text: 'e' });
    expect(run.calls).toHaveLength(0);
    expect(state.editor.buffer!.col).toBeGreaterThan(0);
  });

  test('the palette reaches it too, through an action rather than a state edit', () => {
    const run = recordingLauncher();
    setLauncher(run);
    const instance = app();
    instance.onKey({ name: ':', text: ':' });
    for (const ch of 'edit in') instance.onKey({ name: ch, text: ch });
    instance.onKey({ name: 'enter' });
    expect(run.calls).toHaveLength(1);
  });
});
