/**
 * @heyphat/pinerun/node — Node-only additions: the worker-thread pool runner.
 * Re-exports the browser-safe core for convenience so Node consumers import from
 * a single entry.
 */
export * from './index.js';
export { WorkerPoolRunner, type WorkerPoolOptions } from './pool.js';
