import type { ReconcileError } from './mirror.js';
import type { SecurityFeedHealth } from './security.js';
import type { Bar, Fill, OrderRequest } from './types.js';
import type { RunInstrumentBinding } from './binding.js';

export type ReconcileAction = 'noop' | 'order' | 'reject';

export interface BindingRecord {
  schemaVersion: 2;
  recordType: 'binding';
  configVersion: 1;
  runId: string;
  binding: RunInstrumentBinding;
  recordedAt: string;
}

/** Current cycle schema. schemaVersion 1 remains readable through optional identity fields. */
export interface ForwardRecord {
  schemaVersion: 1 | 2;
  recordType?: 'cycle';
  runId: string;
  strategyId: string;
  cycleId: string;
  sequence: number;
  /** v1 compatibility alias for strategySymbol. */
  symbol: string;
  strategySymbol?: string;
  executionSymbol?: string;
  bindingId?: string;
  timeframe: string;
  bar: Bar;
  target: number;
  actualBefore: number | null;
  actualAfter: number | null;
  delta: number | null;
  action: ReconcileAction;
  clientId?: string;
  /** Full requested economics for execution audit, including limitPrice when applicable. */
  order?: OrderRequest;
  fill?: Fill;
  error?: ReconcileError;
  /** Health of every injected request.security feed at this decision point. */
  securityFeeds?: SecurityFeedHealth[];
  recordedAt: string;
}

/** Durable feed-health event emitted before a stale feed can stop reconciliation. */
export interface SecurityFeedHealthRecord {
  schemaVersion: 2;
  recordType: 'security';
  runId: string;
  strategyId: string;
  key: string;
  error: string;
  feeds: SecurityFeedHealth[];
  recordedAt: string;
}

export interface StartupRecord extends Omit<ForwardRecord, 'recordType' | 'schemaVersion'> {
  schemaVersion: 2;
  recordType: 'startup';
}

export type LedgerRecord = BindingRecord | ForwardRecord | StartupRecord | SecurityFeedHealthRecord;

export interface LedgerSink {
  append(record: LedgerRecord): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export class MemoryLedger implements LedgerSink {
  readonly records: ForwardRecord[] = [];
  readonly bindings: BindingRecord[] = [];
  readonly startups: StartupRecord[] = [];
  readonly security: SecurityFeedHealthRecord[] = [];
  async append(record: LedgerRecord): Promise<void> {
    const cloned = structuredClone(record);
    if (cloned.recordType === 'binding') this.bindings.push(cloned);
    else if (cloned.recordType === 'startup') this.startups.push(cloned);
    else if (cloned.recordType === 'security') this.security.push(cloned);
    else this.records.push(cloned);
  }
}
