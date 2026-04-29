// Reconciliation module — public API surface

export type {
  SyncEvent,
  IReconciliationEventStoreAdapter,
  UpstreamSnapshot,
} from './event-store-adapter';

export type { ConflictRecord } from './conflict-record';
export type { IConflictArchive } from './conflict-archive';

export type {
  MatchedOutcome,
  ConflictOutcome,
  AppliedOutcome,
  ErrorOutcome,
  ReconciliationOutcome,
} from './reconciliation-result';

export type {
  ReconciliationServiceOptions,
  EventMatcher,
  IReconciliationService,
} from './reconciliation-service';

export {
  defaultEventMatcher,
  createReconciliationService,
} from './reconciliation-service';
