/**
 * Batch processing result types.
 */

import type { ConflictDecision } from './runtime';

// ---------------------------------------------------------------------------
// Per-envelope result (discriminated union)
// ---------------------------------------------------------------------------

/**
 * Result for an envelope that was accepted and processed successfully.
 */
export type AcceptedResult = {
  readonly status: 'accepted';
  readonly envelopeId: string;
};

/**
 * Result for an envelope that was already processed (idempotent skip).
 */
export type DuplicateResult = {
  readonly status: 'duplicate';
  readonly envelopeId: string;
};

/**
 * Result for an envelope that was rejected by the runtime.
 */
export type RejectedResult = {
  readonly status: 'rejected';
  readonly envelopeId: string;
  readonly reason: string;
};

/**
 * Result for an envelope where a conflict was detected and resolved.
 */
export type ConflictResolvedResult = {
  readonly status: 'conflict_resolved';
  readonly envelopeId: string;
  readonly decision: ConflictDecision;
};

/**
 * Discriminated union of all per-envelope result shapes.
 */
export type EnvelopeResult =
  | AcceptedResult
  | DuplicateResult
  | RejectedResult
  | ConflictResolvedResult;

// ---------------------------------------------------------------------------
// Batch result
// ---------------------------------------------------------------------------

/**
 * Overall result of processing a batch of sync envelopes.
 */
export type BatchResult = {
  readonly status: 'completed' | 'failed';
  /** Number of envelopes successfully processed. */
  readonly processed: number;
  /** Total number of envelopes in the batch. */
  readonly total: number;
  /** Index of the first envelope that caused a failure (if any). */
  readonly failedAtIndex?: number;
  /** Per-envelope results in input order. */
  readonly results: ReadonlyArray<EnvelopeResult>;
  /** ISO-8601 timestamp when the batch was ingested by the runtime. */
  readonly ingestedAt: string;
};
