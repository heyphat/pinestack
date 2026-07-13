/**
 * WorkerPoolRunner — real parallelism via Node worker_threads. Implements the
 * same `Runner` contract as `LocalRunner`, so the CLI, tests, and (later) a
 * browser Web Worker driver are interchangeable. Determinism-memoization is
 * inherited from `fanOut`.
 */
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import type { Bar, Job } from './job.js';
import type { RunResult } from './result.js';
import { fanOut, type RunAllOptions, type Runner } from './runner.js';

/**
 * Wire form of a Job. Bar arrays cross the thread boundary as refs: the bars
 * travel only the first time a handle sends a given dataset, and the worker
 * caches the datasets of its most recent message. A sweep (thousands of jobs
 * sharing ONE bar set) thus serializes the series once per worker instead of
 * once per combo; a scan (unique bars per job) behaves exactly as before.
 */
export interface BarsRef {
  id: number;
  /** Present only when this handle hasn't already sent the dataset. */
  bars?: Bar[];
}

export interface WireJob extends Omit<Job, 'bars' | 'securityBars'> {
  bars: BarsRef;
  securityBars?: Record<string, BarsRef>;
}

/** Stable process-wide id per bar array (identity-keyed). */
const datasetIds = new WeakMap<Bar[], number>();
let nextDatasetId = 1;
function datasetId(bars: Bar[]): number {
  let id = datasetIds.get(bars);
  if (id == null) {
    id = nextDatasetId++;
    datasetIds.set(bars, id);
  }
  return id;
}

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
}

class WorkerHandle {
  private readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  /** Dataset ids sent in the previous message — exactly what the worker has cached. */
  private cachedIds = new Set<number>();
  /** Set once the thread has errored or exited. postMessage to a terminated
   *  worker is a silent no-op, so a dead handle must never accept another job —
   *  its promise would simply never settle. */
  dead = false;

  constructor() {
    this.worker = new Worker(WORKER_URL);
    this.worker.on('message', (msg: { seq: number; result?: RunResult; error?: string }) => {
      const p = this.pending.get(msg.seq);
      if (!p) return;
      this.pending.delete(msg.seq);
      if (msg.error != null) p.reject(new Error(msg.error));
      else p.resolve(msg.result!);
    });
    this.worker.on('error', (err) => {
      this.dead = true;
      this.failAll(err instanceof Error ? err : new Error(String(err)));
    });
    this.worker.on('exit', (code) => {
      this.dead = true;
      if (code !== 0) this.failAll(new Error(`pinerun worker exited with code ${code}`));
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
    const wire = this.toWire(job);
    return new Promise<RunResult>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      this.worker.postMessage({ seq, job: wire });
    });
  }

  /** Replace bar arrays with refs, omitting datasets the worker already holds. */
  private toWire(job: Job): WireJob {
    const sent = new Set<number>();
    const ref = (bars: Bar[]): BarsRef => {
      const id = datasetId(bars);
      const known = this.cachedIds.has(id) || sent.has(id);
      sent.add(id);
      return known ? { id } : { id, bars };
    };
    const { bars, securityBars, ...rest } = job;
    const wire: WireJob = { ...rest, bars: ref(bars) };
    if (securityBars) {
      const refs: Record<string, BarsRef> = {};
      for (const [key, value] of Object.entries(securityBars)) refs[key] = ref(value);
      wire.securityBars = refs;
    }
    this.cachedIds = sent;
    return wire;
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

  private acquire(): Promise<WorkerHandle> {
    const w = this.idle.pop();
    if (w) return Promise.resolve(w);
    return new Promise<WorkerHandle>((resolve) => this.waiters.push(resolve));
  }

  /** Return a handle to the pool, replacing it with a fresh worker if its
   *  thread died — otherwise the dead handle would be handed to the next job. */
  private release(w: WorkerHandle): void {
    let handle = w;
    if (w.dead && !this.closed) {
      handle = new WorkerHandle();
      const i = this.workers.indexOf(w);
      if (i >= 0) this.workers[i] = handle;
      else this.workers.push(handle);
    }
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
