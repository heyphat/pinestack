/** Strong deterministic memo key over every behavior and projected-result input. */
import type { Bar, Job } from './job.js';
import { canonicalDigest, marketDataDigest, numberArrayDigest } from './digest.js';
import { isResolverIssuedMagnifierDataset } from './magnifier.js';
import { pinerCapabilities } from './piner-capabilities.js';
import { isResolverIssuedSecurityProof } from './security.js';

export { marketDataDigest } from './digest.js';

export function jobHash(job: Job): string {
  // A per-call identity memo is safe even for caller-owned mutable arrays: this
  // function is synchronous and the memo is discarded before mutation can race.
  // Cross-call caching remains restricted inside marketDataDigest to resolver-
  // owned, deeply frozen datasets.
  const datasets = new Map<readonly Bar[], string>();
  const digest = (bars: readonly Bar[]): string => {
    let value = datasets.get(bars);
    if (!value) {
      value = marketDataDigest(bars);
      datasets.set(bars, value);
    }
    return value;
  };

  const capabilities = pinerCapabilities();
  const security = job.securityBars
    ? Object.keys(job.securityBars)
        .sort()
        .map((key) => {
          const proof = job.securityProofs?.[key] ?? null;
          return {
            key,
            digest: digest(job.securityBars![key]!),
            proof,
            resolverIssued: proof !== null && isResolverIssuedSecurityProof(proof),
          };
        })
    : [];
  const orphanSecurityProofs = job.securityProofs
    ? Object.keys(job.securityProofs)
        .filter((key) => !job.securityBars || !(key in job.securityBars))
        .sort()
        .map((key) => {
          const proof = job.securityProofs![key]!;
          return { key, proof, resolverIssued: isResolverIssuedSecurityProof(proof) };
        })
    : [];
  const magnifier = job.magnifier
    ? {
        requestedSymbol: job.magnifier.requestedSymbol,
        contractVersion: job.magnifier.contractVersion,
        mappingVersion: job.magnifier.mappingVersion,
        targetPineTf: job.magnifier.targetPineTf,
        targetCanonicalTf: job.magnifier.targetCanonicalTf,
        sourceCanonicalTf: job.magnifier.sourceCanonicalTf,
        bars: digest(job.magnifier.barsMs),
        chartOpenTimes: numberArrayDigest(job.magnifier.chartOpenTimesMs),
        chartCloseTimes: numberArrayDigest(job.magnifier.chartCloseTimesMs),
        chartIntervalSource: job.magnifier.chartIntervalSource,
        coverage: job.magnifier.coverage,
        provenance: job.magnifier.provenance,
        alignmentEvidence: job.magnifier.alignmentEvidence,
        barsDigest: job.magnifier.barsDigest,
        acquisitionKey: job.magnifier.acquisitionKey,
        resolverIssued: isResolverIssuedMagnifierDataset(job.magnifier),
      }
    : null;

  const hash = canonicalDigest({
    version: 7,
    source: job.source,
    symbol: job.symbol,
    timeframe: job.timeframe,
    backend: job.backend ?? 'js',
    bars: digest(job.bars),
    inputs: job.inputs ?? null,
    mintick: job.mintick ?? null,
    minQty: job.minQty ?? null,
    calcOnOrderFills: job.calcOnOrderFills ?? null,
    useBarMagnifier: job.useBarMagnifier ?? null,
    barMagnifierContractVersion:
      job.magnifier?.contractVersion ?? capabilities.contractVersion ?? null,
    barMagnifierMappingVersion:
      job.magnifier?.mappingVersion ?? capabilities.mappingVersion ?? null,
    security,
    orphanSecurityProofs,
    magnifier,
    metrics: job.metrics ?? null,
    includeTrades: job.includeTrades === true,
  });
  return `${job.symbol}:${job.timeframe}:${hash}`;
}
