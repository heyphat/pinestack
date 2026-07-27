import type { ReconcileError } from './mirror.js';
import type { Bar, Fill } from './types.js';

export type ReconcileAction = 'noop' | 'order' | 'reject';

export interface ForwardRecord {
  schemaVersion: 1;
  runId: string;
  strategyId: string;
  cycleId: string;
  sequence: number;
  symbol: string;
  timeframe: string;
  bar: Bar;
  target: number;
  actualBefore: number | null;
  actualAfter: number | null;
  delta: number | null;
  action: ReconcileAction;
  clientId?: string;
  fill?: Fill;
  error?: ReconcileError;
  recordedAt: string;
}

export interface LedgerSink {
  append(record: ForwardRecord): Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

export class MemoryLedger implements LedgerSink {
  readonly records: ForwardRecord[] = [];
  async append(record: ForwardRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}
