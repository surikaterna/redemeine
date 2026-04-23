/**
 * Core batch processor for the aggregate sync runtime.
 * Processes command-only and command_with_events envelopes through
 * the aggregate lifecycle: validate → resolve → idempotency → sequence → hydrate → dispatch → save.
 * For command_with_events, delegates conflict resolution to per-aggregate plugins.
 */

import type { SyncEnvelope, CommandOnlyEnvelope, CommandWithEventsEnvelope } from './envelopes';
import type { IAuditSink } from './adapters';
import type { BatchResult, EnvelopeResult } from './batch-result';
import type { AggregateRuntimeOptions } from './options';
import type { AuditContext } from './audit';
import { createAuditRecord } from './audit';
import { SyncErrorCode } from './errors';
import { validateEnvelope, type ValidationResult } from './validation';
import { createRegistrationResolver, type RegistrationResolver } from './registration-resolver';
import { createSequenceEnforcer, type SequenceEnforcer } from './sequence-enforcer';
import { handleConflict } from './conflict-handler';
import { runPreflight } from './preflight';

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
// Per-envelope-type processing
// ---------------------------------------------------------------------------

async function processCommandOnly(
  envelope: CommandOnlyEnvelope,
  resolver: RegistrationResolver,
  sequenceEnforcer: SequenceEnforcer,
  options: AggregateRuntimeOptions,
  auditSink: IAuditSink,
  auditCtx: AuditContext,
): Promise<EnvelopeResult> {
  const preflight = await runPreflight(envelope, resolver, sequenceEnforcer, options, auditSink);
  if (preflight.ok === false) {
    return preflight.result;
  }

  await options.depot.save(envelope.aggregateType, envelope.aggregateId, preflight.producedEvents);

  const signal = {
    type: 'accepted' as const,
    envelopeId: envelope.envelopeId,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
  };
  auditSink.emit(createAuditRecord(signal, auditCtx));

  return { status: 'accepted', envelopeId: envelope.envelopeId };
}

async function processCommandWithEvents(
  envelope: CommandWithEventsEnvelope,
  resolver: RegistrationResolver,
  sequenceEnforcer: SequenceEnforcer,
  options: AggregateRuntimeOptions,
  auditSink: IAuditSink,
  auditCtx: AuditContext,
): Promise<EnvelopeResult> {
  const preflight = await runPreflight(envelope, resolver, sequenceEnforcer, options, auditSink);
  if (preflight.ok === false) {
    return preflight.result;
  }

  const conflictResult = handleConflict({
    producedEvents: preflight.producedEvents,
    upstreamEvents: envelope.events,
    resolver: preflight.registration.conflictResolver,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
    envelopeId: envelope.envelopeId,
  });

  if (conflictResult.outcome === 'no_conflict') {
    await options.depot.save(envelope.aggregateType, envelope.aggregateId, preflight.producedEvents);
    const signal = {
      type: 'accepted' as const,
      envelopeId: envelope.envelopeId,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
    };
    auditSink.emit(createAuditRecord(signal, auditCtx));
    return { status: 'accepted', envelopeId: envelope.envelopeId };
  }

  if (conflictResult.outcome === 'unresolved') {
    const signal = {
      type: 'conflict' as const,
      envelopeId: envelope.envelopeId,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
      decision: 'unresolved' as const,
    };
    auditSink.emit(createAuditRecord(signal, auditCtx));
    return rejectEnvelope(
      envelope.envelopeId,
      `${SyncErrorCode.PROCESSING_ERROR}: ${conflictResult.reason}`,
    );
  }

  // outcome === 'resolved'
  const { decision } = conflictResult;

  const conflictSignal = {
    type: 'conflict' as const,
    envelopeId: envelope.envelopeId,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
    decision: decision.decision,
  };
  auditSink.emit(createAuditRecord(conflictSignal, auditCtx));

  if (decision.decision === 'reject') {
    return rejectEnvelope(
      envelope.envelopeId,
      `${SyncErrorCode.PROCESSING_ERROR}: conflict rejected: ${decision.reason}`,
    );
  }

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
  ingestedAt: string,
): Promise<EnvelopeResult> {
  const startTime = Date.now();

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

  // Build audit context for enriched records
  const auditCtx: AuditContext = {
    occurredAt: envelope.occurredAt,
    ingestedAt,
    aggregateType: envelope.aggregateType,
    aggregateId: envelope.aggregateId,
    startTime,
  };

  // Process command_only
  if (envelope.type === 'command_only') {
    return processCommandOnly(envelope, resolver, sequenceEnforcer, options, options.auditSink, auditCtx);
  }

  // Process command_with_events
  return processCommandWithEvents(envelope, resolver, sequenceEnforcer, options, options.auditSink, auditCtx);
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
          const result = await processEnvelope(envelopes[i], resolver, sequenceEnforcer, options, ingestedAt);

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
