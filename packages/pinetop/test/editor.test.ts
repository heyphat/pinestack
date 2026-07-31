import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { App } from '../src/app.js';
import { bufferText, newBuffer } from '../src/editor/buffer.js';
import { setEditorIo, type EditorIo } from '../src/editor/io.js';
import { initialEditor, type EditorState } from '../src/editor/state.js';
import { highlight } from '../src/editor/syntax.js';
import { handleKey, openFile } from '../src/editor/vim.js';
import { bufferInputs } from '../src/pages/editor.js';
import { stripAnsi } from '../src/render/screen.js';
import { SYNTAX } from '../src/render/theme.js';
import { initialState, resetRunIds, type AppState } from '../src/state.js';
import type { Key, Terminal, TerminalSize } from '../src/terminal.js';

// ————————————————————————————————————————————————————————————————— harness

/**
 * A keystroke script. Printable characters are themselves; named keys are
 * written the way vim's own docs write them, so a test reads as the thing a user
 * would type: `type(editor, 'ciw<esc>')`.
 */
function keyOf(spec: string): Key {
  switch (spec) {
    case '<esc>':
      return { name: 'escape' };
    case '<cr>':
      return { name: 'enter' };
    case '<bs>':
      return { name: 'backspace' };
    case '<tab>':
      return { name: 'tab' };
    case '<c-r>':
      return { name: 'ctrl-r' };
    case '<c-d>':
      return { name: 'ctrl-d' };
    case '<c-u>':
      return { name: 'ctrl-u' };
    case '<c-w>':
      return { name: 'ctrl-w' };
    case '<c-c>':
      return { name: 'ctrl-c' };
    default:
      return { name: spec, text: spec };
  }
}

function tokenize(script: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < script.length; i++) {
    if (script[i] === '<') {
      const end = script.indexOf('>', i);
      if (end > i) {
        out.push(script.slice(i, end + 1));
        i = end;
        continue;
      }
    }
    out.push(script[i]!);
  }
  return out;
}

function type(editor: EditorState, script: string): void {
  for (const spec of tokenize(script)) handleKey(editor, keyOf(spec));
}

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

/**
 * An editor holding exactly `lines`, cursor at the origin. The lines are set
 * directly rather than parsed from text, so a test that wants a trailing blank
 * line gets one (`splitLines` is exercised on its own, above).
 */
function editorWith(...lines: string[]): EditorState {
  const editor = initialEditor();
  const buffer = newBuffer('demo.pine', '');
  buffer.lines = lines.length === 0 ? [''] : [...lines];
  editor.buffer = buffer;
  return editor;
}

let io: MemoryIo;

beforeEach(() => {
  io = memoryIo();
  setEditorIo(io);
});

afterEach(() => {
  setEditorIo();
});

// ————————————————————————————————————————————————————————————————— buffer

describe('the buffer', () => {
  test('a trailing newline is the terminator, not an extra line', () => {
    const buffer = newBuffer('x.pine', 'a\nb\n');
    expect(buffer.lines).toEqual(['a', 'b']);
    expect(bufferText(buffer)).toBe('a\nb\n');
  });

  test('an empty file is one empty line, so the cursor always has a position', () => {
    expect(newBuffer('x.pine', '').lines).toEqual(['']);
  });

  test('CRLF is normalized on read and written back as LF', () => {
    expect(bufferText(newBuffer('x.pine', 'a\r\nb'))).toBe('a\nb\n');
  });
});

// ———————————————————————————————————————————————————————————————— motions

describe('motions', () => {
  test('w b e walk words, and w crosses the line break', () => {
    const editor = editorWith('let fast = 12', 'slow = 26');
    type(editor, 'w');
    expect(editor.buffer!.col).toBe(4);
    type(editor, 'w');
    expect(editor.buffer!.col).toBe(9);
    type(editor, 'b');
    expect(editor.buffer!.col).toBe(4);
    type(editor, 'e');
    expect(editor.buffer!.col).toBe(7);
    type(editor, 'wwww');
    expect(editor.buffer!.line).toBe(1);
  });

  test('0 ^ $ and a count on w', () => {
    const editor = editorWith('    ta.sma(close, 14)');
    type(editor, '$');
    expect(editor.buffer!.col).toBe(20);
    type(editor, '0');
    expect(editor.buffer!.col).toBe(0);
    type(editor, '^');
    expect(editor.buffer!.col).toBe(4);
    type(editor, '02w');
    expect(editor.buffer!.col).toBe(6);
  });

  test('gg and G, and 2G goes to a line', () => {
    const editor = editorWith('one', 'two', 'three');
    type(editor, 'G');
    expect(editor.buffer!.line).toBe(2);
    type(editor, 'gg');
    expect(editor.buffer!.line).toBe(0);
    type(editor, '2G');
    expect(editor.buffer!.line).toBe(1);
  });

  test('a vertical move remembers the column it was reaching for', () => {
    const editor = editorWith('a long first line', 'ab', 'another long line');
    type(editor, '$');
    const want = editor.buffer!.col;
    type(editor, 'j');
    expect(editor.buffer!.col).toBe(1); // clamped to the short line
    type(editor, 'j');
    expect(editor.buffer!.col).toBe(want);
  });

  test('f lands on a character, t stops before it, and a miss leaves the cursor', () => {
    const editor = editorWith('strategy.entry("long", strategy.long)');
    type(editor, 'f(');
    expect(editor.buffer!.col).toBe(14);
    type(editor, '0t(');
    expect(editor.buffer!.col).toBe(13);
    type(editor, '0fZ');
    expect(editor.buffer!.col).toBe(0);
    expect(editor.message).toContain('not on this line');
  });

  test('/ searches, n repeats, and a miss says so', () => {
    const editor = editorWith('close', 'open', 'close');
    type(editor, '/close<cr>');
    expect(editor.buffer!.line).toBe(2);
    type(editor, 'n');
    expect(editor.buffer!.line).toBe(0); // wraps
    type(editor, '/nope<cr>');
    expect(editor.message).toContain('pattern not found');
    expect(editor.buffer!.line).toBe(0);
  });
});

// ———————————————————————————————————————————————————————————— insert mode

describe('insert mode', () => {
  test('i types, esc returns to normal and steps the cursor back', () => {
    const editor = editorWith('bc');
    type(editor, 'ia<esc>');
    expect(editor.buffer!.lines[0]).toBe('abc');
    expect(editor.mode).toBe('normal');
    expect(editor.buffer!.col).toBe(0);
  });

  test('A appends, I goes to the first non-blank, o opens an indented line', () => {
    const editor = editorWith('    if close > open');
    type(editor, 'A and true<esc>');
    expect(editor.buffer!.lines[0]).toBe('    if close > open and true');
    type(editor, 'I// <esc>');
    expect(editor.buffer!.lines[0]).toBe('    // if close > open and true');
    type(editor, 'ostrategy.entry<esc>');
    expect(editor.buffer!.lines[1]).toBe('    strategy.entry');
  });

  test('enter splits the line and carries the indent', () => {
    const editor = editorWith('    a b');
    type(editor, 'f A<cr>');
    // `f ` puts the cursor on the space, `A` appends at the line end.
    expect(editor.buffer!.lines).toEqual(['    a b', '    ']);
  });

  test('the whole insert is one undo step', () => {
    const editor = editorWith('x');
    type(editor, 'ihello<esc>');
    expect(editor.buffer!.lines[0]).toBe('hellox');
    type(editor, 'u');
    expect(editor.buffer!.lines[0]).toBe('x');
    type(editor, '<c-r>');
    expect(editor.buffer!.lines[0]).toBe('hellox');
  });

  test('a printable key in insert mode is text, never a keymap action', () => {
    const editor = editorWith('');
    type(editor, 'i1jq:r<esc>');
    expect(editor.buffer!.lines[0]).toBe('1jq:r');
  });
});

// —————————————————————————————————————————————————————————————— operators

describe('operators', () => {
  test('dw stops before the next word; de eats the word', () => {
    const one = editorWith('let x = 1');
    type(one, 'dw');
    expect(one.buffer!.lines[0]).toBe('x = 1');

    const two = editorWith('let x = 1');
    type(two, 'de');
    expect(two.buffer!.lines[0]).toBe(' x = 1');
  });

  test('dd, 3dd and D', () => {
    const editor = editorWith('a', 'b', 'c', 'd', 'e');
    type(editor, 'dd');
    expect(editor.buffer!.lines).toEqual(['b', 'c', 'd', 'e']);
    type(editor, '3dd');
    expect(editor.buffer!.lines).toEqual(['e']);

    const line = editorWith('keep this');
    type(line, 'ftD');
    expect(line.buffer!.lines[0]).toBe('keep ');
  });

  test('cw replaces a word and leaves you in insert mode', () => {
    const editor = editorWith('fast = 12');
    type(editor, 'cwslow');
    expect(editor.mode).toBe('insert');
    expect(editor.buffer!.lines[0]).toBe('slow = 12');
  });

  test('cc rewrites the line but keeps its indent', () => {
    const editor = editorWith('    plot(close)');
    type(editor, 'ccplot(open)<esc>');
    expect(editor.buffer!.lines[0]).toBe('    plot(open)');
  });

  test('yy then p duplicates a line below; P puts above', () => {
    const editor = editorWith('one', 'two');
    type(editor, 'yyp');
    expect(editor.buffer!.lines).toEqual(['one', 'one', 'two']);
    type(editor, 'P');
    expect(editor.buffer!.lines).toEqual(['one', 'one', 'one', 'two']);
    expect(editor.message).toContain('1 line yanked');
  });

  test('an operator reaches a motion that takes an argument: dfx and dgg', () => {
    const find = editorWith('abc|def');
    type(find, 'df|');
    expect(find.buffer!.lines[0]).toBe('def');

    const top = editorWith('a', 'b', 'c');
    type(top, 'Gdgg');
    expect(top.buffer!.lines).toEqual(['']);
  });

  test('an operator is abandoned by a key that is not a motion', () => {
    const editor = editorWith('untouched');
    type(editor, 'dz');
    expect(editor.buffer!.lines[0]).toBe('untouched');
    expect(editor.operator).toBeNull();
  });

  test('>> and << shift by one indent step and leave blank lines alone', () => {
    const editor = editorWith('plot(close)', '');
    type(editor, '>>');
    expect(editor.buffer!.lines[0]).toBe('    plot(close)');
    type(editor, '<<');
    expect(editor.buffer!.lines[0]).toBe('plot(close)');
    type(editor, 'j>>');
    expect(editor.buffer!.lines[1]).toBe('');
  });

  test('x deletes under the cursor, J joins, r replaces one character', () => {
    const editor = editorWith('aXbc', 'tail');
    type(editor, 'lx');
    expect(editor.buffer!.lines[0]).toBe('abc');
    type(editor, 'J');
    expect(editor.buffer!.lines).toEqual(['abc tail']);
    type(editor, '0rZ');
    expect(editor.buffer!.lines[0]).toBe('Zbc tail');
  });

  test('dj is linewise, and dw at a line end does not pull the next line up', () => {
    const editor = editorWith('abcd', 'efgh');
    type(editor, 'lldj');
    expect(editor.buffer!.lines).toEqual(['']);

    const across = editorWith('abcd', 'efgh');
    type(across, 'lldw');
    expect(across.buffer!.lines).toEqual(['ab', 'efgh']);
  });
});

// ——————————————————————————————————————————————————————————— visual mode

describe('visual mode', () => {
  test('v selects inclusively and d takes the selection', () => {
    const editor = editorWith('abcdef');
    type(editor, 'vlld');
    expect(editor.buffer!.lines[0]).toBe('def');
    expect(editor.mode).toBe('normal');
  });

  test('V takes whole lines, and y reports what it copied', () => {
    const editor = editorWith('a', 'b', 'c');
    type(editor, 'Vjd');
    expect(editor.buffer!.lines).toEqual(['c']);

    const yank = editorWith('a', 'b');
    type(yank, 'Vjy');
    expect(yank.register.text).toEqual(['a', 'b']);
    expect(yank.register.linewise).toBe(true);
  });

  test('esc leaves the selection alone', () => {
    const editor = editorWith('abcdef');
    type(editor, 'vll<esc>');
    expect(editor.buffer!.lines[0]).toBe('abcdef');
    expect(editor.mode).toBe('normal');
    expect(editor.anchor).toBeNull();
  });

  test('> indents every line the selection touches', () => {
    const editor = editorWith('a', 'b', 'c');
    type(editor, 'Vj>');
    expect(editor.buffer!.lines).toEqual(['    a', '    b', 'c']);
  });
});

// ———————————————————————————————————————————————————————— the command line

describe('the ex command line', () => {
  test(':w writes the buffer, newline-terminated, and clears the modified flag', () => {
    const editor = initialEditor();
    openFile(editor, 'strats/new.pine', io);
    expect(editor.buffer!.isNew).toBe(true);
    type(editor, 'iplot(close)<esc>');
    expect(editor.buffer!.modified).toBe(true);

    type(editor, ':w<cr>');
    expect(io.store['strats/new.pine']).toBe('plot(close)\n');
    expect(editor.buffer!.modified).toBe(false);
    expect(editor.buffer!.isNew).toBe(false);
    expect(editor.message).toContain('1L written');
  });

  test(':w <path> writes elsewhere and the buffer follows it', () => {
    const editor = editorWith('plot(close)');
    type(editor, ':w copy.pine<cr>');
    expect(io.store['copy.pine']).toBe('plot(close)\n');
    expect(editor.buffer!.path).toBe('copy.pine');
  });

  test(':q refuses to discard unwritten changes; :q! and :wq do not', () => {
    const editor = editorWith('a');
    type(editor, 'ix<esc>:q<cr>');
    expect(editor.buffer).not.toBeNull();
    expect(editor.message).toContain('E37');

    type(editor, ':q!<cr>');
    expect(editor.buffer).toBeNull();

    const written = editorWith('a');
    type(written, 'ix<esc>:wq<cr>');
    expect(written.buffer).toBeNull();
    expect(io.store['demo.pine']).toBe('xa\n');
  });

  test(':e opens a file, and refuses to abandon an unwritten one', () => {
    io.store['other.pine'] = 'plot(open)\n';
    const editor = editorWith('a');
    type(editor, 'ix<esc>:e other.pine<cr>');
    expect(editor.message).toContain('E37');
    expect(editor.buffer!.path).toBe('demo.pine');

    type(editor, ':e! other.pine<cr>');
    expect(editor.buffer!.path).toBe('other.pine');
    expect(editor.buffer!.lines).toEqual(['plot(open)']);
  });

  test(':42 jumps to a line and :set nonu drops the gutter', () => {
    const editor = editorWith('a', 'b', 'c', 'd');
    type(editor, ':3<cr>');
    expect(editor.buffer!.line).toBe(2);
    type(editor, ':set nonu<cr>');
    expect(editor.gutter).toBe(false);
  });

  test('an unimplemented command says so rather than doing nothing', () => {
    const editor = editorWith('a');
    type(editor, ':sort<cr>');
    expect(editor.message).toContain('E492');
    expect(editor.error).toBe(true);
  });

  test('esc abandons the command line without running it', () => {
    const editor = editorWith('a');
    type(editor, ':q!<esc>');
    expect(editor.buffer).not.toBeNull();
    expect(editor.mode).toBe('normal');
  });
});

// ————————————————————————————————————————————————————————————————— syntax

describe('Pine highlighting', () => {
  test('a comment runs to the end of the line', () => {
    const spans = highlight('plot(close) // why');
    expect(spans.some((s) => s.style === SYNTAX.comment && s.start === 12)).toBe(true);
  });

  test('a version annotation is not just a comment', () => {
    expect(highlight('//@version=6')[0]?.style).toBe(SYNTAX.annotation);
  });

  test('namespaces and bar series are builtins; the member after the dot is not', () => {
    const spans = highlight('x = ta.sma(close, 14)');
    const at = (start: number) => spans.find((s) => s.start === start)?.style;
    expect(at(4)).toBe(SYNTAX.builtin); // ta
    expect(at(7)).toBeUndefined(); // sma
    expect(at(11)).toBe(SYNTAX.builtin); // close
    expect(at(18)).toBe(SYNTAX.number); // 14
  });

  test('strings are one span, escapes included, and keywords are keywords', () => {
    const spans = highlight('if str.contains(s, "a\\"b")');
    expect(spans[0]).toEqual({ start: 0, length: 2, style: SYNTAX.keyword });
    // `"a\"b"` — the escaped quote does not end the string.
    expect(spans.some((s) => s.style === SYNTAX.string && s.length === 6)).toBe(true);
  });

  test('a dotted call is not read as a number', () => {
    expect(
      highlight('math.max(1, 2)').some((s) => s.style === SYNTAX.number && s.start === 4),
    ).toBe(false);
  });
});

// ———————————————————————————————————————————————————————————————— the page

function stubTerminal(cols = 168, rows = 46): Terminal {
  const keyHandlers = new Set<(key: Key) => void>();
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
    onResizeEvent() {
      return () => {};
    },
  } as unknown as Terminal;
}

describe('the EDITOR page', () => {
  let state: AppState;

  beforeEach(() => {
    resetRunIds();
    state = initialState();
    state.page = 'editor';
    io.store['strats/demo.pine'] = [
      '//@version=6',
      'strategy("Demo")',
      'length = input.int(14, "RSI length")',
      'stop = input.float(2.4, title = "Stop ATR")',
      'plot(ta.rsi(close, length))',
    ].join('\n');
    openFile(state.editor, 'strats/demo.pine', io);
  });

  const app = (cols = 168, rows = 46): App =>
    new App({ terminal: stubTerminal(cols, rows), state, cwd: '/tmp/pinetop-test' });

  const text = (cols = 168, rows = 46): string =>
    app(cols, rows)
      .render(cols, rows)
      .map((line) => stripAnsi(line))
      .join('\n');

  test('the sidebar and the buffer are both on screen', () => {
    const screen = text();
    expect(screen).toContain('FILES');
    expect(screen).toContain('INPUTS');
    expect(screen).toContain('DEMO'); // the buffer pane is titled for its file
    expect(screen).toContain('strategy("Demo")');
  });

  test('the gutter numbers the lines', () => {
    const screen = text();
    expect(screen).toMatch(/\s1\s+\/\/@version=6/);
    expect(screen).toMatch(/\s5\s+plot\(ta\.rsi/);
  });

  test('rows past the end of the buffer are marked, not left blank', () => {
    expect(text()).toContain('~');
  });

  test('the INPUTS outline reads the buffer, not the file on disk', () => {
    expect(bufferInputs(state.editor)).toEqual(['Stop ATR', 'RSI length']);
    expect(text()).toContain('RSI length');

    // Rename it in the buffer and the outline follows before anything is written.
    type(state.editor, ':3<cr>/RSI<cr>cwLookback<esc>');
    expect(bufferInputs(state.editor)).toContain('Lookback length');
    expect(io.store['strats/demo.pine']).not.toContain('Lookback');
  });

  test('the buffer draws a cursor cell, since the terminal cursor is hidden', () => {
    state.panes.editor.focus = 'editor';
    const raw = app().render(168, 46).join('\n');
    expect(raw).toContain('\x1b[1;7m');
  });

  test('the visual selection is drawn', () => {
    state.panes.editor.focus = 'editor';
    type(state.editor, 'vll');
    expect(app().render(168, 46).join('\n')).toContain('\x1b[7m');
  });

  test('the breadcrumb names the file and flags unwritten changes', () => {
    expect(text()).toContain('strats/demo.pine');
    expect(text()).not.toContain('unwritten changes');
    type(state.editor, 'ix<esc>');
    expect(text()).toContain('unwritten changes');
  });

  test('it renders at a cramped 80×24 and every line fits', () => {
    for (const line of app(80, 24).render(80, 24)) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(80);
    }
  });

  test('with no file open it says how to open one', () => {
    state.editor.buffer = null;
    expect(text()).toContain('no file open');
  });
});

// —————————————————————————————————————————————————————————— key ownership

describe('who owns the keyboard', () => {
  let state: AppState;

  beforeEach(() => {
    resetRunIds();
    state = initialState();
    state.page = 'editor';
    io.store['a.pine'] = 'plot(close)\n';
    openFile(state.editor, 'a.pine', io);
  });

  const app = (): App => new App({ terminal: stubTerminal(), state, cwd: '/tmp/pinetop-test' });

  test('from the FILES pane the keyboard is pinetop’s: digits switch pages', () => {
    state.panes.editor.focus = 'files';
    app().onKey({ name: '2', text: '2' });
    expect(state.page).toBe('backtest');
  });

  test('from the buffer the keyboard is vim’s: a digit is a count, not a page', () => {
    state.panes.editor.focus = 'editor';
    const instance = app();
    instance.onKey({ name: '2', text: '2' });
    expect(state.page).toBe('editor');
    expect(state.editor.count).toBe('2');

    instance.onKey({ name: 'd' });
    instance.onKey({ name: 'd' });
    expect(state.editor.buffer!.lines).toEqual(['']);
  });

  test('tab always leaves the buffer, so it is never a keyboard trap', () => {
    state.panes.editor.focus = 'editor';
    app().onKey({ name: 'tab' });
    expect(state.panes.editor.focus).toBe('inputs');
  });

  test('ctrl-c is never the editor’s, even mid-insert', () => {
    state.panes.editor.focus = 'editor';
    const instance = app();
    instance.onKey({ name: 'i', text: 'i' });
    expect(state.editor.mode).toBe('insert');
    instance.onKey({ name: 'ctrl-c' });
    expect(state.quit).toBe(true);
  });

  test('q inside the buffer explains itself instead of quitting the app', () => {
    state.panes.editor.focus = 'editor';
    app().onKey({ name: 'q', text: 'q' });
    expect(state.quit).toBe(false);
    expect(state.editor.message).toContain(':q closes the buffer');
  });

  test('q elsewhere warns once before discarding an unwritten buffer', () => {
    state.panes.editor.focus = 'files';
    type(state.editor, 'ix<esc>');
    const instance = app();

    instance.onKey({ name: 'q', text: 'q' });
    expect(state.quit).toBe(false);
    expect(state.status).toContain('unwritten changes');

    instance.onKey({ name: 'q', text: 'q' });
    expect(state.quit).toBe(true);
  });

  test('a written buffer quits on the first q', () => {
    state.panes.editor.focus = 'files';
    const instance = app();
    instance.onKey({ name: 'q', text: 'q' });
    expect(state.quit).toBe(true);
  });

  test('↑ on FILES opens the selection into the buffer and focuses it', () => {
    state.editor.buffer = null;
    state.panes.editor.focus = 'files';
    const instance = app();
    // Whatever discovery found in this project — the assertion is the wiring, not
    // the file: ↵ either opens something and moves focus, or says there is none.
    instance.onKey({ name: 'enter' });
    if (state.editor.buffer != null) expect(state.panes.editor.focus).toBe('editor');
    else expect(state.status).toContain('.pine');
  });
});
