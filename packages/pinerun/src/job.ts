/**
 * The unit of work. A `Job` is a pure description of one piner run:
 * `(source, symbol, timeframe, bars, inputs)`. It is fully serializable so it can
 * cross a worker boundary — note we carry the Pine *source string*, never a
 * compiled script (compiled bodies are functions and can't be structured-cloned).
 */
import type {
  AcquisitionProvenance,
  Bar,
  CoverageGapMs,
  CoverageGapSec,
  HalfOpenIntervalMs,
  HalfOpenIntervalSec,
  HistorySessionCalendar,
  UnixMillisecond,
  UnixSecond,
} from '@heyphat/pinery';

export type { Bar };

export interface ResolvedMagnifierCoverage {
  readonly requested: HalfOpenIntervalMs;
  readonly covered: readonly HalfOpenIntervalMs[];
  readonly gaps: readonly CoverageGapMs[];
  readonly complete: boolean;
}

/** Immutable source-alignment evidence bound into an exact magnifier dataset. */
export type ResolvedMagnifierAlignmentEvidence =
  | { readonly kind: 'utc-24x7'; readonly weekAnchorSec?: UnixSecond }
  | {
      readonly kind: 'exchange-calendar';
      readonly calendar: HistorySessionCalendar;
    };

/** Immutable evidence needed to reconstruct static-security coverage from bars. */
export type ResolvedSecurityAlignmentEvidence =
  | { readonly kind: 'utc-24x7'; readonly weekAnchorSec?: UnixSecond }
  | {
      readonly kind: 'exchange-calendar';
      readonly calendar: HistorySessionCalendar;
    };

/** Exact request family represented by one static-security proof. */
export type ResolvedSecurityRequestKind = 'cross-plain' | 'lower' | 'self-plain';

/** Compiler-bound identity and warm-up requirement for one emitted dependency. */
export interface ResolvedSecurityDependencyIdentity {
  /** Index in piner's exact post-inline emitted dependency array. */
  readonly dependencyIndex: number;
  /** Canonical runtime timeframe requested by this exact call. */
  readonly requestedCanonicalTf: string;
  /** Exact compiler-proven lookahead; null is valid only for security_lower_tf. */
  readonly lookahead: boolean | null;
  /** Requested-expression history proven by piner, in runtime target bars. */
  readonly expressionPriorBars: number;
  /** Conservative bars retained for piner's plain-request mapping behavior. */
  readonly baseMappingPriorBars: number;
  /** Sum of expression and base-mapping history used to derive the acquisition range. */
  readonly totalRequiredPriorTargetBars: number;
}

/** Coverage/provenance attestation for one exact static request.security dataset. */
export interface ResolvedSecurityDatasetProof {
  /** Request family controls safe walk-forward prefix derivation. */
  readonly requestKind: ResolvedSecurityRequestKind;
  /** Original static dependency symbol spelling; binds cross/self identities to the key. */
  readonly requestedSymbol: string;
  /** Every represented emitted dependency, in compiler array order (repeats preserved). */
  readonly dependencies: readonly ResolvedSecurityDependencyIdentity[];
  /** Concrete request timeframes represented by this injected source, sorted and unique. */
  readonly requestedCanonicalTfs: readonly string[];
  /** Higher-timeframe requests whose historical value may expose the containing final bucket. */
  readonly lookaheadOnCanonicalTfs: readonly string[];
  /** Timeframe of the attached bars. It may be finer than represented higher-TF requests. */
  readonly targetCanonicalTf: string;
  readonly requested: HalfOpenIntervalSec;
  readonly covered: readonly HalfOpenIntervalSec[];
  readonly gaps: readonly CoverageGapSec[];
  readonly complete: boolean;
  readonly provenance: AcquisitionProvenance;
  /** Immutable UTC/session evidence used to independently re-derive coverage at execution. */
  readonly alignmentEvidence: ResolvedSecurityAlignmentEvidence;
  /** Strong content binding to the corresponding `securityBars` array. */
  readonly barsDigest: string;
  /** Canonical binding over bars digest, coverage, provenance, identity, and alignment evidence. */
  readonly acquisitionKey: string;
}

/** Exact, piner-ready Bar Magnifier data. Every timestamp is already milliseconds. */
export interface ResolvedMagnifierDataset {
  readonly contractVersion: number;
  readonly mappingVersion: number;
  /** Original host-requested symbol spelling; binds this dataset to its Job. */
  readonly requestedSymbol: string;
  readonly targetPineTf: string;
  readonly targetCanonicalTf: string;
  readonly sourceCanonicalTf: string;
  readonly barsMs: readonly Readonly<Bar>[];
  /** Chart opens retained solely to bind a serialized dataset to its Job envelope. */
  readonly chartOpenTimesMs: readonly UnixMillisecond[];
  readonly chartCloseTimesMs: readonly UnixMillisecond[];
  readonly chartIntervalSource: 'utc-fixed' | 'provider-calendar' | 'host-explicit';
  readonly coverage: ResolvedMagnifierCoverage;
  readonly provenance: AcquisitionProvenance;
  /** Immutable provider/source evidence used for chart-grid and target-bar validation. */
  readonly alignmentEvidence: ResolvedMagnifierAlignmentEvidence;
  /** Strong content binding to the exact millisecond target-bar array. */
  readonly barsDigest: string;
  /** Canonical binding over content, coverage, provenance, grid evidence, and identity. */
  readonly acquisitionKey: string;
}

export interface Job {
  /** Stable id for this job (defaults to `${symbol}@${timeframe}` when omitted). */
  id?: string;
  /** Pine v6 source. */
  source: string;
  symbol: string;
  /** piner timeframe label (see pinery `toPinerTimeframe`). */
  timeframe: string;
  /** OHLCV bars to run against (ascending by time). */
  bars: Bar[];
  /** Input overrides keyed by input title. */
  inputs?: Record<string, unknown>;
  /** Instrument tick size (defaults to 0.01). */
  mintick?: number;
  /** Instrument minimum quantity step (lot step). Configures the broker's
   *  TV-parity quantity truncation (derived order sizes, margin-call
   *  liquidations). Unset → piner's default (0.001). */
  minQty?: number;
  /** Override the strategy() declaration's `calc_on_order_fills` — TV's
   *  "After order is filled" Properties checkbox. Changes fill results, so it
   *  is part of the determinism key (hash.ts). Unset → the script's own flag.
   *  Requires a piner engine that models the flag (> 0.9.0): executeJob
   *  REJECTS an explicit override on an older engine (never runs it inertly
   *  under a distinct memo key) — only a source-declared header flag stays
   *  inert there, and it is then reported as inactive. */
  calcOnOrderFills?: boolean;
  /** Tri-state host override of strategy()'s use_bar_magnifier. Unset preserves
   *  the source header; true/false wins over it. */
  useBarMagnifier?: boolean;
  /** Exact piner-ready lower-timeframe dataset resolved before execution. */
  magnifier?: ResolvedMagnifierDataset;
  /** Which piner backend to use. Default 'js'. */
  backend?: 'js' | 'interp';
  /** Attach the full trade ledger + equity curve to the result (strategies only). */
  includeTrades?: boolean;
  /** Options for piner's derived risk-adjusted metrics (strategies only). */
  metrics?: JobMetricsOptions;
  /** Host-fetched bars for request.security, keyed as piner expects: `<symbol>` for a
   *  cross-symbol request, `<symbol>@<tf>` for request.security_lower_tf. Injected into
   *  `ctx.securityBars` before the run. */
  securityBars?: Record<string, Bar[]>;
  /** Exact-mode coverage/content proof for each injected static security key. */
  securityProofs?: Record<string, ResolvedSecurityDatasetProof>;
}

/** Host conventions for piner's `Engine.strategyMetrics` (annualization + risk-free). */
export interface JobMetricsOptions {
  /** Return-annualization periods per year (e.g. 252 daily US-equity bars).
   *  Overrides piner's empirical bar-time / 24/7-timeframe resolution. */
  periodsPerYear?: number;
  /** Annual risk-free rate as a fraction (e.g. 0.02). Default 0. */
  riskFreeRate?: number;
}

export function jobId(job: Job): string {
  return job.id ?? `${job.symbol}@${job.timeframe}`;
}
