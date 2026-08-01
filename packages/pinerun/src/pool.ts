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
  /**
   * How long a fresh thread may take to run its entry module and report ready.
   * A healthy boot is milliseconds; the default leaves room for a cold, loaded
   * CI machine. Overridable via PINERUN_WORKER_BOOT_TIMEOUT_MS. Exists because
   * a `new Worker()` can occasionally produce a thread whose entry module never
   * executes (#12) — without a bound, the job posted to it waits forever.
   */
  bootTimeoutMs?: number;
  /** Test seam: an alternate worker entry module. */
  workerUrl?: URL;
}

function defaultSize(): number {
  const n = cpus()?.length ?? 4;
  return Math.min(16, Math.max(1, n));
}

const DEFAULT_BOOT_TIMEOUT_MS = 5_000;

function defaultBootTimeout(): number {
  const env = Number(process.env['PINERUN_WORKER_BOOT_TIMEOUT_MS']);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_BOOT_TIMEOUT_MS;
}

/**
 * A worker thread that never became ready (#12). The job was never received by
 * anything, so retrying it on a fresh worker is always safe — nothing ran.
 */
class WorkerBootError extends Error {}

/** Boot-miss retries per job. Each attempt is a *different, fresh* worker, so
 *  repeated failure means the environment cannot start threads at all — an
 *  error worth surfacing, not retrying forever. */
const MAX_BOOT_ATTEMPTS = 3;

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
  /**
   * Settles when the entry module reports its message listener attached; rejects
   * with `WorkerBootError` if the boot timeout lapses first, or with the thread's
   * own error if it dies before becoming ready.
   *
   * This gate exists because worker startup can silently miss (#12): the thread
   * is created, its entry module never runs, and neither `error` nor `exit`
   * fires — the one worker death the event handlers below cannot see. `exec`
   * waits here before posting, so no job is ever sent into that void.
   */
  private readonly ready: Promise<void>;

  constructor(url: URL = WORKER_URL, bootTimeoutMs = defaultBootTimeout()) {
    this.datasetAuthSecret = randomBytes(32).toString('hex');
    this.worker = new Worker(url, {
      workerData: { datasetAuthSecret: this.datasetAuthSecret },
    });

    let readyResolve!: () => void;
    let readyReject!: (err: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    // A handle can be replaced while idle without any job ever awaiting `ready`;
    // its rejection must not surface as an unhandled-rejection crash.
    this.ready.catch(() => {});

    const bootTimer = setTimeout(() => {
      this.dead = true;
      readyReject(
        new WorkerBootError(
          `pinerun worker: thread did not become ready within ${bootTimeoutMs}ms ` +
            `(startup miss — https://github.com/heyphat/pinestack/issues/12)`,
        ),
      );
      // The zombie holds an OS thread; release it. Its `exit` event is a no-op
      // here — `ready` is already settled and nothing is pending.
      void this.terminate();
    }, bootTimeoutMs);
    bootTimer.unref?.();

    this.worker.on(
      'message',
      (msg: {
        seq: number;
        result?: RunResult;
        error?: string;
        hydrated: boolean;
        ready?: boolean;
      }) => {
        if (msg.ready === true) {
          clearTimeout(bootTimer);
          readyResolve();
          return;
        }
        const p = this.pending.get(msg.seq);
        if (!p) return;
        this.pending.delete(msg.seq);
        this.cachedIds = senderCacheAfterHydration(p.sent, msg.hydrated);
        if (msg.error != null) p.reject(new Error(msg.error));
        else p.resolve(msg.result!);
      },
    );
    this.worker.on('error', (err) => {
      clearTimeout(bootTimer);
      this.dead = true;
      const error = err instanceof Error ? err : new Error(String(err));
      readyReject(error); // no-op when already ready
      this.failAll(error);
    });
    this.worker.on('exit', (code) => {
      clearTimeout(bootTimer);
      this.dead = true;
      const error = new Error(`pinerun worker exited with code ${code}`);
      readyReject(error); // no-op when already ready
      // A clean-looking exit while a job is pending is still a failed worker:
      // without rejection the promise would never settle and the dead handle
      // could not be released/replaced by the pool.
      if (code !== 0 || this.pending.size > 0) {
        this.failAll(error);
      }
    });
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  async exec(job: Job): Promise<RunResult> {
    // Never post into a thread that has not proven it is listening (#12) — a
    // message to a worker whose entry module never ran is silently dropped and
    // its promise would never settle. Resolved-promise cost on the happy path
    // is one microtask.
    await this.ready;
    if (this.dead) {
      throw new Error('pinerun worker: worker thread is no longer running');
    }
    const seq = this.seq++;
    const { wire, sent } = toWireJob(job, this.cachedIds, this.datasetAuthSecret);
    return new Promise<RunResult>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject, sent });
      this.worker.postMessage({ seq, job: wire });
    });
  }

  private terminated?: Promise<number>;

  /**
   * Idempotent: the boot-timeout path terminates its zombie, and `close()`
   * terminates every handle it knows — the same worker can legitimately be
   * asked twice. A second bare `worker.terminate()` returns a promise that
   * never resolves (observed on Bun 1.2.5), which turned pool shutdown into
   * exactly the kind of hang this file exists to prevent.
   */
  terminate(): Promise<number> {
    this.terminated ??= this.worker.terminate();
    return this.terminated;
  }
}

export class WorkerPoolRunner implements Runner {
  private readonly workers: WorkerHandle[];
  private readonly idle: WorkerHandle[] = [];
  private readonly waiters: Array<(w: WorkerHandle) => void> = [];
  private readonly workerUrl: URL;
  private readonly bootTimeoutMs: number;
  private closed = false;

  constructor(opts: WorkerPoolOptions = {}) {
    const size = Math.max(1, opts.size ?? defaultSize());
    this.workerUrl = opts.workerUrl ?? WORKER_URL;
    this.bootTimeoutMs = opts.bootTimeoutMs ?? defaultBootTimeout();
    this.workers = Array.from({ length: size }, () => this.spawnWorker());
    this.idle.push(...this.workers);
  }

  get size(): number {
    return this.workers.length;
  }

  private spawnWorker(): WorkerHandle {
    return new WorkerHandle(this.workerUrl, this.bootTimeoutMs);
  }

  private replaceDead(w: WorkerHandle): WorkerHandle {
    const replacement = this.spawnWorker();
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
    for (let attempt = 1; ; attempt++) {
      const w = await this.acquire();
      try {
        return await w.exec(job);
      } catch (err) {
        // A boot miss (#12) means the job was never received by anything, so
        // re-dispatching is always safe — `release` in the finally has already
        // swapped the dead handle for a fresh worker. Each attempt is a new
        // thread; give up once repeated fresh threads also fail to start.
        if (err instanceof WorkerBootError && attempt < MAX_BOOT_ATTEMPTS && !this.closed) {
          continue;
        }
        throw err;
      } finally {
        this.release(w);
      }
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
