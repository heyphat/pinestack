/**
 * Alert delivery — the host side of Pine `alert()`.
 *
 * piner owns emission: the engine appends `{ bar, message }` to its output
 * collector during evaluation and rolls forming-tick alerts back itself.
 * Everything here is delivery policy, mirroring the fractal web app's
 * alerting module so the two hosts behave identically where the concepts map:
 * a pure sample-time frequency gate (fractal `frequencyGate`), warmup/replay
 * alerts staying data, bounded fail-open dispatch, and coarse non-PII failure
 * reasons. Dispatch must never delay or destabilize trading: the runner calls
 * it after reconciliation, and nothing in this module throws into the caller.
 */

export type AlertFrequency = 'all' | 'once_per_bar' | 'once_per_bar_close';

/** Close-only today; the field exists so forming dispatch can be added additively. */
export type AlertSource = 'bar-close';

export const DEFAULT_ALERT_FREQUENCY: AlertFrequency = 'once_per_bar_close';
export const DEFAULT_ALERT_SEND_TIMEOUT_MS = 8_000;
export const DEFAULT_ALERT_ATTEMPTS = 2;
export const DEFAULT_ALERT_RETRY_DELAY_MS = 400;
export const DEFAULT_MAX_ALERTS_PER_BAR = 20;
/** Mirrors fractal's alert message cap. */
export const MAX_ALERT_MESSAGE_LENGTH = 1_000;

/** One gated Pine alert, enriched with the identity a channel payload needs. */
export interface StrategyAlert {
  readonly runId: string;
  readonly strategyId: string;
  readonly strategySymbol: string;
  readonly timeframe: string;
  /** Bar open, unix seconds. */
  readonly barTime: number;
  /** Bar close, unix milliseconds — sample time, never wall clock (fractal parity). */
  readonly firedAt: number;
  /** The evaluated bar's close. */
  readonly price: number;
  /** 1-based position among the bar's gated alerts. */
  readonly ordinal: number;
  /** Truncated to MAX_ALERT_MESSAGE_LENGTH. */
  readonly message: string;
  readonly source: AlertSource;
}

/**
 * A notification destination. Implementations own their transport policy
 * (retries, backoff) but must reject — not hang — on failure, honor the
 * signal, and never place secrets (URLs, tokens, account ids) in `name` or
 * thrown messages. `runAlertChannelConformance` enforces the behavioral half.
 */
export interface AlertChannel {
  /** Ledger-safe identity. Never a URL, token, or account id. */
  readonly name: string;
  send(alert: Readonly<StrategyAlert>, signal?: AbortSignal): Promise<void>;
  close?(): Promise<void>;
}

export type AlertDeliveryStatus = 'sent' | 'failed' | 'suppressed';

export interface AlertDeliveryOutcome {
  readonly channel: string;
  readonly outcome: AlertDeliveryStatus;
  /** Coarse, non-PII reason (`http-503`, `AbortError`, `network-error`). */
  readonly error?: string;
}

export interface DispatchedAlert {
  readonly alert: StrategyAlert;
  readonly deliveries: readonly AlertDeliveryOutcome[];
}

export interface AlertSample {
  /** Bar open, unix seconds. */
  readonly barTime: number;
  /** Authoritative bar close? Always true on today's close-only dispatch paths. */
  readonly closed: boolean;
}

export interface AlertFrequencyState {
  lastFiredBarTime?: number;
}

/**
 * Pure emission gate, the exact shape of fractal's `frequencyGate`: depends
 * only on the sample and the prior firing marker, never on wall-clock time.
 * Called per message identity once its `alert()` call was observed.
 */
export function alertFrequencyGate(
  frequency: AlertFrequency,
  state: Readonly<AlertFrequencyState>,
  sample: Readonly<AlertSample>,
): { emit: boolean } {
  switch (frequency) {
    case 'all':
      return { emit: true };
    case 'once_per_bar':
      return { emit: sample.barTime !== state.lastFiredBarTime };
    case 'once_per_bar_close':
      return { emit: sample.closed && sample.barTime !== state.lastFiredBarTime };
  }
}

/** Coerce and cap an engine-emitted message before gating, journaling, or dispatch. */
export function normalizeAlertMessage(message: unknown): string {
  const text = typeof message === 'string' ? message : String(message);
  return text.length > MAX_ALERT_MESSAGE_LENGTH ? text.slice(0, MAX_ALERT_MESSAGE_LENGTH) : text;
}

export interface AlertEvaluationContext {
  readonly runId: string;
  readonly strategyId: string;
  readonly strategySymbol: string;
  readonly timeframe: string;
  /** Bar open, unix seconds. */
  readonly barTime: number;
  /** Bar close, unix milliseconds. */
  readonly barCloseMs: number;
  /** The evaluated bar's close. */
  readonly price: number;
  /** Authoritative final? Close-only dispatch passes true. */
  readonly closed: boolean;
  /** Raw messages emitted by this evaluation, in `alert()` call order. */
  readonly messages: readonly unknown[];
}

export interface AlertDispatcherOptions {
  readonly channels: readonly AlertChannel[];
  readonly frequency?: AlertFrequency;
  /** Overall deadline per alert per channel, covering the channel's own retries. */
  readonly sendTimeoutMs?: number;
  /** Gated alerts allowed per bar; overflow is journaled as suppressed, never sent. */
  readonly maxPerBar?: number;
  /** Advisory failure hook (logging); failures are also reported in the outcomes. */
  readonly onError?: (channel: string, alert: StrategyAlert, reason: string) => void;
}

/**
 * Fail-open, bounded delivery. `process` never throws: every gated alert
 * yields one report whose per-channel outcomes the caller journals. Channels
 * are attempted sequentially per alert so a burst cannot fan out unboundedly,
 * and each send runs under one abort-signalled deadline.
 */
export class AlertDispatcher {
  private readonly channels: readonly AlertChannel[];
  private readonly frequency: AlertFrequency;
  private readonly sendTimeoutMs: number;
  private readonly maxPerBar: number;
  private readonly onError?: AlertDispatcherOptions['onError'];
  /** Per-message firing markers for the active bar only — bounded by construction. */
  private gateBarTime?: number;
  private firedThisBar = new Set<string>();
  private countThisBar = 0;

  constructor(options: AlertDispatcherOptions) {
    this.channels = [...options.channels];
    if (this.channels.length === 0)
      throw new RangeError('alert dispatcher requires at least one channel');
    const names = new Set(this.channels.map((channel) => channel.name));
    if (names.size !== this.channels.length)
      throw new RangeError('alert channel names must be unique');
    this.frequency = options.frequency ?? DEFAULT_ALERT_FREQUENCY;
    this.sendTimeoutMs = options.sendTimeoutMs ?? DEFAULT_ALERT_SEND_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.sendTimeoutMs) || this.sendTimeoutMs <= 0)
      throw new RangeError('sendTimeoutMs must be a positive safe integer');
    this.maxPerBar = options.maxPerBar ?? DEFAULT_MAX_ALERTS_PER_BAR;
    if (!Number.isSafeInteger(this.maxPerBar) || this.maxPerBar <= 0)
      throw new RangeError('maxPerBar must be a positive safe integer');
    this.onError = options.onError;
  }

  get channelNames(): readonly string[] {
    return this.channels.map((channel) => channel.name);
  }

  /** Gate, cap, and deliver one evaluation's alerts. Never throws. */
  async process(context: Readonly<AlertEvaluationContext>): Promise<DispatchedAlert[]> {
    if (context.messages.length === 0) return [];
    if (this.gateBarTime !== context.barTime) {
      this.gateBarTime = context.barTime;
      this.firedThisBar = new Set();
      this.countThisBar = 0;
    }
    const sample: AlertSample = { barTime: context.barTime, closed: context.closed };
    const reports: DispatchedAlert[] = [];
    for (const raw of context.messages) {
      const message = normalizeAlertMessage(raw);
      const state: AlertFrequencyState = this.firedThisBar.has(message)
        ? { lastFiredBarTime: context.barTime }
        : {};
      if (!alertFrequencyGate(this.frequency, state, sample).emit) continue;
      this.firedThisBar.add(message);
      this.countThisBar++;
      const alert: StrategyAlert = {
        runId: context.runId,
        strategyId: context.strategyId,
        strategySymbol: context.strategySymbol,
        timeframe: context.timeframe,
        barTime: context.barTime,
        firedAt: context.barCloseMs,
        price: context.price,
        ordinal: this.countThisBar,
        message,
        source: 'bar-close',
      };
      if (this.countThisBar > this.maxPerBar) {
        const reason = `suppressed: more than ${this.maxPerBar} alerts on one bar`;
        reports.push({
          alert,
          deliveries: this.channels.map((channel) => ({
            channel: channel.name,
            outcome: 'suppressed' as const,
          })),
        });
        this.onError?.('*', alert, reason);
        continue;
      }
      reports.push({ alert, deliveries: await this.deliver(alert) });
    }
    return reports;
  }

  private async deliver(alert: StrategyAlert): Promise<AlertDeliveryOutcome[]> {
    const deliveries: AlertDeliveryOutcome[] = [];
    for (const channel of this.channels) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.sendTimeoutMs);
      try {
        await channel.send(alert, controller.signal);
        deliveries.push({ channel: channel.name, outcome: 'sent' });
      } catch (error) {
        const reason = coarseReason(error);
        deliveries.push({ channel: channel.name, outcome: 'failed', error: reason });
        this.onError?.(channel.name, alert, reason);
      } finally {
        clearTimeout(timer);
      }
    }
    return deliveries;
  }

  /** Settle every channel's close; never throws. */
  async close(): Promise<void> {
    await Promise.all(
      this.channels.map((channel) =>
        Promise.resolve()
          .then(() => channel.close?.())
          .catch(() => undefined),
      ),
    );
  }
}

/**
 * Reduce an arbitrary failure to a coarse, non-PII reason — the fractal
 * convention: an HTTP-shaped `http-<status>` marker survives, everything else
 * degrades to the error's name so URLs, headers, and payloads cannot leak.
 */
export function coarseReason(error: unknown): string {
  if (error instanceof Error) {
    if (/^http-\d{3}$/.test(error.message)) return error.message;
    return error.name && error.name !== 'Error' ? error.name : 'network-error';
  }
  return 'network-error';
}
