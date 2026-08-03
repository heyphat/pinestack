import { describe, expect, test } from 'bun:test';
import { parseArgs } from '../src/cli.js';

describe('version and help flags mirror pinerun', () => {
  test('all three version spellings, as the CLI accepts them', () => {
    // pinerun dispatches `-v` / `--version` / `version` alike; so does pinetop.
    for (const argv of [['--version'], ['-v'], ['version']]) {
      expect(parseArgs(argv).version).toBe(true);
    }
  });

  test('all three help spellings', () => {
    for (const argv of [['--help'], ['-h'], ['help']]) {
      expect(parseArgs(argv).help).toBe(true);
    }
  });

  test('a bare word is a subcommand only in first position', () => {
    // Otherwise `pinetop version.pine` — or any script whose name collides —
    // would stop being runnable.
    expect(parseArgs(['strat.pine', 'version']).version).toBe(false);
    expect(parseArgs(['strat.pine', 'help']).help).toBe(false);
  });

  test('a bare subcommand is not also taken as a script path', () => {
    expect(parseArgs(['version']).scripts).toEqual([]);
    expect(parseArgs(['help']).scripts).toEqual([]);
  });

  test('a .pine named like a subcommand still loads', () => {
    expect(parseArgs(['version.pine']).scripts).toEqual(['version.pine']);
    expect(parseArgs(['version.pine']).version).toBe(false);
  });

  test('flags after a bare subcommand are still parsed', () => {
    const args = parseArgs(['version', '--pinerun', './dist/pinerun']);
    expect(args.version).toBe(true);
    expect(args.bin).toBe('./dist/pinerun');
  });
});

describe('argument parsing', () => {
  test('scripts are positional', () => {
    expect(parseArgs(['a.pine', 'b.pine']).scripts).toEqual(['a.pine', 'b.pine']);
  });

  test('--page only accepts a real page name, including LIVE', () => {
    expect(parseArgs(['--page', 'sweep']).page).toBe('sweep');
    expect(parseArgs(['--page', 'live']).page).toBe('live');
    expect(parseArgs(['--page', 'nonsense']).page).toBeUndefined();
  });

  test('preloads are collected by name', () => {
    const args = parseArgs(['--symbol', 'BTCUSDT', '--tf', '4h', '--limit', '500']);
    expect(args.preload).toEqual({ symbol: 'BTCUSDT', tf: '4h', limit: '500' });
  });

  test('--input is repeatable and splits on the first =', () => {
    const args = parseArgs(['--input', 'fast=5', '--input', 'sess=09:30']);
    expect(args.inputs).toEqual([
      { name: 'fast', value: '5' },
      { name: 'sess', value: '09:30' },
    ]);
  });

  test('--input without an = is ignored rather than half-parsed', () => {
    expect(parseArgs(['--input', 'oops']).inputs).toEqual([]);
  });

  test('--check-flags, --pinerun, and --pinelive', () => {
    const args = parseArgs([
      '--check-flags',
      '--pinerun',
      '/usr/local/bin/pinerun',
      '--pinelive',
      '/usr/local/bin/pinelive',
    ]);
    expect(args.checkFlags).toBe(true);
    expect(args.bin).toBe('/usr/local/bin/pinerun');
    expect(args.pineliveBin).toBe('/usr/local/bin/pinelive');
  });

  test('an unknown flag is not swallowed as a script', () => {
    expect(parseArgs(['--nonsense']).scripts).toEqual([]);
  });
});

describe('upgrade, matching `pinerun upgrade`', () => {
  test('bare `upgrade` is the subcommand', () => {
    expect(parseArgs(['upgrade']).upgrade).toBe(true);
    expect(parseArgs(['upgrade']).upgradeCheck).toBe(false);
  });

  test('`upgrade --check` reports without changing anything', () => {
    const args = parseArgs(['upgrade', '--check']);
    expect(args.upgrade).toBe(true);
    expect(args.upgradeCheck).toBe(true);
  });

  test('it is a first-position subcommand, so a script can still be named that', () => {
    expect(parseArgs(['upgrade.pine']).upgrade).toBe(false);
    expect(parseArgs(['upgrade.pine']).scripts).toEqual(['upgrade.pine']);
    expect(parseArgs(['strat.pine', 'upgrade']).upgrade).toBe(false);
  });

  test('`upgrade` is not also taken as a script path', () => {
    expect(parseArgs(['upgrade']).scripts).toEqual([]);
  });

  test('--check alone does not imply upgrade', () => {
    // It only qualifies the subcommand; on its own it must not self-update.
    expect(parseArgs(['--check']).upgrade).toBe(false);
  });
});
