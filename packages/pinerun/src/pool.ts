/**
 * WorkerPoolRunner — real parallelism via Node worker_threads. Implements the
 * same `Runner` contract as `LocalRunner`, so the CLI, tests, and (later) a
 * browser Web Worker driver are interchangeable. Determinism-memoization is
 * inherited from `fanOut`.
 */
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Job } from './job.js';
import type { RunResult } from './result.js';
import { fanOut, type RunAllOptions, type Runner } from './runner.js';
import { senderCacheAfterHydration, toWireJob } from './wire.js';

export interface WorkerPoolOptions {
  /** Number of worker threads. Default: CPU count (clamped to 1..16). */
  size?: number;
}

function defaultSize(): number {
  const n = cpus()?.length ?? 4;
  return Math.min(16, Math.max(1, n));
}

// Inside a `bun build --compile` binary the worker entrypoint is embedded in the
// virtual bunfs as transpiled `.js` (pass it as a second entrypoint when
// compiling); from source it is the sibling `.ts` module.
const COMPILED = import.meta.url.includes('/$bunfs/') || import.meta.url.includes('~BUN');
const WORKER_URL = new URL(COMPILED ? './worker-entry.js' : './worker-entry.ts', import.meta.url);

interface Pending {
  resolve: (r: RunResult) => void;
  reject: (e: Error) => void;
  /** Exact dataset ids referenced by this message; committed only after the
   *  worker acknowledges successful hydration. */
  sent: Set<number>;
}

class WorkerHandle {
  private readonly worker: Worker;
  private readonly datasetAuthSecret: string;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  /** Dataset ids referenced by the most recent successfully hydrated message —
   *  exactly what the worker has cached. Cleared after a hydration error. */
  private cachedIds = new Set<number>();
  /** Set once the thread has errored or exited. postMessage to a terminated
   *  worker is a silent no-op, so a dead handle must never accept another job —
   *  its promise would simply never settle. */
  dead = false;

  constructor() {
    this.datasetAuthSecret = randomBytes(32).toString('hex');
    this.worker = new Worker(WORKER_URL, {
      workerData: { datasetAuthSecret: this.datasetAuthSecret },
    });
    this.worker.on(
      'message',
      (msg: { seq: number; result?: RunResult; error?: string; hydrated: boolean }) => {
        const p = this.pending.get(msg.seq);
        if (!p) return;
        this.pending.delete(msg.seq);
        this.cachedIds = senderCacheAfterHydration(p.sent, msg.hydrated);
        if (msg.error != null) p.reject(new Error(msg.error));
        else p.resolve(msg.result!);
      },
    );
    this.worker.on('error', (err) => {
      this.dead = true;
      this.failAll(err instanceof Error ? err : new Error(String(err)));
    });
    this.worker.on('exit', (code) => {
      this.dead = true;
      // A clean-looking exit while a job is pending is still a failed worker:
      // without rejection the promise would never settle and the dead handle
      // could not be released/replaced by the pool.
      if (code !== 0 || this.pending.size > 0) {
        this.failAll(new Error(`pinerun worker exited with code ${code}`));
      }
    });
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  exec(job: Job): Promise<RunResult> {
    if (this.dead) {
      return Promise.reject(new Error('pinerun worker: worker thread is no longer running'));
    }
    const seq = this.seq++;
    const { wire, sent } = toWireJob(job, this.cachedIds, this.datasetAuthSecret);
    return new Promise<RunResult>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject, sent });
      this.worker.postMessage({ seq, job: wire });
    });
  }

  terminate(): Promise<number> {
    return this.worker.terminate();
  }
}

export class WorkerPoolRunner implements Runner {
  private readonly workers: WorkerHandle[];
  private readonly idle: WorkerHandle[] = [];
  private readonly waiters: Array<(w: WorkerHandle) => void> = [];
  private closed = false;

  constructor(opts: WorkerPoolOptions = {}) {
    const size = Math.max(1, opts.size ?? defaultSize());
    this.workers = Array.from({ length: size }, () => new WorkerHandle());
    this.idle.push(...this.workers);
  }

  get size(): number {
    return this.workers.length;
  }

  private replaceDead(w: WorkerHandle): WorkerHandle {
    const replacement = new WorkerHandle();
    const index = this.workers.indexOf(w);
    if (index >= 0) this.workers[index] = replacement;
    else this.workers.push(replacement);
    return replacement;
  }

  private acquire(): Promise<WorkerHandle> {
    let handle = this.idle.pop();
    // A worker may exit while idle. Replace it before assignment so a fresh job
    // is never sacrificed merely to trigger release-time recovery.
    if (handle?.dead && !this.closed) handle = this.replaceDead(handle);
    if (handle) return Promise.resolve(handle);
    return new Promise<WorkerHandle>((resolve) => this.waiters.push(resolve));
  }

  /** Return a handle to the pool, replacing it with a fresh worker if its
   *  thread died — otherwise the dead handle would be handed to the next job. */
  private release(w: WorkerHandle): void {
    const handle = w.dead && !this.closed ? this.replaceDead(w) : w;
    const next = this.waiters.shift();
    if (next) next(handle);
    else this.idle.push(handle);
  }

  async run(job: Job): Promise<RunResult> {
    const w = await this.acquire();
    try {
      return await w.exec(job);
    } finally {
      this.release(w);
    }
  }

  runAll(jobs: Job[], opts: RunAllOptions = {}): Promise<RunResult[]> {
    // `?? this.workers.length` (not a spread default): callers passing an
    // explicitly-undefined concurrency must still get the pool-size default.
    return fanOut(jobs, (job) => this.run(job), {
      ...opts,
      concurrency: opts.concurrency ?? this.workers.length,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.workers.map((w) => w.terminate()));
  }
}
