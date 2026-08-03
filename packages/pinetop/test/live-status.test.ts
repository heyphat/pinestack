import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  LiveStatusPoller,
  LiveStatusProtocolError,
  parsePineliveStatusList,
  resolvePineliveBin,
  type LiveStatusChild,
  type LiveStatusPollEvent,
  type LiveStatusSpawn,
} from '../src/run/live-status.js';
import { liveSnapshot } from './fixtures/live-status.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  closeOnTerm = false;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (signal === 'SIGTERM' && this.closeOnTerm)
      queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }

  close(code = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }

  fail(message = 'spawn failed'): void {
    this.emit('error', new Error(message));
  }
}

const asChild = (child: FakeChild): LiveStatusChild => child as unknown as LiveStatusChild;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function eventsOf(poller: LiveStatusPoller): LiveStatusPollEvent[] {
  const events: LiveStatusPollEvent[] = [];
  poller.subscribe((event) => events.push(event));
  return events;
}

describe('dependency-light Pinelive status validation', () => {
  test('accepts and normalizes a statusListVersion 1 snapshot', () => {
    const parsed = parsePineliveStatusList(JSON.stringify(liveSnapshot()));
    expect(parsed.statusListVersion).toBe(1);
    expect(parsed.items).toHaveLength(3);
    expect(parsed.items[0]!.ok).toBe(true);
  });

  test('rejects invalid JSON and unsupported envelopes with typed errors', () => {
    expect(() => parsePineliveStatusList('{')).toThrow(LiveStatusProtocolError);
    try {
      parsePineliveStatusList({
        statusListVersion: 2,
        generatedAt: new Date().toISOString(),
        items: [],
      });
      throw new Error('expected parse failure');
    } catch (error) {
      expect(error).toBeInstanceOf(LiveStatusProtocolError);
      expect((error as LiveStatusProtocolError).code).toBe('invalid-envelope');
    }
  });

  test('isolates malformed nested entries instead of exposing unsafe values to the renderer', () => {
    const parsed = parsePineliveStatusList({
      statusListVersion: 1,
      generatedAt: '2026-08-01T12:00:00.000Z',
      items: [
        { ok: true, value: { discoveryVersion: 1, kind: 'active', instanceId: 'a'.repeat(32) } },
      ],
    });
    expect(parsed.items).toEqual([
      {
        ok: false,
        instanceIdHint: 'a'.repeat(32),
        error: {
          code: 'invalid-status-item',
          message: 'aggregate status item 1 is malformed',
        },
      },
    ]);
  });

  test('resolves explicit binary, then PINELIVE_BIN, then PATH fallback', () => {
    expect(
      resolvePineliveBin({ bin: '/opt/pinelive', env: { PINELIVE_BIN: '/env/pinelive' } }),
    ).toBe('/opt/pinelive');
    expect(resolvePineliveBin({ env: { PINELIVE_BIN: '/env/pinelive' } })).toBe('/env/pinelive');
    expect(resolvePineliveBin({ env: {} })).toBe('pinelive');
  });
});

describe('bounded LIVE polling', () => {
  test('spawns exactly `pinelive status --all --json` and emits a snapshot', async () => {
    const child = new FakeChild();
    let invocation: { bin: string; argv: readonly string[] } | undefined;
    const spawn: LiveStatusSpawn = (bin, argv) => {
      invocation = { bin, argv };
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify(liveSnapshot()));
        child.close(0);
      });
      return asChild(child);
    };
    const poller = new LiveStatusPoller({ bin: '/custom/pinelive', spawn });
    const events = eventsOf(poller);

    expect(await poller.poll()).toBe(true);
    expect(invocation).toEqual({
      bin: '/custom/pinelive',
      argv: ['status', '--all', '--json'],
    });
    expect(events.map((event) => event.type)).toEqual(['started', 'snapshot']);
    await poller.dispose();
  });

  test('refuses overlapping polls', async () => {
    const child = new FakeChild();
    let spawns = 0;
    const poller = new LiveStatusPoller({
      spawn: () => {
        spawns += 1;
        return asChild(child);
      },
      deadlineMs: 1_000,
    });
    const first = poller.poll();
    await tick();
    expect(await poller.poll()).toBe(false);
    expect(spawns).toBe(1);
    child.stdout.end(JSON.stringify(liveSnapshot()));
    child.close(0);
    await first;
    await poller.dispose();
  });

  test('times out, sends TERM, then sends bounded KILL when the child does not exit', async () => {
    const child = new FakeChild();
    const poller = new LiveStatusPoller({
      spawn: () => asChild(child),
      deadlineMs: 5,
      terminateGraceMs: 5,
    });
    const events = eventsOf(poller);

    await poller.poll();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'timeout' } });
    await poller.dispose();
  });

  test('bounds stdout and stderr independently', async () => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const child = new FakeChild();
      child.closeOnTerm = true;
      const poller = new LiveStatusPoller({
        spawn: () => {
          queueMicrotask(() => child[stream].write('x'.repeat(17)));
          return asChild(child);
        },
        maxStdoutBytes: 16,
        maxStderrBytes: 16,
        deadlineMs: 1_000,
      });
      const events = eventsOf(poller);
      await poller.poll();
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        error: { code: stream === 'stdout' ? 'stdout-too-large' : 'stderr-too-large' },
      });
      expect(child.signals).toEqual(['SIGTERM']);
      await poller.dispose();
    }
  });

  test('normalizes spawn failure, nonzero exit, empty output, and invalid JSON', async () => {
    const cases: Array<{
      code: string;
      act: (child: FakeChild) => void;
    }> = [
      { code: 'spawn-failed', act: (child) => child.fail() },
      { code: 'nonzero-exit', act: (child) => child.close(2) },
      { code: 'empty-output', act: (child) => child.close(0) },
      {
        code: 'invalid-json',
        act: (child) => {
          child.stdout.end('{');
          child.close(0);
        },
      },
    ];
    for (const entry of cases) {
      const child = new FakeChild();
      const poller = new LiveStatusPoller({
        spawn: () => {
          queueMicrotask(() => entry.act(child));
          return asChild(child);
        },
      });
      const events = eventsOf(poller);
      await poller.poll();
      expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: entry.code } });
      await poller.dispose();
    }
  });

  test('disposal terminates an active child and suppresses its stale result', async () => {
    const child = new FakeChild();
    const poller = new LiveStatusPoller({
      spawn: () => asChild(child),
      deadlineMs: 1_000,
      terminateGraceMs: 5,
    });
    const events = eventsOf(poller);
    const active = poller.poll();
    await tick();
    await poller.dispose();
    await active;

    child.stdout.end(JSON.stringify(liveSnapshot()));
    child.close(0);
    expect(events.map((event) => event.type)).toEqual(['started']);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('start polls immediately and disposal clears the cadence before another spawn', async () => {
    let spawns = 0;
    const poller = new LiveStatusPoller({
      cadenceMs: 20,
      spawn: () => {
        spawns += 1;
        const child = new FakeChild();
        queueMicrotask(() => {
          child.stdout.end(JSON.stringify(liveSnapshot()));
          child.close(0);
        });
        return asChild(child);
      },
    });
    poller.start();
    await tick();
    await poller.dispose();
    await Bun.sleep(30);
    expect(spawns).toBe(1);
  });
});

test('durable ledger normalization enforces schema, byte, and empty-ledger invariants', () => {
  const malformed = [
    (snapshot: ReturnType<typeof liveSnapshot>) => {
      const item = snapshot.items[0]!;
      if (item.ok && item.value.kind === 'active')
        delete (item.value.durable.ledger as { ledgerSchemaVersion?: 3 }).ledgerSchemaVersion;
    },
    (snapshot: ReturnType<typeof liveSnapshot>) => {
      const item = snapshot.items[0]!;
      if (item.ok && item.value.kind === 'active')
        (item.value.durable.ledger as { validBytes: number }).validBytes = 5_000;
    },
    (snapshot: ReturnType<typeof liveSnapshot>) => {
      const item = snapshot.items[0]!;
      if (item.ok && item.value.kind === 'active') {
        Object.assign(item.value.durable.ledger, {
          bytes: 0,
          validBytes: 0,
          partialTail: true,
        });
        delete (item.value.durable.ledger as { lastSequence?: number }).lastSequence;
        delete (item.value.durable.ledger as { lastRecordAt?: string }).lastRecordAt;
      }
    },
  ];
  for (const mutate of malformed) {
    const snapshot = structuredClone(liveSnapshot());
    mutate(snapshot);
    expect(parsePineliveStatusList(snapshot).items[0]).toMatchObject({
      ok: false,
      error: { code: 'invalid-status-item' },
    });
  }

  const empty = structuredClone(liveSnapshot());
  const item = empty.items[0]!;
  if (!item.ok || item.value.kind !== 'active') throw new Error('expected active fixture');
  Object.assign(item.value.durable.ledger, { bytes: 0, validBytes: 0, partialTail: false });
  delete (item.value.durable.ledger as { ledgerSchemaVersion?: 3 }).ledgerSchemaVersion;
  delete (item.value.durable.ledger as { lastSequence?: number }).lastSequence;
  delete (item.value.durable.ledger as { lastRecordAt?: string }).lastRecordAt;
  expect(parsePineliveStatusList(empty).items[0]).toMatchObject({ ok: true });
});

test('per-entry normalization rejects newline, BEL, ESC, OSC, and C1 controls', () => {
  for (const unsafe of [
    'line\nbreak',
    'bell\u0007',
    '\u001b]0;title\u0007',
    '\u001b]52;c;Y2FuYXJ5\u0007',
    'c1\u009b31m',
  ]) {
    const snapshot = {
      ...liveSnapshot(),
      items: [
        {
          ok: false as const,
          path: '/tmp/unsafe.json',
          error: { code: 'corrupt-record', message: unsafe },
        },
      ],
    };
    expect(parsePineliveStatusList(snapshot).items[0]).toMatchObject({
      ok: false,
      error: { code: 'invalid-status-item' },
    });
    expect(JSON.stringify(parsePineliveStatusList(snapshot))).not.toContain(unsafe);
  }
});
