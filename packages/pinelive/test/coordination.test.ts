import { expect, test } from 'bun:test';
import {
  probeProcessOwner,
  readBootBoundProcessIdentity,
  type BootBoundProcessIdentity,
} from '../src/coordination.js';
import { validateActiveRunRegistrationV1 } from '../src/run-registry.js';

// The probe is the evidence source for recovery's dead-owner proof, so its failure
// direction matters more than its accuracy: `dead` must never be reachable without
// a same-scheme identity comparison. These tests run against the real platform
// identity of this test process.

const current = await readBootBoundProcessIdentity(process.pid);

test.if(current != null)('a live process with its own recorded identity is matching', async () => {
  const probe = await probeProcessOwner({ pid: process.pid, processIdentity: current! });
  expect(probe).toEqual({ state: 'matching', identity: current! });
});

test.if(current != null)(
  'an identity-scheme mismatch is unverifiable, never proof of death',
  async () => {
    // Evidence recorded under a different scheme: an older release's kind, or a
    // record written on another platform. Neither can prove this pid died.
    const foreignKinds: BootBoundProcessIdentity['kind'][] = (
      ['darwin-boot-session', 'darwin-start-time', 'linux-start-ticks'] as const
    ).filter((kind) => kind !== current!.kind);
    for (const kind of foreignKinds) {
      const probe = await probeProcessOwner({
        pid: process.pid,
        processIdentity: { ...current!, kind },
      });
      expect(probe.state).toBe('alive-unverified');
      expect(probe.state).not.toBe('dead');
    }
  },
);

test.if(current != null)(
  'a same-scheme boot-hash mismatch still proves a different process instance',
  async () => {
    const flippedHash = current!.bootIdentityHash.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    const probe = await probeProcessOwner({
      pid: process.pid,
      processIdentity: { ...current!, bootIdentityHash: flippedHash },
    });
    expect(probe).toEqual({
      state: 'dead',
      reason: 'pid now belongs to a different process instance',
    });
  },
);

test.if(current != null)('a same-scheme start-value mismatch proves pid reuse', async () => {
  const probe = await probeProcessOwner({
    pid: process.pid,
    processIdentity: { ...current!, value: `${current!.value}-not-this-process` },
  });
  expect(probe.state).toBe('dead');
});

test('evidence without a boot-bound identity stays unverifiable', async () => {
  const probe = await probeProcessOwner({ pid: process.pid });
  expect(probe).toEqual({
    state: 'alive-unverified',
    reason: 'claim has no boot-bound process identity',
  });
});

test.if(process.platform === 'darwin')(
  'darwin identity uses the per-boot session uuid and is stable across reads',
  async () => {
    // kern.boottime is derived from the wall clock, so NTP adjustments changed it
    // without a reboot and made live owners probe as dead. The session uuid only
    // changes on an actual reboot.
    expect(current).toBeDefined();
    expect(current!.kind).toBe('darwin-boot-session');
    expect(current!.bootIdentityHash).toMatch(/^[a-f0-9]{64}$/);
    const again = await readBootBoundProcessIdentity(process.pid);
    expect(again).toEqual(current!);
  },
);

test('registry records decode both the current and the legacy identity kinds', () => {
  const base = {
    registrationVersion: 1,
    instanceId: 'a'.repeat(32),
    pid: 12_345,
    lifecycle: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    heartbeatAt: '2026-01-01T00:00:05.000Z',
    updatedAt: '2026-01-01T00:00:05.000Z',
    configVersion: 3,
    brokerId: 'compute-only',
    posture: 'compute-only',
    paths: { ledger: '/tmp/ledger.jsonl' },
  };
  for (const kind of ['darwin-boot-session', 'darwin-start-time', 'linux-start-ticks']) {
    const record = validateActiveRunRegistrationV1({
      ...base,
      processIdentity: { kind, value: 'x', bootIdentityHash: 'a'.repeat(64) },
    });
    expect(record.processIdentity?.kind).toBe(kind as BootBoundProcessIdentity['kind']);
  }
  expect(() =>
    validateActiveRunRegistrationV1({
      ...base,
      processIdentity: {
        kind: 'windows-create-time',
        value: 'x',
        bootIdentityHash: 'a'.repeat(64),
      },
    }),
  ).toThrow('process identity kind');
});
