/**
 * Dataset-ref wire protocol for Jobs crossing the worker boundary. Sender and
 * receiver cache exactly the datasets in the most recently acknowledged,
 * atomically hydrated message. Chart, security, and magnifier refs share one id
 * namespace so same-array aliases carry only one payload.
 */
import type { Bar, Job, ResolvedMagnifierDataset } from './job.js';
import { marketDataDigest, registerOwnedImmutableBars } from './digest.js';
import {
  authenticateHydratedMagnifierDataset,
  isResolverIssuedMagnifierDataset,
  magnifierDatasetWireAuthenticator,
} from './magnifier.js';
import {
  authenticateHydratedSecurityProof,
  isResolverIssuedSecurityProof,
  securityProofWireAuthenticator,
} from './security.js';

/** Payload is present only when the sender believes the receiver lacks this array. */
export interface BarsRef {
  id: number;
  bars?: readonly Bar[];
}

export interface WireResolvedMagnifierDataset extends Omit<ResolvedMagnifierDataset, 'barsMs'> {
  barsMs: BarsRef;
}

export interface WireJob extends Omit<Job, 'bars' | 'securityBars' | 'magnifier'> {
  bars: BarsRef;
  securityBars?: Record<string, BarsRef>;
  magnifier?: WireResolvedMagnifierDataset;
  /** Parent-issued, per-worker authenticator for the resolver-owned magnifier envelope. */
  magnifierDatasetAuthenticator?: string;
  /** Parent-issued, per-worker authenticators for resolver-owned security proofs. */
  securityProofAuthenticators?: Record<string, string>;
}

/** Stable process-wide id per bar-array identity and current strong content digest. */
const datasetIds = new WeakMap<object, { readonly id: number; readonly digest: string }>();
let nextDatasetId = 1;
export function datasetId(bars: readonly Bar[]): number {
  const digest = marketDataDigest(bars);
  const current = datasetIds.get(bars);
  if (current?.digest === digest) return current.id;
  const id = nextDatasetId++;
  datasetIds.set(bars, { id, digest });
  return id;
}

/**
 * Replace all market arrays with refs. `sent` is committed as the sender's new
 * cache view only after the worker acknowledges successful hydration.
 */
export function toWireJob(
  job: Job,
  cachedIds: ReadonlySet<number>,
  datasetAuthSecret?: string,
): { wire: WireJob; sent: Set<number> } {
  const sent = new Set<number>();
  const messageIds = new WeakMap<object, number>();
  const ref = (bars: readonly Bar[]): BarsRef => {
    let id = messageIds.get(bars);
    if (id === undefined) {
      id = datasetId(bars);
      messageIds.set(bars, id);
    }
    const known = cachedIds.has(id) || sent.has(id);
    sent.add(id);
    return known ? { id } : { id, bars };
  };
  // Strip the transport-only field even if an untyped caller attempts to
  // smuggle one in; only this trusted sender computes worker authenticators.
  const {
    bars,
    securityBars,
    magnifier,
    magnifierDatasetAuthenticator: _callerMagnifierAuthenticator,
    securityProofAuthenticators: _callerSecurityAuthenticators,
    ...rest
  } = job as Job & {
    magnifierDatasetAuthenticator?: unknown;
    securityProofAuthenticators?: unknown;
  };
  const wire: WireJob = { ...rest, bars: ref(bars) };
  if (securityBars) {
    const refs: Record<string, BarsRef> = {};
    for (const [key, value] of Object.entries(securityBars)) refs[key] = ref(value);
    wire.securityBars = refs;
  }
  if (magnifier) {
    wire.magnifier = { ...magnifier, barsMs: ref(magnifier.barsMs) };
    if (datasetAuthSecret && isResolverIssuedMagnifierDataset(magnifier)) {
      wire.magnifierDatasetAuthenticator = magnifierDatasetWireAuthenticator(
        datasetAuthSecret,
        magnifier,
      );
    }
  }
  if (datasetAuthSecret && job.securityProofs) {
    const authenticators: Record<string, string> = {};
    for (const [key, proof] of Object.entries(job.securityProofs)) {
      if (!isResolverIssuedSecurityProof(proof)) continue;
      authenticators[key] = securityProofWireAuthenticator(datasetAuthSecret, key, proof);
    }
    if (Object.keys(authenticators).length > 0) {
      wire.securityProofAuthenticators = authenticators;
    }
  }
  return { wire, sent };
}

/** Commit on acknowledgement; a hydration miss clears the sender's belief. */
export function senderCacheAfterHydration(
  sent: ReadonlySet<number>,
  hydrated: boolean,
): Set<number> {
  return hydrated ? new Set(sent) : new Set<number>();
}

/**
 * Resolve every ref atomically. Same-message payloads (`next`) precede the prior
 * cache, fixing aliases whose first occurrence carried the only payload.
 */
export function hydrateWireJob(
  wire: WireJob,
  datasets: ReadonlyMap<number, readonly Bar[]>,
): { job: Job; next: Map<number, readonly Bar[]> } {
  const next = new Map<number, readonly Bar[]>();
  const resolve = (ref: BarsRef): readonly Bar[] => {
    const bars = ref.bars ?? next.get(ref.id) ?? datasets.get(ref.id);
    if (!bars) throw new Error(`pinerun worker: dataset ${ref.id} missing from cache`);
    next.set(ref.id, bars);
    return bars;
  };

  const {
    bars,
    securityBars,
    magnifier,
    magnifierDatasetAuthenticator,
    securityProofAuthenticators,
    ...rest
  } = wire;
  const primary = resolve(bars);
  const securityOut: Record<string, Bar[]> | undefined = securityBars ? {} : undefined;
  if (securityBars) {
    for (const [key, ref] of Object.entries(securityBars)) {
      securityOut![key] = resolve(ref) as Bar[];
    }
  }
  const magnifierOut: ResolvedMagnifierDataset | undefined = magnifier
    ? { ...magnifier, barsMs: resolve(magnifier.barsMs) }
    : undefined;

  // Only after every ref resolved do we mutate the staged payloads. A hydration
  // miss therefore leaves both the receiver cache and same-message inputs untouched.
  for (const [id, value] of next) next.set(id, ownHydratedBars(value));

  // Structured cloning removes Object.freeze state. Re-establish ownership and
  // deep immutability before execution so bar-derived coverage proofs have the
  // same trust boundary in workers as they do in local resolver paths. Proof
  // authority is restored only when the private parent/worker authenticator
  // covers the complete cloned proof and its injection key.
  if (rest.securityProofs) {
    deepFreeze(rest.securityProofs);
    for (const [key, proof] of Object.entries(rest.securityProofs)) {
      authenticateHydratedSecurityProof(key, proof, securityProofAuthenticators?.[key]);
    }
  }
  if (magnifierOut) {
    deepFreeze(magnifierOut);
    authenticateHydratedMagnifierDataset(magnifierOut, magnifierDatasetAuthenticator);
  }

  // No externally visible state is changed until every ref above resolved.
  const job: Job = { ...rest, bars: primary as Bar[] };
  if (securityOut) job.securityBars = securityOut;
  if (magnifierOut) job.magnifier = magnifierOut;
  return { job, next };
}

function ownHydratedBars(bars: readonly Bar[]): readonly Bar[] {
  for (const bar of bars) {
    if (!Object.isFrozen(bar)) Object.freeze(bar);
  }
  if (!Object.isFrozen(bars)) Object.freeze(bars);
  return registerOwnedImmutableBars(bars);
}

function deepFreeze(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  Object.freeze(value);
}
