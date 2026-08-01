import type { ResolvedSecurityDatasetProof } from '@heyphat/pinerun';

export type IntrabarBrokerClass = 'compute-only' | 'paper' | 'tiger';

export interface IntrabarAuthorityMagnifierBudget {
  readonly configured: {
    readonly maxTargetBars: number | null;
    readonly maxRawBars: number | null;
  };
  /** No hidden host fallback exists: effective limits equal the normalized configured limits. */
  readonly effective: {
    readonly maxTargetBars: number | null;
    readonly maxRawBars: number | null;
  };
  readonly observed: {
    readonly targetBars: number;
    readonly rawBars: number;
  };
}

export interface IntrabarAuthoritySecurityBudget {
  readonly configured: {
    readonly maxFeeds: number | null;
    readonly maxBarsPerFeed: number | null;
    readonly maxTotalBars: number | null;
    readonly concurrency: number | null;
    readonly requestTimeoutMs: number | null;
    readonly maxStaleRefreshes: number | null;
  };
  /** Exact historical resolution applies the normalized host bar-count limits directly. */
  readonly effective: {
    readonly maxFeeds: number | null;
    readonly maxBarsPerFeed: number | null;
    readonly maxTotalBars: number | null;
  };
  readonly observed: {
    readonly feeds: number;
    readonly totalBars: number;
    readonly maxBarsPerFeed: number;
    readonly barsPerFeed: Readonly<Record<string, number>>;
  };
}

export interface PreparedSecurityAuthority {
  readonly key: string;
  readonly barCount: number;
  readonly requestKind: ResolvedSecurityDatasetProof['requestKind'];
  readonly requestedSymbol: string;
  readonly dependencies: ResolvedSecurityDatasetProof['dependencies'];
  readonly requestedCanonicalTfs: ResolvedSecurityDatasetProof['requestedCanonicalTfs'];
  readonly lookaheadOnCanonicalTfs: ResolvedSecurityDatasetProof['lookaheadOnCanonicalTfs'];
  readonly targetCanonicalTf: string;
  readonly requested: ResolvedSecurityDatasetProof['requested'];
  readonly covered: ResolvedSecurityDatasetProof['covered'];
  readonly gaps: ResolvedSecurityDatasetProof['gaps'];
  readonly complete: true;
  readonly provenance: ResolvedSecurityDatasetProof['provenance'];
  readonly alignmentEvidence: ResolvedSecurityDatasetProof['alignmentEvidence'];
  readonly barsDigest: string;
  readonly acquisitionKey: string;
}

/** Serializable, complete authority frozen after exact preparation and finite Engine replay. */
export interface PreparedIntrabarAuthority {
  readonly authorityVersion: 1;
  readonly source: {
    /** Operator-visible source/job identity, normally the configured strategy path. */
    readonly strategyIdentity: string;
    readonly sourceIdentity: string;
    readonly jobIdentity: string;
    readonly chartBarsDigest: string;
  };
  readonly provider: {
    readonly id: string;
    readonly handle: string;
    readonly requestedSymbol: string;
    readonly strategySymbol: string;
    readonly venueSymbol: string;
    readonly exchange: string | null;
    readonly expiry: string | null;
    readonly mintick: number;
    readonly qtyStep: number;
    readonly minOrderQty: number;
    readonly pointValue: number | null;
  };
  readonly chart: {
    readonly canonicalTimeframe: string;
    readonly pinerTimeframe: string;
    readonly backend: 'js' | 'interp';
    readonly configuredWarmupBars: number;
    readonly effectiveWarmupBars: number;
    readonly observedHistoricalBars: number;
    readonly anchorTime: number;
    readonly firstOpen: number;
    readonly finalOpen: number;
    readonly envelope: { readonly from: number; readonly to: number };
  };
  readonly historical:
    | { readonly mode: 'standard' }
    | {
        readonly mode: 'bar-magnifier';
        readonly exactSource: {
          readonly providerId: string;
          readonly requestedSymbol: string;
          readonly normalizedSymbol: string;
          readonly cacheIdentity: string;
        };
        readonly acquisition: {
          readonly acquisitionKey: string;
          readonly barsDigest: string;
          readonly targetPineTimeframe: string;
          readonly targetCanonicalTimeframe: string;
          readonly sourceCanonicalTimeframe: string;
          readonly targetBarCount: number;
          readonly rawBarCount: number;
          readonly coverage: unknown;
        };
      };
  readonly security: readonly PreparedSecurityAuthority[];
  readonly cutover: {
    readonly after: number;
    readonly finalHistoricalClose: number;
    readonly firstAdmissibleLiveOpen: number;
  };
  readonly live:
    | { readonly cadence: 'bar-close' }
    | {
        readonly cadence: 'every-update';
        readonly source:
          { readonly kind: 'native' } | { readonly kind: 'lower-bars'; readonly timeframe: string };
        readonly throttleMs: number;
        readonly maxPendingFinals: number;
        readonly reconnectAttempts: number;
        readonly reconnectDelayMs: number;
        readonly reconnectMaxDelayMs: number;
      };
  readonly budgets: {
    readonly magnifier: IntrabarAuthorityMagnifierBudget;
    readonly security: IntrabarAuthoritySecurityBudget;
  };
  readonly cadence: 'bar-close' | 'every-update';
  readonly configuredBrokerClass: IntrabarBrokerClass;
}

export interface PreparedIntrabarAuthorityEnvelope {
  readonly algorithm: 'sha256';
  readonly identity: `sha256-${string}`;
  readonly prepared: PreparedIntrabarAuthority;
}

/** Browser-safe canonical SHA-256; object key order and caller insertion order cannot affect it. */
export async function canonicalSha256(value: unknown): Promise<`sha256-${string}`> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 is unavailable in this runtime');
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalSerialize(value)),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256-${hex}`;
}

export async function createPreparedAuthorityEnvelope(
  prepared: PreparedIntrabarAuthority,
): Promise<PreparedIntrabarAuthorityEnvelope> {
  const frozen = deepFreeze(structuredClone(prepared));
  return deepFreeze({
    algorithm: 'sha256' as const,
    identity: await canonicalSha256(frozen),
    prepared: frozen,
  });
}

/** Recompute persisted authority instead of trusting a caller-authored digest field. */
export async function assertPreparedAuthorityEnvelope(
  value: PreparedIntrabarAuthorityEnvelope,
): Promise<void> {
  if (value.algorithm !== 'sha256' || !/^sha256-[a-f0-9]{64}$/.test(value.identity)) {
    throw new Error('prepared authority does not carry a canonical SHA-256 identity');
  }
  const actual = await canonicalSha256(value.prepared);
  if (actual !== value.identity) throw new Error('persisted prepared authority SHA-256 is invalid');
}

export function canonicalSerialize(value: unknown): string {
  return canonical(value);
}

export function authorityEnvelopesEqual(
  left: PreparedIntrabarAuthorityEnvelope,
  right: PreparedIntrabarAuthorityEnvelope,
): boolean {
  return canonicalSerialize(left) === canonicalSerialize(right);
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('authority contains a non-finite number');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'object': {
      if (seen.has(value)) throw new TypeError('authority contains a cycle');
      seen.add(value);
      try {
        if (Array.isArray(value))
          return `[${value.map((item) => canonical(item, seen)).join(',')}]`;
        const entries = Object.entries(value as Readonly<Record<string, unknown>>).sort(
          ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
        );
        return `{${entries
          .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member, seen)}`)
          .join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      throw new TypeError(`authority contains unsupported ${typeof value}`);
  }
  throw new TypeError('authority contains an unsupported value');
}

export function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}
