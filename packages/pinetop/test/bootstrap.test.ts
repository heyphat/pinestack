import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrap } from '../src/app.js';
import { COMMANDS } from '../src/flags/schema.js';
import { initialState } from '../src/state.js';

/** A throwaway project directory with the given .pine files. */
function project(files: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pinetop-boot-'));
  for (const file of files) {
    const path = join(dir, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '//@version=5\nstrategy("x")\n', 'utf8');
  }
  return dir;
}

describe('a bare `pinetop` is a usable starting point', () => {
  test('one .pine in the project is loaded — there is nothing else it could mean', () => {
    const dir = project(['mean-rev.pine']);
    try {
      const state = initialState();
      const status = bootstrap(state, dir);
      for (const command of COMMANDS) {
        expect(state.flags[command].scripts[0]).toContain('mean-rev.pine');
      }
      expect(status).toContain('mean-rev');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('several .pine files are left alone, and the status says what to press', () => {
    const dir = project(['a.pine', 'b.pine', 'nested/c.pine']);
    try {
      const state = initialState();
      const status = bootstrap(state, dir);
      expect(state.flags.backtest.scripts).toEqual([]);
      expect(status).toContain('3 strategies');
      expect(status).toContain('↵');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an empty project says how to set a script rather than looking broken', () => {
    const dir = project([]);
    try {
      const state = initialState();
      expect(bootstrap(state, dir)).toContain('no .pine found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('nothing is guessed beyond the script — no symbol, no provider', () => {
    const dir = project(['only.pine']);
    try {
      const state = initialState();
      bootstrap(state, dir);
      expect(state.flags.backtest.values['symbol']).toBeUndefined();
      expect(state.flags.backtest.values['provider']).toBeUndefined();
      expect(state.flags.backtest.values['tf']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the welcome overlay appears exactly once per project', () => {
  test('a project with nothing configured gets it', () => {
    const dir = project(['a.pine', 'b.pine']);
    try {
      const state = initialState();
      bootstrap(state, dir);
      expect(state.overlay.kind).toBe('welcome');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a project with resumed flags does not', () => {
    const dir = project(['a.pine', 'b.pine']);
    try {
      const state = initialState();
      state.flags.backtest.values['symbol'] = 'BTCUSDT';
      bootstrap(state, dir);
      expect(state.overlay.kind).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a script supplied on the command line counts as configured', () => {
    const dir = project(['a.pine', 'b.pine']);
    try {
      const state = initialState();
      state.flags.backtest.scripts = ['a.pine'];
      bootstrap(state, dir);
      expect(state.overlay.kind).toBe('none');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a saved flag that is merely false does not count as configured', () => {
    const dir = project(['a.pine', 'b.pine']);
    try {
      const state = initialState();
      state.flags.backtest.values['trades'] = false;
      bootstrap(state, dir);
      expect(state.overlay.kind).toBe('welcome');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an already-loaded script is not overwritten by the lone-script rule', () => {
    const dir = project(['only.pine']);
    try {
      const state = initialState();
      state.flags.backtest.scripts = ['chosen.pine'];
      bootstrap(state, dir);
      expect(state.flags.backtest.scripts).toEqual(['chosen.pine']);
      // Commands that had nothing still get the discovered one.
      expect(state.flags.sweep.scripts[0]).toContain('only.pine');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
