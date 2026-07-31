import { describe, expect, test } from 'bun:test';
import {
  Screen,
  displayWidth,
  drawPane,
  padEnd,
  padStart,
  stripAnsi,
  truncate,
} from '../src/render/screen.js';
import { fitColumns, drawLeader, drawRow, type Column } from '../src/render/table.js';
import { STYLE, gradeStyle, signStyle } from '../src/render/theme.js';
import { PassThrough } from 'node:stream';
import { Terminal, decodeKeys } from '../src/terminal.js';

/** Plain-text view of the screen, for asserting on layout. */
function plain(screen: Screen): string[] {
  return screen.render().map((line) => stripAnsi(line).trimEnd());
}

describe('fixed grid, no reflow, no scroll (§4.3.a)', () => {
  test('a line longer than the screen is cut, not wrapped', () => {
    const screen = new Screen(10, 3);
    screen.text(0, 0, 'abcdefghijklmnop');
    const lines = plain(screen);
    expect(lines[0]).toBe('abcdefghij');
    expect(lines[1]).toBe('');
  });

  test('a write is clipped to its rectangle', () => {
    const screen = new Screen(20, 3);
    screen.text(0, 0, '....................');
    screen.text(2, 0, 'XXXXXXXXXX', STYLE.none, { x: 2, y: 0, w: 4, h: 1 });
    expect(plain(screen)[0]).toBe('..XXXX..............');
  });

  test('a block is clipped on both axes', () => {
    const screen = new Screen(12, 4);
    screen.block(0, 0, 'aaaaaaaaaaaaaa\nbbbbbbbbbbbbbb\ncccccccccccccc', STYLE.none, {
      x: 0,
      y: 0,
      w: 5,
      h: 2,
    });
    const lines = plain(screen);
    expect(lines[0]).toBe('aaaaa');
    expect(lines[1]).toBe('bbbbb');
    expect(lines[2]).toBe('');
  });
});

describe('pane titles are never clipped (§4.4)', () => {
  test('the title survives at the pane width', () => {
    const screen = new Screen(24, 4);
    drawPane(screen, { x: 0, y: 0, w: 24, h: 4 }, { title: 'MONTHLY RETURNS %' });
    expect(plain(screen)[0]).toContain('MONTHLY RETURNS %');
  });

  test('a legend is dropped rather than colliding with the title', () => {
    const screen = new Screen(24, 4);
    drawPane(
      screen,
      { x: 0, y: 0, w: 24, h: 4 },
      { title: 'MONTHLY RETURNS %', legend: '2019 → 2025' },
    );
    const top = plain(screen)[0]!;
    expect(top).toContain('MONTHLY RETURNS %');
    expect(top).not.toContain('2019 → 2025');
  });

  test('a legend that fits is drawn on the top border', () => {
    const screen = new Screen(60, 4);
    drawPane(
      screen,
      { x: 0, y: 0, w: 60, h: 4 },
      { title: 'CHARTS', legend: 'net 19% · 140 samples' },
    );
    expect(plain(screen)[0]).toContain('net 19% · 140 samples');
  });

  test('a focused pane is marked with ◆ before its title (§4.2.c)', () => {
    const screen = new Screen(30, 4);
    drawPane(screen, { x: 0, y: 0, w: 30, h: 4 }, { title: 'RANKED', focused: true });
    expect(plain(screen)[0]).toContain('◆ RANKED');
  });

  test('the interior excludes the border', () => {
    const screen = new Screen(20, 6);
    const inner = drawPane(screen, { x: 2, y: 1, w: 10, h: 5 }, { title: 'X' });
    expect(inner).toEqual({ x: 3, y: 2, w: 8, h: 3 });
  });
});

describe('column fitting drops the least important first (§4.4)', () => {
  const columns: Column[] = [
    { key: 'n', header: '#', width: 3, priority: 90 },
    { key: 'bars', header: 'BARS', width: 8, priority: 10 },
    { key: 'net', header: 'NET%', width: 8, priority: 50 },
    { key: 'eff', header: 'EFF', width: 7, priority: 99 },
  ];

  test('everything fits when there is room', () => {
    const fitted = fitColumns(columns, 80);
    expect(fitted.columns).toHaveLength(4);
    expect(fitted.dropped).toEqual([]);
  });

  test('the payoff column survives a narrow pane', () => {
    const fitted = fitColumns(columns, 12);
    expect(fitted.columns.map((c) => c.key)).toContain('eff');
    expect(fitted.dropped).toContain('BARS');
  });

  test('what was dropped is reported, never silently lost (§6)', () => {
    const fitted = fitColumns(columns, 4);
    expect(fitted.dropped.length).toBeGreaterThan(0);
    expect(fitted.columns).toHaveLength(1);
    expect(fitted.columns[0]!.key).toBe('eff');
  });
});

describe('leader rows', () => {
  test('the value is flush right and the leaders absorb the slack', () => {
    const screen = new Screen(30, 1);
    drawLeader(screen, { x: 0, y: 0, w: 30, h: 1 }, 0, 'Sharpe', '1.42');
    const line = plain(screen)[0]!;
    expect(line.startsWith('Sharpe ')).toBe(true);
    expect(line.endsWith('1.42')).toBe(true);
    expect(line).toContain('·');
    expect(line).toHaveLength(30);
  });

  test('a pending edit carries the marker', () => {
    const screen = new Screen(30, 1);
    drawLeader(screen, { x: 0, y: 0, w: 30, h: 1 }, 0, 'stopAtr', '2.4 → 1.8', { marker: '● ' });
    expect(plain(screen)[0]).toContain('● stopAtr');
  });
});

describe('rows land on fixed tracks', () => {
  test('a long cell is cut instead of pushing its neighbour right', () => {
    const columns: Column[] = [
      { key: 'a', header: 'A', width: 6 },
      { key: 'b', header: 'B', width: 6 },
    ];
    const screen = new Screen(20, 2);
    drawRow(screen, { x: 0, y: 0, w: 20, h: 2 }, 0, columns, {
      a: 'aaaaaaaaaaaa',
      b: 'bb',
    });
    const line = plain(screen)[0]!;
    expect(line.slice(0, 6)).toHaveLength(6);
    expect(line.slice(7, 9)).toBe('bb');
  });
});

describe('styled blocks carry colour onto cells', () => {
  test('SGR codes become cell styles instead of printed text', () => {
    const screen = new Screen(10, 1);
    screen.styledBlock(0, 0, 'a\x1b[32mb\x1b[39mc');
    expect(plain(screen)[0]).toBe('abc');
    expect(screen.render()[0]).toContain('\x1b[32m');
  });

  test('an escape does not consume a cell', () => {
    const screen = new Screen(4, 1);
    screen.styledBlock(0, 0, '\x1b[31m####');
    expect(plain(screen)[0]).toBe('####');
  });
});

describe('width measurement', () => {
  test('ANSI does not count', () => {
    expect(displayWidth('\x1b[32mabc\x1b[0m')).toBe(3);
  });

  test('braille and box drawing are single width', () => {
    expect(displayWidth('⣿⠿│┌')).toBe(4);
  });

  test('truncate marks the cut', () => {
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(truncate('abc', 5)).toBe('abc');
  });

  test('padding is exact', () => {
    expect(padEnd('ab', 5)).toBe('ab   ');
    expect(padStart('ab', 5)).toBe('   ab');
    expect(padEnd('abcdef', 3)).toHaveLength(3);
  });
});

describe('value grading mirrors the CLI quintiles (§4.7)', () => {
  test('the worst value grades red and the best bright green', () => {
    const all = [1, 2, 3, 4, 5];
    expect(gradeStyle(1, all)).toBe('31');
    expect(gradeStyle(5, all)).toBe('1;32');
  });

  test('a flat series grades plain', () => {
    expect(gradeStyle(2, [2, 2, 2])).toBe(STYLE.none);
  });

  test('losses are never the accent colour', () => {
    expect(signStyle(-1)).toBe(STYLE.negative);
    expect(signStyle(-1)).not.toBe(STYLE.accent);
  });
});

describe('key decoding', () => {
  test('printable keys carry their text', () => {
    expect(decodeKeys('r')).toEqual([{ name: 'r', text: 'r' }]);
  });

  test('arrows and shift-tab decode from their escape sequences', () => {
    expect(decodeKeys('\x1b[A')[0]!.name).toBe('up');
    expect(decodeKeys('\x1b[B')[0]!.name).toBe('down');
    expect(decodeKeys('\x1b[Z')[0]!.name).toBe('shift-tab');
  });

  test('control keys normalize to ctrl-<letter>', () => {
    expect(decodeKeys('\x18')[0]!.name).toBe('ctrl-x');
    expect(decodeKeys('\x10')[0]!.name).toBe('ctrl-p');
  });

  test('enter, tab and backspace', () => {
    expect(decodeKeys('\r')[0]!.name).toBe('enter');
    expect(decodeKeys('\t')[0]!.name).toBe('tab');
    expect(decodeKeys('\x7f')[0]!.name).toBe('backspace');
  });

  test('a lone escape is escape', () => {
    expect(decodeKeys('\x1b')).toEqual([{ name: 'escape' }]);
  });

  test('a chunk carrying several keys decodes to several keys', () => {
    expect(decodeKeys('abc').map((k) => k.name)).toEqual(['a', 'b', 'c']);
  });

  test('an unknown CSI does not leak its parameter bytes as typed text', () => {
    const keys = decodeKeys('\x1b[200~');
    expect(keys.every((k) => k.text == null)).toBe(true);
  });
});

describe('suspending the terminal for another program', () => {
  /** A stdin/stdout pair the Terminal can drive without a real TTY. */
  function fakeTty(): {
    stdin: PassThrough & { isTTY?: boolean };
    stdout: PassThrough & { columns: number; rows: number; isTTY: boolean };
  } {
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    const stdout = Object.assign(new PassThrough(), {
      columns: 100,
      rows: 30,
      isTTY: true,
    });
    stdout.resume(); // swallow the escape sequences the Terminal writes
    return { stdin, stdout };
  }

  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  test('keys typed while suspended are discarded, not replayed as commands', async () => {
    // The bug this guards: `e` hands the terminal to $EDITOR, and the `:wq` that
    // quit vim came back to pinetop — where `:` opens the command palette and
    // `wq` lands in its filter. Input that arrived while we were not listening
    // belongs to the program we suspended for.
    const { stdin, stdout } = fakeTty();
    const terminal = new Terminal({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    const seen: string[] = [];
    terminal.onKey((key) => seen.push(key.name));

    terminal.open();
    await tick();

    terminal.close(); // the editor now owns the terminal
    stdin.write(':wq\r');
    await tick();

    terminal.open(); // and we take it back
    await tick();
    expect(seen).toEqual([]);

    // Real keys after the hand-off still arrive.
    stdin.write('j');
    await tick();
    expect(seen).toEqual(['j']);
    terminal.close();
  });
});
