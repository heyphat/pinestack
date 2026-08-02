import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readBootBoundProcessIdentity } from './coordination.js';
export * from './coordination.js';
export * from './status.js';
export * from './administrative-recovery.js';
export * from './index.js';
import {
  ExecutionLeaseError,
  type ExecutionLease,
  type ExecutionLeaseSnapshot,
} from './core/lease.js';
import type { LedgerRecord, LedgerSink } from './core/ledger.js';
import type { IntrabarPersistence, IntrabarPersistenceRead } from './core/intrabar-server.js';
import type { LedgerRecoveryState } from './core/recovery.js';

export type JsonlDurability = 'buffered' | 'sync';
export type JsonlSyncMethod = 'datasync' | 'sync';
export type JsonlTailPolicy = 'refuse' | 'repair';

export interface JsonlLedgerOptions {
  /** `sync` is the durable default; `buffered` batches stable-storage sync until flush/close. */
  durability?: JsonlDurability;
  syncMethod?: JsonlSyncMethod;
  /** Refuse dirty EOFs by default; repair requires an exclusively held ledger lease. */
  tailPolicy?: JsonlTailPolicy;
  /** Acquire before opening the ledger and release after final close. */
  lease?: boolean | ExecutionLease;
  /**
   * Default true. Set false only when a surrounding runtime owns an already-acquired lease and
   * must preserve it after a more-sensitive ownership release fails.
   */
  releaseLeaseOnClose?: boolean;
  /** Deterministic fault-injection seam. Production defaults to FileHandle.datasync/sync. */
  syncFile?: (handle: FileHandle, method: JsonlSyncMethod) => Promise<void>;
}

/** Serialized append-only JSONL sink backed by one mode-0600 file handle. */
export class JsonlLedger implements LedgerSink {
  private tail: Promise<void> = Promise.resolve();
  private handle?: FileHandle;
  private fatalError: unknown;
  private closing = false;
  private closed = false;
  private closeValue?: Promise<void>;
  private readonly durability: JsonlDurability;
  private readonly syncMethod: JsonlSyncMethod;
  private readonly tailPolicy: JsonlTailPolicy;
  private readonly lease?: ExecutionLease;
  private readonly releaseLeaseOnClose: boolean;
  private readonly syncFile?: JsonlLedgerOptions['syncFile'];

  constructor(
    readonly path: string,
    options: JsonlLedgerOptions | JsonlDurability = {},
  ) {
    if (!path) throw new RangeError('ledger path must not be empty');
    const normalized = typeof options === 'string' ? { durability: options } : options;
    this.durability = normalized.durability ?? 'sync';
    this.syncMethod = normalized.syncMethod ?? 'datasync';
    this.tailPolicy = normalized.tailPolicy ?? 'refuse';
    if (this.durability !== 'buffered' && this.durability !== 'sync')
      throw new RangeError('ledger durability must be "buffered" or "sync"');
    if (this.syncMethod !== 'datasync' && this.syncMethod !== 'sync')
      throw new RangeError('ledger syncMethod must be "datasync" or "sync"');
    if (this.tailPolicy !== 'refuse' && this.tailPolicy !== 'repair')
      throw new RangeError('ledger tailPolicy must be "refuse" or "repair"');
    this.lease =
      normalized.lease === true
        ? new NodeExclusiveFileLease(`${path}.lock`, { resource: path })
        : normalized.lease || undefined;
    this.releaseLeaseOnClose = normalized.releaseLeaseOnClose ?? true;
    this.syncFile = normalized.syncFile;
  }

  append(record: LedgerRecord): Promise<void> {
    if (this.closing || this.closed) return Promise.reject(new Error('ledger is closed'));
    if (this.fatalError !== undefined) return Promise.reject(this.fatalError);
    let bytes: Uint8Array;
    try {
      bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueue(async () => {
      const handle = await this.openHandle();
      if (this.lease) await this.lease.assertHeld();
      await writeFully(handle, bytes);
      if (this.durability === 'sync') await this.syncHandle(handle);
    });
  }

  async flush(): Promise<void> {
    if (this.closed) {
      if (this.fatalError !== undefined) throw this.fatalError;
      return;
    }
    if (this.fatalError !== undefined) throw this.fatalError;
    await this.enqueue(async () => {
      if (this.handle) await this.syncHandle(this.handle);
    });
  }

  close(): Promise<void> {
    if (this.closeValue) return this.closeValue;
    this.closing = true;
    this.closeValue = this.closeOwnedResources();
    return this.closeValue;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.tail.then(async () => {
      if (this.fatalError !== undefined) throw this.fatalError;
      try {
        await operation();
      } catch (error) {
        this.fatalError = error;
        throw error;
      }
    });
    this.tail = task.catch(() => undefined);
    return task;
  }

  private async openHandle(): Promise<FileHandle> {
    if (this.handle) return this.handle;
    await mkdir(dirname(this.path), { recursive: true });
    let acquiredHere = false;
    let handle: FileHandle | undefined;
    try {
      if (this.lease) {
        if (!this.lease.snapshot) {
          if (!this.releaseLeaseOnClose) {
            throw new Error('externally managed ledger lease must already be acquired');
          }
          await this.lease.acquire();
          acquiredHere = true;
        } else {
          await this.lease.assertHeld();
        }
      }
      handle = await open(this.path, 'a+', 0o600);
      await chmod(this.path, 0o600);
      await this.prepareTail(handle);
      if (this.lease) await this.lease.assertHeld();
      this.handle = handle;
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (acquiredHere) await this.lease?.release().catch(() => undefined);
      throw error;
    }
  }

  private async prepareTail(handle: FileHandle): Promise<void> {
    const bytes = await handle.readFile();
    const prefix = parseJsonlBytes<unknown>(this.path, bytes, true);
    if (bytes.length === 0 || bytes[bytes.length - 1] === 0x0a) return;
    if (this.tailPolicy !== 'repair')
      throw new Error(`${this.path}: final JSONL record is not newline-terminated`);
    if (!this.lease)
      throw new Error('repairing a JSONL crash tail requires an exclusive ledger lease');
    await this.lease.assertHeld();
    if (prefix.partialFinalLine != null) await handle.truncate(prefix.validBytes);
    else await writeFully(handle, Buffer.from('\n', 'utf8'));
  }

  private async syncHandle(handle: FileHandle): Promise<void> {
    if (this.syncFile) {
      await this.syncFile(handle, this.syncMethod);
      return;
    }
    if (this.syncMethod === 'datasync') await handle.datasync();
    else await handle.sync();
  }

  private async closeOwnedResources(): Promise<void> {
    const errors: unknown[] = [];
    await this.tail;
    if (this.fatalError === undefined && this.handle) {
      try {
        await this.syncHandle(this.handle);
      } catch (error) {
        this.fatalError = error;
        errors.push(error);
      }
    } else if (this.fatalError !== undefined) {
      errors.push(this.fatalError);
    }
    if (this.handle) {
      try {
        await this.handle.close();
      } catch (error) {
        errors.push(error);
      }
      this.handle = undefined;
    }
    if (this.lease?.snapshot && this.releaseLeaseOnClose) {
      try {
        await this.lease.release();
      } catch (error) {
        errors.push(error);
      }
    }
    this.closed = true;
    this.closing = false;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'ledger close failed');
  }
}

export interface ReadJsonlOptions {
  /** Ignore one malformed, non-newline-terminated final JSON object fragment. Default false. */
  allowPartialFinalLine?: boolean;
}

export interface JsonlPrefix<T> {
  records: T[];
  /** Present only when an opted-in crash fragment was discarded. */
  partialFinalLine?: string;
  validBytes: number;
  totalBytes: number;
}

export interface NodeIntrabarPersistenceOptions {
  readonly ledgerPath: string;
  readonly leasePath: string;
  readonly ownerId?: string;
}

/** Node schema-v3 persistence adapter. Read happens before lease; JsonlLedger rechecks under lease. */
export class NodeIntrabarPersistence implements IntrabarPersistence {
  constructor(private readonly options: NodeIntrabarPersistenceOptions) {
    if (!options.ledgerPath) throw new RangeError('intrabar ledger path must not be empty');
    if (!options.leasePath) throw new RangeError('intrabar lease path must not be empty');
    if (options.ledgerPath === options.leasePath)
      throw new RangeError('intrabar ledger and lease paths must be different');
  }

  async read(): Promise<IntrabarPersistenceRead> {
    try {
      return await readJsonlPrefix<unknown>(this.options.ledgerPath, {
        allowPartialFinalLine: true,
      });
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return { records: [] };
      throw error;
    }
  }

  createLease(recovery: LedgerRecoveryState): ExecutionLease {
    if (recovery.activeLease) {
      throw new Error(
        'durable execution lease is still active; automatic stale takeover is forbidden',
      );
    }
    return new NodeExclusiveFileLease(this.options.leasePath, {
      resource: this.options.ledgerPath,
      ownerId: this.options.ownerId,
    });
  }

  createLedger(lease: ExecutionLease): LedgerSink {
    return new JsonlLedger(this.options.ledgerPath, {
      durability: 'sync',
      tailPolicy: 'repair',
      lease,
      releaseLeaseOnClose: false,
    });
  }
}

export function createNodeIntrabarPersistence(
  options: NodeIntrabarPersistenceOptions,
): NodeIntrabarPersistence {
  return new NodeIntrabarPersistence(options);
}

export async function readJsonlPrefix<T>(
  path: string,
  options: ReadJsonlOptions | boolean = {},
): Promise<JsonlPrefix<T>> {
  const normalized = typeof options === 'boolean' ? { allowPartialFinalLine: options } : options;
  const allowPartial = normalized.allowPartialFinalLine ?? false;
  return parseJsonlBytes<T>(path, await readFile(path), allowPartial);
}

function parseJsonlBytes<T>(path: string, bytes: Buffer, allowPartial: boolean): JsonlPrefix<T> {
  const records: T[] = [];
  let lineStart = 0;
  let lineNumber = 1;
  let validBytes = 0;

  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0x0a) continue;
    const end = index > lineStart && bytes[index - 1] === 0x0d ? index - 1 : index;
    const line = bytes.subarray(lineStart, end).toString('utf8');
    if (line.length === 0) throw new Error(`${path}:${lineNumber}: blank JSONL record`);
    records.push(parseJsonLine<T>(path, line, lineNumber));
    validBytes = index + 1;
    lineStart = index + 1;
    lineNumber++;
  }

  if (lineStart === bytes.length)
    return { records, validBytes: bytes.length, totalBytes: bytes.length };
  const tail = bytes.subarray(lineStart).toString('utf8');
  if (tail.length === 0) return { records, validBytes: bytes.length, totalBytes: bytes.length };
  try {
    records.push(JSON.parse(tail) as T);
    return { records, validBytes: bytes.length, totalBytes: bytes.length };
  } catch (error) {
    if (!allowPartial || !isViableJsonPrefix(tail))
      throw new Error(`${path}:${lineNumber}: invalid JSON`, { cause: error });
    return { records, partialFinalLine: tail, validBytes, totalBytes: bytes.length };
  }
}

export async function readJsonl<T>(
  path: string,
  options: ReadJsonlOptions | boolean = {},
): Promise<T[]> {
  return (await readJsonlPrefix<T>(path, options)).records;
}

export const parseJsonlPrefix = readJsonlPrefix;

export interface NodeExclusiveFileLeaseOptions {
  resource?: string;
  ownerId?: string;
  leaseId?: string;
  now?: () => number;
}

/**
 * Cooperative cross-process fail-closed lease. Stale files are never stolen implicitly. Deploy
 * the lock in a permission-isolated directory when same-host processes are not mutually trusted.
 */
export class NodeExclusiveFileLease implements ExecutionLease {
  readonly resource: string;
  readonly ownerId: string;
  private readonly leaseId: string;
  private readonly now: () => number;
  private handle?: FileHandle;
  private value?: ExecutionLeaseSnapshot;

  constructor(
    readonly path: string,
    options: NodeExclusiveFileLeaseOptions = {},
  ) {
    if (!path) throw new RangeError('lease path must not be empty');
    this.resource = options.resource ?? path;
    this.ownerId = options.ownerId ?? `pid:${process.pid}`;
    this.leaseId = options.leaseId ?? randomUUID();
    this.now = options.now ?? Date.now;
  }

  get snapshot(): ExecutionLeaseSnapshot | undefined {
    return this.value ? { ...this.value } : undefined;
  }

  async acquire(): Promise<ExecutionLeaseSnapshot> {
    if (this.value) {
      await this.assertHeld();
      return { ...this.value };
    }
    await mkdir(dirname(this.path), { recursive: true });
    let handle: FileHandle;
    try {
      handle = await open(this.path, 'wx+', 0o600);
    } catch (error) {
      if (isNodeError(error, 'EEXIST'))
        throw new ExecutionLeaseError(
          'contended',
          `execution lease is already held for ${this.resource}`,
          { cause: error },
        );
      throw error;
    }
    const timestamp = this.now();
    if (!Number.isFinite(timestamp)) {
      await handle.close().catch(() => undefined);
      await unlink(this.path).catch(() => undefined);
      throw new Error('execution lease clock is not finite');
    }
    const snapshot = {
      resource: this.resource,
      leaseId: this.leaseId,
      ownerId: this.ownerId,
      acquiredAt: new Date(timestamp).toISOString(),
    };
    const processIdentity = await readBootBoundProcessIdentity();
    try {
      await chmod(this.path, 0o600);
      await handle.writeFile(
        `${JSON.stringify({
          leaseVersion: 2,
          ...snapshot,
          pid: process.pid,
          ...(processIdentity ? { processIdentity } : {}),
        })}\n`,
        'utf8',
      );
      await handle.datasync();
      this.handle = handle;
      this.value = snapshot;
      return { ...snapshot };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(this.path).catch(() => undefined);
      throw error;
    }
  }

  async assertHeld(): Promise<void> {
    if (!this.value || !this.handle)
      throw new ExecutionLeaseError('not-held', `execution lease is not held for ${this.resource}`);
    let metadata: unknown;
    try {
      metadata = JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      throw new ExecutionLeaseError('lost', `execution lease was lost for ${this.resource}`, {
        cause: error,
      });
    }
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      (metadata as Record<string, unknown>).leaseId !== this.value.leaseId ||
      (metadata as Record<string, unknown>).ownerId !== this.value.ownerId
    )
      throw new ExecutionLeaseError('lost', `execution lease owner changed for ${this.resource}`);
  }

  async release(): Promise<void> {
    if (!this.value) return;
    await this.assertHeld();
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
    try {
      const metadata = JSON.parse(await readFile(this.path, 'utf8')) as Record<string, unknown>;
      if (metadata.leaseId !== this.value.leaseId || metadata.ownerId !== this.value.ownerId)
        throw new ExecutionLeaseError(
          'lost',
          `execution lease owner changed before release for ${this.resource}`,
        );
      await unlink(this.path);
      this.value = undefined;
    } catch (error) {
      throw error instanceof ExecutionLeaseError
        ? error
        : new ExecutionLeaseError('lost', `execution lease release failed for ${this.resource}`, {
            cause: error,
          });
    }
  }
}

export class FileExecutionLease extends NodeExclusiveFileLease {}
export class ExclusiveFileLease extends NodeExclusiveFileLease {}

async function writeFully(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error('ledger write made no progress');
    offset += bytesWritten;
  }
}

function parseJsonLine<T>(path: string, line: string, lineNumber: number): T {
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    throw new Error(`${path}:${lineNumber}: invalid JSON`, { cause: error });
  }
}

type JsonPrefixStatus = 'complete' | 'partial' | 'invalid';

interface JsonPrefixParse {
  status: JsonPrefixStatus;
  index: number;
}

/** True only when appending bytes (without changing the prefix) could form a JSON object/array. */
function isViableJsonPrefix(text: string): boolean {
  const start = skipJsonWhitespace(text, 0);
  if (text[start] !== '{' && text[start] !== '[') return false;
  const parsed = parseJsonPrefixValue(text, start);
  if (parsed.status === 'invalid') return false;
  if (parsed.status === 'partial') return true;
  // A complete value would already have parsed above; trailing non-whitespace is corruption.
  return false;
}

function parseJsonPrefixValue(text: string, start: number): JsonPrefixParse {
  const index = skipJsonWhitespace(text, start);
  if (index >= text.length) return { status: 'partial', index };
  const first = text[index]!;
  if (first === '{') return parseJsonPrefixObject(text, index + 1);
  if (first === '[') return parseJsonPrefixArray(text, index + 1);
  if (first === '"') return parseJsonPrefixString(text, index + 1);
  if (first === 't') return parseJsonPrefixLiteral(text, index, 'true');
  if (first === 'f') return parseJsonPrefixLiteral(text, index, 'false');
  if (first === 'n') return parseJsonPrefixLiteral(text, index, 'null');
  if (first === '-' || (first >= '0' && first <= '9')) return parseJsonPrefixNumber(text, index);
  return { status: 'invalid', index };
}

function parseJsonPrefixObject(text: string, start: number): JsonPrefixParse {
  let index = skipJsonWhitespace(text, start);
  if (index >= text.length) return { status: 'partial', index };
  if (text[index] === '}') return { status: 'complete', index: index + 1 };
  for (;;) {
    if (text[index] !== '"') return { status: 'invalid', index };
    const key = parseJsonPrefixString(text, index + 1);
    if (key.status !== 'complete') return key;
    index = skipJsonWhitespace(text, key.index);
    if (index >= text.length) return { status: 'partial', index };
    if (text[index] !== ':') return { status: 'invalid', index };
    const value = parseJsonPrefixValue(text, index + 1);
    if (value.status !== 'complete') return value;
    index = skipJsonWhitespace(text, value.index);
    if (index >= text.length) return { status: 'partial', index };
    if (text[index] === '}') return { status: 'complete', index: index + 1 };
    if (text[index] !== ',') return { status: 'invalid', index };
    index = skipJsonWhitespace(text, index + 1);
    if (index >= text.length) return { status: 'partial', index };
  }
}

function parseJsonPrefixArray(text: string, start: number): JsonPrefixParse {
  let index = skipJsonWhitespace(text, start);
  if (index >= text.length) return { status: 'partial', index };
  if (text[index] === ']') return { status: 'complete', index: index + 1 };
  for (;;) {
    const value = parseJsonPrefixValue(text, index);
    if (value.status !== 'complete') return value;
    index = skipJsonWhitespace(text, value.index);
    if (index >= text.length) return { status: 'partial', index };
    if (text[index] === ']') return { status: 'complete', index: index + 1 };
    if (text[index] !== ',') return { status: 'invalid', index };
    index = skipJsonWhitespace(text, index + 1);
    if (index >= text.length) return { status: 'partial', index };
  }
}

function parseJsonPrefixString(text: string, start: number): JsonPrefixParse {
  let index = start;
  while (index < text.length) {
    const character = text[index]!;
    if (character === '"') return { status: 'complete', index: index + 1 };
    if (character.charCodeAt(0) < 0x20) return { status: 'invalid', index };
    if (character !== '\\') {
      index++;
      continue;
    }
    index++;
    if (index >= text.length) return { status: 'partial', index };
    const escaped = text[index]!;
    if ('"\\/bfnrt'.includes(escaped)) {
      index++;
      continue;
    }
    if (escaped !== 'u') return { status: 'invalid', index };
    for (let digit = 0; digit < 4; digit++) {
      index++;
      if (index >= text.length) return { status: 'partial', index };
      if (!/[0-9a-f]/i.test(text[index]!)) return { status: 'invalid', index };
    }
    index++;
  }
  return { status: 'partial', index };
}

function parseJsonPrefixLiteral(
  text: string,
  start: number,
  literal: 'true' | 'false' | 'null',
): JsonPrefixParse {
  for (let offset = 0; offset < literal.length; offset++) {
    const index = start + offset;
    if (index >= text.length) return { status: 'partial', index };
    if (text[index] !== literal[offset]) return { status: 'invalid', index };
  }
  return { status: 'complete', index: start + literal.length };
}

function parseJsonPrefixNumber(text: string, start: number): JsonPrefixParse {
  let index = start;
  while (index < text.length && !isJsonNumberDelimiter(text[index]!)) index++;
  const token = text.slice(start, index);
  const complete = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token);
  if (complete) return { status: 'complete', index };
  const partial =
    /^-$/.test(token) ||
    /^-?(?:0|[1-9]\d*)\.$/.test(token) ||
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?[eE][+-]?$/.test(token);
  return {
    status: partial && index === text.length ? 'partial' : 'invalid',
    index,
  };
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && isJsonWhitespace(text[index]!)) index++;
  return index;
}

function isJsonWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\r' || character === '\n';
}

function isJsonNumberDelimiter(character: string): boolean {
  return isJsonWhitespace(character) || character === ',' || character === ']' || character === '}';
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
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

export interface CreateNodeTigerBrokerOptions {
  /** Require a runtime-installed account-claim and synchronization guard before mutations. */
  readonly requireExecutionSafety?: boolean;
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
  options: CreateNodeTigerBrokerOptions = {},
): TigerBroker {
  const config = assertTigerBrokerConfig(input);
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
    requireExecutionSafety: options.requireExecutionSafety ?? true,
  });
}

function optionalCredential(value: unknown, name: string): string | undefined {
  if (value != null && typeof value !== 'string')
    throw new Error(`pinelive: Tiger credential ${name} must be a string`);
  return value as string | undefined;
}
