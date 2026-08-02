import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import type { BootBoundProcessIdentity } from './coordination.js';
import type { EffectiveRunPosture } from './core/ledger.js';

export const RUN_REGISTRY_RECORD_MAX_BYTES = 64 * 1024;
export const RUN_REGISTRY_MAX_ENTRIES = 1_000;
export const RUN_HISTORY_MAX_RECORDS = 500;
export const RUN_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
export const RUN_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
export const RUN_HEARTBEAT_INTERVAL_MS = 5_000;

const INSTANCE_ID_PATTERN = /^[a-f0-9]{32,128}$/;
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_IDENTITY_LENGTH = 256;
const MAX_DISPLAY_LENGTH = 256;
const MAX_PROCESS_IDENTITY_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export type RunLifecycle = 'starting' | 'running' | 'stopping';
export type RunHistoryOutcome =
  'stopped' | 'failed-startup' | 'failed-runtime' | 'execution-latched';
export type RunRegistryBrokerId = 'compute-only' | 'paper' | 'tiger';

export interface ActiveRunRegistrationV1 {
  readonly registrationVersion: 1;
  readonly instanceId: string;
  readonly pid: number;
  readonly processIdentity?: BootBoundProcessIdentity;
  readonly lifecycle: RunLifecycle;
  readonly startedAt: string;
  readonly heartbeatAt: string;
  readonly updatedAt: string;

  readonly configVersion: 3;
  readonly runId?: string;
  readonly executionId?: string;
  readonly brokerId: RunRegistryBrokerId;
  readonly posture: EffectiveRunPosture;

  readonly paths: {
    readonly ledger: string;
    readonly executionLease?: string;
    readonly accountClaim?: string;
    readonly config?: string;
    readonly log?: string;
  };

  readonly display?: {
    readonly strategyId?: string;
    readonly strategySymbol?: string;
    readonly executionSymbol?: string;
    readonly timeframe?: string;
  };
}

export interface RunHistoryRecordV1 {
  readonly historyVersion: 1;
  readonly instanceId: string;
  readonly runId?: string;
  readonly executionId?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: RunHistoryOutcome;
  readonly finalLedgerPath?: string;
  readonly finalLedgerSequence?: number;
  readonly finalReasonCode?: string;
  readonly configVersion: 3;
  readonly brokerId: RunRegistryBrokerId;
  readonly posture: EffectiveRunPosture;
}

export type RunRegistryErrorCode =
  | 'corrupt-record'
  | 'entry-limit-exceeded'
  | 'filename-mismatch'
  | 'history-active-mismatch'
  | 'history-conflict'
  | 'invalid-entry-name'
  | 'invalid-instance-id'
  | 'not-found'
  | 'record-too-large'
  | 'unsafe-directory'
  | 'unsafe-entry'
  | 'unsupported-version';

export class RunRegistryError extends Error {
  constructor(
    readonly code: RunRegistryErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'RunRegistryError';
  }
}

export interface RunRegistryEntryError {
  readonly code: RunRegistryErrorCode;
  readonly message: string;
  readonly path: string;
  readonly instanceIdHint?: string;
}

export interface RunRegistryEnumerationEntry {
  readonly instanceId: string;
  readonly active?: ActiveRunRegistrationV1;
  readonly history?: RunHistoryRecordV1;
}

export interface RunRegistryEnumeration {
  readonly entries: readonly RunRegistryEnumerationEntry[];
  readonly errors: readonly RunRegistryEntryError[];
}

export interface RunHistoryRetentionResult {
  readonly removedInstanceIds: readonly string[];
  readonly retainedRecords: number;
  readonly retainedBytes: number;
  readonly errors: readonly RunRegistryEntryError[];
}

export interface NodeRunRegistryOptions {
  readonly rootDir?: string;
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly env?: Readonly<{ PINELIVE_RUNS_DIR?: string }>;
  readonly now?: () => Date;
  readonly onMaintenanceWarning?: (warning: {
    readonly code: RunRegistryErrorCode;
    readonly message: string;
  }) => void;
}

interface ScannedRecord<T> {
  readonly instanceId: string;
  readonly value: T;
  readonly path: string;
  readonly bytes: number;
}

interface ScannedDirectory<T> {
  readonly records: readonly ScannedRecord<T>[];
  readonly errors: readonly RunRegistryEntryError[];
}

/** Generate an opaque portable identifier containing 128 random bits. */
export function createRunInstanceId(): string {
  return randomBytes(16).toString('hex');
}

/** Resolve a configured registry root once against the caller's original working directory. */
export function resolveRunRegistryRoot(options: NodeRunRegistryOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.env ?? process.env;
  const configured =
    options.rootDir ??
    environment.PINELIVE_RUNS_DIR ??
    join(options.homeDir ?? homedir(), '.pinelive', 'runs');
  if (!configured) throw new RangeError('run registry root must not be empty');
  return resolve(cwd, configured);
}

/** Resolve a registered artifact path once against the runtime's original working directory. */
export function resolveRunRegistrationPath(path: string, cwd = process.cwd()): string {
  if (!path) throw new RangeError('registered path must not be empty');
  return resolve(cwd, path);
}

export function encodeActiveRunRegistrationV1(record: ActiveRunRegistrationV1): string {
  const value = validateActiveRunRegistrationV1(record);
  return encodeBounded(value, 'active registration');
}

export function decodeActiveRunRegistrationV1(input: string | Uint8Array): ActiveRunRegistrationV1 {
  return validateActiveRunRegistrationV1(decodeBounded(input, 'active registration'));
}

export function encodeRunHistoryRecordV1(record: RunHistoryRecordV1): string {
  const value = validateRunHistoryRecordV1(record);
  return encodeBounded(value, 'history record');
}

export function decodeRunHistoryRecordV1(input: string | Uint8Array): RunHistoryRecordV1 {
  return validateRunHistoryRecordV1(decodeBounded(input, 'history record'));
}

export function validateActiveRunRegistrationV1(value: unknown): ActiveRunRegistrationV1 {
  const record = objectValue(value, 'active registration');
  assertExactKeys(
    record,
    [
      'registrationVersion',
      'instanceId',
      'pid',
      'processIdentity',
      'lifecycle',
      'startedAt',
      'heartbeatAt',
      'updatedAt',
      'configVersion',
      'runId',
      'executionId',
      'brokerId',
      'posture',
      'paths',
      'display',
    ],
    'active registration',
  );
  if (record.registrationVersion !== 1)
    throw registryError('unsupported-version', 'unsupported registrationVersion; expected 1');
  const instanceId = instanceIdValue(record.instanceId);
  const pid = positiveSafeInteger(record.pid, 'active registration pid');
  const processIdentity = optionalProcessIdentity(record.processIdentity);
  const lifecycle = enumValue(
    record.lifecycle,
    ['starting', 'running', 'stopping'] as const,
    'active registration lifecycle',
  );
  const startedAt = timestampValue(record.startedAt, 'active registration startedAt');
  const heartbeatAt = timestampValue(record.heartbeatAt, 'active registration heartbeatAt');
  const updatedAt = timestampValue(record.updatedAt, 'active registration updatedAt');
  if (Date.parse(heartbeatAt) < Date.parse(startedAt))
    throw corrupt('active registration heartbeatAt precedes startedAt');
  if (Date.parse(updatedAt) < Date.parse(heartbeatAt))
    throw corrupt('active registration updatedAt precedes heartbeatAt');
  if (record.configVersion !== 3)
    throw registryError('unsupported-version', 'unsupported configVersion; expected 3');
  const runId = optionalBoundedString(
    record.runId,
    'active registration runId',
    MAX_IDENTITY_LENGTH,
  );
  const executionId = optionalBoundedString(
    record.executionId,
    'active registration executionId',
    MAX_IDENTITY_LENGTH,
  );
  const brokerId = brokerIdValue(record.brokerId);
  const posture = postureValue(record.posture);
  const paths = activePathsValue(record.paths);
  const display = optionalDisplayValue(record.display);

  return {
    registrationVersion: 1,
    instanceId,
    pid,
    ...(processIdentity ? { processIdentity } : {}),
    lifecycle,
    startedAt,
    heartbeatAt,
    updatedAt,
    configVersion: 3,
    ...(runId ? { runId } : {}),
    ...(executionId ? { executionId } : {}),
    brokerId,
    posture,
    paths,
    ...(display ? { display } : {}),
  };
}

export function validateRunHistoryRecordV1(value: unknown): RunHistoryRecordV1 {
  const record = objectValue(value, 'history record');
  assertExactKeys(
    record,
    [
      'historyVersion',
      'instanceId',
      'runId',
      'executionId',
      'startedAt',
      'endedAt',
      'outcome',
      'finalLedgerPath',
      'finalLedgerSequence',
      'finalReasonCode',
      'configVersion',
      'brokerId',
      'posture',
    ],
    'history record',
  );
  if (record.historyVersion !== 1)
    throw registryError('unsupported-version', 'unsupported historyVersion; expected 1');
  const instanceId = instanceIdValue(record.instanceId);
  const runId = optionalBoundedString(record.runId, 'history runId', MAX_IDENTITY_LENGTH);
  const executionId = optionalBoundedString(
    record.executionId,
    'history executionId',
    MAX_IDENTITY_LENGTH,
  );
  const startedAt = timestampValue(record.startedAt, 'history startedAt');
  const endedAt = timestampValue(record.endedAt, 'history endedAt');
  if (Date.parse(endedAt) < Date.parse(startedAt))
    throw corrupt('history endedAt precedes startedAt');
  const outcome = enumValue(
    record.outcome,
    ['stopped', 'failed-startup', 'failed-runtime', 'execution-latched'] as const,
    'history outcome',
  );
  const finalLedgerPath = optionalAbsolutePath(record.finalLedgerPath, 'history finalLedgerPath');
  const finalLedgerSequence = optionalNonnegativeSafeInteger(
    record.finalLedgerSequence,
    'history finalLedgerSequence',
  );
  if (outcome !== 'failed-startup' && !finalLedgerPath)
    throw corrupt('history finalLedgerPath is required unless outcome is failed-startup');
  if (finalLedgerSequence !== undefined && !finalLedgerPath)
    throw corrupt('history finalLedgerSequence requires finalLedgerPath');
  const finalReasonCode = optionalReasonCode(record.finalReasonCode);
  if (record.configVersion !== 3)
    throw registryError('unsupported-version', 'unsupported configVersion; expected 3');
  const brokerId = brokerIdValue(record.brokerId);
  const posture = postureValue(record.posture);

  return {
    historyVersion: 1,
    instanceId,
    ...(runId ? { runId } : {}),
    ...(executionId ? { executionId } : {}),
    startedAt,
    endedAt,
    outcome,
    ...(finalLedgerPath ? { finalLedgerPath } : {}),
    ...(finalLedgerSequence !== undefined ? { finalLedgerSequence } : {}),
    ...(finalReasonCode ? { finalReasonCode } : {}),
    configVersion: 3,
    brokerId,
    posture,
  };
}

/** Private, bounded, atomic storage for active discovery and terminal history records. */
export class NodeRunRegistry {
  readonly rootDir: string;
  readonly activeDir: string;
  readonly historyDir: string;
  private readonly now: () => Date;
  private readonly onMaintenanceWarning?: NodeRunRegistryOptions['onMaintenanceWarning'];
  private readonly instanceMutations = new Map<string, Promise<void>>();
  private historyMutation: Promise<void> = Promise.resolve();

  constructor(options: NodeRunRegistryOptions = {}) {
    this.rootDir = resolveRunRegistryRoot(options);
    this.activeDir = join(this.rootDir, 'active');
    this.historyDir = join(this.rootDir, 'history');
    this.now = options.now ?? (() => new Date());
    this.onMaintenanceWarning = options.onMaintenanceWarning;
  }

  createInstanceId(): string {
    return createRunInstanceId();
  }

  async writeActive(record: ActiveRunRegistrationV1): Promise<void> {
    const encoded = encodeActiveRunRegistrationV1(record);
    await this.enqueueInstanceMutation(record.instanceId, async () => {
      await this.atomicWrite(this.activeDir, record.instanceId, encoded);
    });
  }

  async updateActive(
    instanceId: string,
    update: (
      current: ActiveRunRegistrationV1,
    ) => ActiveRunRegistrationV1 | Promise<ActiveRunRegistrationV1>,
  ): Promise<ActiveRunRegistrationV1> {
    instanceIdValue(instanceId);
    return this.enqueueInstanceMutation(instanceId, async () => {
      const current = await this.readActive(instanceId);
      if (!current)
        throw registryError(
          'not-found',
          'active registration does not exist',
          this.activePath(instanceId),
        );
      const next = validateActiveRunRegistrationV1(await update(current));
      if (next.instanceId !== instanceId)
        throw registryError('filename-mismatch', 'active update cannot change instanceId');
      await this.atomicWrite(this.activeDir, instanceId, encodeActiveRunRegistrationV1(next));
      return next;
    });
  }

  async heartbeat(instanceId: string, at = this.now()): Promise<ActiveRunRegistrationV1> {
    if (!Number.isFinite(at.getTime())) throw new RangeError('heartbeat date must be valid');
    return this.updateActive(instanceId, (current) => {
      const heartbeatAt = latestTimestamp(current.heartbeatAt, at.toISOString());
      return {
        ...current,
        heartbeatAt,
        updatedAt: latestTimestamp(current.updatedAt, heartbeatAt),
      };
    });
  }

  createHeartbeatService(
    instanceId: string,
    options: Omit<AdvisoryHeartbeatServiceOptions, 'writeHeartbeat'> = {},
  ): AdvisoryHeartbeatService {
    instanceIdValue(instanceId);
    return new AdvisoryHeartbeatService({
      ...options,
      writeHeartbeat: async () => {
        await this.heartbeat(instanceId);
      },
    });
  }

  async readActive(instanceId: string): Promise<ActiveRunRegistrationV1 | undefined> {
    instanceIdValue(instanceId);
    const path = this.activePath(instanceId);
    const bytes = await readBoundedRegularFile(path);
    if (!bytes) return undefined;
    const value = decodeActiveRunRegistrationV1(bytes);
    assertFilenameIdentity(value.instanceId, instanceId, path);
    return value;
  }

  async writeHistory(record: RunHistoryRecordV1): Promise<void> {
    const validated = validateRunHistoryRecordV1(record);
    const encoded = encodeRunHistoryRecordV1(validated);
    await this.enqueueHistoryMutation(async () => {
      await this.publishHistory(validated, encoded);
      await this.bestEffortRetentionNow();
    });
  }

  async readHistory(instanceId: string): Promise<RunHistoryRecordV1 | undefined> {
    instanceIdValue(instanceId);
    const path = this.historyPath(instanceId);
    const bytes = await readBoundedRegularFile(path);
    if (!bytes) return undefined;
    const value = decodeRunHistoryRecordV1(bytes);
    assertFilenameIdentity(value.instanceId, instanceId, path);
    return value;
  }

  /** Atomically persist terminal history before attempting compatible active-record removal. */
  async completeRun(record: RunHistoryRecordV1): Promise<{ readonly activeRemoved: boolean }> {
    const validated = validateRunHistoryRecordV1(record);
    const encoded = encodeRunHistoryRecordV1(validated);
    return this.enqueueHistoryMutation(async () => {
      const result = await this.enqueueInstanceMutation(validated.instanceId, async () => {
        await this.publishHistory(validated, encoded);
        const active = await this.readActive(validated.instanceId);
        if (!active) return { activeRemoved: false } as const;
        assertHistoryMatchesActive(validated, active);
        const activeRemoved = await this.removeRegularRecord(
          this.activePath(validated.instanceId),
          this.activeDir,
        );
        return { activeRemoved } as const;
      });
      await this.bestEffortRetentionNow();
      return result;
    });
  }

  async removeActive(instanceId: string): Promise<boolean> {
    instanceIdValue(instanceId);
    return this.enqueueInstanceMutation(instanceId, async () => {
      const existing = await this.readActive(instanceId);
      if (!existing) return false;
      return this.removeRegularRecord(this.activePath(instanceId), this.activeDir);
    });
  }

  /** Read active/history independently and return their deterministic instance-ID union. */
  async enumerate(): Promise<RunRegistryEnumeration> {
    const rootExists = await assertSafeDirectory(this.rootDir, true);
    if (!rootExists) return { entries: [], errors: [] };
    const budget = { count: 0 };
    const active = await this.scanDirectory(this.activeDir, decodeActiveRunRegistrationV1, budget);
    const history = await this.scanDirectory(this.historyDir, decodeRunHistoryRecordV1, budget);
    const union = new Map<
      string,
      { active?: ActiveRunRegistrationV1; history?: RunHistoryRecordV1 }
    >();
    for (const record of active.records) {
      const item = union.get(record.instanceId) ?? {};
      item.active = record.value;
      union.set(record.instanceId, item);
    }
    for (const record of history.records) {
      const item = union.get(record.instanceId) ?? {};
      item.history = record.value;
      union.set(record.instanceId, item);
    }
    const entries = [...union.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([instanceId, value]) => ({ instanceId, ...value }));
    const errors = [...active.errors, ...history.errors].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    return { entries, errors };
  }

  /** Explicit writer-side history cleanup. Readers never call this operation. */
  async pruneHistory(now = this.now()): Promise<RunHistoryRetentionResult> {
    return this.enqueueHistoryMutation(async () => this.pruneHistoryNow(now));
  }

  private async pruneHistoryNow(now: Date): Promise<RunHistoryRetentionResult> {
    if (!Number.isFinite(now.getTime())) throw new RangeError('retention date must be valid');
    const rootExists = await assertSafeDirectory(this.rootDir, true);
    if (!rootExists)
      return { removedInstanceIds: [], retainedRecords: 0, retainedBytes: 0, errors: [] };
    const scan = await this.scanDirectory(this.historyDir, decodeRunHistoryRecordV1, { count: 0 });
    const oldestFirst = [...scan.records].sort(
      (left, right) =>
        Date.parse(left.value.endedAt) - Date.parse(right.value.endedAt) ||
        left.instanceId.localeCompare(right.instanceId),
    );
    const cutoff = now.getTime() - RUN_HISTORY_MAX_AGE_MS;
    const remove = new Set(
      oldestFirst
        .filter((record) => Date.parse(record.value.endedAt) < cutoff)
        .map((record) => record.instanceId),
    );
    let retainedRecords = oldestFirst.length - remove.size;
    let retainedBytes = oldestFirst
      .filter((record) => !remove.has(record.instanceId))
      .reduce((total, record) => total + record.bytes, 0);
    for (const record of oldestFirst) {
      if (retainedRecords <= RUN_HISTORY_MAX_RECORDS && retainedBytes <= RUN_HISTORY_MAX_BYTES)
        break;
      if (remove.has(record.instanceId)) continue;
      remove.add(record.instanceId);
      retainedRecords -= 1;
      retainedBytes -= record.bytes;
    }

    const removedInstanceIds: string[] = [];
    const errors = [...scan.errors];
    for (const record of oldestFirst) {
      if (!remove.has(record.instanceId)) continue;
      try {
        const current = await this.readHistory(record.instanceId);
        if (!current || current.endedAt !== record.value.endedAt) continue;
        if (await this.removeRegularRecord(record.path, this.historyDir)) {
          removedInstanceIds.push(record.instanceId);
        }
      } catch (error) {
        errors.push(entryError(error, record.path, record.instanceId));
      }
    }

    const removed = new Set(removedInstanceIds);
    return {
      removedInstanceIds,
      retainedRecords: oldestFirst.filter((record) => !removed.has(record.instanceId)).length,
      retainedBytes: oldestFirst
        .filter((record) => !removed.has(record.instanceId))
        .reduce((total, record) => total + record.bytes, 0),
      errors: errors.sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  private async publishHistory(record: RunHistoryRecordV1, encoded: string): Promise<void> {
    const bytes = Buffer.from(encoded, 'utf8');
    if (bytes.byteLength > RUN_REGISTRY_RECORD_MAX_BYTES)
      throw registryError('record-too-large', 'registry record exceeds 64 KiB');
    await this.ensureDirectories();
    const destination = this.historyPath(record.instanceId);
    const temporary = join(
      this.historyDir,
      `.${record.instanceId}.${randomBytes(12).toString('hex')}.tmp`,
    );
    let handle: FileHandle | undefined;
    let temporaryExists = false;
    try {
      handle = await open(temporary, 'wx', 0o600);
      temporaryExists = true;
      await handle.writeFile(bytes);
      await handle.datasync();
      await handle.close();
      handle = undefined;

      try {
        // Hard-link publication is atomic and never replaces an existing terminal record.
        await link(temporary, destination);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        const existing = await this.readHistory(record.instanceId);
        if (!existing)
          throw registryError(
            'history-conflict',
            'terminal history publication raced with removal',
            destination,
          );
        if (encodeRunHistoryRecordV1(existing) !== encoded)
          throw registryError(
            'history-conflict',
            'terminal history already exists with different evidence',
            destination,
          );
        return;
      }

      await unlink(temporary);
      temporaryExists = false;
      await syncDirectory(this.historyDir);
    } finally {
      await handle?.close().catch(() => undefined);
      if (temporaryExists) {
        await unlink(temporary).catch(() => undefined);
        await syncDirectory(this.historyDir).catch(() => undefined);
      }
    }
  }

  private enqueueInstanceMutation<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.instanceMutations.get(instanceId) ?? Promise.resolve();
    const result = predecessor.catch(() => undefined).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.instanceMutations.set(instanceId, settled);
    void settled.then(() => {
      if (this.instanceMutations.get(instanceId) === settled)
        this.instanceMutations.delete(instanceId);
    });
    return result;
  }

  private enqueueHistoryMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.historyMutation.catch(() => undefined).then(operation);
    this.historyMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private activePath(instanceId: string): string {
    return join(this.activeDir, `${instanceId}.json`);
  }

  private historyPath(instanceId: string): string {
    return join(this.historyDir, `${instanceId}.json`);
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await assertSafeDirectory(this.rootDir, false);
    await setPrivateMode(this.rootDir, 0o700);
    for (const path of [this.activeDir, this.historyDir]) {
      await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
        if (!isNodeError(error, 'EEXIST')) throw error;
      });
      await assertSafeDirectory(path, false);
      await setPrivateMode(path, 0o700);
    }
  }

  private async atomicWrite(directory: string, instanceId: string, content: string): Promise<void> {
    instanceIdValue(instanceId);
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.byteLength > RUN_REGISTRY_RECORD_MAX_BYTES)
      throw registryError('record-too-large', 'registry record exceeds 64 KiB');
    await this.ensureDirectories();
    const destination = join(directory, `${instanceId}.json`);
    await assertReplaceableRecord(destination);
    const temporary = join(directory, `.${instanceId}.${randomBytes(12).toString('hex')}.tmp`);
    let handle: FileHandle | undefined;
    let renamed = false;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.datasync();
      await handle.close();
      handle = undefined;
      await assertReplaceableRecord(destination);
      await rename(temporary, destination);
      renamed = true;
      await syncDirectory(directory);
    } finally {
      await handle?.close().catch(() => undefined);
      if (!renamed) {
        await unlink(temporary).catch(() => undefined);
        await syncDirectory(directory).catch(() => undefined);
      }
    }
  }

  private async removeRegularRecord(path: string, directory: string): Promise<boolean> {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile())
      throw registryError('unsafe-entry', 'registry record is not a regular file', path);
    await unlink(path);
    await syncDirectory(directory);
    return true;
  }

  private async scanDirectory<T>(
    directory: string,
    decode: (input: string | Uint8Array) => T,
    budget: { count: number; exhausted?: boolean },
  ): Promise<ScannedDirectory<T>> {
    if (!(await assertSafeDirectory(directory, true))) return { records: [], errors: [] };
    const records: ScannedRecord<T>[] = [];
    const errors: RunRegistryEntryError[] = [];
    const stream = await opendir(directory);
    for await (const entry of stream) {
      if (budget.count >= RUN_REGISTRY_MAX_ENTRIES) {
        if (!budget.exhausted) {
          errors.push({
            code: 'entry-limit-exceeded',
            message: `registry enumeration stopped after ${RUN_REGISTRY_MAX_ENTRIES} entries`,
            path: directory,
          });
        }
        budget.exhausted = true;
        break;
      }
      budget.count += 1;
      // Atomic-write temporaries and host metadata are not registry records. Count them toward the
      // scan budget, but do not turn harmless dotfiles such as .DS_Store into permanent error rows.
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      const match = /^([a-f0-9]{32,128})\.json$/.exec(entry.name);
      if (!match?.[1]) {
        errors.push({
          code: 'invalid-entry-name',
          message: 'registry entry name is not a portable instance record',
          path,
        });
        continue;
      }
      const instanceId = match[1];
      try {
        const bytes = await readBoundedRegularFile(path);
        if (!bytes)
          throw registryError('not-found', 'registry entry disappeared during enumeration', path);
        const value = decode(bytes);
        const valueInstanceId = (value as { readonly instanceId?: unknown }).instanceId;
        assertFilenameIdentity(valueInstanceId, instanceId, path);
        records.push({ instanceId, value, path, bytes: bytes.byteLength });
      } catch (error) {
        errors.push(entryError(error, path, instanceId));
      }
    }
    records.sort((left, right) => left.instanceId.localeCompare(right.instanceId));
    return { records, errors };
  }

  private async bestEffortRetentionNow(): Promise<void> {
    try {
      const result = await this.pruneHistoryNow(this.now());
      for (const error of result.errors) this.onMaintenanceWarning?.(error);
    } catch (error) {
      const normalized = normalizeRegistryError(error);
      this.onMaintenanceWarning?.({ code: normalized.code, message: normalized.message });
    }
  }
}

export interface AdvisoryHeartbeatServiceOptions {
  readonly writeHeartbeat: () => Promise<void>;
  readonly intervalMs?: number;
  readonly onWarning?: (warning: {
    readonly code: 'heartbeat-write-failed';
    readonly failureCount: number;
  }) => void;
}

/** Rate-limited advisory heartbeat loop. A slow write is never overlapped by another write. */
export class AdvisoryHeartbeatService {
  readonly intervalMs: number;
  private readonly writeHeartbeat: () => Promise<void>;
  private readonly onWarning?: AdvisoryHeartbeatServiceOptions['onWarning'];
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private failures = 0;

  constructor(options: AdvisoryHeartbeatServiceOptions) {
    this.intervalMs = options.intervalMs ?? RUN_HEARTBEAT_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs <= 0)
      throw new RangeError('heartbeat intervalMs must be a positive integer');
    this.writeHeartbeat = options.writeHeartbeat;
    this.onWarning = options.onWarning;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  get failureCount(): number {
    return this.failures;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pulse();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Trigger one heartbeat; false means an earlier write is still in flight. */
  async pulse(): Promise<boolean> {
    if (this.inFlight) return false;
    const task = Promise.resolve()
      .then(this.writeHeartbeat)
      .catch(() => {
        this.failures += 1;
        this.onWarning?.({ code: 'heartbeat-write-failed', failureCount: this.failures });
      });
    const tracked = task.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    await tracked;
    return true;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

function activePathsValue(value: unknown): ActiveRunRegistrationV1['paths'] {
  const paths = objectValue(value, 'active registration paths');
  assertExactKeys(
    paths,
    ['ledger', 'executionLease', 'accountClaim', 'config', 'log'],
    'active registration paths',
  );
  const ledger = absolutePath(paths.ledger, 'active registration ledger path');
  const executionLease = optionalAbsolutePath(
    paths.executionLease,
    'active registration executionLease path',
  );
  const accountClaim = optionalAbsolutePath(
    paths.accountClaim,
    'active registration accountClaim path',
  );
  const config = optionalAbsolutePath(paths.config, 'active registration config path');
  const log = optionalAbsolutePath(paths.log, 'active registration log path');
  return {
    ledger,
    ...(executionLease ? { executionLease } : {}),
    ...(accountClaim ? { accountClaim } : {}),
    ...(config ? { config } : {}),
    ...(log ? { log } : {}),
  };
}

function optionalDisplayValue(value: unknown): ActiveRunRegistrationV1['display'] | undefined {
  if (value === undefined) return undefined;
  const display = objectValue(value, 'active registration display');
  assertExactKeys(
    display,
    ['strategyId', 'strategySymbol', 'executionSymbol', 'timeframe'],
    'active registration display',
  );
  const strategyId = optionalBoundedString(
    display.strategyId,
    'active registration display strategyId',
    MAX_DISPLAY_LENGTH,
  );
  const strategySymbol = optionalBoundedString(
    display.strategySymbol,
    'active registration display strategySymbol',
    MAX_DISPLAY_LENGTH,
  );
  const executionSymbol = optionalBoundedString(
    display.executionSymbol,
    'active registration display executionSymbol',
    MAX_DISPLAY_LENGTH,
  );
  const timeframe = optionalBoundedString(
    display.timeframe,
    'active registration display timeframe',
    MAX_DISPLAY_LENGTH,
  );
  return {
    ...(strategyId ? { strategyId } : {}),
    ...(strategySymbol ? { strategySymbol } : {}),
    ...(executionSymbol ? { executionSymbol } : {}),
    ...(timeframe ? { timeframe } : {}),
  };
}

function optionalProcessIdentity(value: unknown): BootBoundProcessIdentity | undefined {
  if (value === undefined) return undefined;
  const identity = objectValue(value, 'process identity');
  assertExactKeys(identity, ['kind', 'value', 'bootIdentityHash'], 'process identity');
  const kind = enumValue(
    identity.kind,
    ['darwin-start-time', 'linux-start-ticks'] as const,
    'process identity kind',
  );
  const identityValue = boundedString(
    identity.value,
    'process identity value',
    MAX_PROCESS_IDENTITY_LENGTH,
  );
  const bootIdentityHash = boundedString(
    identity.bootIdentityHash,
    'process boot identity hash',
    64,
  );
  if (!/^[a-f0-9]{64}$/.test(bootIdentityHash))
    throw corrupt('process boot identity hash must be lowercase SHA-256 hex');
  return { kind, value: identityValue, bootIdentityHash };
}

function encodeBounded(value: unknown, label: string): string {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > RUN_REGISTRY_RECORD_MAX_BYTES)
    throw registryError('record-too-large', `${label} exceeds 64 KiB`);
  return encoded;
}

function decodeBounded(input: string | Uint8Array, label: string): unknown {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  if (bytes.byteLength > RUN_REGISTRY_RECORD_MAX_BYTES)
    throw registryError('record-too-large', `${label} exceeds 64 KiB`);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw corrupt(`${label} is not valid JSON`);
  }
}

async function readBoundedRegularFile(path: string): Promise<Uint8Array | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile())
    throw registryError('unsafe-entry', 'registry record is not a regular file', path);
  if (metadata.size > RUN_REGISTRY_RECORD_MAX_BYTES)
    throw registryError('record-too-large', 'registry record exceeds 64 KiB', path);

  let handle: FileHandle | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile())
      throw registryError('unsafe-entry', 'registry record is not a regular file', path);
    const buffer = Buffer.alloc(RUN_REGISTRY_RECORD_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const result = await handle.read(buffer, length, buffer.byteLength - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > RUN_REGISTRY_RECORD_MAX_BYTES)
      throw registryError('record-too-large', 'registry record exceeds 64 KiB', path);
    return buffer.subarray(0, length);
  } catch (error) {
    if (isNodeError(error, 'ELOOP'))
      throw registryError('unsafe-entry', 'registry record is a symbolic link', path);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertReplaceableRecord(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile())
      throw registryError('unsafe-entry', 'registry destination is not a regular file', path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
}

async function assertSafeDirectory(path: string, allowMissing: boolean): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw registryError('unsafe-directory', 'registry path is not a regular directory', path);
    return true;
  } catch (error) {
    if (allowMissing && isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function setPrivateMode(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, mode);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (
      isNodeError(error, 'EINVAL') ||
      isNodeError(error, 'ENOTSUP') ||
      isNodeError(error, 'EISDIR')
    )
      return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function entryError(error: unknown, path: string, instanceIdHint?: string): RunRegistryEntryError {
  const normalized = normalizeRegistryError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    path,
    ...(instanceIdHint ? { instanceIdHint } : {}),
  };
}

function normalizeRegistryError(error: unknown): RunRegistryError {
  if (error instanceof RunRegistryError) return error;
  if (isNodeError(error, 'EACCES') || isNodeError(error, 'EPERM'))
    return registryError('unsafe-entry', 'registry entry cannot be inspected safely');
  return corrupt('registry entry could not be validated');
}

function assertHistoryMatchesActive(
  history: RunHistoryRecordV1,
  active: ActiveRunRegistrationV1,
): void {
  const identityMatches =
    history.instanceId === active.instanceId &&
    history.startedAt === active.startedAt &&
    history.runId === active.runId &&
    history.executionId === active.executionId &&
    history.brokerId === active.brokerId &&
    history.posture === active.posture &&
    (history.finalLedgerPath === undefined || history.finalLedgerPath === active.paths.ledger);
  if (!identityMatches)
    throw registryError(
      'history-active-mismatch',
      'terminal history does not match the active registration',
    );
}

function assertFilenameIdentity(value: unknown, expected: string, path: string): void {
  if (value !== expected)
    throw registryError('filename-mismatch', 'record instanceId does not match its filename', path);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw corrupt(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    throw corrupt(`${label} contains an unsupported field`);
}

function instanceIdValue(value: unknown): string {
  if (typeof value !== 'string' || !INSTANCE_ID_PATTERN.test(value))
    throw registryError(
      'invalid-instance-id',
      'instanceId must be 128-bit-or-stronger lowercase hexadecimal',
    );
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw corrupt(`${label} must be a positive safe integer`);
  return value as number;
}

function optionalNonnegativeSafeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw corrupt(`${label} must be a nonnegative safe integer`);
  return value as number;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    TERMINAL_CONTROL.test(value)
  )
    throw corrupt(`${label} must be a nonempty bounded string without terminal controls`);
  return value;
}

function optionalBoundedString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, label, maximum);
}

function timestampValue(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 64);
  const time = new Date(timestamp);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== timestamp)
    throw corrupt(`${label} must be a canonical ISO-8601 timestamp`);
  return timestamp;
}

function optionalReasonCode(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !REASON_CODE_PATTERN.test(value))
    throw corrupt('history finalReasonCode must be a bounded code, not a raw error');
  return value;
}

function absolutePath(value: unknown, label: string): string {
  const path = boundedString(value, label, MAX_PATH_LENGTH);
  if (!isAbsolute(path) || normalize(path) !== path)
    throw corrupt(`${label} must be absolute and normalized`);
  return path;
}

function optionalAbsolutePath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return absolutePath(value, label);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw corrupt(`${label} is invalid`);
  return value as T[number];
}

function brokerIdValue(value: unknown): RunRegistryBrokerId {
  return enumValue(value, ['compute-only', 'paper', 'tiger'] as const, 'brokerId');
}

function postureValue(value: unknown): EffectiveRunPosture {
  return enumValue(value, ['live', 'monitor', 'compute-only'] as const, 'posture');
}

function latestTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function corrupt(message: string): RunRegistryError {
  return registryError('corrupt-record', message);
}

function registryError(
  code: RunRegistryErrorCode,
  message: string,
  path?: string,
): RunRegistryError {
  return new RunRegistryError(code, message, path);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
