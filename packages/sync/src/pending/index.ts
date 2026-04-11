// Pending event lifecycle — public API surface

export type {
  ConfirmedOutcome,
  SupersededOutcome,
  NewOutcome,
  AlreadyConfirmedOutcome,
  ErrorOutcome,
  ReconciliationResult,
} from './reconciliation-result';

export {
  type AuthoritativeEvent,
  type EventMatcher,
  defaultEventMatcher,
  ReconciliationDispatcher,
} from './reconciliation-dispatcher';

export {
  type EventApplier,
  type RebuildResult,
  rebuildFromConfirmed,
} from './aggregate-rebuilder';

export {
  type ProducedEvent,
  createPendingEvents,
} from './pending-event-factory';
