export type { BarUpdateValidationOptions } from './validation.js';
export {
  BarUpdateValidator,
  DEFAULT_FINAL_DEDUPE_BARS,
  DEFAULT_MAX_FORMING_BARS,
  equivalentFinalBarUpdate,
  liveTimeframeSeconds,
  snapshotLiveSourcePolicy,
  validateBarUpdate,
} from './validation.js';
export type { ExactChildAggregationOptions, ExactChildBucket } from './aggregation.js';
export { ExactChildBarAggregator, aggregateExactChildBarUpdates } from './aggregation.js';
export type { RecoverLiveBarUpdatesOptions } from './recovery.js';
export { recoverLiveBarUpdates } from './recovery.js';
export type { BufferLiveBarUpdatesOptions, ConformLiveBarUpdatesOptions } from './stream.js';
export {
  DEFAULT_LIVE_TEARDOWN_TIMEOUT_MS,
  DEFAULT_MAX_PENDING_FINALS,
  LiveBarUpdateBuffer,
  bufferLiveBarUpdates,
  conformLiveBarUpdates,
} from './stream.js';
