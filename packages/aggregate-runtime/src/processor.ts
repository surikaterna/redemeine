/**
 * Core batch processor for the aggregate sync runtime.
 * Processes command-only envelopes through the aggregate lifecycle:
 * validate → resolve → idempotency → hydrate → dispatch → save.
 */

import type { SyncEnvelope, CommandOnlyEnvelope } from './envelopes';
import type { AggregateRegistration } from './runtime';
import type { IAuditSink } from './adapters';
import type { BatchResult, EnvelopeResult } from './batch-result';
import type { AggregateRuntimeOptions, AggregateInstance, IDepot } from './options';
import { SyncErrorCode } from './errors';
import { validateEnvelope, type ValidationResult } from './validation';
import { createRegistrationResolver, type RegistrationResolver } from './registration-resolver';

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

// ---------------------------------------------------------------------------
// Dispatch per envelope type
// ---------------------------------------------------------------------------

async function processEnvelope(
  envelope: SyncEnvelope,
  resolver: RegistrationResolver,
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
    return processCommandOnly(envelope, resolver, options, options.auditSink);
  }

  // command_with_events: not implemented in this bead (4gs.4 scope)
  // For now, reject with processing error to avoid silent drops
  options.auditSink.emit({
    type: 'rejected',
    envelopeId: envelope.envelopeId,
    reason: 'command_with_events processing not yet implemented',
  });
  return rejectEnvelope(
    envelope.envelopeId,
    `${SyncErrorCode.PROCESSING_ERROR}: command_with_events processing not yet implemented`,
  );
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

  return {
    async processBatch(
      envelopes: ReadonlyArray<SyncEnvelope>,
    ): Promise<BatchResult> {
      const ingestedAt = new Date().toISOString();
      const results: EnvelopeResult[] = [];

      for (let i = 0; i < envelopes.length; i++) {
        try {
          const result = await processEnvelope(envelopes[i], resolver, options);

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
