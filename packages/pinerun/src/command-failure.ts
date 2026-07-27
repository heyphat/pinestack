import { ExactHistoryError } from '@heyphat/pinery';
import { BarMagnifierError } from './failure.js';
import type { Job } from './job.js';
import type { RunFailure, RunResult } from './result.js';

/** Runtime guard for JavaScript callers; TypeScript's optional boolean is not enough. */
export function assertBooleanOverride(value: unknown, name = 'useBarMagnifier'): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError(`${name} must be true, false, or undefined`);
  }
}

/** Preserve the two serializable permanent exact-mode failure vocabularies. */
export function exactRunFailure(error: unknown): RunFailure | undefined {
  if (error instanceof BarMagnifierError || error instanceof ExactHistoryError) {
    return error.toJSON();
  }
  return undefined;
}

/** A command-level failure shaped exactly like an execution failure. */
export function failedJobResult(
  job: Pick<Job, 'id' | 'symbol' | 'timeframe' | 'bars'>,
  error: unknown,
): RunResult {
  const message = error instanceof Error ? error.message : String(error);
  const failure = exactRunFailure(error);
  return {
    id: job.id ?? `${job.symbol}@${job.timeframe}`,
    symbol: job.symbol,
    timeframe: job.timeframe,
    ok: false,
    bars: job.bars.length,
    plots: [],
    alerts: [],
    error: message,
    ...(failure ? { failure } : {}),
  };
}
