/**
 * Symbol normalization helpers for crypto pairs. Different exchanges want
 * different instrument-id forms (Binance concatenated `BTCUSDT`, OKX dashed
 * `BTC-USDT`, Kraken slashed `BTC/USD`), so pinery normalizes a user-typed symbol
 * to each provider's canonical form. Adapted from fractal-chart's
 * symbol-normalization module, trimmed to the history use case.
 */

/** Split a concatenated pair (e.g. "BTCUSDT") into base/quote via a longest-suffix match. */
export function splitConcatenatedPair(
  symbol: string,
  quoteCurrencies: readonly string[],
): { base: string; quote: string } | null {
  for (const quote of quoteCurrencies) {
    if (symbol.length > quote.length && symbol.endsWith(quote)) {
      return { base: symbol.slice(0, symbol.length - quote.length), quote };
    }
  }
  return null;
}

const OKX_QUOTES = ['USDT', 'USDC', 'USDK', 'USD', 'EURT', 'EUR', 'BTC', 'ETH', 'OKB', 'DAI', 'BRZ'] as const;

/** OKX spot instId: dashed BASE-QUOTE (e.g. "BTC-USDT"). Idempotent. */
export function normalizeOkxSpot(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/\//g, '-');
  if (!cleaned) throw new Error(`okx: cannot normalize empty symbol`);
  if (cleaned.includes('-')) return cleaned;
  const split = splitConcatenatedPair(cleaned, OKX_QUOTES);
  if (!split) throw new Error(`okx: cannot split "${raw}" into a BASE-QUOTE pair`);
  return `${split.base}-${split.quote}`;
}

/** OKX perpetual instId: BASE-QUOTE-SWAP (e.g. "BTC-USDT-SWAP"). Idempotent. */
export function normalizeOkxSwap(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/\//g, '-');
  if (!cleaned) throw new Error(`okx: cannot normalize empty symbol`);
  const withoutSuffix = cleaned.endsWith('-SWAP') ? cleaned.slice(0, -'-SWAP'.length) : cleaned;
  const spot = withoutSuffix.includes('-') ? withoutSuffix : normalizeOkxSpot(withoutSuffix);
  return `${spot}-SWAP`;
}

const KRAKEN_QUOTES = [
  'USDT', 'USDC', 'USDG', 'PYUSD', 'EURT', 'AUSD', 'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'JPY', 'DAI', 'XBT', 'BTC', 'ETH',
] as const;

function krakenModernAsset(token: string): string {
  if (token === 'XBT') return 'BTC';
  if (token === 'XDG') return 'DOGE';
  return token;
}

/** Kraken spot pair: modern slash form BASE/QUOTE (e.g. "BTC/USD"). Idempotent. */
export function normalizeKrakenSpot(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/[/\-:]/g, '-');
  if (!cleaned) throw new Error(`kraken: cannot normalize empty symbol`);
  let base: string;
  let quote: string;
  if (cleaned.includes('-')) {
    const parts = cleaned.split('-');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`kraken: cannot parse pair "${raw}"`);
    [base, quote] = parts as [string, string];
  } else {
    const split = splitConcatenatedPair(cleaned, KRAKEN_QUOTES);
    if (!split) throw new Error(`kraken: cannot split "${raw}" into a BASE/QUOTE pair`);
    base = split.base;
    quote = split.quote;
  }
  return `${krakenModernAsset(base)}/${krakenModernAsset(quote)}`;
}
