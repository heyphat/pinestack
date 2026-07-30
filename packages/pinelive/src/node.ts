import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export * from './index.js';
import type { LedgerRecord, LedgerSink } from './core/ledger.js';

/** Serialized append-only JSONL sink. Each append reaches the OS before resolving. */
export class JsonlLedger implements LedgerSink {
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(readonly path: string) {}

  append(record: LedgerRecord): Promise<void> {
    if (this.closed) return Promise.reject(new Error('ledger is closed'));
    const line = `${JSON.stringify(record)}\n`;
    this.chain = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line, { encoding: 'utf8', mode: 0o600 });
    });
    return this.chain;
  }

  async flush(): Promise<void> {
    await this.chain;
  }

  async close(): Promise<void> {
    await this.flush();
    this.closed = true;
  }
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`${path}:${index + 1}: invalid JSON`, { cause: error });
      }
    });
}

/** Load optional JSON config; callers should pass only non-secret values to logs. */
export async function readConfig(path: string): Promise<Readonly<Record<string, unknown>>> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed))
    throw new Error('config must be a JSON object');
  return parsed as Readonly<Record<string, unknown>>;
}

import { TigerBroker, type TigerTradingTransport } from './brokers/tiger.js';
import { createOfficialTigerTradingTransport } from './brokers/tiger-official.js';

export {
  OfficialTigerTradingTransport,
  createOfficialTigerTradingTransport,
  tigerUserMark,
  type OfficialTigerTradeClient,
  type OfficialTigerTradingOptions,
} from './brokers/tiger-official.js';

export interface TigerBrokerConfig {
  id: 'tiger';
  profile?: string;
  account?: string;
  orderPollIntervalMs?: number;
  maxOrderPolls?: number;
  cancelStuckOrders?: boolean;
}

export interface TigerTradingCredentials {
  tigerId?: string;
  privateKey?: string;
  account?: string;
  secretKey?: string;
  license?: string;
  token?: string;
}

export type TigerTradingTransportFactory = (
  config: TigerBrokerConfig,
  credentials: Readonly<TigerTradingCredentials>,
) => TigerTradingTransport;

let tigerTradingTransportFactory: TigerTradingTransportFactory | undefined;

/** Override the built-in official Tiger OpenAPI execution transport. */
export function registerTigerTradingTransport(factory: TigerTradingTransportFactory): void {
  tigerTradingTransportFactory = factory;
}

export function assertTigerBrokerConfig(value: unknown): TigerBrokerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('pinelive: Tiger broker config must be an object');
  const config = value as Record<string, unknown>;
  const allowed = [
    'id',
    'profile',
    'account',
    'orderPollIntervalMs',
    'maxOrderPolls',
    'cancelStuckOrders',
  ];
  const unknown = Object.keys(config).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`pinelive: Tiger broker config does not allow "${unknown}"`);
  if (config.id !== 'tiger') throw new Error('pinelive: Tiger broker config requires id "tiger"');
  for (const key of ['profile', 'account'] as const) {
    if (config[key] != null && typeof config[key] !== 'string')
      throw new Error(`pinelive: Tiger broker ${key} must be a string`);
  }
  if (
    config.orderPollIntervalMs != null &&
    (!Number.isInteger(config.orderPollIntervalMs) || (config.orderPollIntervalMs as number) < 0)
  )
    throw new Error('pinelive: Tiger broker orderPollIntervalMs must be a non-negative integer');
  if (
    config.maxOrderPolls != null &&
    (!Number.isInteger(config.maxOrderPolls) || (config.maxOrderPolls as number) < 0)
  )
    throw new Error('pinelive: Tiger broker maxOrderPolls must be a non-negative integer');
  if (config.cancelStuckOrders != null && typeof config.cancelStuckOrders !== 'boolean')
    throw new Error('pinelive: Tiger broker cancelStuckOrders must be boolean');
  return {
    id: 'tiger',
    profile: config.profile as string | undefined,
    account: config.account as string | undefined,
    orderPollIntervalMs: config.orderPollIntervalMs as number | undefined,
    maxOrderPolls: config.maxOrderPolls as number | undefined,
    cancelStuckOrders: config.cancelStuckOrders as boolean | undefined,
  };
}

export function createNodeTigerBroker(
  input: TigerBrokerConfig,
  armed: boolean,
  credentials: Readonly<TigerTradingCredentials> = {
    tigerId: process.env.TIGEROPEN_TIGER_ID ?? process.env.TIGER_ID,
    privateKey: process.env.TIGEROPEN_PRIVATE_KEY ?? process.env.TIGER_PRIVATE_KEY,
    account: process.env.TIGEROPEN_ACCOUNT ?? process.env.TIGER_ACCOUNT,
    secretKey: process.env.TIGEROPEN_SECRET_KEY,
    license: process.env.TIGEROPEN_LICENSE,
    token: process.env.TIGEROPEN_TOKEN,
  },
): TigerBroker {
  const config = assertTigerBrokerConfig(input);
  if (!armed) throw new Error('pinelive: Tiger execution requires explicit arming');
  const credentialSlice: TigerTradingCredentials = {
    tigerId: optionalCredential(credentials.tigerId, 'tigerId'),
    privateKey: optionalCredential(credentials.privateKey, 'privateKey'),
    account: optionalCredential(credentials.account, 'account'),
    secretKey: optionalCredential(credentials.secretKey, 'secretKey'),
    license: optionalCredential(credentials.license, 'license'),
    token: optionalCredential(credentials.token, 'token'),
  };
  const factory =
    tigerTradingTransportFactory ??
    ((value: TigerBrokerConfig, secrets: TigerTradingCredentials) =>
      createOfficialTigerTradingTransport({
        ...secrets,
        account: value.account ?? secrets.account,
        propertiesFilePath: value.profile,
      }));
  return new TigerBroker({
    transport: factory(config, credentialSlice),
    armed,
    accountId: config.account ?? credentialSlice.account,
    orderPollIntervalMs: config.orderPollIntervalMs,
    maxOrderPolls: config.maxOrderPolls,
    cancelStuckOrders: config.cancelStuckOrders,
  });
}

function optionalCredential(value: unknown, name: string): string | undefined {
  if (value != null && typeof value !== 'string')
    throw new Error(`pinelive: Tiger credential ${name} must be a string`);
  return value as string | undefined;
}
