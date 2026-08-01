/**
 * Worker entry (Node worker_threads). Receives `{ seq, job }` in wire form (bar
 * arrays as dataset refs — see pool.ts), rehydrates it, runs the pure
 * `executeJob`, posts back `{ seq, result }`. Each worker keeps its own module-
 * level compile cache, so scanning one script across many symbols compiles once
 * per worker rather than once per job; the dataset cache likewise lets a sweep's
 * shared bar set cross the thread boundary once instead of once per combo.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { Bar } from './job.js';
import { hydrateWireJob, type WireJob } from './wire.js';
import { executeJob } from './execute.js';
import { initializeWorkerMagnifierDatasetAuthentication } from './magnifier.js';
import { initializeWorkerSecurityProofAuthentication } from './security.js';

if (!parentPort) {
  throw new Error('pinerun worker-entry: expected to run inside a worker_thread');
}

const datasetAuthSecret = (workerData as { datasetAuthSecret?: unknown } | null)?.datasetAuthSecret;
if (typeof datasetAuthSecret !== 'string') {
  throw new Error('pinerun worker-entry: missing dataset authentication secret');
}
initializeWorkerSecurityProofAuthentication(datasetAuthSecret);
initializeWorkerMagnifierDatasetAuthentication(datasetAuthSecret);

/** Datasets from the most recent successfully hydrated message. */
let datasets = new Map<number, readonly Bar[]>();

const port = parentPort;
port.on('message', (msg: { seq: number; job: WireJob }) => {
  let hydrated: ReturnType<typeof hydrateWireJob>;
  try {
    hydrated = hydrateWireJob(msg.job, datasets);
    // Commit only after every ref in the message resolved. A partial hydration
    // failure leaves the previous cache intact.
    datasets = hydrated.next;
  } catch (err) {
    port.postMessage({ seq: msg.seq, error: errMessage(err), hydrated: false });
    return;
  }
  executeJob(hydrated.job)
    .then((result) => port.postMessage({ seq: msg.seq, result, hydrated: true }))
    .catch((err: unknown) =>
      port.postMessage({ seq: msg.seq, error: errMessage(err), hydrated: true }),
    );
});

// Announce that the listener above is attached. The pool holds every job until
// this arrives: a `new Worker()` can occasionally produce a thread whose entry
// module never executes at all — no `error` event, no `exit` event, nothing
// (heyphat/pinestack#12) — and a job posted to that thread would never settle.
// Readiness is the signal that lets pool.ts bound the wait and recover.
port.postMessage({ ready: true });

function errMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}
