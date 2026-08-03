import { expect, test } from 'bun:test';
import * as browserSafeApi from '../src/index.js';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdvisoryHeartbeatService,
  NodeRunRegistry,
  RUN_HISTORY_MAX_AGE_MS,
  RUN_HISTORY_MAX_BYTES,
  RUN_HISTORY_MAX_RECORDS,
  RUN_REGISTRY_MAX_ENTRIES,
  RUN_REGISTRY_RECORD_MAX_BYTES,
  createRunInstanceId,
  decodeActiveRunRegistrationV1,
  decodeRunHistoryRecordV1,
  encodeActiveRunRegistrationV1,
  encodeRunHistoryRecordV1,
  resolveRunRegistrationPath,
  resolveRunRegistryRoot,
  type ActiveRunRegistrationV1,
  type RunHistoryRecordV1,
} from '../src/node.js';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pinelive-registry-'));
}

function instanceId(index: number): string {
  return index.toString(16).padStart(32, '0');
}

function active(
  root: string,
  id = instanceId(1),
  overrides: Partial<ActiveRunRegistrationV1> = {},
): ActiveRunRegistrationV1 {
  return {
    registrationVersion: 1,
    instanceId: id,
    pid: process.pid,
    lifecycle: 'starting',
    startedAt: new Date(BASE_TIME).toISOString(),
    heartbeatAt: new Date(BASE_TIME).toISOString(),
    updatedAt: new Date(BASE_TIME).toISOString(),
    configVersion: 3,
    brokerId: 'compute-only',
    posture: 'compute-only',
    paths: { ledger: join(root, `${id}.jsonl`) },
    ...overrides,
  };
}

function history(
  root: string,
  id = instanceId(1),
  endedAt = BASE_TIME + 1_000,
  overrides: Partial<RunHistoryRecordV1> = {},
): RunHistoryRecordV1 {
  return {
    historyVersion: 1,
    instanceId: id,
    startedAt: new Date(BASE_TIME).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    outcome: 'stopped',
    finalLedgerPath: join(root, `${id}.jsonl`),
    finalLedgerSequence: 0,
    configVersion: 3,
    brokerId: 'compute-only',
    posture: 'compute-only',
    ...overrides,
  };
}

test('V1 codecs enforce versions, paths, redaction shape, and failed-startup ledger rules', () => {
  expect(browserSafeApi).not.toHaveProperty('NodeRunRegistry');
  const root = '/tmp/pinelive-codec';
  const registration = active(root, instanceId(1), {
    lifecycle: 'running',
    runId: 'run-1',
    executionId: 'execution-1',
    display: { strategyId: 'strategy', timeframe: '1m' },
  });
  expect(decodeActiveRunRegistrationV1(encodeActiveRunRegistrationV1(registration))).toEqual(
    registration,
  );
  expect(decodeRunHistoryRecordV1(encodeRunHistoryRecordV1(history(root)))).toEqual(history(root));

  const failedStartup = history(root, instanceId(2), BASE_TIME + 1_000, {
    outcome: 'failed-startup',
    finalLedgerPath: undefined,
    finalLedgerSequence: undefined,
    finalReasonCode: 'storage-open-failed',
  });
  expect(decodeRunHistoryRecordV1(encodeRunHistoryRecordV1(failedStartup))).toEqual(failedStartup);
  expect(() =>
    encodeRunHistoryRecordV1({
      ...history(root),
      outcome: 'failed-runtime',
      finalLedgerPath: undefined,
      finalLedgerSequence: undefined,
    }),
  ).toThrow('finalLedgerPath is required');
  expect(() =>
    decodeActiveRunRegistrationV1(JSON.stringify({ ...registration, registrationVersion: 2 })),
  ).toThrow('expected 1');
  expect(() =>
    decodeActiveRunRegistrationV1(JSON.stringify({ ...registration, configVersion: 2 })),
  ).toThrow('expected 3');
  const canarySecret = 'credential-canary-must-not-leak';
  try {
    decodeActiveRunRegistrationV1(
      JSON.stringify({ ...registration, [canarySecret]: { token: 'secret' } }),
    );
    throw new Error('expected unsupported field rejection');
  } catch (error) {
    expect(String(error)).toContain('an unsupported field');
    expect(String(error)).not.toContain(canarySecret);
  }
  expect(() =>
    encodeRunHistoryRecordV1({ ...history(root), finalReasonCode: 'raw error details here' }),
  ).toThrow('not a raw error');
  expect(() =>
    encodeActiveRunRegistrationV1({
      ...registration,
      paths: { ledger: '../relative-ledger.jsonl' },
    }),
  ).toThrow('absolute and normalized');

  expect(resolveRunRegistrationPath('../ledger.jsonl', '/tmp/project/run')).toBe(
    '/tmp/project/ledger.jsonl',
  );
  expect(
    resolveRunRegistryRoot({
      env: { PINELIVE_RUNS_DIR: '../private-runs' },
      cwd: '/tmp/project/run',
    }),
  ).toBe('/tmp/project/private-runs');
  expect(resolveRunRegistryRoot({ env: {}, homeDir: '/tmp/home', cwd: '/tmp/project' })).toBe(
    '/tmp/home/.pinelive/runs',
  );
  expect(createRunInstanceId()).toMatch(/^[a-f0-9]{32}$/);
  expect(createRunInstanceId()).not.toBe(createRunInstanceId());
});

test('writers create private modes and atomically replace complete same-directory records', async () => {
  const temporary = await temporaryDirectory();
  try {
    const root = join(temporary, 'runs');
    const registry = new NodeRunRegistry({ rootDir: root });
    const id = instanceId(1);
    await registry.writeActive(active(temporary, id));
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        registry.writeActive(
          active(temporary, id, {
            lifecycle: index % 2 === 0 ? 'running' : 'stopping',
            runId: `run-${index}`,
          }),
        ),
      ),
    );

    const moduleUrl = new URL('../src/node.ts', import.meta.url).href;
    const childRecord = active(temporary, id);
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { NodeRunRegistry } from ${JSON.stringify(moduleUrl)};
         const registry = new NodeRunRegistry({ rootDir: ${JSON.stringify(root)} });
         const base = ${JSON.stringify(childRecord)};
         for (let index = 0; index < 30; index += 1) {
           await registry.writeActive({ ...base, pid: process.pid, runId: 'child-' + index });
         }`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const observations = Promise.all(
      Array.from({ length: 100 }, async (_, index) => {
        await Bun.sleep(index);
        const observed = await registry.readActive(id);
        expect(observed?.instanceId).toBe(id);
      }),
    );
    const exitCode = await child.exited;
    await observations;
    if (exitCode !== 0) throw new Error(await new Response(child.stderr).text());

    const stored = await registry.readActive(id);
    expect(stored?.instanceId).toBe(id);
    expect(stored?.runId).toBe('child-29');
    expect((await readdir(join(root, 'active'))).filter((name) => name.endsWith('.tmp'))).toEqual(
      [],
    );
    if (process.platform !== 'win32') {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, 'active'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, 'history'))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, 'active', `${id}.json`))).mode & 0o777).toBe(0o600);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('active updates serialize heartbeat and lifecycle progress for one instance', async () => {
  const temporary = await temporaryDirectory();
  try {
    const registry = new NodeRunRegistry({ rootDir: join(temporary, 'runs') });
    const id = instanceId(1);
    await registry.writeActive(active(temporary, id));
    const lifecycleAt = new Date(BASE_TIME + 1_000).toISOString();
    const heartbeatAt = new Date(BASE_TIME + 2_000);
    const lifecycleUpdate = registry.updateActive(id, async (current) => {
      await Bun.sleep(15);
      return { ...current, lifecycle: 'running', updatedAt: lifecycleAt };
    });
    const heartbeatUpdate = registry.heartbeat(id, heartbeatAt);
    await Promise.all([lifecycleUpdate, heartbeatUpdate]);

    expect(await registry.readActive(id)).toMatchObject({
      lifecycle: 'running',
      heartbeatAt: heartbeatAt.toISOString(),
      updatedAt: heartbeatAt.toISOString(),
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('records and enumeration are bounded before parsing', async () => {
  expect(() =>
    decodeActiveRunRegistrationV1(' '.repeat(RUN_REGISTRY_RECORD_MAX_BYTES + 1)),
  ).toThrow('64 KiB');

  const temporary = await temporaryDirectory();
  try {
    const root = join(temporary, 'runs');
    const registry = new NodeRunRegistry({ rootDir: root });
    await registry.writeActive(active(temporary));
    const activeDir = join(root, 'active');
    const names = Array.from(
      { length: RUN_REGISTRY_MAX_ENTRIES },
      (_, index) => `invalid-${index}.json`,
    );
    for (let offset = 0; offset < names.length; offset += 100) {
      await Promise.all(
        names.slice(offset, offset + 100).map((name) => writeFile(join(activeDir, name), '{}')),
      );
    }
    const enumeration = await registry.enumerate();
    expect(enumeration.errors).toContainEqual(
      expect.objectContaining({ code: 'entry-limit-exceeded' }),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('readers refuse symlink and non-regular records without hiding healthy union entries', async () => {
  const temporary = await temporaryDirectory();
  try {
    const registry = new NodeRunRegistry({
      rootDir: join(temporary, 'runs'),
      now: () => new Date(BASE_TIME + 10_000),
    });
    const activeOnly = instanceId(1);
    const historyOnly = instanceId(2);
    const both = instanceId(3);
    await registry.writeActive(active(temporary, activeOnly));
    await registry.writeHistory(history(temporary, historyOnly));
    await registry.writeActive(active(temporary, both));
    await registry.writeHistory(history(temporary, both));

    const unsafeLink = instanceId(4);
    await symlink(
      join(registry.activeDir, `${activeOnly}.json`),
      join(registry.activeDir, `${unsafeLink}.json`),
    );
    const unsafeDirectory = instanceId(5);
    await mkdir(join(registry.historyDir, `${unsafeDirectory}.json`));

    const result = await registry.enumerate();
    expect(result.entries).toEqual([
      { instanceId: activeOnly, active: active(temporary, activeOnly) },
      { instanceId: historyOnly, history: history(temporary, historyOnly) },
      {
        instanceId: both,
        active: active(temporary, both),
        history: history(temporary, both),
      },
    ]);
    expect(result.errors.map((error) => [error.instanceIdHint, error.code])).toEqual([
      [unsafeLink, 'unsafe-entry'],
      [unsafeDirectory, 'unsafe-entry'],
    ]);
    expect((await lstat(join(registry.activeDir, `${unsafeLink}.json`))).isSymbolicLink()).toBe(
      true,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('filename identity mismatch is preserved as an independent enumeration error', async () => {
  const temporary = await temporaryDirectory();
  try {
    const registry = new NodeRunRegistry({
      rootDir: join(temporary, 'runs'),
      now: () => new Date(BASE_TIME + 10_000),
    });
    const fileId = instanceId(1);
    const recordId = instanceId(2);
    await registry.writeActive(active(temporary, fileId));
    await writeFile(
      join(registry.activeDir, `${fileId}.json`),
      encodeActiveRunRegistrationV1(active(temporary, recordId)),
      { mode: 0o600 },
    );
    const result = await registry.enumerate();
    expect(result.entries).toEqual([]);
    expect(result.errors).toMatchObject([{ code: 'filename-mismatch', instanceIdHint: fileId }]);
    expect(await readFile(join(registry.activeDir, `${fileId}.json`), 'utf8')).toContain(recordId);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('completeRun persists history before active removal and preserves both on unsafe cleanup', async () => {
  const temporary = await temporaryDirectory();
  try {
    const registry = new NodeRunRegistry({
      rootDir: join(temporary, 'runs'),
      now: () => new Date(BASE_TIME + 10_000),
    });
    const clean = instanceId(1);
    await registry.writeActive(active(temporary, clean));
    expect(await registry.completeRun(history(temporary, clean))).toEqual({ activeRemoved: true });
    expect(await registry.readActive(clean)).toBeUndefined();
    expect(await registry.readHistory(clean)).toEqual(history(temporary, clean));

    const unsafe = instanceId(2);
    await registry.writeActive(active(temporary, unsafe));
    await rm(join(registry.activeDir, `${unsafe}.json`));
    await mkdir(join(registry.activeDir, `${unsafe}.json`));
    await expect(registry.completeRun(history(temporary, unsafe))).rejects.toMatchObject<
      Partial<RunRegistryError>
    >({ code: 'unsafe-entry' });
    expect(await registry.readHistory(unsafe)).toEqual(history(temporary, unsafe));
    expect((await stat(join(registry.activeDir, `${unsafe}.json`))).isDirectory()).toBe(true);

    const mismatch = instanceId(3);
    await registry.writeActive(active(temporary, mismatch, { runId: 'active-run' }));
    const mismatchedHistory = history(temporary, mismatch, BASE_TIME + 1_000, {
      runId: 'different-run',
    });
    await expect(registry.completeRun(mismatchedHistory)).rejects.toMatchObject<
      Partial<RunRegistryError>
    >({ code: 'history-active-mismatch' });
    expect(await registry.readActive(mismatch)).toMatchObject({ runId: 'active-run' });
    expect(await registry.readHistory(mismatch)).toEqual(mismatchedHistory);
    await expect(
      registry.writeHistory({ ...mismatchedHistory, runId: 'replacement-run' }),
    ).rejects.toMatchObject<Partial<RunRegistryError>>({ code: 'history-conflict' });
    expect(await registry.readHistory(mismatch)).toEqual(mismatchedHistory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('explicit retention enforces 30 days and 500 records without touching unsafe evidence', async () => {
  const temporary = await temporaryDirectory();
  try {
    const now = BASE_TIME + RUN_HISTORY_MAX_AGE_MS + 10_000;
    const registry = new NodeRunRegistry({
      rootDir: join(temporary, 'runs'),
      now: () => new Date(now),
    });
    await registry.writeActive(active(temporary));
    const oldId = instanceId(1);
    const historyDir = registry.historyDir;
    await writeFile(
      join(historyDir, `${oldId}.json`),
      encodeRunHistoryRecordV1(history(temporary, oldId, BASE_TIME + 1_000)),
      { mode: 0o600 },
    );
    const currentIds = Array.from({ length: RUN_HISTORY_MAX_RECORDS + 1 }, (_, index) =>
      instanceId(index + 2),
    );
    for (let offset = 0; offset < currentIds.length; offset += 100) {
      await Promise.all(
        currentIds.slice(offset, offset + 100).map((id, index) => {
          const endedAt = now - 1_000 + offset + index;
          return writeFile(
            join(historyDir, `${id}.json`),
            encodeRunHistoryRecordV1(
              history(temporary, id, endedAt, {
                startedAt: new Date(endedAt - 1_000).toISOString(),
              }),
            ),
            { mode: 0o600 },
          );
        }),
      );
    }
    const unsafeId = instanceId(RUN_HISTORY_MAX_RECORDS + 3);
    await mkdir(join(historyDir, `${unsafeId}.json`));

    const result = await registry.pruneHistory(new Date(now));
    expect(result.removedInstanceIds).toHaveLength(2);
    expect(result.removedInstanceIds).toContain(oldId);
    expect(result.retainedRecords).toBe(RUN_HISTORY_MAX_RECORDS);
    expect(result.retainedBytes).toBeLessThanOrEqual(RUN_HISTORY_MAX_BYTES);
    expect(result.errors).toMatchObject([{ code: 'unsafe-entry', instanceIdHint: unsafeId }]);
    expect((await stat(join(historyDir, `${unsafeId}.json`))).isDirectory()).toBe(true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('explicit retention enforces the 8 MiB byte cap below the count limit', async () => {
  const temporary = await temporaryDirectory();
  try {
    const now = BASE_TIME + 100_000;
    const registry = new NodeRunRegistry({
      rootDir: join(temporary, 'runs'),
      now: () => new Date(now),
    });
    await registry.writeActive(active(temporary));
    const records = Array.from({ length: 129 }, (_, index) => {
      const id = instanceId(index + 1);
      const encoded = encodeRunHistoryRecordV1(history(temporary, id, BASE_TIME + index + 1));
      return {
        id,
        encoded: encoded + ' '.repeat(RUN_REGISTRY_RECORD_MAX_BYTES - Buffer.byteLength(encoded)),
      };
    });
    for (let offset = 0; offset < records.length; offset += 16) {
      await Promise.all(
        records
          .slice(offset, offset + 16)
          .map(({ id, encoded }) =>
            writeFile(join(registry.historyDir, `${id}.json`), encoded, { mode: 0o600 }),
          ),
      );
    }

    const result = await registry.pruneHistory(new Date(now));
    expect(result.removedInstanceIds).toEqual([records[0]!.id]);
    expect(result.retainedRecords).toBe(128);
    expect(result.retainedBytes).toBe(RUN_HISTORY_MAX_BYTES);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('advisory heartbeat service skips overlapping writes and contains failures', async () => {
  let concurrent = 0;
  let maximumConcurrent = 0;
  let writes = 0;
  let warnings = 0;
  const service = new AdvisoryHeartbeatService({
    intervalMs: 2,
    writeHeartbeat: async () => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      writes += 1;
      await Bun.sleep(12);
      concurrent -= 1;
      if (writes === 1) throw new Error('advisory failure must be contained');
    },
    onWarning: () => {
      warnings += 1;
    },
  });

  service.start();
  await Bun.sleep(40);
  await service.stop();
  expect(maximumConcurrent).toBe(1);
  expect(writes).toBeGreaterThanOrEqual(2);
  expect(warnings).toBe(1);
  expect(service.failureCount).toBe(1);
  expect(service.running).toBe(false);
});

test('independent publishers cannot replace immutable terminal history', async () => {
  const temporary = await temporaryDirectory();
  try {
    const root = join(temporary, 'runs');
    const options = { rootDir: root, now: () => new Date(BASE_TIME + 10_000) };
    const firstRegistry = new NodeRunRegistry(options);
    const secondRegistry = new NodeRunRegistry(options);
    const id = instanceId(77);
    const first = history(temporary, id, BASE_TIME + 1_000, { runId: 'first-run' });
    const second = history(temporary, id, BASE_TIME + 1_000, { runId: 'second-run' });

    const results = await Promise.allSettled([
      firstRegistry.writeHistory(first),
      secondRegistry.writeHistory(second),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toMatchObject<Partial<RunRegistryError>>({
      code: 'history-conflict',
    });
    const stored = await firstRegistry.readHistory(id);
    expect([first, second]).toContainEqual(stored);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('registry codecs reject newline, BEL, ESC, and OSC terminal controls', () => {
  const root = '/tmp/pinelive-control-codec';
  for (const unsafe of [
    'line\nbreak',
    'bell\u0007',
    '\u001b]0;title\u0007',
    '\u001b]52;c;Y2FuYXJ5\u0007',
    'c1\u009b31m',
  ]) {
    expect(() =>
      decodeActiveRunRegistrationV1(JSON.stringify({ ...active(root), runId: unsafe })),
    ).toThrow('without terminal controls');
  }
});
