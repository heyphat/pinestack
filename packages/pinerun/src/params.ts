/**
 * params — the parameter-sweep axis grammar. Turns `name=spec` strings into typed
 * value lists, expands the cartesian product of axes into input-override records,
 * and produces stable combo ids. Pure and browser-safe (no I/O, no Node built-ins)
 * so it is unit-testable in isolation and usable in the browser.
 *
 * Spec forms (disambiguated in this order):
 *   1. contains ","  → list:   fast=5,10,20        → [5, 10, 20]
 *                              (a list member may itself be a range: 5,10:20:5)
 *   2. numeric range → range:  fast=5:20:5         → [5, 10, 15, 20]  (start:stop:step)
 *                              len=5:8             → [5, 6, 7, 8]     (default step 1)
 *   3. otherwise     → single: src=close           → ["close"]
 *
 * Tokens coerce to number / boolean / string:
 *   "5" | "1.5" | ".5" | "-3" | "1e3" → number,  "true" | "false" → boolean,
 *   else the raw string.
 *
 * A token wrapped in matching quotes is a literal string — no coercion, no range
 * expansion: sess='09:30' → ["09:30"] (unquoted, 09:30 would expand to 9..30).
 * Commas still split lists before quotes are read, so a literal comma can't be
 * quoted into a value.
 *
 * The axis `name` is the piner input **title** — the key piner overrides by (see
 * `Job.inputs`). It must match an `input(...)` title in the script exactly.
 */

export interface Axis {
  /** Input title to override (must match a Pine `input()` title). */
  name: string;
  /** The expanded, typed values this axis will iterate over. */
  values: unknown[];
}

/** Default cap on the total number of combinations a sweep may generate. */
export const DEFAULT_MAX_COMBOS = 5000;

/** Hard cap on the count a single numeric range may expand to (runaway guard). */
const MAX_RANGE_VALUES = 100_000;

/** Float-drift epsilon so a `stop` that lands on the grid is included. */
const EPSILON = 1e-9;

/** One numeric token: optional sign, "5" / "5." / ".5" / "1.5", optional exponent. */
const NUM_SRC = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const NUM_RE = new RegExp(`^${NUM_SRC}$`);
const RANGE_RE = new RegExp(`^(${NUM_SRC}):(${NUM_SRC})(?::(${NUM_SRC}))?$`);

/** Strip matching surrounding quotes, marking the token as a literal string. */
function unquote(token: string): string | null {
  const t = token.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1);
  }
  return null;
}

/**
 * Coerce one raw token to a number, boolean, or string.
 *   "5" → 5   "1.5" → 1.5   ".5" → 0.5   "1e3" → 1000   "-3" → -3
 *   "true"/"FALSE" → bool   "close" → "close"
 * A quoted token ('09:30', "true") is always the literal string inside the quotes.
 */
export function coerceToken(token: string): number | boolean | string {
  const literal = unquote(token);
  if (literal != null) return literal;
  const t = token.trim();
  if (NUM_RE.test(t)) return Number(t);
  const lower = t.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  return t;
}

/**
 * Expand an inclusive numeric range `start:stop:step` (step defaults to 1).
 * Includes `stop` when it lands on the grid (within EPSILON). Throws on a
 * non-positive step or a range that would exceed MAX_RANGE_VALUES.
 */
export function expandRange(start: number, stop: number, step = 1): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(stop) || !Number.isFinite(step)) {
    throw new Error(`range: non-finite bound in ${start}:${stop}:${step}`);
  }
  if (step <= 0) throw new Error(`range: step must be > 0 (got ${step})`);
  if (stop < start) throw new Error(`range: stop (${stop}) must be >= start (${start})`);

  const count = Math.floor((stop - start) / step + EPSILON) + 1;
  if (count > MAX_RANGE_VALUES) {
    throw new Error(
      `range: ${start}:${stop}:${step} expands to ${count} values (max ${MAX_RANGE_VALUES})`,
    );
  }

  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    // Multiply rather than accumulate to avoid float drift over long ranges.
    const v = start + i * step;
    // Round away tiny binary-float noise (e.g. 0.1 steps) to a sane precision.
    out.push(roundish(v));
  }
  return out;
}

/** Trim binary-float noise like 0.30000000000000004 → 0.3 without harming real precision. */
function roundish(v: number): number {
  if (Number.isInteger(v)) return v;
  const r = Math.round(v * 1e10) / 1e10;
  return r;
}

/** Expand a token that is a numeric range `start:stop[:step]`, else null. */
function tryRange(token: string): number[] | null {
  if (unquote(token) != null) return null; // quoted → literal, never a range
  const range = RANGE_RE.exec(token);
  if (!range) return null;
  const start = Number(range[1]);
  const stop = Number(range[2]);
  const step = range[3] != null ? Number(range[3]) : 1;
  return expandRange(start, stop, step);
}

/** Parse the value spec (right-hand side of `name=spec`) into a typed value list. */
export function parseSpec(spec: string): unknown[] {
  const s = spec.trim();
  if (s.length === 0) throw new Error('axis: empty value spec');

  // 1. Explicit list — a comma always wins. Members may themselves be ranges.
  if (s.includes(',')) {
    const values = s
      .split(',')
      .map((tok) => tok.trim())
      .filter((tok) => tok.length > 0)
      .flatMap((tok) => tryRange(tok) ?? [coerceToken(tok)]);
    if (values.length === 0) throw new Error(`axis: no values in "${spec}"`);
    return values;
  }

  // 2. Numeric range `start:stop[:step]`.
  const ranged = tryRange(s);
  if (ranged) return ranged;

  // 3. Single value.
  return [coerceToken(s)];
}

/** Parse one `name=spec` axis argument (e.g. "fast=5,10,20"). */
export function parseAxis(arg: string): Axis {
  const eq = arg.indexOf('=');
  if (eq < 0) throw new Error(`axis: expected "name=spec", got "${arg}"`);
  const name = arg.slice(0, eq).trim();
  const spec = arg.slice(eq + 1);
  if (name.length === 0) throw new Error(`axis: missing name in "${arg}"`);
  return { name, values: parseSpec(spec) };
}

/** Parse many `--input name=spec` arguments. Rejects a repeated axis name. */
export function parseAxes(args: string[]): Axis[] {
  const axes: Axis[] = [];
  const seen = new Set<string>();
  for (const arg of args) {
    const axis = parseAxis(arg);
    if (seen.has(axis.name)) throw new Error(`axis: duplicate input "${axis.name}"`);
    seen.add(axis.name);
    axes.push(axis);
  }
  return axes;
}

/** Product of every axis's value count — the number of combinations a sweep runs. */
export function countCombos(axes: Axis[]): number {
  return axes.reduce((n, a) => n * a.values.length, 1);
}

export interface ComboBudgetOptions {
  /** Symbols the grid is multiplied across (multi-symbol sweep). Default 1. */
  symbols?: number;
  /** Random-sample size — caps the per-symbol combo count (smart search). */
  sample?: number;
}

/**
 * The one run-budget guard, shared by `sweep()` and the CLI pre-check so the cap
 * logic and message can't drift. The budget is the number of RUNS a sweep will
 * launch: per-symbol combos (the full grid, or `sample` when sampling) times the
 * symbol count. Throws when that exceeds `cap`; returns the run count otherwise.
 * A non-finite `cap` (NaN from a parsed flag) is rejected.
 */
export function assertComboBudget(
  axes: Axis[],
  cap: number = DEFAULT_MAX_COMBOS,
  opts: ComboBudgetOptions = {},
): number {
  if (!Number.isFinite(cap) || cap < 1) {
    throw new Error(`sweep: maxCombos must be a positive number (got ${cap})`);
  }
  const symbols = opts.symbols ?? 1;
  const grid = countCombos(axes);
  const perSymbol = opts.sample != null ? Math.min(opts.sample, grid) : grid;
  const total = perSymbol * symbols;
  if (total > cap) {
    const shape = axes.map((a) => `${a.name}(${a.values.length})`).join(' × ') || '(none)';
    const sym = symbols > 1 ? ` × ${symbols} symbols` : '';
    const hint =
      opts.sample == null && grid > cap
        ? ' (raise --max-combos, or --sample N to random-sample the grid)'
        : ' (raise --max-combos to override)';
    throw new Error(`sweep: ${total} combos [${shape}${sym}] exceeds max ${cap}${hint}`);
  }
  return total;
}

/**
 * Cartesian product of the axes → one input-override record per combination.
 * The LAST axis varies fastest (odometer order), so a printed table reads
 * naturally. An empty axis list yields a single empty combo `[{}]`.
 */
export function cartesian(axes: Axis[]): Record<string, unknown>[] {
  let combos: Record<string, unknown>[] = [{}];
  for (const axis of axes) {
    const next: Record<string, unknown>[] = [];
    for (const base of combos) {
      for (const value of axis.values) {
        next.push({ ...base, [axis.name]: value });
      }
    }
    combos = next;
  }
  return combos;
}

/**
 * The combo at `index` of the cartesian (odometer) order WITHOUT materializing
 * the grid — the decode side of `cartesian`. `comboAt(axes, i)` equals
 * `cartesian(axes)[i]` for every valid index; sampling uses it to pull single
 * points out of grids far too large to expand.
 */
export function comboAt(axes: Axis[], index: number): Record<string, unknown> {
  const total = countCombos(axes);
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new Error(`combo: index ${index} out of range [0, ${total})`);
  }
  const combo: Record<string, unknown> = {};
  let rem = index;
  let stride = total;
  for (const axis of axes) {
    stride /= axis.values.length;
    const digit = Math.floor(rem / stride);
    rem -= digit * stride;
    combo[axis.name] = axis.values[digit];
  }
  return combo;
}

/** Default PRNG seed for `sampleCombos`, so unseeded samples still reproduce. */
export const DEFAULT_SAMPLE_SEED = 42;

/** Deterministic 32-bit PRNG (mulberry32) — sampled sweeps must be reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 53-bit uniform in [0, 1) from two 32-bit draws — a grid can exceed 2^32 combos. */
function rand53(rand: () => number): number {
  return (Math.floor(rand() * 2 ** 26) * 2 ** 27 + Math.floor(rand() * 2 ** 27)) / 2 ** 53;
}

/**
 * `count` DISTINCT combos sampled uniformly from the cartesian grid — the
 * "smart search" alternative to exhausting a huge grid. Deterministic for a
 * given `seed`. Returned in ascending grid order (so tables and heatmaps read
 * as a sparse version of the full grid); `count >= grid size` returns the full
 * grid, exactly as `cartesian` would.
 */
export function sampleCombos(
  axes: Axis[],
  count: number,
  seed: number = DEFAULT_SAMPLE_SEED,
): Record<string, unknown>[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`sample: count must be a positive integer (got ${count})`);
  }
  if (!Number.isFinite(seed)) {
    throw new Error(`sample: seed must be a finite number (got ${seed})`);
  }
  const total = countCombos(axes);
  if (count >= total) return cartesian(axes);
  const rand = mulberry32(seed);
  const picked = new Set<number>();
  while (picked.size < count) {
    picked.add(Math.floor(rand53(rand) * total));
  }
  return Array.from(picked)
    .sort((a, b) => a - b)
    .map((i) => comboAt(axes, i));
}

/** Stable, human-readable id for a combo: "fast=10|slow=50" (keys sorted). */
export function comboId(inputs: Record<string, unknown>): string {
  const keys = Object.keys(inputs).sort();
  if (keys.length === 0) return '(defaults)';
  return keys.map((k) => `${k}=${fmtValue(inputs[k])}`).join('|');
}

function fmtValue(v: unknown): string {
  if (typeof v === 'string') return v;
  return String(v);
}
