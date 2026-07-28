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

export interface TigerBrokerConfig {
  id: 'tiger';
  profile?: string;
  account?: string;
}

export interface TigerTradingCredentials {
  tigerId?: string;
  privateKey?: string;
  account?: string;
}

export type TigerTradingTransportFactory = (
  config: TigerBrokerConfig,
  credentials: Readonly<TigerTradingCredentials>,
) => TigerTradingTransport;

let tigerTradingTransportFactory: TigerTradingTransportFactory | undefined;

/** Register an independently verified production Tiger execution transport. */
export function registerTigerTradingTransport(factory: TigerTradingTransportFactory): void {
  tigerTradingTransportFactory = factory;
}

export function assertTigerBrokerConfig(value: unknown): TigerBrokerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('pinelive: Tiger broker config must be an object');
  const config = value as Record<string, unknown>;
  const unknown = Object.keys(config).find((key) => !['id', 'profile', 'account'].includes(key));
  if (unknown) throw new Error(`pinelive: Tiger broker config does not allow "${unknown}"`);
  if (config.id !== 'tiger') throw new Error('pinelive: Tiger broker config requires id "tiger"');
  for (const key of ['profile', 'account'] as const) {
    if (config[key] != null && typeof config[key] !== 'string')
      throw new Error(`pinelive: Tiger broker ${key} must be a string`);
  }
  return {
    id: 'tiger',
    profile: config.profile as string | undefined,
    account: config.account as string | undefined,
  };
}

export function createNodeTigerBroker(
  input: TigerBrokerConfig,
  armed: boolean,
  credentials: Readonly<TigerTradingCredentials> = {
    tigerId: process.env.TIGER_ID,
    privateKey: process.env.TIGER_PRIVATE_KEY,
    account: process.env.TIGER_ACCOUNT,
  },
): TigerBroker {
  const config = assertTigerBrokerConfig(input);
  if (!armed) throw new Error('pinelive: Tiger execution requires explicit arming');
  if (!tigerTradingTransportFactory)
    throw new Error(
      'pinelive: no production Tiger trading transport is registered; install/register a verified credentialed transport',
    );
  const credentialSlice: TigerTradingCredentials = {
    tigerId: optionalCredential(credentials.tigerId, 'tigerId'),
    privateKey: optionalCredential(credentials.privateKey, 'privateKey'),
    account: optionalCredential(credentials.account, 'account'),
  };
  return new TigerBroker({
    transport: tigerTradingTransportFactory(config, credentialSlice),
    armed,
    accountId: config.account,
  });
}

function optionalCredential(value: unknown, name: string): string | undefined {
  if (value != null && typeof value !== 'string')
    throw new Error(`pinelive: Tiger credential ${name} must be a string`);
  return value as string | undefined;
}
