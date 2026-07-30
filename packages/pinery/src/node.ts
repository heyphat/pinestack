/**
 * @heyphat/pinery/node — Node-only filesystem cache and CSV provider.
 * Exact acquisitions use a separate versioned payload containing identity,
 * range, bars, coverage, gaps, truncation, and provenance.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Bar,
  HistoryAcquisition,
  HistoryProvider,
  HistoryRange,
  HistoryRequest,
  InstrumentInfo,
  MarketDataProvider,
  ResolvedHistorySource,
} from './provider.js';
import { isMarketDataProvider } from './provider.js';
import { resolveHistorySource } from './acquisition.js';
import {
  snapshotHistoryCapabilities,
  snapshotResolvedHistorySource,
  historyCapabilityRecordSpan,
  validateHistoryAcquisition,
} from './coverage.js';
import type { ProviderConfig } from './factory.js';
import { assertProviderConfig, createMarketDataProvider } from './factory.js';
import { CsvProvider } from './adapters/csv.js';
import { ReplayProvider } from './adapters/replay.js';
import type { TigerMarketDataTransport } from './adapters/tiger.js';
import { createOfficialTigerMarketDataTransport } from './adapters/tiger-official.js';

export * from './index.js';
export { CsvProvider, type CsvProviderOptions } from './adapters/csv.js';
export {
  OfficialTigerMarketDataTransport,
  createOfficialTigerMarketDataTransport,
  resolveTigerProfilePath,
  type OfficialTigerMarketDataOptions,
  type OfficialTigerQuoteClient,
} from './adapters/tiger-official.js';

export interface DiskCacheOptions {
  /** Cache directory. Default `.pinery-cache` under the current working directory. */
  dir?: string;
  /** Bypass reads (still writes). Default false. */
  refresh?: boolean;
}

interface LegacyHistoryPayload {
  readonly schema: 'pinery.history';
  readonly version: 2;
  readonly key: {
    readonly cacheIdentity: string;
    readonly normalizedSymbol: string;
    readonly timeframe: string;
    readonly range: HistoryRange | null;
  };
  readonly bars: Bar[];
}

interface ExactHistoryPayload {
  readonly schema: 'pinery.history-acquisition';
  readonly version: 3;
  readonly key: {
    readonly cacheIdentity: string;
    readonly normalizedSymbol: string;
    readonly sourceTimeframe: string;
    readonly requested: HistoryRequest['requested'];
    readonly query: HistoryRequest['query'] | null;
    readonly weekAnchorSec: ResolvedHistorySource['capabilities']['weekAnchorSec'] | null;
    readonly coverageSemantics: ResolvedHistorySource['capabilities']['coverageSemantics'];
    readonly recordSpan: ResolvedHistorySource['capabilities']['recordSpan'] | null;
  };
  readonly acquisition: HistoryAcquisition;
}

/** Wrap a provider so identical requests are served from disk. */
export function cached(provider: HistoryProvider, opts: DiskCacheOptions = {}): HistoryProvider {
  const dir = opts.dir ?? join(process.cwd(), '.pinery-cache');
  const cacheIdentity = provider.cacheIdentity ?? provider.id;
  const wrapped: HistoryProvider = {
    id: `${provider.id}+cache`,
    cacheIdentity,
    ...(provider.assetClass ? { assetClass: provider.assetClass } : {}),

    async history(symbol: string, timeframe: string, range?: HistoryRange): Promise<Bar[]> {
      const source = await resolveHistorySource(provider, symbol);
      const identity = legacyIdentity(source, timeframe, range);
      const file = cacheFile(dir, provider.id, source.normalizedSymbol, timeframe, identity);
      if (!opts.refresh) {
        const payload = readJson(file);
        if (isLegacyPayload(payload, identity)) return payload.bars;
      }

      const bars = await provider.history(symbol, timeframe, range);
      const payload: LegacyHistoryPayload = {
        schema: 'pinery.history',
        version: 2,
        key: identity,
        bars,
      };
      writeJsonAtomic(file, payload);
      return bars;
    },

    async resolveHistorySource(symbol: string): Promise<ResolvedHistorySource> {
      const source = await resolveHistorySource(provider, symbol);
      const capabilities = snapshotHistoryCapabilities(source.capabilities);
      return snapshotResolvedHistorySource({
        provider: source.provider,
        normalizedSymbol: source.normalizedSymbol,
        cacheIdentity: source.cacheIdentity,
        capabilities,
        history: async (request: HistoryRequest): Promise<HistoryAcquisition> => {
          const identity = exactIdentity(source, request);
          const file = cacheFile(
            dir,
            provider.id,
            source.normalizedSymbol,
            request.timeframe,
            identity,
          );

          if (!opts.refresh) {
            const payload = readJson(file);
            if (isExactPayload(payload, identity)) {
              try {
                validateHistoryAcquisition(payload.acquisition, {
                  requested: request.requested,
                  cacheIdentity: source.cacheIdentity,
                  normalizedSymbol: source.normalizedSymbol,
                  sourceTimeframe: request.timeframe,
                  targetTimeframe: request.timeframe,
                  aggregationVersion: 0,
                  alignment: capabilities.alignment,
                  weekAnchorSec: capabilities.weekAnchorSec,
                  calendar: capabilities.calendar,
                  coverageSemantics: capabilities.coverageSemantics,
                  recordSpan: historyCapabilityRecordSpan(capabilities, request.timeframe),
                });
                return payload.acquisition;
              } catch {
                // A stale/corrupt/forged payload is never accepted as coverage proof.
              }
            }
          }

          const acquisition = await source.history(request);
          validateHistoryAcquisition(acquisition, {
            requested: request.requested,
            cacheIdentity: source.cacheIdentity,
            normalizedSymbol: source.normalizedSymbol,
            sourceTimeframe: request.timeframe,
            targetTimeframe: request.timeframe,
            aggregationVersion: 0,
            alignment: capabilities.alignment,
            weekAnchorSec: capabilities.weekAnchorSec,
            calendar: capabilities.calendar,
            coverageSemantics: capabilities.coverageSemantics,
            recordSpan: historyCapabilityRecordSpan(capabilities, request.timeframe),
          });
          const payload: ExactHistoryPayload = {
            schema: 'pinery.history-acquisition',
            version: 3,
            key: identity,
            acquisition,
          };
          writeJsonAtomic(file, payload);
          return acquisition;
        },
      });
    },
  };

  // Instrument metadata is keyed by resolved source identity + normalized symbol
  // and a UTC day, so feed/venue settings cannot alias and rules refresh daily.
  if (provider.instrument) {
    wrapped.instrument = async (symbol: string): Promise<InstrumentInfo | undefined> => {
      const source = await resolveHistorySource(provider, symbol);
      const day = new Date().toISOString().slice(0, 10);
      const identity = {
        schema: 'pinery.instrument',
        version: 2,
        cacheIdentity: source.cacheIdentity,
        normalizedSymbol: source.normalizedSymbol,
        day,
      };
      const file = cacheFile(dir, provider.id, source.normalizedSymbol, 'instrument', identity);
      if (!opts.refresh) {
        const payload = readJson(file);
        if (isInstrumentPayload(payload, identity)) return payload.info;
      }
      const info = await provider.instrument!(symbol);
      if (info) writeJsonAtomic(file, { ...identity, info });
      return info;
    };
  }
  if (isMarketDataProvider(provider)) {
    const live = provider;
    const liveWrapped = wrapped as MarketDataProvider;
    liveWrapped.resolve = (symbol, options) => live.resolve(symbol, options);
    liveWrapped.historyResolved = (instrument, timeframe, range, signal) =>
      live.historyResolved(instrument, timeframe, range, signal);
    liveWrapped.closedBars = (instrument, timeframe, options) =>
      live.closedBars(instrument, timeframe, options);
    if (live.disconnect) liveWrapped.disconnect = () => live.disconnect!();
  }
  return wrapped;
}

function legacyIdentity(
  source: ResolvedHistorySource,
  timeframe: string,
  range?: HistoryRange,
): LegacyHistoryPayload['key'] & { readonly day: string | null } {
  return {
    cacheIdentity: source.cacheIdentity,
    normalizedSymbol: source.normalizedSymbol,
    timeframe,
    range: range ? { ...range } : null,
    // Open-ended history is time-varying; expire it daily as before.
    day: range?.to == null ? new Date().toISOString().slice(0, 10) : null,
  };
}

function exactIdentity(
  source: ResolvedHistorySource,
  request: HistoryRequest,
): ExactHistoryPayload['key'] {
  return {
    cacheIdentity: source.cacheIdentity,
    normalizedSymbol: source.normalizedSymbol,
    sourceTimeframe: request.timeframe,
    requested: request.requested,
    query: request.query ?? null,
    weekAnchorSec: source.capabilities.weekAnchorSec ?? null,
    coverageSemantics: source.capabilities.coverageSemantics,
    recordSpan: historyCapabilityRecordSpan(source.capabilities, request.timeframe) ?? null,
  };
}

function cacheFile(
  dir: string,
  providerId: string,
  symbol: string,
  timeframe: string,
  identity: unknown,
): string {
  const digest = createHash('sha256').update(stableStringify(identity)).digest('hex');
  const safeProvider = sanitize(providerId);
  const safeSymbol = sanitize(symbol);
  const safeTimeframe = sanitize(timeframe);
  return join(dir, `${safeProvider}_${safeSymbol}_${safeTimeframe}_${digest}.json`);
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
  if (dir) mkdirSync(dir, { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  renameSync(temp, file);
}

function isLegacyPayload(
  value: unknown,
  identity: ReturnType<typeof legacyIdentity>,
): value is LegacyHistoryPayload {
  if (!isRecord(value) || value.schema !== 'pinery.history' || value.version !== 2) return false;
  if (!isRecord(value.key) || stableStringify(value.key) !== stableStringify(identity))
    return false;
  return Array.isArray(value.bars) && value.bars.every(isBar);
}

function isExactPayload(
  value: unknown,
  identity: ExactHistoryPayload['key'],
): value is ExactHistoryPayload {
  return (
    isRecord(value) &&
    value.schema === 'pinery.history-acquisition' &&
    value.version === 3 &&
    isRecord(value.key) &&
    stableStringify(value.key) === stableStringify(identity) &&
    isRecord(value.acquisition)
  );
}

function isInstrumentPayload(
  value: unknown,
  identity: Record<string, unknown>,
): value is Record<string, unknown> & { info: InstrumentInfo } {
  if (!isRecord(value) || !isRecord(value.info)) return false;
  return Object.entries(identity).every(([key, expected]) => value[key] === expected);
}

function isBar(value: unknown): value is Bar {
  if (!isRecord(value)) return false;
  return ['time', 'open', 'high', 'low', 'close', 'volume'].every((key) =>
    Number.isFinite(value[key]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

export interface TigerMarketDataCredentials {
  tigerId?: string;
  privateKey?: string;
  account?: string;
  license?: string;
  token?: string;
}

export interface NodeMarketDataFactoryOptions {
  tigerCredentials?: Readonly<TigerMarketDataCredentials>;
}

export type TigerTransportFactory = (
  config: Extract<ProviderConfig, { provider: 'tiger' }>,
  credentials: Readonly<TigerMarketDataCredentials>,
) => TigerMarketDataTransport;

let tigerTransportFactory: TigerTransportFactory | undefined;

/** Override the built-in official Tiger OpenAPI market-data transport. */
export function registerTigerMarketDataTransport(factory: TigerTransportFactory): void {
  tigerTransportFactory = factory;
}

export function createNodeMarketDataProvider(
  input: ProviderConfig,
  options: NodeMarketDataFactoryOptions = {},
): MarketDataProvider {
  const config = assertProviderConfig(input);
  if (config.provider === 'csv') {
    const source = new CsvProvider({ dir: config.dataDir });
    return new ReplayProvider(source, {
      cutoverTime: config.cutoverTime,
      paceMs: config.paceMs,
      instrument: {
        mintick: config.mintick,
        qtyStep: config.qtyStep,
        minOrderQty: config.minOrderQty,
        pointValue: config.pointValue,
        exchange: config.exchange,
        expiry: config.expiry,
      },
    });
  }
  if (config.provider === 'tiger' && !config.transport) {
    const credentials = options.tigerCredentials ?? {
      tigerId: process.env.TIGEROPEN_TIGER_ID ?? process.env.TIGER_ID,
      privateKey: process.env.TIGEROPEN_PRIVATE_KEY ?? process.env.TIGER_PRIVATE_KEY,
      account: process.env.TIGEROPEN_ACCOUNT ?? process.env.TIGER_ACCOUNT,
      license: process.env.TIGEROPEN_LICENSE,
      token: process.env.TIGEROPEN_TOKEN,
    };
    const credentialSlice: TigerMarketDataCredentials = {
      tigerId: optionalTigerCredential(credentials.tigerId, 'tigerId'),
      privateKey: optionalTigerCredential(credentials.privateKey, 'privateKey'),
      account: optionalTigerCredential(credentials.account, 'account'),
      license: optionalTigerCredential(credentials.license, 'license'),
      token: optionalTigerCredential(credentials.token, 'token'),
    };
    const factory =
      tigerTransportFactory ??
      ((
        tigerConfig: Extract<ProviderConfig, { provider: 'tiger' }>,
        value: TigerMarketDataCredentials,
      ) =>
        createOfficialTigerMarketDataTransport({
          ...value,
          propertiesFilePath: tigerConfig.profile,
          serverUrl: tigerConfig.baseUrl,
        }));
    return createMarketDataProvider({
      ...config,
      transport: factory(config, credentialSlice),
    });
  }
  return createMarketDataProvider(config);
}

function optionalTigerCredential(value: unknown, name: string): string | undefined {
  if (value != null && typeof value !== 'string')
    throw new Error(`pinery: Tiger credential ${name} must be a string`);
  return value as string | undefined;
}
