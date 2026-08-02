/**
 * Host-side `request.security` orchestration for the forward runner.
 *
 * piner declares dependencies and consumes injected bars; it never fetches. This module plans
 * concrete provider feeds, warms them before the historical replay, and refreshes them before
 * each closed chart bar. Live trading is fail-closed by default: a feed that cannot be proven
 * current enough to evaluate safely stops the run before reconciliation.
 */
import { ArrayFeed, Engine } from '@heyphat/piner';
import type { CompiledScript, SecurityDependency, SecurityRequest } from '@heyphat/piner';
import {
  barCloseTime,
  normalizeBars,
  pinerTimeframeToCanonical,
  resolveLowerFetchTf,
  resolveSameSymbolFetchTf,
  timeframeSeconds,
  type Bar,
  type MarketDataProvider,
  type ResolvedDataInstrument,
  type Timeframe,
} from '@heyphat/pinery';
import { toPinerBar } from './time.js';

export const PROBE_SYMBOL = '__pinelive_probe__';
export const DEFAULT_MAX_SECURITY_BARS = 5000;
export const DEFAULT_MAX_SECURITY_FEEDS = 32;
export const DEFAULT_SECURITY_CONCURRENCY = 4;
export const DEFAULT_SECURITY_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_SECURITY_STALE_REFRESHES = 0;

export type SecurityFeedKind = 'cross' | 'cross-lower-tf' | 'self' | 'self-lower-tf';

export interface SecurityFeedSpec {
  /** The exact `ctx.securityBars` key piner reads. */
  key: string;
  symbol: string;
  self: boolean;
  /** Canonical pinery timeframe actually fetched. */
  fetchTf: Timeframe;
  /** Raw piner timeframe string (used by timeframe-qualified keys). */
  rawTf: string;
  kind: SecurityFeedKind;
}

export interface SecurityFeedHealth {
  key: string;
  symbol: string;
  timeframe: Timeframe;
  bars: number;
  lastSourceTime: number;
  status: 'healthy' | 'stale';
  consecutiveFailures: number;
  lastError?: string;
}

interface NormalizedDep {
  lowerTf: boolean;
  self: boolean;
  symbol: string | null;
  timeframe: string | null;
}

/** Plain cross-symbol security uses a bare key, so one base feed must satisfy every call site. */
function resolveCrossPlainFetchTf(rawTf: string | null, chartTf: Timeframe): Timeframe {
  if (rawTf === null) return chartTf; // timeframe.period / chart timeframe
  const requested = resolveSameSymbolFetchTf(rawTf, chartTf);
  if (!requested) return chartTf;
  try {
    return timeframeSeconds(requested) <= timeframeSeconds(chartTf) ? requested : chartTf;
  } catch {
    return chartTf;
  }
}

function buildFeeds(
  deps: readonly NormalizedDep[],
  chartTf: Timeframe,
  chartSymbol: string,
): SecurityFeedSpec[] {
  const feeds = new Map<string, SecurityFeedSpec>();
  const add = (feed: SecurityFeedSpec): void => {
    const existing = feeds.get(feed.key);
    if (!existing) {
      feeds.set(feed.key, feed);
      return;
    }
    // A bare cross-symbol key can serve several plain request.security call sites. Fetch the
    // finest required base timeframe and let piner resample it upward for every site.
    if (
      existing.kind === 'cross' &&
      feed.kind === 'cross' &&
      timeframeSeconds(feed.fetchTf) < timeframeSeconds(existing.fetchTf)
    ) {
      feeds.set(feed.key, feed);
    }
  };

  for (const dep of deps) {
    if (dep.lowerTf) {
      const symbol = dep.self ? chartSymbol : dep.symbol;
      if (symbol === null || dep.timeframe === null) continue;
      const fetchTf = resolveLowerFetchTf(dep.timeframe, chartTf);
      if (!fetchTf) continue;
      add({
        key: `${symbol}@${dep.timeframe}`,
        symbol,
        self: dep.self,
        fetchTf,
        rawTf: dep.timeframe,
        kind: dep.self ? 'self-lower-tf' : 'cross-lower-tf',
      });
    } else if (dep.self) {
      if (dep.timeframe === null) continue;
      const fetchTf = resolveSameSymbolFetchTf(dep.timeframe, chartTf);
      if (!fetchTf) continue;
      add({
        key: `${chartSymbol}@${dep.timeframe}`,
        symbol: chartSymbol,
        self: true,
        fetchTf,
        rawTf: dep.timeframe,
        kind: 'self',
      });
    } else if (dep.symbol !== null) {
      add({
        key: dep.symbol,
        symbol: dep.symbol,
        self: false,
        fetchTf: resolveCrossPlainFetchTf(dep.timeframe, chartTf),
        rawTf: dep.timeframe ?? '',
        kind: 'cross',
      });
    }
  }
  return [...feeds.values()];
}

export interface SecurityPlan {
  feeds: SecurityFeedSpec[];
  discovered: boolean;
}

export function planSecurityFromStatic(
  deps: readonly SecurityDependency[],
  chartTf: Timeframe,
  chartSymbol: string,
): SecurityFeedSpec[] | null {
  if (deps.some((dep) => dep.dynamic)) return null;
  return buildFeeds(
    deps.map((dep) => ({
      lowerTf: dep.lowerTf,
      self: dep.self,
      symbol: dep.symbol,
      timeframe: dep.timeframe,
    })),
    chartTf,
    chartSymbol,
  );
}

export function planSecurityFromRequests(
  requests: readonly SecurityRequest[],
  chartTf: Timeframe,
  chartSymbol: string,
  probeSymbol: string = PROBE_SYMBOL,
): SecurityFeedSpec[] {
  return buildFeeds(
    requests.map((request) => {
      const self = request.symbol === probeSymbol || request.symbol === '';
      return {
        lowerTf: request.lowerTf,
        self,
        symbol: self ? null : request.symbol,
        timeframe: request.timeframe,
      };
    }),
    chartTf,
    chartSymbol,
  );
}

/** Return runtime requests not satisfiable by the feeds opened at initialization. */
export function findUncoveredSecurityFeeds(
  requests: readonly SecurityRequest[],
  opened: readonly SecurityFeedSpec[],
  chartTf: Timeframe,
  chartSymbol: string,
): SecurityFeedSpec[] {
  const required = planSecurityFromRequests(requests, chartTf, chartSymbol, chartSymbol);
  const byKey = new Map(opened.map((feed) => [feed.key, feed]));
  return required.filter((feed) => {
    const have = byKey.get(feed.key);
    if (!have) return true;
    // Bare cross feeds can satisfy coarser requests, never finer ones.
    return (
      feed.kind === 'cross' &&
      have.kind === 'cross' &&
      timeframeSeconds(have.fetchTf) > timeframeSeconds(feed.fetchTf)
    );
  });
}

export interface DiscoverOptions {
  timeframe: string;
  inputs?: Readonly<Record<string, unknown>>;
  backend?: 'js' | 'interp';
  mintick?: number;
}

export async function discoverSecurityRequests(
  compiled: CompiledScript,
  pinerBars: readonly Bar[],
  opts: DiscoverOptions,
): Promise<SecurityRequest[]> {
  const engine = new Engine(compiled, new ArrayFeed([...pinerBars]), {
    backend: opts.backend ?? 'js',
    inputs: opts.inputs as Record<string, unknown> | undefined,
  });
  await engine.run({ symbol: PROBE_SYMBOL, timeframe: opts.timeframe, mintick: opts.mintick });
  return engine.outputs.securityRequests.map((request) => ({ ...request }));
}

export interface SecurityFeedManagerOptions {
  chartTf: Timeframe;
  chartInstrument: ResolvedDataInstrument;
  /** Close time of the newest chart-history bar; secondary warmup cannot see beyond it. */
  chartWarmupEnd: number;
  /** Required startup bars per feed. */
  warmupBars: number;
  /** Hard total-series ceiling. Exceeding it stops the run instead of truncating history. */
  maxBars?: number;
  maxFeeds?: number;
  concurrency?: number;
  requestTimeoutMs?: number;
  /** Failed refreshes tolerated before stopping. Default 0 (first failure stops). */
  maxStaleRefreshes?: number;
  signal?: AbortSignal;
  onFetch?: (key: string, bars: number) => void | Promise<void>;
  onError?: (
    key: string,
    error: string,
    health: readonly SecurityFeedHealth[],
  ) => void | Promise<void>;
}

interface FeedState {
  spec: SecurityFeedSpec;
  instrument: ResolvedDataInstrument;
  fetchTfSeconds: number;
  pinerBars: Bar[];
  lastSourceTime: number;
  consecutiveFailures: number;
  lastError?: string;
}

export class SecurityFeedError extends Error {
  constructor(
    readonly key: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SecurityFeedError';
  }
}

export class SecurityFeedManager {
  private readonly states: FeedState[] = [];
  /** Provider operations retain these slots until they settle, even after our timeout wins. */
  private readonly activeOperations = new Set<Promise<unknown>>();
  private readonly activeKeys = new Set<string>();
  private draining = false;
  private readonly maxBars: number;
  private readonly concurrency: number;
  private readonly requestTimeoutMs: number;
  private readonly maxStaleRefreshes: number;
  private readonly chartTfSeconds: number;

  constructor(
    private readonly data: MarketDataProvider,
    private readonly feeds: readonly SecurityFeedSpec[],
    private readonly options: SecurityFeedManagerOptions,
  ) {
    this.maxBars = positiveInteger(options.maxBars ?? DEFAULT_MAX_SECURITY_BARS, 'maxBars');
    this.concurrency = positiveInteger(
      options.concurrency ?? DEFAULT_SECURITY_CONCURRENCY,
      'concurrency',
    );
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_SECURITY_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    );
    this.maxStaleRefreshes = nonNegativeInteger(
      options.maxStaleRefreshes ?? DEFAULT_MAX_SECURITY_STALE_REFRESHES,
      'maxStaleRefreshes',
    );
    const maxFeeds = positiveInteger(options.maxFeeds ?? DEFAULT_MAX_SECURITY_FEEDS, 'maxFeeds');
    const warmupBars = positiveInteger(options.warmupBars, 'warmupBars');
    nonNegativeInteger(options.chartWarmupEnd, 'chartWarmupEnd');
    if (feeds.length > maxFeeds)
      throw new RangeError(
        `request.security feed count ${feeds.length} exceeds maxFeeds ${maxFeeds}`,
      );
    if (warmupBars > this.maxBars)
      throw new RangeError(`warmupBars ${warmupBars} exceeds maxBars ${this.maxBars}`);
    this.chartTfSeconds = timeframeSeconds(options.chartTf);
  }

  get specs(): readonly SecurityFeedSpec[] {
    return this.feeds;
  }

  describe(): SecurityFeedHealth[] {
    return this.states.map((state) => ({
      key: state.spec.key,
      symbol: state.instrument.venueSymbol,
      timeframe: state.spec.fetchTf,
      bars: state.pinerBars.length,
      lastSourceTime: state.lastSourceTime,
      status: state.consecutiveFailures > 0 ? 'stale' : 'healthy',
      consecutiveFailures: state.consecutiveFailures,
      ...(state.lastError ? { lastError: state.lastError } : {}),
    }));
  }

  async warmup(): Promise<void> {
    await mapLimit(this.feeds, this.concurrency, (spec) => this.warmupFeed(spec));
    this.states.sort((a, b) => a.spec.key.localeCompare(b.spec.key));
  }

  private async warmupFeed(spec: SecurityFeedSpec): Promise<void> {
    let instrument: ResolvedDataInstrument;
    try {
      instrument = spec.self
        ? this.options.chartInstrument
        : await this.request(spec.key, (signal) =>
            this.data.resolve(spec.symbol, { strict: true, signal }),
          );
    } catch (error) {
      throw new SecurityFeedError(
        spec.key,
        `request.security feed "${spec.key}" could not resolve symbol "${spec.symbol}": ${errorMessage(error)}`,
        { cause: error },
      );
    }

    const fetchTfSeconds = timeframeSeconds(spec.fetchTf);
    const { required, requested } = this.warmupDepth(fetchTfSeconds);
    if (required > this.maxBars)
      throw new SecurityFeedError(
        spec.key,
        `request.security feed "${spec.key}" needs ${required} warmup bars but maxSecurityBars is ${this.maxBars}; raise maxSecurityBars or reduce the chart/security warmup`,
      );

    let bars: Bar[];
    try {
      const response = normalizeBars(
        await this.request(spec.key, (signal) =>
          this.data.historyResolved(
            instrument,
            spec.fetchTf,
            { to: this.options.chartWarmupEnd, limit: requested },
            signal,
          ),
        ),
      );
      // Providers may ignore `to` or include a forming tail. Warmup is evaluated as-of the
      // newest chart-history close, so later secondary bars cannot consume the request limit
      // or leak future values into piner's historical replay.
      bars = response.filter(
        (bar) => barCloseTime(bar.time, spec.fetchTf) <= this.options.chartWarmupEnd,
      );
    } catch (error) {
      throw new SecurityFeedError(
        spec.key,
        `request.security feed "${spec.key}" (${spec.symbol} ${spec.fetchTf}) history fetch failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (bars.length > this.maxBars)
      throw new SecurityFeedError(
        spec.key,
        `request.security feed "${spec.key}" (${spec.symbol} ${spec.fetchTf}) returned ${bars.length} aligned bars, exceeding maxSecurityBars ${this.maxBars}; refusing to truncate indicator history`,
      );
    if (bars.length < required)
      throw new SecurityFeedError(
        spec.key,
        `request.security feed "${spec.key}" (${spec.symbol} ${spec.fetchTf}) returned ${bars.length} aligned bars at the chart warmup horizon but ${required} are required`,
      );

    const pinerBars = bars.map(toPinerBar);
    this.states.push({
      spec,
      instrument,
      fetchTfSeconds,
      pinerBars,
      lastSourceTime: bars[bars.length - 1]!.time,
      consecutiveFailures: 0,
    });
    await this.options.onFetch?.(spec.key, pinerBars.length);
  }

  private warmupDepth(fetchTfSeconds: number): { required: number; requested: number } {
    const span = Math.ceil((this.options.warmupBars * this.chartTfSeconds) / fetchTfSeconds);
    const required = Math.max(this.options.warmupBars, span);
    return { required, requested: Math.min(this.maxBars, required + 3) };
  }

  inject(engine: Engine): void {
    for (const state of this.states) engine.ctx.securityBars.set(state.spec.key, state.pinerBars);
  }

  async refresh(chartBarTime: number): Promise<void> {
    const chartBarClose = barCloseTime(chartBarTime, this.options.chartTf);
    await mapLimit(this.states, this.concurrency, (state) =>
      this.refreshFeed(state, chartBarClose),
    );
  }

  private async refreshFeed(state: FeedState, chartBarClose: number): Promise<void> {
    try {
      const overlapFrom = Math.max(0, state.lastSourceTime - 2 * state.fetchTfSeconds);
      const response = normalizeBars(
        await this.request(state.spec.key, (signal) =>
          this.data.historyResolved(
            state.instrument,
            state.spec.fetchTf,
            { from: overlapFrom, to: chartBarClose, limit: this.maxBars },
            signal,
          ),
        ),
      );
      // Do not trust a provider to exclude a forming tail. Finality is checked against the
      // chart bar's close, using calendar-aware month handling in barCloseTime().
      const closed = response.filter(
        (bar) => barCloseTime(bar.time, state.spec.fetchTf) <= chartBarClose,
      );
      const hadNewer = closed.some((bar) => bar.time > state.lastSourceTime);
      if (hadNewer && !closed.some((bar) => bar.time === state.lastSourceTime))
        throw new Error(
          `catch-up response omitted the previous tail ${state.lastSourceTime}; history may be truncated`,
        );

      const changed = this.merge(state, closed);
      if (changed > 0) {
        state.consecutiveFailures = 0;
        state.lastError = undefined;
      }
      // A successful no-progress response is valid when the dependency's market is closed.
      // It deliberately does NOT clear an earlier failure; only real data progress does.
    } catch (error) {
      if (this.options.signal?.aborted) throw error;
      state.consecutiveFailures++;
      state.lastError = errorMessage(error);
      const message = `${state.lastError} (feed has ${state.consecutiveFailures} consecutive failed refresh(es))`;
      await this.options.onError?.(state.spec.key, message, this.describe());
      if (state.consecutiveFailures > this.maxStaleRefreshes)
        throw new SecurityFeedError(
          state.spec.key,
          `request.security feed "${state.spec.key}" is stale: ${message}; reconciliation stopped`,
          { cause: error },
        );
    }
  }

  /** Merge revisions and appends without ever discarding historical state. */
  private merge(state: FeedState, fresh: readonly Bar[]): number {
    let changed = 0;
    const byTime = new Map(state.pinerBars.map((bar, index) => [bar.time, index]));
    for (const bar of fresh) {
      const pinerBar = toPinerBar(bar);
      const existingIndex = byTime.get(pinerBar.time);
      if (existingIndex !== undefined) {
        const existing = state.pinerBars[existingIndex]!;
        if (!sameBar(existing, pinerBar)) {
          state.pinerBars[existingIndex] = pinerBar;
          changed++;
        }
        continue;
      }
      if (bar.time <= state.lastSourceTime) continue;
      if (state.pinerBars.length >= this.maxBars)
        throw new Error(
          `feed reached maxSecurityBars=${this.maxBars}; refusing to truncate indicator history`,
        );
      state.pinerBars.push(pinerBar);
      byTime.set(pinerBar.time, state.pinerBars.length - 1);
      state.lastSourceTime = bar.time;
      changed++;
    }
    return changed;
  }

  private async request<T>(
    key: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.draining) throw new Error(`request.security feed "${key}" manager is shutting down`);
    const parent = this.options.signal;
    if (parent?.aborted) throw new Error(`request.security feed "${key}" request aborted`);
    if (this.activeKeys.has(key))
      throw new Error(
        `request.security feed "${key}" still has a timed-out provider request in flight`,
      );
    if (this.activeOperations.size >= this.concurrency)
      throw new Error(
        `request.security request capacity remains occupied by ${this.activeOperations.size} unsettled provider request(s)`,
      );

    const controller = new AbortController();
    let rejectAbort: ((error: Error) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = (): void => {
      controller.abort(parent?.reason);
      rejectAbort?.(new Error(`request.security feed "${key}" request aborted`));
    };
    parent?.addEventListener('abort', abort, { once: true });

    // Keep the real provider operation in the active sets until it settles. Promise.race may
    // enforce our caller-facing deadline, but AbortSignal is advisory and a non-cooperative
    // transport must not free a concurrency slot or permit another request for this feed.
    const pending = Promise.resolve().then(() => operation(controller.signal));
    this.activeOperations.add(pending);
    this.activeKeys.add(key);
    const release = (): void => {
      this.activeOperations.delete(pending);
      this.activeKeys.delete(key);
    };
    void pending.then(release, release);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error(
            `request.security feed "${key}" request timed out after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);
    });
    try {
      return await Promise.race([pending, timeout, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    }
  }

  /**
   * Stop admitting provider work and wait for every real request to settle. AbortSignal is
   * advisory, so a provider that ignores both abort and disconnect turns shutdown into an
   * explicit bounded failure rather than a false successful drain.
   */
  async drain(): Promise<void> {
    this.draining = true;
    const deadline = Date.now() + this.requestTimeoutMs;
    while (this.activeOperations.size > 0) {
      const snapshot = [...this.activeOperations];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settled = await Promise.race([
        Promise.allSettled(snapshot).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (timer) clearTimeout(timer);
      // Release handlers were registered when each request started; let them update the sets.
      await Promise.resolve();
      if (this.activeOperations.size === 0) return;
      if (!settled || Date.now() >= deadline) {
        const keys = [...this.activeKeys].sort().join(', ');
        throw new Error(
          `request.security shutdown timed out after ${this.requestTimeoutMs}ms; ` +
            `${this.activeOperations.size} provider request(s) remain active` +
            `${keys ? ` (${keys})` : ''}; provider did not honor abort/disconnect`,
        );
      }
    }
  }
}

function sameBar(a: Bar, b: Bar): boolean {
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()),
  );
}
