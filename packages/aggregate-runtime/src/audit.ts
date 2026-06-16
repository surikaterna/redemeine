/**
 * Enhanced audit record types for runtime observability.
 * Extends AuditSignal with timing and context information.
 */

import type { AuditSignal } from './adapters';

// ---------------------------------------------------------------------------
// Context passed to audit record creation
// ---------------------------------------------------------------------------

/**
 * Contextual information for creating an audit record.
 */
export type AuditContext = {
  /** ISO-8601 timestamp from the upstream envelope. */
  readonly occurredAt: string;
  /** ISO-8601 timestamp when the runtime ingested this envelope. */
  readonly ingestedAt: string;
  /** The aggregate type being processed. */
  readonly aggregateType: string;
  /** The aggregate instance being processed. */
  readonly aggregateId: string;
  /** High-resolution start time (ms) for duration calculation. */
  readonly startTime: number;
};

// ---------------------------------------------------------------------------
// Audit record
// ---------------------------------------------------------------------------

/**
 * An enriched audit record that extends an AuditSignal with
 * timing and aggregate context information.
 */
export type AuditRecord = AuditSignal & {
  /** ISO-8601 timestamp from the upstream envelope. */
  readonly occurredAt: string;
  /** ISO-8601 timestamp when the runtime ingested this envelope. */
  readonly ingestedAt: string;
  /** The aggregate type being processed. */
  readonly aggregateType: string;
  /** The aggregate instance being processed. */
  readonly aggregateId: string;
  /** Processing duration in milliseconds for this envelope. */
  readonly durationMs: number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an audit record by enriching an AuditSignal with timing
 * and context information.
 */
export function createAuditRecord(
  signal: AuditSignal,
  context: AuditContext,
): AuditRecord {
  const durationMs = Date.now() - context.startTime;

  return {
    ...signal,
    occurredAt: context.occurredAt,
    ingestedAt: context.ingestedAt,
    aggregateType: context.aggregateType,
    aggregateId: context.aggregateId,
    durationMs,
  };
}
