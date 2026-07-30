import type { Bar } from '@heyphat/piner';
import {
  applyRange,
  assertResolvedDataInstrument,
  barCloseTime,
  MarketDataError,
  normalizeBars,
  throwIfAborted,
  type ClosedBarsOptions,
  type HistoryProvider,
  type HistoryRange,
  type MarketDataProvider,
  type ResolvedDataInstrument,
  type ResolveDataInstrumentOptions,
} from '../provider.js';

export interface ReplayProviderOptions {
  /** First possible live bar open time, unix seconds. Required. */
  cutoverTime: number;
  /** Virtual venue clock used to gate closed bars. Defaults to positive infinity for fixture replay. */
  clock?: () => number;
  /** Delay between virtual-clock checks. Default 1,000ms. */
  clockPollIntervalMs?: number;
  /** Injectable cancellation-aware delay for deterministic virtual-clock tests. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  paceMs?: number;
  /** Required metadata defaults when the historical source has no instrument() values. */
  instrument?: {
    venueSymbol?: string;
    mintick?: number;
    qtyStep?: number;
    minOrderQty?: number;
    pointValue?: number;
    exchange?: string;
    expiry?: string;
  };
}

/** Cutover-based offline provider implementing the same contract as a network provider. */
export class ReplayProvider implements MarketDataProvider {
  readonly id: string;
  readonly assetClass;
  private stopped = false;
  private readonly issued = new WeakSet<object>();

  constructor(
    private readonly source: HistoryProvider,
    private readonly options: ReplayProviderOptions,
  ) {
    this.id = `${source.id}-replay`;
    this.assetClass = source.assetClass;
    if (!Number.isFinite(options.cutoverTime) || options.cutoverTime < 0)
      throw new RangeError('replay cutoverTime must be a non-negative unix timestamp');
    for (const [name, value] of [
      ['paceMs', options.paceMs],
      ['clockPollIntervalMs', options.clockPollIntervalMs],
    ] as const) {
      if (value != null && (!Number.isFinite(value) || value < 0))
        throw new RangeError(`replay ${name} must be non-negative`);
    }
  }

  async resolve(
    strategySymbol: string,
    options: ResolveDataInstrumentOptions = {},
  ): Promise<ResolvedDataInstrument> {
    throwIfAborted(options.signal);
    if (!strategySymbol.trim())
      throw new MarketDataError('invalid-symbol', 'replay symbol is required', {
        retryable: false,
      });
    const info = await this.source.instrument?.(strategySymbol);
    throwIfAborted(options.signal);
    const qtyStep = this.options.instrument?.qtyStep ?? info?.minQty;
    const resolved = {
      strategySymbol,
      providerHandle: `${this.source.id}:${strategySymbol}`,
      venueSymbol: this.options.instrument?.venueSymbol ?? strategySymbol,
      mintick: this.options.instrument?.mintick ?? info?.mintick,
      qtyStep,
      minOrderQty: this.options.instrument?.minOrderQty ?? qtyStep,
      pointValue: this.options.instrument?.pointValue,
      exchange: this.options.instrument?.exchange,
      expiry: this.options.instrument?.expiry,
    };
    const instrument = Object.freeze(
      assertResolvedDataInstrument(resolved as ResolvedDataInstrument),
    );
    this.issued.add(instrument);
    return instrument;
  }

  async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
    const resolved = await this.resolve(symbol);
    return this.historyResolved(resolved, timeframe, range);
  }

  async instrument(symbol: string) {
    return this.source.instrument?.(symbol);
  }

  async historyResolved(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    range?: HistoryRange,
    signal?: AbortSignal,
  ): Promise<Bar[]> {
    this.assertOwned(instrument);
    throwIfAborted(signal);
    const capAtCutover = range?.to == null;
    const sourceRange = {
      ...range,
      ...(capAtCutover ? { to: this.options.cutoverTime - 1 } : {}),
      limit: undefined,
    };
    const bars = normalizeBars(
      await this.source.history(instrument.strategySymbol, timeframe, sourceRange),
    );
    throwIfAborted(signal);
    return applyRange(
      capAtCutover ? bars.filter((bar) => bar.time < this.options.cutoverTime) : bars,
      range,
    ).map((bar) => ({ ...bar }));
  }

  async *closedBars(
    instrument: ResolvedDataInstrument,
    timeframe: string,
    options: ClosedBarsOptions = {},
  ): AsyncIterable<Bar> {
    this.assertOwned(instrument);
    throwIfAborted(options.signal);
    const from = Math.max(this.options.cutoverTime, (options.after ?? -Infinity) + 1);
    const bars = normalizeBars(
      await this.source.history(instrument.strategySymbol, timeframe, { from }),
    );
    let last = options.after ?? -Infinity;
    for (const bar of bars) {
      if (this.stopped || options.signal?.aborted) return;
      if (bar.time < this.options.cutoverTime || bar.time <= last) continue;
      while (barCloseTime(bar.time, timeframe) > this.clock()) {
        await this.sleep(this.options.clockPollIntervalMs ?? 1_000, options.signal);
        if (this.stopped || options.signal?.aborted) return;
      }
      if ((this.options.paceMs ?? 0) > 0) await this.sleep(this.options.paceMs!, options.signal);
      if (this.stopped || options.signal?.aborted) return;
      last = bar.time;
      yield { ...bar };
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if ('disconnect' in this.source && typeof this.source.disconnect === 'function')
      await this.source.disconnect();
  }

  private clock(): number {
    if (!this.options.clock) return Number.POSITIVE_INFINITY;
    const now = this.options.clock();
    if (!Number.isFinite(now) || now < 0)
      throw new MarketDataError('malformed-data', 'replay clock returned an invalid unix time', {
        retryable: false,
      });
    return now;
  }

  private sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
    return (this.options.sleep ?? wait)(milliseconds, signal);
  }

  private assertOwned(instrument: ResolvedDataInstrument): void {
    if (!this.issued.has(instrument))
      throw new MarketDataError(
        'invalid-symbol',
        'resolved instrument was not issued by this provider',
        { retryable: false },
      );
  }
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
