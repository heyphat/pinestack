#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { BrokerRegistry } from './core/registry.js';
import { runForwardServer } from './core/server.js';
import type { Instrument } from './core/types.js';
import { PaperBroker } from './brokers/paper.js';
import { CsvReplayFeed } from './feeds/csv-replay.js';
import { JsonlLedger, readJsonl } from './node.js';
import { compareLedgerParity } from './parity.js';
import type { ForwardRecord } from './core/ledger.js';
import type { ExpectedPositionRecord } from './parity.js';

interface Args {
  positional: string[];
  values: Map<string, string>;
  flags: Set<string>;
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

function numberArg(args: Args, name: string, fallback: number): number {
  const raw = args.values.get(name);
  const value = raw == null ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${name} must be numeric`);
  return value;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(
      'pinelive run <strategy.pine> --data <bars.csv> --symbol <SYM> --tf <tf> [--warmup N] [--ledger path] [--arm]',
    );
    console.log('pinelive parity <live.jsonl> <expected.jsonl>');
    return;
  }
  if (command === 'parity') {
    const args = parseArgs(rest);
    const [livePath, expectedPath] = args.positional;
    if (!livePath || !expectedPath)
      throw new Error('parity requires <live.jsonl> <expected.jsonl>');
    const [live, expected] = await Promise.all([
      readJsonl<ForwardRecord>(livePath),
      readJsonl<ExpectedPositionRecord>(expectedPath),
    ]);
    const differences = compareLedgerParity(live, expected);
    console.log(JSON.stringify({ matches: differences.length === 0, differences }, null, 2));
    if (differences.length > 0) process.exitCode = 2;
    return;
  }
  if (command !== 'run') throw new Error(`unknown command "${command}"`);

  const args = parseArgs(rest);
  const strategyPath = args.positional[0];
  const dataPath = args.values.get('data');
  const symbol = args.values.get('symbol');
  const timeframe = args.values.get('tf');
  const brokerId = args.values.get('broker') ?? 'paper';
  if (!strategyPath || !dataPath || !symbol || !timeframe) {
    throw new Error('run requires <strategy.pine>, --data, --symbol, and --tf');
  }
  if ((args.values.get('feed') ?? 'csv') !== 'csv')
    throw new Error('only the offline csv feed is available in this release');

  const instrument: Instrument = {
    symbol,
    minQty: numberArg(args, 'min-qty', 1),
    mintick: numberArg(args, 'mintick', 0.01),
    pointValue: numberArg(args, 'point-value', 1),
  };
  const registry = new BrokerRegistry().register('paper', {
    real: false,
    factory: () =>
      new PaperBroker({
        instruments: { [symbol]: instrument },
        initialBalance: numberArg(args, 'balance', 100_000),
        slippageBps: numberArg(args, 'slippage-bps', 0),
        commissionPerUnit: numberArg(args, 'commission', 0),
      }),
  });
  if (!registry.has(brokerId)) {
    throw new Error(
      `broker adapter "${brokerId}" is not installed; this SDK-free build provides paper only`,
    );
  }
  const armed = args.flags.has('arm');
  const broker = await registry.create(brokerId, { armed, env: process.env });
  const source = await readFile(strategyPath, 'utf8');
  const csv = await readFile(dataPath, 'utf8');
  const warmupBars = numberArg(args, 'warmup', 100);
  const feed = new CsvReplayFeed(csv, { warmupBars, paceMs: numberArg(args, 'pace', 0) });
  const ledgerPath = args.values.get('ledger') ?? '.pinelive/ledger.jsonl';
  const ledger = new JsonlLedger(ledgerPath);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await runForwardServer({
      source,
      symbol,
      timeframe,
      broker,
      feed,
      ledger,
      warmupBars,
      signal: controller.signal,
      executionId: args.values.get('execution-id'),
      onLog: (line) => console.log(line),
    });
    console.log(
      `stopped: position=${result.finalPosition} equity=${result.finalEquity} ledger=${ledgerPath}`,
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
