export type ExecutionLeaseErrorCode = 'contended' | 'lost' | 'not-held';

export interface ExecutionLeaseSnapshot {
  resource: string;
  leaseId: string;
  ownerId: string;
  acquiredAt: string;
}

export class ExecutionLeaseError extends Error {
  constructor(
    readonly code: ExecutionLeaseErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ExecutionLeaseError';
  }
}

/**
 * Exclusive ownership gate for one execution namespace. Implementations must never silently steal
 * an existing lease. `assertHeld` is awaited immediately before every broker effect.
 */
export interface ExecutionLease {
  readonly resource: string;
  readonly ownerId: string;
  readonly snapshot: ExecutionLeaseSnapshot | undefined;
  acquire(): Promise<ExecutionLeaseSnapshot>;
  assertHeld(): void | Promise<void>;
  release(): Promise<void>;
}

export interface InMemoryExecutionLeaseOptions {
  ownerId?: string;
  leaseId?: string;
  now?: () => number;
}

const memoryLeases = new Map<string, ExecutionLeaseSnapshot>();
let memoryLeaseSequence = 0;

/** Deterministic process-local implementation used by offline orchestration and tests. */
export class InMemoryExecutionLease implements ExecutionLease {
  readonly ownerId: string;
  private value?: ExecutionLeaseSnapshot;
  private readonly leaseId: string;
  private readonly now: () => number;

  constructor(
    readonly resource: string,
    options: InMemoryExecutionLeaseOptions = {},
  ) {
    if (!resource) throw new RangeError('execution lease resource must not be empty');
    this.ownerId = options.ownerId ?? 'local';
    this.leaseId = options.leaseId ?? `memory-${++memoryLeaseSequence}`;
    this.now = options.now ?? Date.now;
    if (!this.ownerId) throw new RangeError('execution lease ownerId must not be empty');
    if (!this.leaseId) throw new RangeError('execution lease leaseId must not be empty');
  }

  get snapshot(): ExecutionLeaseSnapshot | undefined {
    return this.value ? { ...this.value } : undefined;
  }

  async acquire(): Promise<ExecutionLeaseSnapshot> {
    if (this.value) {
      await this.assertHeld();
      return { ...this.value };
    }
    const existing = memoryLeases.get(this.resource);
    if (existing)
      throw new ExecutionLeaseError(
        'contended',
        `execution lease is already held for ${this.resource}`,
      );
    const timestamp = this.now();
    if (!Number.isFinite(timestamp)) throw new Error('execution lease clock is not finite');
    const snapshot = {
      resource: this.resource,
      leaseId: this.leaseId,
      ownerId: this.ownerId,
      acquiredAt: new Date(timestamp).toISOString(),
    };
    memoryLeases.set(this.resource, snapshot);
    this.value = snapshot;
    return { ...snapshot };
  }

  assertHeld(): void {
    if (!this.value)
      throw new ExecutionLeaseError('not-held', `execution lease is not held for ${this.resource}`);
    const current = memoryLeases.get(this.resource);
    if (!current || current.leaseId !== this.value.leaseId || current.ownerId !== this.ownerId)
      throw new ExecutionLeaseError('lost', `execution lease was lost for ${this.resource}`);
  }

  async release(): Promise<void> {
    if (!this.value) return;
    this.assertHeld();
    memoryLeases.delete(this.resource);
    this.value = undefined;
  }
}

export type Lease = ExecutionLease;
export const LeaseError = ExecutionLeaseError;
