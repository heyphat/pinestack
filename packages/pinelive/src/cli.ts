#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import {
  assertLiveSymbolMatchesConfig,
  assertProviderConfig,
  type ProviderConfig,
} from '@heyphat/pinery';
import { createNodeMarketDataProvider } from '@heyphat/pinery/node';
import { runForwardServer } from './core/server.js';
import { PaperBroker } from './brokers/paper.js';
import { JsonlLedger, createNodeTigerBroker, readConfig, readJsonl } from './node.js';
import { compareLedgerParity } from './parity.js';
import type { ForwardRecord, LedgerRecord } from './core/ledger.js';
import type { ExpectedPositionRecord } from './parity.js';

interface Args {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

export interface RunConfig {
  configVersion?: 1;
  strategy: string;
  symbol: string;
  timeframe: string;
  warmupBars?: number;
  inputs?: Readonly<Record<string, unknown>>;
  executionId?: string;
  reconcileOnStart?: boolean;
  data: ProviderConfig;
  broker:
    | { id: 'paper'; initialBalance?: number; slippageBps?: number; commissionPerUnit?: number }
    | { id: 'tiger'; profile?: string; account?: string };
  armed?: boolean;
  ledger?: string;
}

function parseArgs(args: string[]): Args {
  const parsed: Args = { positional: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      parsed.positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (next != null && !next.startsWith('--')) {
      parsed.values.set(name, next);
      i++;
    } else parsed.flags.add(name);
  }
  return parsed;
}

export function parseRunConfig(value: Readonly<Record<string, unknown>>): RunConfig {
  assertConfigKeys(
    value,
    [
      'configVersion',
      'strategy',
      'symbol',
      'timeframe',
      'warmupBars',
      'inputs',
      'executionId',
      'reconcileOnStart',
      'data',
      'broker',
      'armed',
      'ledger',
    ],
    'config',
  );
  for (const field of ['strategy', 'symbol', 'timeframe'] as const)
    if (typeof value[field] !== 'string' || !value[field])
      throw new Error(`config.${field} must be a non-empty string`);
  if (value.configVersion != null && value.configVersion !== 1)
    throw new Error('unsupported configVersion');
  if (
    value.warmupBars != null &&
    (!Number.isInteger(value.warmupBars) || (value.warmupBars as number) < 0)
  )
    throw new Error('config.warmupBars must be a non-negative integer');
  const data = assertProviderConfig(value.data);
  const brokerValue = value.broker === undefined ? { id: 'paper' } : value.broker;
  if (!brokerValue || typeof brokerValue !== 'object' || Array.isArray(brokerValue))
    throw new Error('config.broker must be an object');
  const broker = brokerValue as Record<string, unknown>;
  if (broker.id !== 'paper' && broker.id !== 'tiger')
    throw new Error('config.broker.id must be "paper" or "tiger"');
  if (broker.id === 'paper') {
    assertConfigKeys(
      broker,
      ['id', 'initialBalance', 'slippageBps', 'commissionPerUnit'],
      'config.broker',
    );
    for (const field of ['initialBalance', 'slippageBps', 'commissionPerUnit'] as const) {
      if (
        broker[field] != null &&
        (typeof broker[field] !== 'number' || !Number.isFinite(broker[field]))
      )
        throw new Error(`config.broker.${field} must be numeric`);
    }
  } else {
    assertConfigKeys(broker, ['id', 'profile', 'account'], 'config.broker');
    if (broker.profile != null && typeof broker.profile !== 'string')
      throw new Error('config.broker.profile must be a string');
    if (broker.account != null && typeof broker.account !== 'string')
      throw new Error('config.broker.account must be a string');
  }
  if (value.armed != null && typeof value.armed !== 'boolean')
    throw new Error('config.armed must be boolean');
  if (value.reconcileOnStart != null && typeof value.reconcileOnStart !== 'boolean')
    throw new Error('config.reconcileOnStart must be boolean');
  if (value.executionId != null && typeof value.executionId !== 'string')
    throw new Error('config.executionId must be a string');
  if (value.ledger != null && typeof value.ledger !== 'string')
    throw new Error('config.ledger must be a string');
  if (
    value.inputs != null &&
    (typeof value.inputs !== 'object' || value.inputs == null || Array.isArray(value.inputs))
  )
    throw new Error('config.inputs must be an object');
  return {
    ...(value as unknown as RunConfig),
    configVersion: 1,
    data,
    broker: broker as unknown as RunConfig['broker'],
  };
}

function assertConfigKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${path}.${unknown} is not allowed`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log('pinelive run --config <pinelive.json>');
    console.log('pinelive parity <live.jsonl> <expected.jsonl>');
    return;
  }
  if (command === 'parity') {
    const args = parseArgs(rest);
    const [livePath, expectedPath] = args.positional;
    if (!livePath || !expectedPath)
      throw new Error('parity requires <live.jsonl> <expected.jsonl>');
    const [ledger, expected] = await Promise.all([
      readJsonl<LedgerRecord>(livePath),
      readJsonl<ExpectedPositionRecord>(expectedPath),
    ]);
    const live = ledger.filter(
      (row): row is ForwardRecord => row.recordType !== 'binding' && row.recordType !== 'startup',
    );
    const differences = compareLedgerParity(live, expected);
    console.log(JSON.stringify({ matches: differences.length === 0, differences }, null, 2));
    if (differences.length > 0) process.exitCode = 2;
    return;
  }
  if (command !== 'run') throw new Error(`unknown command "${command}"`);

  const args = parseArgs(rest);
  const configPath = args.values.get('config');
  if (!configPath)
    throw new Error('run requires --config <path>; direct --data CSV mode moved to pinery config');
  const config = parseRunConfig(await readConfig(configPath));
  const runSymbol = assertLiveSymbolMatchesConfig(config.symbol, config.data);
  const data = createNodeMarketDataProvider(config.data, {
    tigerCredentials: {
      tigerId: process.env.TIGER_ID,
      privateKey: process.env.TIGER_PRIVATE_KEY,
      account: process.env.TIGER_ACCOUNT,
    },
  });
  const armed = config.armed ?? false;

  let broker;
  if (config.broker.id === 'tiger') {
    broker = createNodeTigerBroker(config.broker, armed, {
      tigerId: process.env.TIGER_ID,
      privateKey: process.env.TIGER_PRIVATE_KEY,
      account: process.env.TIGER_ACCOUNT,
    });
  } else {
    broker = new PaperBroker({
      instrumentResolver: async (symbol) => {
        const resolved = await data.resolve(runSymbol, { strict: true });
        if (resolved.venueSymbol !== symbol)
          throw new Error('paper broker requested a contract different from pinery resolution');
        return {
          symbol: resolved.venueSymbol,
          dataSymbol: resolved.venueSymbol,
          brokerSymbol: resolved.venueSymbol,
          minQty: resolved.qtyStep,
          qtyStep: resolved.qtyStep,
          minOrderQty: resolved.minOrderQty,
          mintick: resolved.mintick,
          pointValue: resolved.pointValue,
          exchange: resolved.exchange,
          expiry: resolved.expiry,
        };
      },
      initialBalance: config.broker.initialBalance,
      slippageBps: config.broker.slippageBps,
      commissionPerUnit: config.broker.commissionPerUnit,
    });
  }

  const source = await readFile(config.strategy, 'utf8');
  const ledgerPath = config.ledger ?? '.pinelive/ledger.jsonl';
  const ledger = new JsonlLedger(ledgerPath);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await runForwardServer({
      source,
      symbol: runSymbol,
      timeframe: config.timeframe,
      data,
      broker,
      ledger,
      warmupBars: config.warmupBars,
      inputs: config.inputs,
      executionId: config.executionId,
      reconcileOnStart: config.reconcileOnStart,
      signal: controller.signal,
      onLog: (line) => console.log(line),
    });
    console.log(
      `stopped: contract=${result.binding.executionSymbol} position=${result.finalPosition} equity=${result.finalEquity} ledger=${ledgerPath}`,
    );
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (import.meta.main)
  main().catch((error) => {
    console.error(`pinelive: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
