import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

// Every test here spawns `bun src/cli.ts`, which transpiles the whole CLI
// module graph per spawn — seconds on a cold CI runner, past the 5s default.
setDefaultTimeout(30_000);
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
let dir: string;
let sourceOff: string;
let sourceOn: string;

function run(...args: string[]): { code: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync(['bun', CLI, ...args], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    code: child.exitCode ?? -1,
    stdout: new TextDecoder().decode(child.stdout),
    stderr: new TextDecoder().decode(child.stderr),
  };
}

function csvRows(step: number, count: number, omitted = new Set<number>()): string {
  const rows = ['time,open,high,low,close,volume'];
  for (let index = 0; index < count; index++) {
    if (omitted.has(index)) continue;
    const value = 100 + index;
    rows.push(`${index * step},${value},${value + 1},${value - 1},${value + 0.25},${10 + index}`);
  }
  return rows.join('\n');
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinerun-csv-exact-cli-'));
  sourceOff = join(dir, 'off.pine');
  sourceOn = join(dir, 'on.pine');
  writeFileSync(sourceOff, '//@version=6\nstrategy("off", use_bar_magnifier=false)\nplot(close)\n');
  writeFileSync(sourceOn, '//@version=6\nstrategy("on", use_bar_magnifier=true)\nplot(close)\n');
  writeFileSync(join(dir, 'X_1h.csv'), csvRows(3_600, 2));
  writeFileSync(join(dir, 'X_10m.csv'), csvRows(600, 12, new Set([3])));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function mixedArgs(): string[] {
  return [
    '--symbol',
    'CSV:X',
    '--tf',
    '1h',
    '--provider',
    'binance',
    '--data-dir',
    dir,
    '--workers',
    'local',
    '--no-cache',
    '--json',
  ];
}

describe('CSV exact CLI claims', () => {
  test('help documents assertions, calendar path, week anchor, and complete-record risk', () => {
    for (const command of ['scan', 'backtest', 'compare', 'portfolio', 'sweep', 'walkforward']) {
      const result = run(command, '--help');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('--csv-alignment');
      expect(result.stdout).toContain('--csv-week-anchor');
      expect(result.stdout).toContain('--csv-calendar');
      expect(result.stdout).toContain('--csv-complete-record');
    }
    const scan = run('scan', '--help').stdout;
    expect(scan).toContain('host assertion');
    expect(scan).toContain('cannot prove session data was labelled correctly');
  });

  test('CSV claims configure a routed leaf without requiring --provider csv', () => {
    const result = run('backtest', sourceOff, ...mixedArgs(), '--csv-alignment=utc-24x7');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, symbol: 'CSV:X' });
  });

  test('strict scalar, alignment, week-anchor, and conflict validation fails before data use', () => {
    const cases: Array<[string[], string]> = [
      [['--csv-alignment', 'utc-24x7'], 'require --data-dir'],
      [['--data-dir', dir, '--csv-alignment', 'exchange-calendar'], 'only utc-24x7'],
      [['--data-dir', dir, '--csv-week-anchor', 'Monday'], 'requires --csv-alignment'],
      [
        ['--data-dir', dir, '--csv-alignment', 'utc-24x7', '--csv-week-anchor', '2024-02-30'],
        'real UTC calendar date',
      ],
      [
        ['--data-dir', dir, '--csv-alignment', 'utc-24x7', '--csv-week-anchor', '1.5'],
        'strict YYYY-MM-DD or integer seconds',
      ],
      [
        ['--data-dir', dir, '--csv-alignment', 'utc-24x7', '--csv-calendar', 'calendar.json'],
        'cannot be used with',
      ],
      [['--data-dir', dir, '--csv-complete-record'], 'requires explicit'],
      [['--symbol', 'CSV:X', '--symbol', 'CSV:Y'], 'duplicate scalar option --symbol'],
    ];
    for (const [flags, message] of cases) {
      const result = run('backtest', sourceOff, '--symbol', 'CSV:X', '--tf', '1h', ...flags);
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(message);
    }
  });

  test('strict week anchors accept a real UTC date and safe integer seconds', () => {
    for (const anchor of ['1970-01-01', '-259200']) {
      const result = run(
        'backtest',
        sourceOff,
        ...mixedArgs(),
        '--csv-alignment',
        'utc-24x7',
        '--csv-week-anchor',
        anchor,
      );
      expect(result.code, result.stderr).toBe(0);
    }
  });

  test('calendar JSON rejects unknown keys and unsafe intervals, and accepts periods', () => {
    const calendar = join(dir, 'calendar.json');
    const base = {
      calendarId: 'TEST',
      version: '1',
      coverage: { from: 0, to: 86_400 },
      sessions: [{ from: 0, to: 3_600 }],
      periods: { '1d': [{ from: 0, to: 86_400 }] },
    };
    for (const [value, message] of [
      [{ ...base, timezone: 'UTC' }, 'unknown key "timezone"'],
      [{ ...base, sessions: [{ from: 0, to: 3_600, label: 'open' }] }, 'unknown key "label"'],
      [{ ...base, coverage: { from: 0, to: Number.MAX_SAFE_INTEGER + 1 } }, 'safe integer'],
    ] as const) {
      writeFileSync(calendar, JSON.stringify(value));
      const result = run('backtest', sourceOff, ...mixedArgs(), '--csv-calendar', calendar);
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(message);
    }
    writeFileSync(calendar, JSON.stringify(base));
    const valid = run('backtest', sourceOff, ...mixedArgs(), '--csv-calendar', calendar);
    expect(valid.code, valid.stderr).toBe(0);
  });

  test('bars-only rejects a sparse exact target while complete-record authenticates it', () => {
    const barsOnly = run('backtest', sourceOn, ...mixedArgs(), '--csv-alignment', 'utc-24x7');
    expect(barsOnly.code).not.toBe(0);
    expect(JSON.parse(barsOnly.stdout).failure).toMatchObject({
      code: 'incomplete-required-coverage',
      permanent: true,
    });

    const completeLocal = run(
      'backtest',
      sourceOn,
      ...mixedArgs(),
      '--csv-alignment',
      'utc-24x7',
      '--csv-complete-record',
    );
    expect(completeLocal.code, completeLocal.stderr).toBe(0);
    expect(JSON.parse(completeLocal.stdout)).toMatchObject({
      ok: true,
      strategy: { barMagnifier: { requested: true, active: true } },
    });

    const scanArgs = [
      sourceOn,
      '--symbols',
      'CSV:X',
      '--tf',
      '1h',
      '--provider',
      'binance',
      '--data-dir',
      dir,
      '--csv-alignment',
      'utc-24x7',
      '--csv-complete-record',
      '--no-cache',
      '--json',
    ];
    const local = run('scan', ...scanArgs, '--workers', 'local');
    const worker = run('scan', ...scanArgs, '--workers', '1');
    expect(local.code, local.stderr).toBe(0);
    expect(worker.code, worker.stderr).toBe(0);
    expect(JSON.parse(worker.stdout).ranked[0].strategy).toEqual(
      JSON.parse(local.stdout).ranked[0].strategy,
    );
  });
});
