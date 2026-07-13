/**
 * Runner — the fan-out contract. `run` executes one job; `runAll` executes many
 * with bounded concurrency and determinism-memoization. `LocalRunner` runs
 * in-process (browser-safe, used for tests and small scans); the worker-pool
 * runner in `./node` implements the same interface for true parallelism.
 */
import type { Job } from './job.js';
import { jobId } from './job.js';
import type { RunResult } from './result.js';
import { jobHash } from './hash.js';
import { executeJob } from './execute.js';

export interface RunAllOptions {
  /** Max jobs in flight at once. Default 4. */
  concurrency?: number;
  /** Called as each job settles (for progress reporting). */
  onResult?: (result: RunResult, done: number, total: number) => void;
  /** Skip the determinism memo cache. Default false. */
  noCache?: boolean;
}

export interface Runner {
  run(job: Job): Promise<RunResult>;
  runAll(jobs: Job[], opts?: RunAllOptions): Promise<RunResult[]>;
  close(): Promise<void>;
}

/** Shared bounded-concurrency fan-out with per-hash memoization. */
export async function fanOut(
  jobs: Job[],
  exec: (job: Job) => Promise<RunResult>,
  opts: RunAllOptions = {},
): Promise<RunResult[]> {
  // Guard non-finite (NaN from a parsed flag): Array.from({length: NaN}) would
  // silently spawn ZERO workers and return an array of holes.
  const requested = opts.concurrency;
  const concurrency = Number.isFinite(requested) ? Math.max(1, Math.floor(requested!)) : 4;
  const total = jobs.length;
  const results = new Array<RunResult>(total);
  const memo = new Map<string, Promise<RunResult>>();
  let done = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < total) {
      const i = next++;
      const job = jobs[i]!;
      let result: RunResult;
      if (opts.noCache) {
        result = await exec(job);
      } else {
        const key = jobHash(job);
        let pending = memo.get(key);
        if (!pending) {
          pending = exec(job);
          memo.set(key, pending);
        }
        // Re-tag a cache hit with this job's own id so callers see the right symbol.
        const shared = await pending;
        result =
          shared.id === jobId(job) ? shared : { ...shared, id: jobId(job), symbol: job.symbol };
      }
      results[i] = result;
      done++;
      opts.onResult?.(result, done, total);
    }
  }

  const pool = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(pool);
  return results;
}

export class LocalRunner implements Runner {
  run(job: Job): Promise<RunResult> {
    return executeJob(job);
  }
  runAll(jobs: Job[], opts?: RunAllOptions): Promise<RunResult[]> {
    return fanOut(jobs, executeJob, opts);
  }
  async close(): Promise<void> {
    /* nothing to tear down */
  }
}
