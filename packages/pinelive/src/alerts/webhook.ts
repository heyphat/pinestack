/**
 * Webhook alert channel — fractal's delivery contract, server-side.
 *
 * One JSON POST per alert. Never leaks the destination: the URL and headers
 * are construction secrets that appear in no error, log, or ledger row — the
 * ledger sees only the channel `name`. Failure reasons are coarse and non-PII
 * (`http-503`, `AbortError`, `network-error`), and transient failures
 * (network errors, 5xx, 408, 429) retry with a small linear backoff while any
 * other 4xx is permanent — exactly the fractal webhook policy. The dispatcher
 * owns the overall per-alert deadline via the abort signal; retries here stop
 * the moment that signal fires.
 */

import {
  DEFAULT_ALERT_ATTEMPTS,
  DEFAULT_ALERT_RETRY_DELAY_MS,
  type AlertChannel,
  type StrategyAlert,
} from '../core/alerts.js';

export interface WebhookAlertChannelOptions {
  /** Ledger-safe identity; defaults are assigned by config normalization. */
  readonly name: string;
  /** http(s) destination. A construction secret — never journaled or thrown. */
  readonly url: string;
  /** Optional static headers (e.g. an auth token). Same secrecy as the URL. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Total tries including the first. Default 2. */
  readonly attempts?: number;
  /** Linear backoff base between tries. Default 400 ms. */
  readonly retryDelayMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** The POST body — fractal's WebhookPayload shape with strategy identity. */
export interface WebhookAlertPayload {
  readonly type: 'pinelive.alert';
  readonly alertId: string;
  readonly alertName: string;
  readonly message: string;
  readonly instrument: { readonly symbol: string; readonly timeframe: string };
  readonly condition: 'Pine alert()';
  readonly price: number;
  /** Bar close, unix milliseconds — sample time, never wall clock. */
  readonly firedAt: number;
  /** Bar open, unix seconds. */
  readonly barTime: number;
  readonly ordinal: number;
  readonly runId: string;
  readonly source: StrategyAlert['source'];
}

export function webhookAlertPayload(alert: Readonly<StrategyAlert>): WebhookAlertPayload {
  return {
    type: 'pinelive.alert',
    alertId: `pine:${alert.strategyId}`,
    alertName: alert.strategyId,
    message: alert.message,
    instrument: { symbol: alert.strategySymbol, timeframe: alert.timeframe },
    condition: 'Pine alert()',
    price: alert.price,
    firedAt: alert.firedAt,
    barTime: alert.barTime,
    ordinal: alert.ordinal,
    runId: alert.runId,
    source: alert.source,
  };
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export class WebhookAlertChannel implements AlertChannel {
  readonly name: string;
  private readonly url: string;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: WebhookAlertChannelOptions) {
    if (!options.name) throw new RangeError('webhook alert channel requires a name');
    let parsed: URL;
    try {
      parsed = new URL(options.url);
    } catch (error) {
      throw new RangeError(`webhook alert channel "${options.name}" has an invalid url`, {
        cause: error,
      });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      throw new RangeError(`webhook alert channel "${options.name}" url must be http(s)`);
    this.name = options.name;
    this.url = options.url;
    this.headers = { ...options.headers };
    this.attempts = options.attempts ?? DEFAULT_ALERT_ATTEMPTS;
    if (!Number.isSafeInteger(this.attempts) || this.attempts < 1)
      throw new RangeError('webhook attempts must be a positive safe integer');
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_ALERT_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0)
      throw new RangeError('webhook retryDelayMs must be a non-negative safe integer');
    const fetchImpl = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!fetchImpl) throw new RangeError('webhook alert channel requires a fetch implementation');
    this.fetchImpl = fetchImpl;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async send(alert: Readonly<StrategyAlert>, signal?: AbortSignal): Promise<void> {
    const body = JSON.stringify(webhookAlertPayload(alert));
    let lastReason = 'network-error';
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      if (signal?.aborted) throw abortError();
      try {
        const response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.headers },
          body,
          signal,
        });
        if (response.ok) return;
        lastReason = `http-${response.status}`;
        if (!isRetryableStatus(response.status)) throw new Error(lastReason);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (error instanceof Error && /^http-\d{3}$/.test(error.message)) {
          if (!isRetryableStatus(Number(error.message.slice(5)))) throw error;
          lastReason = error.message;
        } else {
          // Redaction: keep the error class only — fetch failures can embed the URL.
          lastReason =
            error instanceof Error && error.name && error.name !== 'Error'
              ? error.name
              : 'network-error';
        }
      }
      if (attempt < this.attempts) await this.sleep(this.retryDelayMs * attempt);
    }
    throw new Error(lastReason);
  }
}

function abortError(): Error {
  const error = new Error('http request aborted');
  error.name = 'AbortError';
  return error;
}
