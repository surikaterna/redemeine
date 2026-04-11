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

// Validation
export { validateEnvelope } from './validation';
export type { ValidationResult } from './validation';

// Registration resolver
export { createRegistrationResolver } from './registration-resolver';
export type { RegistrationResolver } from './registration-resolver';

// Batch processor
export { createAggregateRuntimeProcessor } from './processor';
export type { AggregateRuntimeProcessor } from './processor';
