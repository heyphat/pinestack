/**
 * Behavioral conformance for AlertChannel implementations — the alerting
 * sibling of runBrokerConformance. A channel must deliver a well-formed alert,
 * reject (not hang) on an aborted signal, fail with Error instances, and keep
 * its construction secrets out of everything observable.
 */

import type { AlertChannel, StrategyAlert } from '../core/alerts.js';

export interface AlertChannelConformanceOptions {
  /** A fresh channel per check; construction must be side-effect free. */
  readonly create: () => AlertChannel | Promise<AlertChannel>;
  /**
   * Construction secrets (URLs, tokens). Conformance asserts none of them
   * appear in the channel name or in any thrown message.
   */
  readonly secrets?: readonly string[];
  /** Sends during the happy-path check must resolve within this bound. */
  readonly sendTimeoutMs?: number;
}

export interface AlertConformanceFailure {
  readonly check: string;
  readonly message: string;
}

export const CONFORMANCE_ALERT: StrategyAlert = Object.freeze({
  runId: 'conformance-run',
  strategyId: 'conformance-strategy',
  strategySymbol: 'CONF',
  timeframe: '1h',
  barTime: 1_704_067_200,
  firedAt: 1_704_070_800_000,
  price: 100.5,
  ordinal: 1,
  message: 'conformance alert',
  source: 'bar-close',
});

export async function runAlertChannelConformance(
  options: AlertChannelConformanceOptions,
): Promise<AlertConformanceFailure[]> {
  const failures: AlertConformanceFailure[] = [];
  const secrets = options.secrets ?? [];
  const timeoutMs = options.sendTimeoutMs ?? 10_000;

  const leak = (text: string): string | undefined =>
    secrets.find((secret) => text.includes(secret));

  // 1. A well-formed alert delivers within the bound.
  try {
    const channel = await options.create();
    const secretInName = leak(channel.name);
    if (secretInName)
      failures.push({ check: 'redaction', message: 'channel name contains a secret' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        channel.send(CONFORMANCE_ALERT),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('send timed out')), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await channel.close?.();
  } catch (error) {
    failures.push({
      check: 'delivery',
      message: `well-formed send rejected: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // 2. An already-aborted signal rejects promptly instead of sending or hanging.
  try {
    const channel = await options.create();
    const controller = new AbortController();
    controller.abort();
    let rejected = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        channel.send(CONFORMANCE_ALERT, controller.signal).then(
          () => undefined,
          (error: unknown) => {
            rejected = true;
            if (!(error instanceof Error))
              failures.push({ check: 'abort', message: 'abort rejection is not an Error' });
            else {
              const secretInMessage = leak(error.message);
              if (secretInMessage)
                failures.push({ check: 'redaction', message: 'abort error leaks a secret' });
            }
          },
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('aborted send hung')), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!rejected)
      failures.push({ check: 'abort', message: 'send resolved despite an aborted signal' });
    await channel.close?.();
  } catch (error) {
    failures.push({
      check: 'abort',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return failures;
}
