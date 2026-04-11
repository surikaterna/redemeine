/**
 * Core batch processor for the aggregate sync runtime.
 * Processes command-only and command_with_events envelopes through
 * the aggregate lifecycle: validate → resolve → idempotency → sequence → hydrate → dispatch → save.
 * For command_with_events, delegates conflict resolution to per-aggregate plugins.
 */

import type { SyncEnvelope, CommandOnlyEnvelope, CommandWithEventsEnvelope } from './envelopes';
import type { AggregateRegistration } from './runtime';
import type { IAuditSink } from './adapters';
import type { BatchResult, EnvelopeResult } from './batch-result';
import type { AggregateRuntimeOptions, AggregateInstance, IDepot } from './options';
import { SyncErrorCode } from './errors';
import { validateEnvelope, type ValidationResult } from './validation';
import { createRegistrationResolver, type RegistrationResolver } from './registration-resolver';
import { createSequenceEnforcer, type SequenceEnforcer } from './sequence-enforcer';
import { handleConflict } from './conflict-handler';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Stateless batch processor for sync envelopes.
 * All state comes from adapter contracts — the processor itself holds none.
 */
export type AggregateRuntimeProcessor = {
  processBatch(envelopes: ReadonlyArray<SyncEnvelope>): Promise<BatchResult>;
};

// ---------------------------------------------------------------------------
// Envelope processing helpers
// ---------------------------------------------------------------------------

type InvalidResult = { readonly valid: false; readonly code: SyncErrorCode; readonly reason: string };

function isInvalidResult(result: ValidationResult): result is InvalidResult {
  return !result.valid;
}

function rejectEnvelope(envelopeId: string, reason: string): EnvelopeResult {
  return { status: 'rejected', envelopeId, reason };
}

function buildFailedBatch(
  results: ReadonlyArray<EnvelopeResult>,
  total: number,
  failedAtIndex: number,
  ingestedAt: string,
): BatchResult {
  return {
    status: 'failed',
    processed: failedAtIndex,
    total,
    failedAtIndex,
    results,
    ingestedAt,
  };
}

function buildCompletedBatch(
  results: ReadonlyArray<EnvelopeResult>,
  total: number,
  ingestedAt: string,
): BatchResult {
  return {
    status: 'completed',
    processed: total,
    total,
    results,
    ingestedAt,
  };
}

// ---------------------------------------------------------------------------
// Single-envelope processing
// ---------------------------------------------------------------------------

async function checkIdempotency(
  envelopeId: string,
  aggregateType: string,
  aggregateId: string,
  options: AggregateRuntimeOptions,
): Promise<EnvelopeResult | undefined> {
  const reserved = await options.idempotencyStore.reserve(envelopeId);
  if (!reserved) {
    options.auditSink.emit({
      type: 'duplicate',
      envelopeId,
      aggregateType,
      aggregateId,
    });
    return { status: 'duplicate', envelopeId };
  }
  return undefined;
}

async function hydrateAggregate(
  depot: IDepot,
  aggregateType: string,
  aggregateId: string,
): Promise<AggregateInstance> {
  const existing = await depot.get(aggregateType, aggregateId);
  if (existing !== undefined) {
    return existing;
  }
  return { state: undefined, version: 0 };
}

function dispatchCommand(
  registration: AggregateRegistration,
  commandType: string,
  state: unknown,
  payload: unknown,
): ReadonlyArray<unknown> {
  const handler = registration.commandHandlers[commandType];
  if (handler === undefined) {
    throw new Error(`No handler registered for command "${commandType}" on aggregate "${registration.aggregateType}"`);
  }
  const result = handler(state, payload);
  if (Array.isArray(result)) {
    return result as ReadonlyArray<unknown>;
  }
  return [result];
}

async function processCommandOnly(
  envelope: CommandOnlyEnvelope,
  resolver: RegistrationResolver,
  sequenceEnforcer: SequenceEnforcer,
  options: AggregateRuntimeOptions,
  auditSink: IAuditSink,
): Promise<EnvelopeResult> {
  // Resolve registration
  const registration = resolver.resolve(envelope.aggregateType);
  if (registration === undefined) {
    auditSink.emit({
      type: 'rejected',
      envelopeId: envelope.envelopeId,
      reason: `Unknown aggregate type: ${envelope.aggregateType}`,
    });
    return rejectEnvelope(
      envelope.envelopeId,
      `${SyncErrorCode.UNKNOWN_AGGREGATE}: Unknown aggregate type "${envelope.aggregateType}"`,
    );
  }

  // Idempotency check
  const duplicateResult = await checkIdempotency(
    envelope.envelopeId,
    envelope.aggregateType,
    envelope.aggregateId,
    options,
  );
  if (duplicateResult !== undefined) {
    return duplicateResult;
  }

  // Sequence enforcement
  const sequenceResult = await sequenceEnforcer.enforce(
    envelope.aggregateType,
    envelope.aggregateId,
    envelope.sequence,
  );

  if (sequenceResult.status === 'duplicate_sequence') {
    auditSink.emit({
      type: 'duplicate',
      envelopeId: envelope.envelopeId,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
    });
    return { status: 'duplicate', envelopeId: envelope.envelopeId };
  }

  if (sequenceResult.status === 'gap' || sequenceResult.status === 'out_of_order') {
    auditSink.emit({
      type: 'rejected',
      envelopeId: envelope.envelopeId,
      reason: `${SyncErrorCode.SEQUENCE_GAP}: expected ${sequenceResult.expected}, received ${sequenceResult.received}`,
    });
    return rejectEnvelope(
      envelope.envelopeId,
      `${SyncErrorCode.SEQUENCE_GAP}: expected sequence ${sequenceResult.expected}, received ${sequenceResult.received}`,
    );
  }

  // Lazy hydrate
  const instance = await hydrateAggregate(
    options.depot,
    envelope.aggregateType,
    envelope.aggregateId,
  );

  // Dispatch command
  const events = dispatchCommand(
    registration,
    envelope.commandType,
    instance.state,
    envelope.payload,
  );

  // Save events
  await options.depot.save(envelope.aggregateType, envelope.aggregateId, events);

  // Emit accepted signal
  auditSink.emit({
    type: 'accepted',
    envelopeId: envelope.envelopeId,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
  });

  return { status: 'accepted', envelopeId: envelope.envelopeId };
}

async function processCommandWithEvents(
  envelope: CommandWithEventsEnvelope,
  resolver: RegistrationResolver,
  sequenceEnforcer: SequenceEnforcer,
  options: AggregateRuntimeOptions,
  auditSink: IAuditSink,
): Promise<EnvelopeResult> {
  // Resolve registration
  const registration = resolver.resolve(envelope.aggregateType);
  if (registration === undefined) {
    auditSink.emit({
      type: 'rejected',
      envelopeId: envelope.envelopeId,
      reason: `Unknown aggregate type: ${envelope.aggregateType}`,
    });
    return rejectEnvelope(
      envelope.envelopeId,
      `${SyncErrorCode.UNKNOWN_AGGREGATE}: Unknown aggregate type "${envelope.aggregateType}"`,
    );
  }

  // Idempotency check
  const duplicateResult = await checkIdempotency(
    envelope.envelopeId,
    envelope.aggregateType,
    envelope.aggregateId,
    options,
  );
  if (duplicateResult !== undefined) {
    return duplicateResult;
  }

  // Sequence enforcement
  const sequenceResult = await sequenceEnforcer.enforce(
    envelope.aggregateType,
    envelope.aggregateId,
    envelope.sequence,
  );

  if (sequenceResult.status === 'duplicate_sequence') {
    auditSink.emit({
      type: 'duplicate',
      envelopeId: envelope.envelopeId,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
    });
    return { status: 'duplicate', envelopeId: envelope.envelopeId };
  }

  if (sequenceResult.status === 'gap' || sequenceResult.status === 'out_of_order') {
    auditSink.emit({
      type: 'rejected',
      envelopeId: envelope.envelopeId,
      reason: `${SyncErrorCode.SEQUENCE_GAP}: expected ${sequenceResult.expected}, received ${sequenceResult.received}`,
    });
    return rejectEnvelope(
      envelope.envelopeId,
      `${SyncErrorCode.SEQUENCE_GAP}: expected sequence ${sequenceResult.expected}, received ${sequenceResult.received}`,
    );
  }

  // Lazy hydrate
  const instance = await hydrateAggregate(
    options.depot,
    envelope.aggregateType,
    envelope.aggregateId,
  );

  // Dispatch command → produces local events
  const producedEvents = dispatchCommand(
    registration,
    envelope.commandType,
    instance.state,
    envelope.payload,
  );

  // Compare local vs upstream events via conflict handler
  const conflictResult = handleConflict({
    producedEvents,
    upstreamEvents: envelope.events,
    resolver: registration.conflictResolver,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
    envelopeId: envelope.envelopeId,
  });

  if (conflictResult.outcome === 'no_conflict') {
    await options.depot.save(envelope.aggregateType, envelope.aggregateId, producedEvents);
    auditSink.emit({
      type: 'accepted',
      envelopeId: envelope.envelopeId,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
    });
    return { status: 'accepted', envelopeId: envelope.envelopeId };
  }

  if (conflictResult.outcome === 'unresolved') {
    auditSink.emit({
      type: 'conflict',
      envelopeId: envelope.envelopeId,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      decision: 'unresolved',
    });
    return rejectEnvelope(
      envelope.envelopeId,
      `${SyncErrorCode.PROCESSING_ERROR}: ${conflictResult.reason}`,
    );
  }

  // outcome === 'resolved'
  const { decision } = conflictResult;

  // Emit conflict audit signal for any conflict (even resolved ones)
  auditSink.emit({
    type: 'conflict',
    envelopeId: envelope.envelopeId,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
    decision: decision.decision,
  });

  if (decision.decision === 'reject') {
    return rejectEnvelope(
      envelope.envelopeId,
      `${SyncErrorCode.PROCESSING_ERROR}: conflict rejected: ${decision.reason}`,
    );
  }

  // accept → save upstream events; override → save override events
  await options.depot.save(envelope.aggregateType, envelope.aggregateId, conflictResult.events);

  return {
    status: 'conflict_resolved',
    envelopeId: envelope.envelopeId,
    decision,
  };
}

// ---------------------------------------------------------------------------
// Dispatch per envelope type
// ---------------------------------------------------------------------------

async function processEnvelope(
  envelope: SyncEnvelope,
  resolver: RegistrationResolver,
  sequenceEnforcer: SequenceEnforcer,
  options: AggregateRuntimeOptions,
): Promise<EnvelopeResult> {
  // Validate structure
  const validation = validateEnvelope(envelope);
  if (isInvalidResult(validation)) {
    options.auditSink.emit({
      type: 'rejected',
      envelopeId: (envelope as { envelopeId?: string }).envelopeId ?? 'unknown',
      reason: validation.reason,
    });
    return rejectEnvelope(
      (envelope as { envelopeId?: string }).envelopeId ?? 'unknown',
      `${validation.code}: ${validation.reason}`,
    );
  }

  // Reject events_only
  if (envelope.type === 'events_only') {
    options.auditSink.emit({
      type: 'rejected',
      envelopeId: envelope.envelopeId,
      reason: 'events_only envelopes are not supported in v1',
    });
    return rejectEnvelope(
      envelope.envelopeId,
      `${SyncErrorCode.EVENTS_ONLY_NOT_SUPPORTED}: events_only envelopes are not supported in v1`,
    );
  }

  // Process command_only
  if (envelope.type === 'command_only') {
    return processCommandOnly(envelope, resolver, sequenceEnforcer, options, options.auditSink);
  }

  // Process command_with_events
  return processCommandWithEvents(envelope, resolver, sequenceEnforcer, options, options.auditSink);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an aggregate runtime processor.
 * The processor is stateless — all state flows through adapter contracts.
 */
export function createAggregateRuntimeProcessor(
  options: AggregateRuntimeOptions,
): AggregateRuntimeProcessor {
  const resolver = createRegistrationResolver(options.registrations);
  const sequenceEnforcer = createSequenceEnforcer(options.orderingStore);

  return {
    async processBatch(
      envelopes: ReadonlyArray<SyncEnvelope>,
    ): Promise<BatchResult> {
      const ingestedAt = new Date().toISOString();
      const results: EnvelopeResult[] = [];

      for (let i = 0; i < envelopes.length; i++) {
        try {
          const result = await processEnvelope(envelopes[i], resolver, sequenceEnforcer, options);

          // Stop on first failure (rejected = failure for batch semantics)
          if (result.status === 'rejected') {
            results.push(result);
            return buildFailedBatch(results, envelopes.length, i, ingestedAt);
          }

          results.push(result);
        } catch (error) {
          const envelopeId = (envelopes[i] as { envelopeId?: string }).envelopeId ?? 'unknown';
          const reason = error instanceof Error ? error.message : String(error);

          options.auditSink.emit({
            type: 'batch_failed',
            envelopeId,
            reason,
          });

          results.push(rejectEnvelope(
            envelopeId,
            `${SyncErrorCode.PROCESSING_ERROR}: ${reason}`,
          ));

          return buildFailedBatch(results, envelopes.length, i, ingestedAt);
        }
      }

      return buildCompletedBatch(results, envelopes.length, ingestedAt);
    },
  };
}
