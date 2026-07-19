/**
 * Asset-class model — mirrors fractal-chart's multi-asset-class design without
 * the UI. Asset class is orthogonal to the data provider: a single provider can
 * serve more than one class (Binance serves crypto spot AND USDⓈ-M futures).
 * The registry below declares which (provider, assetClass) pairs pinery serves,
 * and the address helpers give every instrument one canonical
 * `PREFIX[:CODE]:TICKER` form (e.g. `BI:FU:BTCUSDT` = Binance futures BTCUSDT).
 */

/** The closed universe of supported asset classes. */
export type AssetClass = 'equities' | 'crypto' | 'futures' | 'forex';

export const ASSET_CLASSES = ['equities', 'crypto', 'futures', 'forex'] as const;

/** The data providers pinery ships adapters for. */
export type DataProvider = 'binance' | 'okx' | 'kraken' | 'alpaca' | 'massive' | 'csv';

export const DATA_PROVIDERS = ['binance', 'okx', 'kraken', 'alpaca', 'massive', 'csv'] as const;

export interface ProviderAssetClassDeclaration {
  /** Used when a caller names this provider but no asset class. */
  defaultAssetClass: AssetClass;
  /** Served classes in declaration order (default class first). */
  assetClasses: readonly AssetClass[];
}

/**
 * Which asset classes each provider serves, per the adapters that exist today:
 * Binance spot/futures klines, OKX spot/swap candles, Kraken spot OHLC,
 * Alpaca + Massive US equities. Local CSV files can hold anything, so `csv`
 * serves every class (the default is nominal — asset class does not change how
 * a file is read).
 */
export const ASSET_CLASS_REGISTRY: Record<DataProvider, ProviderAssetClassDeclaration> = {
  binance: { defaultAssetClass: 'crypto', assetClasses: ['crypto', 'futures'] },
  okx: { defaultAssetClass: 'crypto', assetClasses: ['crypto', 'futures'] },
  kraken: { defaultAssetClass: 'crypto', assetClasses: ['crypto'] },
  alpaca: { defaultAssetClass: 'equities', assetClasses: ['equities'] },
  massive: { defaultAssetClass: 'equities', assetClasses: ['equities'] },
  csv: { defaultAssetClass: 'crypto', assetClasses: ['crypto', 'futures', 'equities', 'forex'] },
};

export function isDataProvider(value: unknown): value is DataProvider {
  return (DATA_PROVIDERS as readonly string[]).includes(value as string);
}

export function isAssetClass(value: unknown): value is AssetClass {
  return (ASSET_CLASSES as readonly string[]).includes(value as string);
}

/** The asset classes a provider serves, in declaration order. */
export function assetClassesForProvider(provider: DataProvider): readonly AssetClass[] {
  return ASSET_CLASS_REGISTRY[provider]?.assetClasses ?? [];
}

/** The class used when a caller names this provider but no asset class. */
export function defaultAssetClassForProvider(provider: DataProvider): AssetClass {
  return ASSET_CLASS_REGISTRY[provider]?.defaultAssetClass ?? 'crypto';
}

export function supportsPair(provider: DataProvider, assetClass: AssetClass): boolean {
  return assetClassesForProvider(provider).includes(assetClass);
}

/**
 * Coerce an untrusted value to an asset class the provider actually serves,
 * substituting the provider's default for anything invalid or unserved. Never
 * throws, so CLI flags and stored values degrade gracefully.
 */
export function coerceAssetClass(value: string | null | undefined, provider: DataProvider): AssetClass {
  return isAssetClass(value) && supportsPair(provider, value)
    ? value
    : defaultAssetClassForProvider(provider);
}

// ── instrument addressing ───────────────────────────────────
// One canonical address per instrument: PREFIX[:CODE]:TICKER, where the
// 2-letter asset-class CODE is omitted when it equals the provider's default.
// Same prefixes and codes as fractal-chart so addresses port between the two.

const PROVIDER_PREFIXES: Record<string, DataProvider> = {
  BI: 'binance',
  OK: 'okx',
  KR: 'kraken',
  AL: 'alpaca',
  MA: 'massive',
  CSV: 'csv',
};

const ASSET_CLASS_CODES = {
  equities: 'EQ',
  crypto: 'CR',
  futures: 'FU',
  forex: 'FX',
} satisfies Record<AssetClass, string>;

export function providerPrefix(provider: DataProvider): string {
  if (provider === 'binance') return 'BI';
  if (provider === 'okx') return 'OK';
  if (provider === 'kraken') return 'KR';
  if (provider === 'alpaca') return 'AL';
  if (provider === 'csv') return 'CSV';
  return 'MA';
}

export function assetClassCode(assetClass: AssetClass): string {
  return ASSET_CLASS_CODES[assetClass];
}

function assetClassFromCode(code: string): AssetClass | null {
  const upper = code.toUpperCase();
  const match = (Object.entries(ASSET_CLASS_CODES) as Array<[AssetClass, string]>).find(
    ([, value]) => value === upper,
  );
  return match ? match[0] : null;
}

function providerFromPrefix(prefix: string): DataProvider | null {
  return PROVIDER_PREFIXES[prefix.toUpperCase()] ?? null;
}

export interface ParsedInstrumentAddress {
  ticker: string;
  provider: DataProvider | null;
  assetClass: AssetClass | null;
  explicitProvider: boolean;
}

/**
 * Parse a user-typed instrument address. Accepts three forms:
 *  - `TICKER` (e.g. `BTCUSDT`, `BTC/USD`) — no provider, no class
 *  - `PREFIX:TICKER` (e.g. `BI:BTCUSDT`) — provider, class left to the default
 *  - `PREFIX:CODE:TICKER` (e.g. `BI:FU:BTCUSDT`) — provider + explicit class
 * The 3-part form only activates when BOTH the prefix and the 2-letter code are
 * known, so tickers that merely contain colons are untouched by it.
 */
export function parseInstrumentAddress(input: string): ParsedInstrumentAddress {
  const value = input.trim().toUpperCase();

  const withClass = value.match(/^([A-Z]{2,8}):([A-Z]{2}):(.+)$/);
  if (withClass) {
    const provider = providerFromPrefix(withClass[1]!);
    const assetClass = assetClassFromCode(withClass[2]!);
    if (provider && assetClass) {
      return { ticker: withClass[3]!.trim(), provider, assetClass, explicitProvider: true };
    }
  }

  const prefixed = value.match(/^([A-Z]{2,8}):(.+)$/);
  if (!prefixed) {
    return { ticker: value, provider: null, assetClass: null, explicitProvider: false };
  }

  const provider = providerFromPrefix(prefixed[1]!);
  return {
    ticker: prefixed[2]!.trim(),
    provider,
    assetClass: null,
    explicitProvider: Boolean(provider),
  };
}

/**
 * Encode a (provider, assetClass, ticker) as its canonical address. The class
 * code is omitted when it equals the provider's default, so each instrument has
 * exactly one canonical form (`BI:BTCUSDT`, not `BI:CR:BTCUSDT`).
 */
export function encodeInstrumentAddress(
  provider: DataProvider,
  assetClass: AssetClass,
  ticker: string,
): string {
  const prefix = providerPrefix(provider);
  const normalizedTicker = ticker.trim().toUpperCase();
  if (assetClass === defaultAssetClassForProvider(provider)) {
    return `${prefix}:${normalizedTicker}`;
  }
  return `${prefix}:${assetClassCode(assetClass)}:${normalizedTicker}`;
}

/**
 * Canonicalize an instrument address to its single stable form. Idempotent:
 * `canonicalize(canonicalize(x)) === canonicalize(x)`.
 */
export function canonicalizeInstrumentAddress(
  address: string,
  fallbackProvider: DataProvider = 'binance',
): string {
  const parsed = parseInstrumentAddress(address);
  const provider = parsed.provider ?? fallbackProvider;
  const assetClass = parsed.assetClass ?? defaultAssetClassForProvider(provider);
  return encodeInstrumentAddress(provider, assetClass, parsed.ticker);
}
