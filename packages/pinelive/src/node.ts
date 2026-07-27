import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export * from './index.js';
import type { ForwardRecord, LedgerSink } from './core/ledger.js';

/** Serialized append-only JSONL sink. Each append reaches the OS before resolving. */
export class JsonlLedger implements LedgerSink {
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(readonly path: string) {}

  append(record: ForwardRecord): Promise<void> {
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
