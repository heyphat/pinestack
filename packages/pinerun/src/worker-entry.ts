/**
 * Worker entry (Node worker_threads). Receives `{ seq, job }` in wire form (bar
 * arrays as dataset refs — see pool.ts), rehydrates it, runs the pure
 * `executeJob`, posts back `{ seq, result }`. Each worker keeps its own module-
 * level compile cache, so scanning one script across many symbols compiles once
 * per worker rather than once per job; the dataset cache likewise lets a sweep's
 * shared bar set cross the thread boundary once instead of once per combo.
 */
import { parentPort } from 'node:worker_threads';
import type { Bar, Job } from './job.js';
import type { BarsRef, WireJob } from './pool.js';
import { executeJob } from './execute.js';

if (!parentPort) {
  throw new Error('pinerun worker-entry: expected to run inside a worker_thread');
}

/** Datasets from the most recent message — mirrors the pool's `cachedIds`. */
let datasets = new Map<number, Bar[]>();

/** Resolve every BarsRef against the cache; the new cache is exactly this job's datasets. */
function hydrate(wire: WireJob): Job {
  const next = new Map<number, Bar[]>();
  const resolve = (ref: BarsRef): Bar[] => {
    const bars = ref.bars ?? datasets.get(ref.id);
    if (!bars) throw new Error(`pinerun worker: dataset ${ref.id} missing from cache`);
    next.set(ref.id, bars);
    return bars;
  };
  const { bars, securityBars, ...rest } = wire;
  const job: Job = { ...rest, bars: resolve(bars) };
  if (securityBars) {
    const out: Record<string, Bar[]> = {};
    for (const [key, ref] of Object.entries(securityBars)) out[key] = resolve(ref);
    job.securityBars = out;
  }
  datasets = next;
  return job;
}

const port = parentPort;
port.on('message', (msg: { seq: number; job: WireJob }) => {
  let job: Job;
  try {
    job = hydrate(msg.job);
  } catch (err) {
    port.postMessage({ seq: msg.seq, error: errMessage(err) });
    return;
  }
  executeJob(job)
    .then((result) => port.postMessage({ seq: msg.seq, result }))
    .catch((err: unknown) => port.postMessage({ seq: msg.seq, error: errMessage(err) }));
});

function errMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
