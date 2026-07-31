/**
 * The FlagModel and argv composition.
 *
 * Decision 4.1.b — this is the single source of truth for the UI. The config
 * pane renders from a FlagModel, the `$ pinerun …` line is composed from the
 * same FlagModel, and the process is spawned from it too. There is no second
 * copy of the invocation anywhere: if the line on screen would not run, that is
 * a bug, and it is a bug in exactly one function.
 */

import { inputValue } from '../render/format.js';
import type { CommandId, FlagSpec } from './schema.js';
import { schemaFor } from './schema.js';

/** A repeatable `name=value` pair (`--input`, `--input-a`, …). */
export interface Pair {
  name: string;
  value: string;
}

export type FlagValue = string | number | boolean | 'on' | 'off' | string[] | Pair[] | undefined;

export interface FlagModel {
  command: CommandId;
  /** Script paths, positional. One for most commands, two for compare. */
  scripts: string[];
  values: Record<string, FlagValue>;
}

/** An AI or user edit to a Pine `input()`, not yet re-run (§4.5.c). */
export interface Override {
  input: string;
  from: string;
  to: string;
}

export function emptyModel(command: CommandId): FlagModel {
  return { command, scripts: [], values: {} };
}

export function cloneModel(model: FlagModel): FlagModel {
  return {
    command: model.command,
    scripts: [...model.scripts],
    values: structuredClone(model.values),
  };
}

export function isSet(value: FlagValue): boolean {
  if (value == null || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** The value as the config pane shows it (never what reaches argv — §4.5.e). */
export function displayValue(spec: FlagSpec, value: FlagValue): string {
  if (!isSet(value)) return spec.placeholder ?? '—';
  switch (spec.kind) {
    case 'bool':
      return 'on';
    case 'tristate':
      return value === 'on' ? 'on' : 'off';
    case 'list':
      return Array.isArray(value) ? (value as string[]).join(',') : String(value);
    case 'pairs': {
      const pairs = value as Pair[];
      return pairs.map((p) => `${p.name}=${p.value}`).join(' ');
    }
    default:
      return String(value);
  }
}

/**
 * Merge pending overrides into the model's `--input` pairs. An override wins
 * over a same-named fixed input: it is the edit the user just accepted, and the
 * config pane shows it struck through against the old value.
 */
export function withOverrides(model: FlagModel, overrides: readonly Override[]): FlagModel {
  if (overrides.length === 0) return model;
  const key = model.command === 'compare' ? 'input-a' : 'input';
  const spec = schemaFor(model.command).flags.find((f) => f.name === key);
  if (spec == null) return model;

  const merged = cloneModel(model);
  const existing = (merged.values[key] as Pair[] | undefined) ?? [];
  const byName = new Map(existing.map((p) => [p.name, p]));
  for (const override of overrides)
    byName.set(override.input, { name: override.input, value: override.to });
  merged.values[key] = [...byName.values()];
  return merged;
}

/**
 * Compose the argv. `json` appends `--json`, which is how every page reads its
 * report; the copy-pasteable line shown to the user is the same argv without
 * it, because a user pasting into a shell wants the table.
 */
export function composeArgv(model: FlagModel, opts: { json?: boolean } = {}): string[] {
  const schema = schemaFor(model.command);
  const argv: string[] = [model.command, ...model.scripts];

  for (const spec of schema.flags) {
    const value = model.values[spec.name];
    if (!isSet(value)) continue;

    switch (spec.kind) {
      case 'bool':
        argv.push(`--${spec.name}`);
        break;
      case 'tristate':
        argv.push(value === 'on' ? `--${spec.name}` : `--no-${spec.name}`);
        break;
      case 'list': {
        const list = Array.isArray(value) ? (value as string[]) : [String(value)];
        argv.push(`--${spec.name}`, list.join(','));
        break;
      }
      case 'pairs':
        for (const pair of value as Pair[]) {
          argv.push(`--${spec.name}`, `${pair.name}=${inputValue(pair.value)}`);
        }
        break;
      case 'number':
        argv.push(`--${spec.name}`, String(value));
        break;
      default:
        argv.push(`--${spec.name}`, String(value));
    }
  }

  if (opts.json) argv.push('--json');
  return argv;
}

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(arg: string): string {
  if (arg === '') return "''";
  return SAFE.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Anything that looks like a credential is masked before it is displayed or
 * written to the session log (§9). Credentials are not in the FlagModel at all,
 * so this is defence in depth: a key pasted into a free-text field still must
 * not reach the screen, the log, or the AI grounding payload.
 */
const SECRETISH = /^(?:--?(?:api-key|api-secret|token|password|secret)|[A-Za-z0-9_-]{32,})$/i;

export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    out.push(arg);
    if (/^--(api-key|api-secret|token|password|secret)$/i.test(arg) && i + 1 < argv.length) {
      out.push('«redacted»');
      i++;
      continue;
    }
    if (SECRETISH.test(arg) && !arg.startsWith('-')) out[out.length - 1] = '«redacted»';
  }
  return out;
}

/** The `$ pinerun …` line, verbatim and copy-pasteable (§3 G2). */
export function commandLine(model: FlagModel, opts: { json?: boolean } = {}): string {
  const argv = redactArgv(composeArgv(model, opts));
  return `pinerun ${argv.map(shellQuote).join(' ')}`;
}

/**
 * Validate before spawning. The CLI enforces these too — doing it here keeps
 * the user in the page with an explanation instead of dropping them into a
 * failed process (§7 P2: the --max-combos guard is enforced before spawn, as
 * the CLI does).
 */
export function validate(model: FlagModel): string[] {
  const problems: string[] = [];
  const schema = schemaFor(model.command);
  const v = model.values;

  if (model.scripts.length < schema.scripts) {
    problems.push(
      schema.scripts === 2
        ? 'compare needs two scripts'
        : `${model.command} needs a script (.pine)`,
    );
  }

  const needsSymbol: CommandId[] = ['backtest', 'walkforward', 'compare'];
  if (needsSymbol.includes(model.command) && !isSet(v['symbol'])) {
    problems.push(`--symbol is required for ${model.command}`);
  }

  const needsUniverse: CommandId[] = ['scan', 'portfolio'];
  if (needsUniverse.includes(model.command) && !isSet(v['symbols']) && !isSet(v['universe'])) {
    problems.push(`${model.command} needs --symbols or --universe`);
  }

  if (model.command === 'sweep' || model.command === 'walkforward') {
    const axes = (v['input'] as Pair[] | undefined) ?? [];
    if (axes.length === 0) problems.push(`${model.command} needs at least one --input axis`);
    const combos = comboCount(axes);
    const cap = typeof v['max-combos'] === 'number' ? v['max-combos'] : 5000;
    const sample = typeof v['sample'] === 'number' ? v['sample'] : undefined;
    const effective = sample ?? combos;
    if (Number.isFinite(effective) && effective > cap) {
      problems.push(
        `grid is ${effective.toLocaleString('en-US')} combos, over --max-combos ${cap.toLocaleString('en-US')}` +
          (sample == null ? ' — raise the cap or use --sample' : ''),
      );
    }
    if (v['heatmap'] === true && axes.length !== 2) {
      problems.push(`--heatmap needs exactly two --input axes (have ${axes.length})`);
    }
  }

  if (model.command === 'walkforward') {
    const oos = v['oos'];
    if (typeof oos === 'number' && !(oos > 0 && oos < 1))
      problems.push('--oos must be between 0 and 1');
  }

  if (v['watch'] != null && isSet(v['watch'])) {
    problems.push(
      '--watch redraws a terminal and cannot be read as JSON — pinetop owns the refresh',
    );
  }

  // The csv provider reads a directory of <SYMBOL>_<TF>.csv files; without it the
  // CLI fails on the first fetch. Catching it here names the missing flag rather
  // than surfacing "no data for BTCUSDT" from a run that never had a chance.
  if (v['provider'] === 'csv' && !isSet(v['data-dir'])) {
    problems.push('--provider csv needs --data-dir <dir> (a directory of <SYMBOL>_<TF>.csv files)');
  }
  // The CLI rejects this pairing itself; refusing early keeps the reason on the
  // page instead of in a failed run's stderr.
  if (isSet(v['csv-calendar']) && (isSet(v['csv-alignment']) || isSet(v['csv-week-anchor']))) {
    problems.push('--csv-calendar conflicts with --csv-alignment / --csv-week-anchor');
  }

  return problems;
}

/** Cartesian size of a `--input` axis set, using the CLI's own grammar. */
export function comboCount(axes: readonly Pair[]): number {
  let total = 1;
  for (const axis of axes) total *= axisValues(axis.value).length || 1;
  return total;
}

/**
 * Expand one axis spec into its values. Mirrors the CLI's swept-input grammar:
 * a comma list whose members may themselves be `start:stop:step` ranges, and a
 * quoted member is a literal string rather than a range.
 */
export function axisValues(spec: string): string[] {
  const out: string[] = [];
  for (const member of spec.split(',')) {
    const token = member.trim();
    if (token === '') continue;
    if (/^['"].*['"]$/.test(token)) {
      out.push(token.slice(1, -1));
      continue;
    }
    const range = token.match(/^(-?[\d.]+):(-?[\d.]+)(?::(-?[\d.]+))?$/);
    if (range) {
      const start = Number(range[1]);
      const stop = Number(range[2]);
      const step = range[3] != null ? Number(range[3]) : 1;
      if (Number.isFinite(start) && Number.isFinite(stop) && step > 0) {
        for (let v = start; v <= stop + 1e-9; v += step) {
          out.push(String(Number(v.toFixed(10))));
        }
        continue;
      }
    }
    out.push(token);
  }
  return out;
}
