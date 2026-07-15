/**
 * Per-symbol instrument resolution: the effective lot step (`minQty`) and tick
 * size (`mintick`) a job should run with. Explicit CLI/API overrides win;
 * otherwise the provider's exchange metadata (`provider.instrument()`) fills the
 * gaps; whatever stays undefined falls through to piner's defaults (mintick
 * 0.01, minQty 0.001).
 *
 * The lot step matters for TV parity: TradingView truncates derived order
 * quantities AND margin-call liquidation quantities to the symbol's minimum
 * contract size (see piner's dev-docs/margin-parity-findings.md), so running
 * SOLUSDT-perps (step 0.01) or spot BTC (step 1e-5) on a flat 0.001 default
 * distorts sizing and the margin simulation.
 */
import type { HistoryProvider } from '@heyphat/pinery';

export interface ResolvedInstrument {
  minQty?: number;
  mintick?: number;
}

/**
 * Resolve `{minQty, mintick}` for one symbol. Metadata is best-effort: a
 * provider without `instrument()` — or one whose lookup fails — yields only the
 * explicit overrides, never an error (a missing lot step must not fail a run).
 */
export async function resolveInstrument(
  provider: HistoryProvider,
  symbol: string,
  overrides: { minQty?: number; mintick?: number } = {},
): Promise<ResolvedInstrument> {
  let fetched: { minQty?: number; mintick?: number } | undefined;
  if ((overrides.minQty == null || overrides.mintick == null) && provider.instrument) {
    try {
      fetched = await provider.instrument(symbol);
    } catch {
      // metadata is advisory — run on defaults rather than fail
    }
  }
  return {
    minQty: overrides.minQty ?? fetched?.minQty,
    mintick: overrides.mintick ?? fetched?.mintick,
  };
}
