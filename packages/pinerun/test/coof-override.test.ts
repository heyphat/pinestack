import { describe, it, expect } from 'bun:test';
import { StrategyBroker } from '@heyphat/piner';
import { StaticProvider } from '@heyphat/pinery';
import { jobHash } from '../src/hash.js';
import { executeJob } from '../src/execute.js';
import { parseTriStateFlag } from '../src/flags.js';
import { backtest } from '../src/backtest.js';
import { scan } from '../src/scan.js';
import { sweep } from '../src/sweep.js';
import { walkforward } from '../src/walkforward.js';
import { parseAxes } from '../src/params.js';
import { LocalRunner, fanOut } from '../src/runner.js';
import { WorkerPoolRunner } from '../src/node.js';
import type { Job, Bar } from '../src/job.js';
import type { RunResult } from '../src/result.js';

// ═══════════════════════════════════════════════════════════════════════════
// --calc-on-order-fills override (Phase 3; audit:
// dev-docs/calc-on-order-fills-phase-3-audit-findings.md)
//
// CAPABILITY-GATED: the same probe execute.ts uses. Against piner ≤ 0.9.0 the
// override is REJECTED (findings 1-2: never run once-per-bar under a distinct
// memo key while reporting the mode active) — those tests run today. The
// behavioral on/off oracle and precedence matrix activate automatically when
// the dependency ships the feature (finding 3), so the suite gains — never
// loses — coverage across the version bump.
// ═══════════════════════════════════════════════════════════════════════════

const COOF_CAPABLE = 'calcOnOrderFills' in new StrategyBroker().settings;
/** Runs only on a feature-capable engine (post-dependency-bump). */
const capableIt = COOF_CAPABLE ? it : it.skip;
/** Pins the rejection surface of an incapable engine (pre-bump). */
const incapableIt = COOF_CAPABLE ? it.skip : it;
const UNSUPPORTED = /does not model calc_on_order_fills/;

const T0 = 1_700_000_000;
const bars: Bar[] = Array.from({ length: 12 }, (_, i) => ({
  time: T0 + i * 3600,
  open: 100 + i,
  high: 102 + i,
  low: 98 + i,
  close: 100 + i,
  volume: 1,
}));

// The docs' flip strategy: with coof ON it fills at every path point (4 trades
// per bar); OFF it fills once per bar — a maximally discriminating oracle.
const FLIP = (header = '') => `//@version=6
strategy("flip"${header})
if strategy.position_size <= 0
    strategy.entry("L", strategy.long)
else
    strategy.entry("S", strategy.short)
plot(strategy.position_size)
`;

const job = (calcOnOrderFills?: boolean, source = FLIP()): Job => ({
  source,
  symbol: 'TEST',
  timeframe: '60',
  bars,
  calcOnOrderFills,
});

const closed = (r: RunResult): number => r.strategy?.closedTrades ?? -1;

describe('calc_on_order_fills override — hash + tri-state parsing (all engines)', () => {
  it('joins the determinism key — variants can never share a memo entry', () => {
    const unset = jobHash(job());
    const on = jobHash(job(true));
    const off = jobHash(job(false));
    expect(on).not.toBe(unset);
    expect(off).not.toBe(unset);
    expect(on).not.toBe(off);
    expect(jobHash(job(true))).toBe(on); // identical jobs still memoize
  });

  it('tri-state CLI parsing: bare, negated, =true/=false, absent, garbage', () => {
    const p = (v: string | undefined, bare: boolean, no: boolean) =>
      parseTriStateFlag(v, bare, no, 'calc-on-order-fills');
    expect(p(undefined, true, false)).toBe(true); // --calc-on-order-fills
    expect(p(undefined, false, true)).toBe(false); // --no-calc-on-order-fills
    expect(p('true', false, false)).toBe(true); // --calc-on-order-fills=true
    expect(p('false', false, false)).toBe(false); // --calc-on-order-fills=false
    expect(p(undefined, false, false)).toBeUndefined(); // absent
    expect(() => p('yes', false, false)).toThrow(/expected true or false/);
  });
});

describe('incapable engine (piner ≤ 0.9.0): reject, never misreport', () => {
  incapableIt('an explicit override is rejected with an actionable error', async () => {
    for (const v of [true, false]) {
      const r = await executeJob(job(v));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(UNSUPPORTED);
    }
  });

  incapableIt('unset runs, and a source-declared flag is NOT reported as active', async () => {
    const r = await executeJob(job(undefined, FLIP(', calc_on_order_fills = true')));
    expect(r.ok).toBe(true);
    // The engine ignored the header — the effective-state marker must be
    // absent (finding 2: requested configuration is not engine state).
    expect(r.strategy?.calcOnOrderFills).toBeUndefined();
  });

  incapableIt('the rejection round-trips the worker boundary', async () => {
    const runner = new WorkerPoolRunner({ size: 1 });
    try {
      const [r] = await runner.runAll([job(true)]);
      expect(r!.ok).toBe(false);
      expect(r!.error).toMatch(UNSUPPORTED);
    } finally {
      await runner.close();
    }
  });
});

describe('capable engine: behavioral oracle + precedence (activates on the dep bump)', () => {
  capableIt('on/off discriminate behaviorally: 4 fills per bar vs 1', async () => {
    const on = await executeJob(job(true));
    const off = await executeJob(job(false));
    const unset = await executeJob(job());
    expect(on.ok && off.ok && unset.ok).toBe(true);
    expect(closed(on)).toBeGreaterThan(closed(off)); // ~4× the trades
    expect(closed(unset)).toBe(closed(off)); // no header flag → unset ≡ off
    expect(on.strategy?.calcOnOrderFills).toBe(true);
    expect(off.strategy?.calcOnOrderFills).toBeUndefined();
    expect(unset.strategy?.calcOnOrderFills).toBeUndefined();
  });

  capableIt('override ↔ source precedence: override wins both ways', async () => {
    const srcOn = FLIP(', calc_on_order_fills = true');
    const headerOnly = await executeJob(job(undefined, srcOn));
    const forcedOff = await executeJob(job(false, srcOn));
    const forcedOn = await executeJob(job(true, FLIP()));
    expect(headerOnly.strategy?.calcOnOrderFills).toBe(true); // unset preserves source
    expect(forcedOff.strategy?.calcOnOrderFills).toBeUndefined(); // override false beats source true
    expect(closed(forcedOff)).toBe(closed(await executeJob(job(undefined, FLIP())))); // behaviorally off
    expect(forcedOn.strategy?.calcOnOrderFills).toBe(true); // override true beats absent source
    expect(closed(forcedOn)).toBe(closed(headerOnly)); // behaviorally identical to source-on
  });
});

describe('command propagation (world-agnostic: reaches executeJob in every command)', () => {
  // In the incapable world the option surfaces as the rejection error; in the
  // capable world as the effective marker — either way, seeing it in the
  // result proves the command threaded the option into its Jobs.
  const expectReached = (r: RunResult | undefined): void => {
    expect(r).toBeDefined();
    if (COOF_CAPABLE) {
      expect(r!.ok).toBe(true);
      expect(r!.strategy?.calcOnOrderFills).toBe(true);
    } else {
      expect(r!.ok).toBe(false);
      expect(r!.error).toMatch(UNSUPPORTED);
    }
  };
  const provider = () => new StaticProvider({ A: bars, B: bars });

  it('backtest', async () => {
    const report = await backtest({
      source: FLIP(),
      symbol: 'A',
      timeframe: '1h',
      provider: provider(),
      calcOnOrderFills: true,
      resolveSecurity: false,
    });
    expectReached(report.result);
  });

  it('scan (through the runner/memo path)', async () => {
    const report = await scan({
      source: FLIP(),
      symbols: ['A', 'B'],
      timeframe: '1h',
      provider: provider(),
      calcOnOrderFills: true,
      resolveSecurity: false,
      runner: new LocalRunner(),
    });
    expect(report.results).toHaveLength(2);
    for (const r of report.results) expectReached(r);
  });

  it('sweep (every combo)', async () => {
    const report = await sweep({
      source: `//@version=6
strategy("s")
n = input.int(2, "n")
if bar_index % n == 0
    strategy.entry("L", strategy.long)
plot(strategy.position_size)
`,
      symbol: 'A',
      timeframe: '1h',
      provider: provider(),
      axes: parseAxes(['n=2,3']),
      calcOnOrderFills: true,
      resolveSecurity: false,
      runner: new LocalRunner(),
    });
    if (COOF_CAPABLE) {
      expect(report.errors).toHaveLength(0);
      expect(report.points.length).toBe(2);
    } else {
      expect(report.errors).toHaveLength(2); // both combos rejected → option reached both Jobs
      for (const r of report.errors) expect(r.error).toMatch(UNSUPPORTED);
    }
  });

  it('walkforward (in-sample sweep inherits the override)', async () => {
    const report = await walkforward({
      source: `//@version=6
strategy("w")
n = input.int(2, "n")
if bar_index % n == 0
    strategy.entry("L", strategy.long)
plot(strategy.position_size)
`,
      symbol: 'A',
      timeframe: '1h',
      provider: provider(),
      axes: parseAxes(['n=2,3']),
      windows: 2,
      oosFraction: 0.25,
      calcOnOrderFills: true,
      resolveSecurity: false,
    });
    for (const w of report.windows) {
      if (COOF_CAPABLE) {
        expect(w.error).toBeUndefined();
        // The WINNER phase must inherit the override too (audit §4.3: removing
        // it from the full-window job would otherwise still pass) — assert the
        // effective marker on each window's winner RunResult.
        expect(w.result?.strategy?.calcOnOrderFills).toBe(true);
      } else expect(w.error).toMatch(UNSUPPORTED); // "no ranked combo (first error: …)"
    }
  });
});

describe('memo + worker execution (audit §4.1/§4.4)', () => {
  it('fanOut executes each variant once and memoizes duplicates (not just key inequality)', async () => {
    const seen: string[] = [];
    const jobs = [job(true), job(true), job(false), job(), job()];
    const results = await fanOut(
      jobs,
      async (j) => {
        seen.push(`coof=${String(j.calcOnOrderFills)}`);
        return {
          id: 'x',
          symbol: j.symbol,
          timeframe: j.timeframe,
          ok: true,
          bars: j.bars.length,
          plots: [],
          alerts: [],
        } as RunResult;
      },
      { concurrency: 1 }, // deterministic execution order for the assertion
    );
    expect(results).toHaveLength(5);
    // 5 submissions, 3 distinct memo keys → exactly 3 executions.
    expect(seen).toEqual(['coof=true', 'coof=false', 'coof=undefined']);
  });

  capableIt('worker boundary: the override changes fills after serialization (on vs off)', async () => {
    const runner = new WorkerPoolRunner({ size: 1 });
    try {
      const [on, off] = await runner.runAll([job(true), job(false)], { noCache: true });
      expect(on!.ok && off!.ok).toBe(true);
      expect(closed(on!)).toBeGreaterThan(closed(off!)); // the 43-vs-10 shape
      expect(on!.strategy?.calcOnOrderFills).toBe(true);
      expect(off!.strategy?.calcOnOrderFills).toBeUndefined();
    } finally {
      await runner.close();
    }
  });
});
