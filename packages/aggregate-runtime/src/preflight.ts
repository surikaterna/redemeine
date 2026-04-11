/**
 * Shared pre-flight pipeline for command-bearing envelopes.
 * Handles registration resolution, idempotency, sequence enforcement,
 * lazy hydration, and command dispatch.
 */

import type { CommandOnlyEnvelope, CommandWithEventsEnvelope } from './envelopes';
import type { AggregateRegistration } from './runtime';
import type { IAuditSink } from './adapters';
import type { EnvelopeResult } from './batch-result';
import type { AggregateRuntimeOptions } from './options';
import type { RegistrationResolver } from './registration-resolver';
import type { SequenceEnforcer } from './sequence-enforcer';
import { SyncErrorCode } from './errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandEnvelope = CommandOnlyEnvelope | CommandWithEventsEnvelope;

export type PreflightSuccess = {
  readonly ok: true;
  readonly registration: AggregateRegistration;
  readonly producedEvents: ReadonlyArray<unknown>;
};

export type PreflightEarlyReturn = {
  readonly ok: false;
  readonly result: EnvelopeResult;
};

export type PreflightOutcome = PreflightSuccess | PreflightEarlyReturn;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rejectEnvelope(envelopeId: string, reason: string): EnvelopeResult {
  return { status: 'rejected', envelopeId, reason };
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

// ---------------------------------------------------------------------------
// Pre-flight pipeline
// ---------------------------------------------------------------------------

/**
 * Run registration resolve → idempotency → sequence → hydrate → dispatch.
 * Returns either a successful outcome with the registration and produced events,
 * or an early-return envelope result (duplicate, rejected, etc.).
 */
export async function runPreflight(
  envelope: CommandEnvelope,
  resolver: RegistrationResolver,
  sequenceEnforcer: SequenceEnforcer,
  options: AggregateRuntimeOptions,
  auditSink: IAuditSink,
): Promise<PreflightOutcome> {
  // Resolve registration
  const registration = resolver.resolve(envelope.aggregateType);
  if (registration === undefined) {
    auditSink.emit({
      type: 'rejected',
      envelopeId: envelope.envelopeId,
      reason: `Unknown aggregate type: ${envelope.aggregateType}`,
    });
    return {
      ok: false,
      result: rejectEnvelope(
        envelope.envelopeId,
        `${SyncErrorCode.UNKNOWN_AGGREGATE}: Unknown aggregate type "${envelope.aggregateType}"`,
      ),
    };
  }

  // Idempotency check
  const reserved = await options.idempotencyStore.reserve(envelope.envelopeId);
  if (!reserved) {
    options.auditSink.emit({
      type: 'duplicate',
      envelopeId: envelope.envelopeId,
      aggregateType: envelope.aggregateType,
      aggregateId: envelope.aggregateId,
    });
    return { ok: false, result: { status: 'duplicate', envelopeId: envelope.envelopeId } };
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
    return { ok: false, result: { status: 'duplicate', envelopeId: envelope.envelopeId } };
  }

  if (sequenceResult.status === 'gap' || sequenceResult.status === 'out_of_order') {
    auditSink.emit({
      type: 'rejected',
      envelopeId: envelope.envelopeId,
      reason: `${SyncErrorCode.SEQUENCE_GAP}: expected ${sequenceResult.expected}, received ${sequenceResult.received}`,
    });
    return {
      ok: false,
      result: rejectEnvelope(
        envelope.envelopeId,
        `${SyncErrorCode.SEQUENCE_GAP}: expected sequence ${sequenceResult.expected}, received ${sequenceResult.received}`,
      ),
    };
  }

  // Lazy hydrate
  const existing = await options.depot.get(envelope.aggregateType, envelope.aggregateId);
  const state = existing !== undefined ? existing.state : undefined;

  // Dispatch command
  const producedEvents = dispatchCommand(
    registration,
    envelope.commandType,
    state,
    envelope.payload,
  );

  return { ok: true, registration, producedEvents };
}
