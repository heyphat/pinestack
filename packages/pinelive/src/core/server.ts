import type { Broker } from './broker.js';
import type { LiveFeed } from './feed.js';
import type { LedgerSink } from './ledger.js';
import type { PositionMirrorOptions } from './mirror.js';
import { ForwardRunner } from './runner.js';

export interface ForwardServerOptions {
  source: string;
  symbol: string;
  timeframe: string;
  broker: Broker;
  feed: LiveFeed;
  ledger: LedgerSink;
  warmupBars?: number;
  inputs?: Readonly<Record<string, unknown>>;
  runId?: string;
  strategyId?: string;
  executionId?: string;
  mirror?: PositionMirrorOptions;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
}

export interface ForwardServerResult {
  finalPosition: number;
  finalEquity: number;
}

/** Run until the feed ends or the signal aborts. Shutdown never flattens. */
export async function runForwardServer(
  options: ForwardServerOptions,
): Promise<ForwardServerResult> {
  if (options.signal?.aborted) throw new Error('forward server start aborted');
  const runner = new ForwardRunner(options.broker, options.feed, {
    source: options.source,
    symbol: options.symbol,
    timeframe: options.timeframe,
    warmupBars: options.warmupBars,
    inputs: options.inputs,
    runId: options.runId,
    strategyId: options.strategyId,
    executionId: options.executionId,
    mirror: { transientRetries: 2, retryDelayMs: 250, ...options.mirror },
    onRecord: async (record) => {
      await options.ledger.append(record);
      const fill = record.fill ? ` fill=${record.fill.filledQty}@${record.fill.price}` : '';
      const error = record.error ? ` ${record.error.code}: ${record.error.message}` : '';
      options.onLog?.(
        `${record.bar.time} target=${record.target} action=${record.action}${fill}${error}`,
      );
    },
  });
  // Cancellation must be synchronous: do not wait for an effectful feed.stop()
  // before preventing an in-progress initialization from reconciling warmup.
  const abort = () => runner.cancel();
  options.signal?.addEventListener('abort', abort, { once: true });

  let result: ForwardServerResult | undefined;
  let primaryError: unknown;
  try {
    await runner.start();
    const [position, account] = await Promise.all([
      options.broker.getPosition(options.symbol),
      options.broker.getAccount(),
    ]);
    result = { finalPosition: position.qty, finalEquity: account.equity };
  } catch (error) {
    primaryError = error;
  }

  options.signal?.removeEventListener('abort', abort);
  const cleanupErrors: unknown[] = [];
  const cleanup = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(error);
    }
  };
  // Every resource gets its cleanup attempt even if an earlier one fails.
  await cleanup(() => runner.stop());
  await cleanup(async () => options.ledger.flush?.());
  await cleanup(() => runner.disconnect());
  await cleanup(async () => options.ledger.close?.());

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'forward server and cleanup failed',
      );
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'forward server cleanup failed');
  }
  if (!result) throw new Error('forward server stopped before final state was available');
  return result;
}
