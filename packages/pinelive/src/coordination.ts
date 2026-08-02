import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, open, readFile, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { CanonicalAccountIdentity } from './core/broker.js';
import {
  ExecutionLeaseError,
  type ExecutionLease,
  type ExecutionLeaseSnapshot,
} from './core/lease.js';

const execFileAsync = promisify(execFile);

export interface BootBoundProcessIdentity {
  readonly kind: 'darwin-start-time' | 'linux-start-ticks';
  readonly value: string;
  readonly bootIdentityHash: string;
}

export type ProcessOwnerProbe =
  | { readonly state: 'matching'; readonly identity: BootBoundProcessIdentity }
  | { readonly state: 'dead'; readonly reason: string }
  | { readonly state: 'alive-unverified'; readonly reason: string }
  | { readonly state: 'permission-denied'; readonly reason: string }
  | { readonly state: 'unsupported'; readonly reason: string };

export interface LeaseOwnerEvidence {
  readonly pid: number;
  readonly processIdentity?: BootBoundProcessIdentity;
}

/** Obtain a boot-bound process identity on Linux or macOS; unsupported platforms return undefined. */
export async function readBootBoundProcessIdentity(
  pid = process.pid,
): Promise<BootBoundProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('process pid is invalid');
  if (process.platform === 'linux') {
    try {
      const [bootId, stat] = await Promise.all([
        readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        readFile(`/proc/${pid}/stat`, 'utf8'),
      ]);
      const close = stat.lastIndexOf(')');
      if (close < 0) return undefined;
      // Fields after comm start at field 3; starttime is field 22, therefore index 19 here.
      const fields = stat
        .slice(close + 2)
        .trim()
        .split(/\s+/);
      const startTicks = fields[19];
      if (!startTicks || !/^\d+$/.test(startTicks)) return undefined;
      return {
        kind: 'linux-start-ticks',
        value: startTicks,
        bootIdentityHash: sha256(`pinelive-boot-v1\0${bootId.trim()}`),
      };
    } catch {
      return undefined;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const [{ stdout: started }, { stdout: boot }] = await Promise.all([
        execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
          timeout: 2_000,
          maxBuffer: 16_384,
        }),
        execFileAsync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
          timeout: 2_000,
          maxBuffer: 16_384,
        }),
      ]);
      const value = started.trim();
      const bootValue = boot.trim();
      if (!value || !bootValue) return undefined;
      return {
        kind: 'darwin-start-time',
        value,
        bootIdentityHash: sha256(`pinelive-boot-v1\0${bootValue}`),
      };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Conservative process-owner probe. PID reuse is detected by the boot-bound identity. */
export async function probeProcessOwner(evidence: LeaseOwnerEvidence): Promise<ProcessOwnerProbe> {
  if (!Number.isSafeInteger(evidence.pid) || evidence.pid <= 0)
    return { state: 'alive-unverified', reason: 'claim contains an invalid pid' };
  try {
    process.kill(evidence.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { state: 'dead', reason: 'recorded pid does not exist' };
    if (code === 'EPERM')
      return { state: 'permission-denied', reason: 'recorded pid exists but cannot be inspected' };
    return { state: 'alive-unverified', reason: 'process probe failed' };
  }
  if (!evidence.processIdentity)
    return { state: 'alive-unverified', reason: 'claim has no boot-bound process identity' };
  const current = await readBootBoundProcessIdentity(evidence.pid);
  if (!current)
    return { state: 'unsupported', reason: 'boot-bound process identity is unavailable' };
  if (
    current.kind !== evidence.processIdentity.kind ||
    current.value !== evidence.processIdentity.value ||
    current.bootIdentityHash !== evidence.processIdentity.bootIdentityHash
  ) {
    return { state: 'dead', reason: 'pid now belongs to a different process instance' };
  }
  return { state: 'matching', identity: current };
}

export interface AccountInstrumentClaimResource {
  readonly identity: CanonicalAccountIdentity;
  readonly executionSymbol: string;
}

export interface NodeAccountInstrumentClaimOptions {
  readonly root?: string;
  readonly ownerId?: string;
  readonly claimId?: string;
  readonly now?: () => number;
  readonly processIdentity?: () => Promise<BootBoundProcessIdentity | undefined>;
}

export interface AccountInstrumentClaimSnapshot extends ExecutionLeaseSnapshot {
  readonly resourceDigest: string;
  readonly accountDigest: string;
  readonly instrumentDigest: string;
  readonly path: string;
}

interface AccountClaimFile {
  readonly claimVersion: 1;
  readonly kind: 'account-instrument';
  readonly resourceDigest: string;
  readonly accountDigest: string;
  readonly instrumentDigest: string;
  readonly claimId: string;
  readonly ownerId: string;
  readonly acquiredAt: string;
  readonly pid: number;
  readonly processIdentity?: BootBoundProcessIdentity;
}

/** Same-host cooperative account/exact-instrument exclusion. Existing files are never stolen. */
export class NodeAccountInstrumentClaim implements ExecutionLease {
  readonly path: string;
  readonly resource: string;
  readonly ownerId: string;
  readonly resourceDigest: string;
  readonly accountDigest: string;
  readonly instrumentDigest: string;
  private readonly claimId: string;
  private readonly now: () => number;
  private readonly processIdentity: () => Promise<BootBoundProcessIdentity | undefined>;
  private handle?: FileHandle;
  private value?: AccountInstrumentClaimSnapshot;

  constructor(
    resource: AccountInstrumentClaimResource,
    options: NodeAccountInstrumentClaimOptions = {},
  ) {
    validateAccountIdentity(resource.identity);
    if (!resource.executionSymbol.trim())
      throw new RangeError('account claim execution symbol must not be empty');
    const root = options.root ?? join(homedir(), '.pinelive', 'claims');
    this.accountDigest = sha256(
      `pinelive-account-claim-account-v1\0${canonical(resource.identity)}`,
    );
    this.instrumentDigest = sha256(
      `pinelive-account-claim-instrument-v1\0${canonical({
        accountDigest: this.accountDigest,
        executionSymbol: resource.executionSymbol,
      })}`,
    );
    this.resourceDigest = `sha256-${sha256(
      `pinelive-account-claim-resource-v1\0${this.accountDigest}\0${this.instrumentDigest}`,
    )}`;
    this.path = join(root, this.accountDigest, `${this.instrumentDigest}.lock`);
    this.resource = this.resourceDigest;
    this.ownerId = options.ownerId ?? `instance:${randomUUID()}`;
    this.claimId = options.claimId ?? randomUUID();
    this.now = options.now ?? Date.now;
    this.processIdentity = options.processIdentity ?? (() => readBootBoundProcessIdentity());
    if (!this.ownerId) throw new RangeError('account claim ownerId must not be empty');
    if (!this.claimId) throw new RangeError('account claim claimId must not be empty');
  }

  get snapshot(): AccountInstrumentClaimSnapshot | undefined {
    return this.value ? { ...this.value } : undefined;
  }

  async acquire(): Promise<AccountInstrumentClaimSnapshot> {
    if (this.value) {
      await this.assertHeld();
      return { ...this.value };
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    let handle: FileHandle;
    try {
      handle = await open(this.path, 'wx+', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new ExecutionLeaseError(
          'contended',
          `account/instrument claim is already held for ${this.resourceDigest}`,
          { cause: error },
        );
      throw error;
    }
    const timestamp = this.now();
    if (!Number.isFinite(timestamp)) {
      await handle.close().catch(() => undefined);
      await unlink(this.path).catch(() => undefined);
      throw new Error('account claim clock is not finite');
    }
    const acquiredAt = new Date(timestamp).toISOString();
    const processIdentity = await this.processIdentity();
    const body: AccountClaimFile = {
      claimVersion: 1,
      kind: 'account-instrument',
      resourceDigest: this.resourceDigest,
      accountDigest: this.accountDigest,
      instrumentDigest: this.instrumentDigest,
      claimId: this.claimId,
      ownerId: this.ownerId,
      acquiredAt,
      pid: process.pid,
      ...(processIdentity ? { processIdentity } : {}),
    };
    try {
      await chmod(this.path, 0o600);
      await handle.writeFile(`${JSON.stringify(body)}\n`, 'utf8');
      await handle.datasync();
      this.handle = handle;
      this.value = {
        resource: this.resource,
        resourceDigest: this.resourceDigest,
        accountDigest: this.accountDigest,
        instrumentDigest: this.instrumentDigest,
        leaseId: this.claimId,
        ownerId: this.ownerId,
        acquiredAt,
        path: this.path,
      };
      return { ...this.value };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(this.path).catch(() => undefined);
      throw error;
    }
  }

  async assertHeld(): Promise<void> {
    if (!this.value || !this.handle)
      throw new ExecutionLeaseError('not-held', `account claim is not held for ${this.resource}`);
    let body: AccountClaimFile;
    try {
      body = JSON.parse(await readFile(this.path, 'utf8')) as AccountClaimFile;
    } catch (error) {
      throw new ExecutionLeaseError('lost', `account claim was lost for ${this.resource}`, {
        cause: error,
      });
    }
    if (
      body.claimVersion !== 1 ||
      body.kind !== 'account-instrument' ||
      body.resourceDigest !== this.resourceDigest ||
      body.claimId !== this.claimId ||
      body.ownerId !== this.ownerId
    )
      throw new ExecutionLeaseError('lost', `account claim owner changed for ${this.resource}`);
  }

  async release(): Promise<void> {
    if (!this.value) return;
    await this.assertHeld();
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
    const body = JSON.parse(await readFile(this.path, 'utf8')) as AccountClaimFile;
    if (body.claimId !== this.claimId || body.ownerId !== this.ownerId)
      throw new ExecutionLeaseError(
        'lost',
        `account claim owner changed before release for ${this.resource}`,
      );
    await unlink(this.path);
    this.value = undefined;
  }
}

export function createNodeAccountInstrumentClaim(
  resource: AccountInstrumentClaimResource,
  options?: NodeAccountInstrumentClaimOptions,
): NodeAccountInstrumentClaim {
  return new NodeAccountInstrumentClaim(resource, options);
}

function validateAccountIdentity(identity: CanonicalAccountIdentity): void {
  if (
    identity.identityVersion !== 1 ||
    !identity.brokerId.trim() ||
    !identity.opaqueAccountId.trim() ||
    (identity.environment != null && !identity.environment.trim())
  )
    throw new RangeError('canonical account identity is invalid');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`)
    .join(',')}}`;
}
