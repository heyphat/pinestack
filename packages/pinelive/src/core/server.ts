import type { MarketDataProvider } from '@heyphat/pinery';
import type { Broker } from './broker.js';
import type { LedgerSink } from './ledger.js';
import type { PositionMirrorOptions } from './mirror.js';
import { ForwardRunner } from './runner.js';
import type { RunInstrumentBinding } from './binding.js';

export interface ForwardServerOptions {
  source: string;
  symbol: string;
  timeframe: string;
  data: MarketDataProvider;
  broker: Broker;
  ledger: LedgerSink;
  warmupBars?: number;
  inputs?: Readonly<Record<string, unknown>>;
  runId?: string;
  strategyId?: string;
  executionId?: string;
  reconcileOnStart?: boolean;
  /** Resolve `request.security` dependencies via secondary provider feeds. Default true. */
  resolveSecurity?: boolean;
  /** Bars fetched per secondary feed. Defaults to chart-history bars actually received. */
  securityWarmupBars?: number;
  /** Hard total-series ceiling per feed. Exceeding it stops the run. */
  maxSecurityBars?: number;
  maxSecurityFeeds?: number;
  securityConcurrency?: number;
  securityRequestTimeoutMs?: number;
  /** Failed refreshes tolerated before stopping. Default 0. */
  maxSecurityStaleRefreshes?: number;
  mirror?: PositionMirrorOptions;
  signal?: AbortSignal;
  onLog?: (message: string) => void;
}

export interface ForwardServerResult {
  finalPosition: number;
  finalEquity: number;
  binding: RunInstrumentBinding;
}

/** Run until pinery ends or the signal aborts. Shutdown never flattens. */
export async function runForwardServer(
  options: ForwardServerOptions,
): Promise<ForwardServerResult> {
  if (options.signal?.aborted) throw new Error('forward server start aborted');
  const runner = new ForwardRunner(options.data, options.broker, {
    source: options.source,
    symbol: options.symbol,
    timeframe: options.timeframe,
    warmupBars: options.warmupBars,
    inputs: options.inputs,
    runId: options.runId,
    strategyId: options.strategyId,
    executionId: options.executionId,
    reconcileOnStart: options.reconcileOnStart,
    resolveSecurity: options.resolveSecurity,
    securityWarmupBars: options.securityWarmupBars,
    maxSecurityBars: options.maxSecurityBars,
    maxSecurityFeeds: options.maxSecurityFeeds,
    securityConcurrency: options.securityConcurrency,
    securityRequestTimeoutMs: options.securityRequestTimeoutMs,
    maxSecurityStaleRefreshes: options.maxSecurityStaleRefreshes,
    onSecurityFetch: (key, bars) => options.onLog?.(`security feed ${key} bars=${bars}`),
    onSecurityError: (key, error) => options.onLog?.(`security feed ${key} STALE: ${error}`),
    onSecurityHealth: (record) => options.ledger.append(record),
    mirror: { transientRetries: 2, retryDelayMs: 250, ...options.mirror },
    onBinding: (record) => options.ledger.append(record),
    onStartupRecord: async (record) => {
      await options.ledger.append(record);
      options.onLog?.(`startup target=${record.target} action=${record.action}`);
    },
    onRecord: async (record) => {
      await options.ledger.append(record);
      const order = record.order
        ? ` order=${record.order.type}${
            record.order.type === 'limit' ? `@${record.order.limitPrice}` : ''
          }`
        : '';
      const fill = record.fill ? ` fill=${record.fill.filledQty}@${record.fill.price}` : '';
      const error = record.error ? ` ${record.error.code}: ${record.error.message}` : '';
      options.onLog?.(
        `${record.bar.time} target=${record.target} action=${record.action}${order}${fill}${error}`,
      );
    },
  });
  const abort = () => runner.cancel();
  options.signal?.addEventListener('abort', abort, { once: true });

  let result: ForwardServerResult | undefined;
  let primaryError: unknown;
  try {
    await runner.start();
    const binding = runner.binding;
    if (!binding) throw new Error('forward server stopped before instrument binding');
    const [position, account] = await Promise.all([
      options.broker.getPosition(binding.executionSymbol),
      options.broker.getAccount(),
    ]);
    result = { finalPosition: position.qty, finalEquity: account.equity, binding };
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
  await cleanup(() => runner.stop());
  await cleanup(async () => options.ledger.flush?.());
  await cleanup(() => runner.disconnect());
  await cleanup(async () => options.ledger.close?.());

  if (primaryError !== undefined) {
    if (cleanupErrors.length > 0)
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'forward server and cleanup failed',
      );
    throw primaryError;
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(cleanupErrors, 'forward server cleanup failed');
  if (!result) throw new Error('forward server stopped before final state was available');
  return result;
}
