/**
 * The session log (§8): every spawned invocation, with its exit code and
 * duration, so a user can reproduce any on-screen result outside the app.
 *
 * Argv is written redacted (§9) — the log is a file on disk and a credential
 * pasted into a free-text flag must not survive there.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandId } from '../flags/schema.js';

export const STATE_DIR = '.pinetop';

export interface SessionEntry {
  /** ISO timestamp of the spawn. */
  at: string;
  command: CommandId;
  /** Redacted argv, exactly as spawned. */
  argv: string[];
  exitCode: number | null;
  elapsedMs: number;
  ok: boolean;
  /** The run id this produced, so the LOGS page can point back at a row. */
  runId: string;
  error?: string;
}

export function stateDir(cwd = process.cwd()): string {
  return join(cwd, STATE_DIR);
}

export function sessionLogPath(cwd = process.cwd()): string {
  return join(stateDir(cwd), 'session.jsonl');
}

/** Append one entry. Never throws: a read-only project must not break a run. */
export function appendSession(entry: SessionEntry, cwd = process.cwd()): void {
  const path = sessionLogPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Losing the audit line is strictly better than losing the run.
  }
}

export function readSession(cwd = process.cwd(), limit = 200): SessionEntry[] {
  try {
    const text = readFileSync(sessionLogPath(cwd), 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    const tail = lines.slice(-limit);
    const entries: SessionEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as SessionEntry);
      } catch {
        // A truncated final line (killed mid-append) is skipped, not fatal.
      }
    }
    return entries;
  } catch {
    return [];
  }
}
