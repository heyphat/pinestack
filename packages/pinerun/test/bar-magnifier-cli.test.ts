import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { pinerCapabilities } from '../src/index.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// These tests are about PERMANENT failures serializing through every command,
// not about one particular code. Which code appears depends on how far exact
// mode gets: an incapable engine stops at capability preflight, while a capable
// one proceeds and the CSV fixture provider (no proven alignment) fails
// acquisition instead. Keeping both alive preserves the coverage on both engines.
const EXACT_FAILURE_CODE = pinerCapabilities().capable
  ? 'unknown-alignment'
  : 'piner-bar-magnifier-capability-unavailable';
const T0 = 1_700_000_000;
let dir: string;
let sourceOn: string;
let sourceOff: string;
let indicator: string;

function run(...args: string[]): { code: number; stdout: string; stderr: string } {
  const process = Bun.spawnSync(['bun', CLI, ...args], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...processEnv(), NO_COLOR: '1' },
  });
  return {
    code: process.exitCode ?? -1,
    stdout: new TextDecoder().decode(process.stdout),
    stderr: new TextDecoder().decode(process.stderr),
  };
}

function processEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

function dataArgs(): string[] {
  return ['--symbol', 'X', '--tf', '1h', '--provider', 'csv', '--data-dir', dir, '--no-cache'];
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinerun-magnifier-cli-'));
  sourceOn = join(dir, 'on.pine');
  sourceOff = join(dir, 'off.pine');
  indicator = join(dir, 'indicator.pine');

  const strategy = (requested: boolean) => `//@version=6
strategy("fixture", use_bar_magnifier=${requested ? 'true' : 'false'}, initial_capital=10000)
bias = input.int(0, "bias")
if bar_index == 1
    strategy.entry("L", strategy.long)
if bar_index == 8
    strategy.close("L")
plot(close + bias, "value")
`;
  writeFileSync(sourceOn, strategy(true));
  writeFileSync(sourceOff, strategy(false));
  writeFileSync(indicator, '//@version=6\nindicator("fixture")\nplot(close)\n');

  const rows = ['time,open,high,low,close,volume'];
  for (let index = 0; index < 80; index++) {
    const value = 100 + index * 0.25;
    rows.push(
      `${T0 + index * 3_600},${value},${value + 1},${value - 1},${value + 0.25},${1_000 + index}`,
    );
  }
  writeFileSync(join(dir, 'X_1h.csv'), rows.join('\n'));
  // Y needs data too: an incapable engine rejects BOTH symbols at capability
  // preflight (before any I/O), but a capable engine resolves per symbol — a
  // missing Y file would fail as a fetch error instead of the typed exact
  // failure this suite asserts, and the scan error count would drop to 1.
  writeFileSync(join(dir, 'Y_1h.csv'), rows.join('\n'));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('Bar Magnifier CLI help and strict tri-state parsing', () => {
  test('every override-capable command documents both forms; portfolio does not advertise one', () => {
    for (const command of ['backtest', 'compare', 'scan', 'sweep', 'walkforward']) {
      const result = run(command, '--help');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('--bar-magnifier');
      expect(result.stdout).toContain('--no-bar-magnifier');
      expect(result.stdout).toContain('automatic');
      expect(result.stdout).toContain('@heyphat/piner 0.11.1');
      // Help text documents the code as a literal; it does not vary with the
      // engine that happens to be loaded.
      expect(result.stdout).toContain('piner-bar-magnifier-capability-unavailable');
      expect(result.stdout).toContain('requested/inactive');
      expect(result.stdout).not.toContain('Current piner traversal');
    }
    const portfolio = run('portfolio', '--help');
    expect(portfolio.code).toBe(0);
    expect(portfolio.stdout).not.toContain('--bar-magnifier');
    expect(portfolio.stdout).toContain('no portfolio-wide CLI override');
    expect(portfolio.stdout).toContain('@heyphat/piner 0.11.1');
    expect(portfolio.stdout).toContain('before exact provider');
  });

  test('portfolio rejects every unsupported magnifier flag before script/provider I/O', () => {
    const missingScript = join(dir, 'must-not-be-read.pine');
    for (const flag of [
      '--bar-magnifier',
      '--bar-magnifier=true',
      '--bar-magnifier=false',
      '--bar-magnifier=10m',
      '--no-bar-magnifier',
    ]) {
      const result = run('portfolio', flag, missingScript, '--provider', 'csv', '--data-dir', dir);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('v1 has no portfolio-wide Bar Magnifier override');
      expect(result.stderr).toContain(
        'each sleeve follows strategy(use_bar_magnifier=...) from the source header',
      );
      expect(result.stderr).not.toContain('ENOENT');
      expect(result.stderr).not.toContain('no symbols');
    }
  });

  test('bare/explicit false work before the script path and preserve source-off behavior', () => {
    for (const flag of [
      ['--no-bar-magnifier'],
      ['--bar-magnifier=false'],
      ['--bar-magnifier', 'false'],
    ]) {
      const result = run('backtest', ...flag, sourceOn, ...dataArgs(), '--json');
      expect(result.code).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.ok).toBe(true);
      expect(json.strategy.barMagnifier).toBeUndefined();
    }
  });

  test('positive bare flag before a positional script is not consumed as a value', () => {
    const result = run('backtest', '--bar-magnifier', indicator, ...dataArgs(), '--json');
    expect(result.code).not.toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.failure).toMatchObject({
      type: 'bar-magnifier-error',
      code: 'bar-magnifier-strategy-only',
      permanent: true,
    });
    expect(result.stderr).not.toContain('ENOENT');
  });

  test('custom/nonboolean/negated values and conflicting forms fail fast', () => {
    const cases: [string[], string][] = [
      [['--bar-magnifier=10m'], 'expected true or false'],
      [['--bar-magnifier=maybe'], 'expected true or false'],
      [['--bar-magnifier', '10m'], 'expected true or false'],
      [['--bar-magnifier', 'maybe'], 'expected true or false'],
      [['--no-bar-magnifier=true'], 'negated flag does not take a value'],
      [['--bar-magnifier', '--no-bar-magnifier'], 'cannot be used together'],
    ];
    for (const [flags, message] of cases) {
      const result = run('backtest', sourceOff, ...dataArgs(), ...flags);
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(message);
    }

    const beforeScript = run('backtest', '--bar-magnifier', '10m', sourceOff, ...dataArgs());
    expect(beforeScript.code).not.toBe(0);
    expect(beforeScript.stdout + beforeScript.stderr).toContain('expected true or false');
  });
});

describe('Bar Magnifier CLI command outcomes and summaries', () => {
  test('compare keeps independent headers while applying one shared override to both sides', () => {
    const independent = run('compare', sourceOn, sourceOff, ...dataArgs(), '--no-chart', '--json');
    expect(independent.code).not.toBe(0);
    const independentJson = JSON.parse(independent.stdout);
    expect(independentJson.a.result.failure).toMatchObject({
      code: EXACT_FAILURE_CODE,
      permanent: true,
    });
    expect(independentJson.b.result.ok).toBe(true);

    const forcedOff = run(
      'compare',
      '--no-bar-magnifier',
      sourceOn,
      sourceOff,
      ...dataArgs(),
      '--no-chart',
      '--json',
    );
    expect(forcedOff.code).toBe(0);
    const forcedOffJson = JSON.parse(forcedOff.stdout);
    expect(forcedOffJson.a.result.ok).toBe(true);
    expect(forcedOffJson.b.result.ok).toBe(true);
    expect(forcedOffJson.a.result.strategy.barMagnifier).toBeUndefined();
    expect(forcedOffJson.b.result.strategy.barMagnifier).toBeUndefined();

    const forcedOn = run(
      'compare',
      sourceOn,
      sourceOff,
      ...dataArgs(),
      '--bar-magnifier=true',
      '--no-chart',
      '--json',
    );
    expect(forcedOn.code).not.toBe(0);
    const forcedOnJson = JSON.parse(forcedOn.stdout);
    expect(forcedOnJson.a.result.failure?.code).toBe(EXACT_FAILURE_CODE);
    expect(forcedOnJson.b.result.failure?.code).toBe(EXACT_FAILURE_CODE);
  });

  test('backtest, scan, sweep, walk-forward, and portfolio serialize permanent failures', () => {
    const backtested = run('backtest', sourceOn, ...dataArgs(), '--json');
    expect(backtested.code).not.toBe(0);
    expect(JSON.parse(backtested.stdout).failure.code).toBe(EXACT_FAILURE_CODE);

    const scanned = run(
      'scan',
      sourceOn,
      '--symbols',
      'X,Y',
      '--tf',
      '1h',
      '--provider',
      'csv',
      '--data-dir',
      dir,
      '--no-cache',
      '--workers',
      'local',
      '--json',
    );
    expect(scanned.code).toBe(0);
    const scanJson = JSON.parse(scanned.stdout);
    expect(scanJson.errors).toHaveLength(2);
    expect(
      scanJson.errors.every(
        (entry: { failure?: { code?: string } }) => entry.failure?.code === EXACT_FAILURE_CODE,
      ),
    ).toBe(true);

    const swept = run(
      'sweep',
      sourceOn,
      ...dataArgs(),
      '--input',
      'bias=0,1',
      '--workers',
      'local',
      '--json',
    );
    expect(swept.code).toBe(0);
    const sweepJson = JSON.parse(swept.stdout);
    expect(sweepJson.total).toBe(2);
    expect(sweepJson.errors).toHaveLength(2);
    expect(sweepJson.errors[0].failure.code).toBe(EXACT_FAILURE_CODE);

    const walked = run(
      'walkforward',
      sourceOff,
      ...dataArgs(),
      '--input',
      'bias=0,1',
      '--windows',
      '1',
      '--bar-magnifier',
      '--workers',
      'local',
      '--json',
    );
    expect(walked.code).toBe(0);
    // WHERE the failure surfaces depends on how far exact mode gets: capability
    // preflight fails once for the whole report, while a capable engine reaches
    // acquisition inside each window and reports the typed failure per window.
    const walkedJson = JSON.parse(walked.stdout);
    if (pinerCapabilities().capable) {
      expect(walkedJson.windows.length).toBeGreaterThan(0);
      for (const window of walkedJson.windows) {
        expect(window.failure).toMatchObject({ code: EXACT_FAILURE_CODE, permanent: true });
      }
    } else {
      expect(walkedJson.failure).toMatchObject({ code: EXACT_FAILURE_CODE, permanent: true });
    }

    const portfolio = run(
      'portfolio',
      sourceOn,
      '--symbols',
      'X',
      '--tf',
      '1h',
      '--provider',
      'csv',
      '--data-dir',
      dir,
      '--no-cache',
      '--json',
    );
    expect(portfolio.code).not.toBe(0);
    expect(JSON.parse(portfolio.stdout).failure).toMatchObject({
      code: EXACT_FAILURE_CODE,
      permanent: true,
    });
  });

  test('ordinary human and JSON output identify standard chart-OHLC fills', () => {
    const human = run('backtest', sourceOff, ...dataArgs(), '--no-chart');
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('fill model: standard chart OHLC');
    expect(human.stdout).not.toContain('fill model: bar magnifier');

    const json = run('backtest', sourceOff, ...dataArgs(), '--json');
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout).strategy.barMagnifier).toBeUndefined();
  });
});
