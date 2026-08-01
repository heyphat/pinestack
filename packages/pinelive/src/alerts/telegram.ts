/**
 * Telegram alert channel — Bot API `sendMessage`, under the same delivery
 * contract as the webhook channel: never leaks its secrets (the bot token is
 * part of the request URL and the chat id identifies an account — both are
 * construction secrets that appear in no ledger row, log, or thrown message),
 * coarse non-PII failure reasons (`http-429`, `telegram-403`, `AbortError`),
 * and transient-only retries. One Telegram-specific addition: a 429 body may
 * carry `parameters.retry_after` (seconds), and the retry honors it — capped,
 * because the dispatcher's per-alert deadline is the real budget.
 *
 * Messages are plain text (no parse_mode): alert payloads are user-authored
 * strings, and MarkdownV2/HTML would demand escaping that can itself fail
 * delivery. Text is truncated to Telegram's 4096-character message limit.
 */

import {
  DEFAULT_ALERT_ATTEMPTS,
  DEFAULT_ALERT_RETRY_DELAY_MS,
  type AlertChannel,
  type StrategyAlert,
} from '../core/alerts.js';

export const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
/** Bot API text limit ("1-4096 characters after entities parsing"). */
export const TELEGRAM_MAX_TEXT_LENGTH = 4_096;
/** Ceiling on honoring a server-requested retry_after within one send. */
const MAX_RETRY_AFTER_MS = 10_000;

export interface TelegramAlertChannelOptions {
  /** Ledger-safe identity; defaults are assigned by config normalization. */
  readonly name: string;
  /** BotFather token (`<digits>:<secret>`). A construction secret. */
  readonly botToken: string;
  /** Target chat: user/group/channel id, or an `@channelusername`. A secret. */
  readonly chatId: string;
  /** Deliver silently (no notification sound). Default false. */
  readonly disableNotification?: boolean;
  /** Total tries including the first. Default 2. */
  readonly attempts?: number;
  /** Linear backoff base between tries when the server names no delay. */
  readonly retryDelayMs?: number;
  /** Override for tests/self-hosted Bot API servers. */
  readonly apiBaseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** Deterministic plain-text rendering of one alert, truncated to the API limit. */
export function telegramAlertText(alert: Readonly<StrategyAlert>): string {
  const when = new Date(alert.firedAt).toISOString();
  const text =
    `${alert.strategySymbol} ${alert.timeframe} — ${alert.message}\n` +
    `price ${alert.price} · bar close ${when} · ${alert.strategyId}`;
  return text.length > TELEGRAM_MAX_TEXT_LENGTH ? text.slice(0, TELEGRAM_MAX_TEXT_LENGTH) : text;
}

const TOKEN_SHAPE = /^\d+:[\w-]+$/;

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export class TelegramAlertChannel implements AlertChannel {
  readonly name: string;
  private readonly endpoint: string;
  private readonly chatId: string;
  private readonly disableNotification: boolean;
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: TelegramAlertChannelOptions) {
    if (!options.name) throw new RangeError('telegram alert channel requires a name');
    if (typeof options.botToken !== 'string' || !TOKEN_SHAPE.test(options.botToken))
      throw new RangeError(
        `telegram alert channel "${options.name}" botToken must look like "<digits>:<secret>"`,
      );
    if (typeof options.chatId !== 'string' || options.chatId.trim().length === 0)
      throw new RangeError(`telegram alert channel "${options.name}" requires a chatId`);
    const base = options.apiBaseUrl ?? TELEGRAM_API_BASE_URL;
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch (error) {
      throw new RangeError(`telegram alert channel "${options.name}" has an invalid apiBaseUrl`, {
        cause: error,
      });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      throw new RangeError(`telegram alert channel "${options.name}" apiBaseUrl must be http(s)`);
    this.name = options.name;
    this.endpoint = `${base.replace(/\/$/, '')}/bot${options.botToken}/sendMessage`;
    this.chatId = options.chatId;
    this.disableNotification = options.disableNotification ?? false;
    this.attempts = options.attempts ?? DEFAULT_ALERT_ATTEMPTS;
    if (!Number.isSafeInteger(this.attempts) || this.attempts < 1)
      throw new RangeError('telegram attempts must be a positive safe integer');
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_ALERT_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0)
      throw new RangeError('telegram retryDelayMs must be a non-negative safe integer');
    const fetchImpl = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!fetchImpl) throw new RangeError('telegram alert channel requires a fetch implementation');
    this.fetchImpl = fetchImpl;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  async send(alert: Readonly<StrategyAlert>, signal?: AbortSignal): Promise<void> {
    const body = JSON.stringify({
      chat_id: this.chatId,
      text: telegramAlertText(alert),
      ...(this.disableNotification ? { disable_notification: true } : {}),
    });
    let lastReason = 'network-error';
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      if (signal?.aborted) throw abortError();
      let retryAfterMs: number | undefined;
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal,
        });
        const outcome = await interpretResponse(response);
        if (outcome.ok) return;
        lastReason = outcome.reason;
        retryAfterMs = outcome.retryAfterMs;
        if (!outcome.retryable) throw new Error(lastReason);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (error instanceof Error && /^(http|telegram)-\d+$/.test(error.message)) {
          // Interpreted terminal outcome from above — permanent, rethrow as-is.
          if (!isInterpretedRetryable(error.message)) throw error;
          lastReason = error.message;
        } else {
          // Redaction: keep the error class only — transport failures can embed
          // the endpoint URL, which contains the bot token.
          lastReason =
            error instanceof Error && error.name && error.name !== 'Error'
              ? error.name
              : 'network-error';
        }
      }
      if (attempt < this.attempts) await this.sleep(retryAfterMs ?? this.retryDelayMs * attempt);
    }
    throw new Error(lastReason);
  }
}

interface InterpretedResponse {
  readonly ok: boolean;
  readonly reason: string;
  readonly retryable: boolean;
  /** Server-requested backoff from a 429 body, already capped. */
  readonly retryAfterMs?: number;
}

/**
 * Fold the HTTP status and the Bot API envelope into one coarse outcome. The
 * envelope's `description` is deliberately dropped: coarse reasons only.
 */
async function interpretResponse(response: Response): Promise<InterpretedResponse> {
  let envelope: { ok?: boolean; error_code?: number; parameters?: { retry_after?: number } } = {};
  try {
    envelope = (await response.json()) as typeof envelope;
  } catch {
    // Non-JSON body (proxy error page); the HTTP status decides alone.
  }
  if (response.ok && envelope.ok === true) return { ok: true, reason: '', retryable: false };
  const code = envelope.error_code ?? response.status;
  const reason = envelope.error_code != null ? `telegram-${code}` : `http-${response.status}`;
  const retryAfterSeconds = envelope.parameters?.retry_after;
  const retryAfterMs =
    typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)
      ? Math.min(Math.max(retryAfterSeconds, 0) * 1000, MAX_RETRY_AFTER_MS)
      : undefined;
  return { ok: false, reason, retryable: isRetryableStatus(code), retryAfterMs };
}

function isInterpretedRetryable(reason: string): boolean {
  const code = Number(reason.slice(reason.indexOf('-') + 1));
  return isRetryableStatus(code);
}

function abortError(): Error {
  const error = new Error('http request aborted');
  error.name = 'AbortError';
  return error;
}
