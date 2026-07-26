/**
 * Process-level CLI coverage for --calc-on-order-fills (Phase 3 audit §4.2/§6):
 * real argv through the real binary entry (`bun src/cli.ts`), not the parser
 * helper. Help discoverability and the invalid-value exit run in every world;
 * the old-engine rejection pins today's piner 0.9.0; the capable JSON-marker
 * tests (backtest on/off, walk-forward per-window marker) activate on the
 * dependency bump — same capability gate as coof-override.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { StrategyBroker } from '@heyphat/piner';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COOF_CAPABLE = 'calcOnOrderFills' in new StrategyBroker().settings;
const capableIt = COOF_CAPABLE ? it : it.skip;
const incapableIt = COOF_CAPABLE ? it.skip : it;

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

function run(...args: string[]): { code: number; stdout: string; stderr: string } {
  const p = Bun.spawnSync(['bun', CLI, ...args], {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    code: p.exitCode ?? -1,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

// Offline fixtures: a CSV symbol + the docs' flip strategy (maximally
// discriminating under the flag: ~4 fills/bar on vs 1 off).
let dir: string;
const T0 = 1_700_000_000;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'pinerun-coof-cli-'));
  const rows = ['time,open,high,low,close,volume'];
  for (let i = 0; i < 12; i++) {
    const px = 100 + i;
    rows.push(`${T0 + i * 3600},${px},${px + 2},${px - 2},${px},1`);
  }
  writeFileSync(join(dir, 'FLIPUSD_1h.csv'), rows.join('\n'));
  writeFileSync(
    join(dir, 'flip.pine'),
    `//@version=6
strategy("flip")
off = input.int(0, "off")
if strategy.position_size <= 0
    strategy.entry("L", strategy.long)
else
    strategy.entry("S", strategy.short)
plot(strategy.position_size + off)
`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const dataArgs = ['--provider', 'csv', '--data-dir', () => dir] as const;
const bt = (...extra: string[]) => [
  'backtest',
  join(dir, 'flip.pine'),
  '--symbol',
  'FLIPUSD',
  '--tf',
  '1h',
  '--provider',
  'csv',
  '--data-dir',
  dir,
  '--no-security',
  '--no-cache',
  ...extra,
];
void dataArgs;

describe('CLI process coverage — help & parsing (all engines)', () => {
  it('every supported command documents BOTH flag forms in its own --help', () => {
    for (const cmd of ['backtest', 'scan', 'sweep', 'walkforward']) {
      const r = run(cmd, '--help');
      expect(r.code).toBe(0);
      const help = r.stdout + r.stderr;
      expect(help).toContain('--calc-on-order-fills');
      expect(help).toContain('--no-calc-on-order-fills');
    }
  });

  it('an invalid value fails fast with an actionable message and nonzero exit', () => {
    const r = run(...bt('--calc-on-order-fills=maybe'));
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('expected true or false');
  });
});

describe('CLI process coverage — engine capability', () => {
  incapableIt('the override is rejected end-to-end on piner ≤ 0.9.0 (nonzero exit)', () => {
    const r = run(...bt('--calc-on-order-fills', '--json'));
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('does not model calc_on_order_fills');
  });

  capableIt('backtest --json reports the EFFECTIVE marker: on discriminates from off', () => {
    const on = run(...bt('--calc-on-order-fills', '--json'));
    const off = run(...bt('--no-calc-on-order-fills', '--json'));
    expect(on.code).toBe(0);
    expect(off.code).toBe(0);
    const jon = JSON.parse(on.stdout);
    const joff = JSON.parse(off.stdout);
    expect(jon.strategy.calcOnOrderFills).toBe(true);
    expect(joff.strategy.calcOnOrderFills).toBeUndefined();
    expect(jon.strategy.closedTrades).toBeGreaterThan(joff.strategy.closedTrades);
  });

  capableIt('walkforward --json carries the per-window fill-model marker (audit §6)', () => {
    const r = run(
      'walkforward',
      join(dir, 'flip.pine'),
      '--symbol',
      'FLIPUSD',
      '--tf',
      '1h',
      '--provider',
      'csv',
      '--data-dir',
      dir,
      '--input',
      'off=0,1', // a real (behavior-neutral) axis so the IS sweep has a grid
      '--windows',
      '2',
      '--calc-on-order-fills',
      '--no-security',
      '--no-cache',
      '--json',
    );
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.windows.length).toBeGreaterThan(0);
    for (const w of j.windows) expect(w.calcOnOrderFills).toBe(true);
  });
});
