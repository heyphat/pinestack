/**
 * Per-project persistence (§7 P6): reopening resumes the last session's flags.
 *
 * State lives in `.pinetop/` beside the project, the same convention pinery
 * uses for `.pinery-cache`. Overrides are deliberately NOT persisted: a pending
 * parameter edit that survives a restart would be an unexplained divergence
 * from the script on disk, which §4.5.c exists to prevent.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlagModel, FlagValue } from './flags/model.js';
import { emptyModel } from './flags/model.js';
import type { CommandId } from './flags/schema.js';
import { COMMANDS, flagSpec } from './flags/schema.js';
import { stateDir } from './run/session-log.js';

interface PersistedFlags {
  version: 1;
  flags: Partial<Record<CommandId, { scripts: string[]; values: Record<string, FlagValue> }>>;
}

function flagsPath(cwd: string): string {
  return join(stateDir(cwd), 'flags.json');
}

export function loadFlags(cwd = process.cwd()): Partial<Record<CommandId, FlagModel>> {
  let parsed: PersistedFlags;
  try {
    parsed = JSON.parse(readFileSync(flagsPath(cwd), 'utf8')) as PersistedFlags;
  } catch {
    return {};
  }
  if (parsed?.version !== 1 || parsed.flags == null) return {};

  const out: Partial<Record<CommandId, FlagModel>> = {};
  for (const command of COMMANDS) {
    const saved = parsed.flags[command];
    if (saved == null) continue;
    const model = emptyModel(command);
    model.scripts = Array.isArray(saved.scripts)
      ? saved.scripts.filter((s) => typeof s === 'string')
      : [];
    // Drop unknown flag names rather than carrying them into argv: a stale
    // state file from an older pinerun must not compose an invalid command.
    for (const [name, value] of Object.entries(saved.values ?? {})) {
      if (flagSpec(command, name) != null) model.values[name] = value;
    }
    out[command] = model;
  }
  return out;
}

export function saveFlags(flags: Record<CommandId, FlagModel>, cwd = process.cwd()): void {
  const payload: PersistedFlags = { version: 1, flags: {} };
  for (const command of COMMANDS) {
    const model = flags[command];
    payload.flags[command] = { scripts: model.scripts, values: model.values };
  }
  try {
    mkdirSync(stateDir(cwd), { recursive: true });
    writeFileSync(flagsPath(cwd), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch {
    // A read-only project still runs; it just does not resume.
  }
}
