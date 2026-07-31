/**
 * Spawning `pinerun`.
 *
 * Decision 4.1.a — pinetop shells out and never links the engine. The cost is
 * one process spawn per run, which is immaterial next to run time; the benefit
 * is that the numbers on screen and the numbers from the printed command come
 * from the same execution path, which is the premise the whole UI rests on.
 *
 * stdout carries the `--json` report. stderr carries the engine's own
 * narration (resolve, fetch/cache, warmup, fills, artifact writes) — that is
 * the TRADES page log (§8), not noise to be swallowed.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { redactArgv } from '../flags/model.js';

/** What `stdio: ['ignore', 'pipe', 'pipe']` actually yields: no stdin, two reads. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogLine {
  level: LogLevel;
  text: string;
  /** ms since the run started — the log is scoped per run, not wall-clock. */
  at: number;
}

export interface RunOutcome {
  ok: boolean;
  /** The parsed `--json` payload. Undefined when the process produced no JSON. */
  report?: unknown;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  log: LogLine[];
  elapsedMs: number;
  /** Set when the process failed, or its stdout was not the expected JSON. */
  error?: string;
  /** The exact argv, redacted, for the session log and for reproduction. */
  argv: string[];
}

export interface SpawnOptions {
  /** The pinerun executable. Defaults to $PINERUN_BIN, else `pinerun` on PATH. */
  bin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: LogLine) => void;
  /** Called as the engine narrates, so a page can show live progress. */
  onProgress?: (text: string) => void;
  signal?: AbortSignal;
}

export function resolveBin(opts: SpawnOptions = {}): string {
  return opts.bin ?? process.env['PINERUN_BIN'] ?? 'pinerun';
}

/** The engine grades its own lines; this reads that grading back off the text. */
export function classify(line: string): LogLevel {
  if (/^\s*(error|fatal)\b|failed|cannot|refus|reject/i.test(line)) return 'error';
  if (/^\s*warn(ing)?\b|deprecat|skipped|fallback/i.test(line)) return 'warn';
  return 'info';
}

/**
 * Run one `pinerun` invocation to completion.
 *
 * Rejects only on a spawn failure; a non-zero exit is an outcome, not an
 * exception, because a failed run still has a log worth showing and a report
 * worth parsing (the CLI emits JSON for typed failures).
 */
export function runPinerun(argv: readonly string[], opts: SpawnOptions = {}): Promise<RunOutcome> {
  const bin = resolveBin(opts);
  const started = Date.now();
  const log: LogLine[] = [];
  const redacted = redactArgv(argv);

  return new Promise<RunOutcome>((resolve) => {
    let child: PipedChild;
    try {
      child = spawn(bin, [...argv], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        log,
        elapsedMs: Date.now() - started,
        error: `could not spawn ${bin}: ${err instanceof Error ? err.message : String(err)}`,
        argv: redacted,
      });
      return;
    }

    let stdout = '';
    let stderrTail = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail += chunk;
      const lines = stderrTail.split('\n');
      stderrTail = lines.pop() ?? '';
      for (const raw of lines) {
        const text = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
        if (text.trim() === '') continue;
        const entry: LogLine = { level: classify(text), text, at: Date.now() - started };
        log.push(entry);
        opts.onLog?.(entry);
        opts.onProgress?.(text.trim());
      }
    });

    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (stderrTail.trim() !== '') {
        const text = stderrTail.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd();
        log.push({ level: classify(text), text, at: Date.now() - started });
      }
      const elapsedMs = Date.now() - started;

      let report: unknown;
      let error: string | undefined;
      const trimmed = stdout.trim();
      if (trimmed !== '') {
        try {
          report = JSON.parse(trimmed);
        } catch {
          error = 'pinerun did not emit JSON on stdout';
        }
      } else if (exitCode !== 0) {
        // No JSON and a bad exit: the last error line is the useful message.
        error = log.filter((l) => l.level === 'error').at(-1)?.text ?? `pinerun exited ${exitCode}`;
      } else {
        error = 'pinerun produced no output';
      }

      resolve({
        ok: exitCode === 0 && report != null,
        report,
        exitCode,
        signal,
        log,
        elapsedMs,
        error,
        argv: redacted,
      });
    };

    child.on('error', (err) => {
      log.push({ level: 'error', text: err.message, at: Date.now() - started });
      settle(null, null);
    });
    child.on('close', (code, signal) => settle(code, signal));
  });
}

/** `pinerun --version`, used at startup to prove the binary is reachable. */
export async function probePinerun(opts: SpawnOptions = {}): Promise<string | undefined> {
  const outcome = await new Promise<string | undefined>((resolve) => {
    let child: PipedChild;
    try {
      child = spawn(resolveBin(opts), ['--version'], {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      out += c;
    });
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => resolve(code === 0 ? out.trim() : undefined));
  });
  return outcome;
}
