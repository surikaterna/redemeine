// Envelope types
export type {
  EnvelopeMetadata,
  UpstreamEvent,
  CommandOnlyEnvelope,
  CommandWithEventsEnvelope,
  EventsOnlyEnvelope,
  SyncEnvelope,
} from './envelopes';

// Runtime interfaces
export type {
  CommandHandler,
  ConflictContext,
  ConflictDecision,
  ConflictResolver,
  AggregateRegistration,
} from './runtime';

// Adapter contracts
export type {
  AuditSignal,
  IIdempotencyStore,
  IOrderingStore,
  IAuditSink,
} from './adapters';

// Batch result types
export type {
  AcceptedResult,
  DuplicateResult,
  RejectedResult,
  ConflictResolvedResult,
  EnvelopeResult,
  BatchResult,
} from './batch-result';

// Runtime options
export type {
  AggregateInstance,
  IDepot,
  AggregateRuntimeOptions,
} from './options';

// Error codes and error class (value exports)
export { SyncErrorCode, SyncRuntimeError } from './errors';
