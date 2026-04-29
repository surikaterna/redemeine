/**
 * Simple batch summary report.
 * Pure function that summarizes a BatchResult into a readable report.
 */

import type { BatchResult } from './batch-result';

// ---------------------------------------------------------------------------
// Report type
// ---------------------------------------------------------------------------

/**
 * A plain summary of batch processing outcomes and timing.
 */
export type BatchReport = {
  /** Unique identifier for the batch (matches ingestedAt for traceability). */
  readonly batchId: string;
  /** Total number of envelopes in the batch. */
  readonly total: number;
  /** Number of envelopes accepted (including conflict_resolved with accept). */
  readonly accepted: number;
  /** Number of duplicate envelopes skipped. */
  readonly duplicates: number;
  /** Number of envelopes rejected. */
  readonly rejected: number;
  /** Number of envelopes that went through conflict resolution. */
  readonly conflicts: number;
  /** Whether the batch failed (stopped on first failure). */
  readonly failed: boolean;
  /** Index of the first failed envelope, if any. */
  readonly failedAtIndex?: number;
  /** Total batch processing duration in milliseconds. */
  readonly durationMs: number;
  /** ISO-8601 timestamp when processing started. */
  readonly startedAt: string;
  /** ISO-8601 timestamp when processing completed. */
  readonly completedAt: string;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a batch report from a BatchResult and timing information.
 */
export function createBatchReport(
  result: BatchResult,
  startedAt: string,
  durationMs: number,
): BatchReport {
  let accepted = 0;
  let duplicates = 0;
  let rejected = 0;
  let conflicts = 0;

  for (const envelope of result.results) {
    switch (envelope.status) {
      case 'accepted':
        accepted++;
        break;
      case 'duplicate':
        duplicates++;
        break;
      case 'rejected':
        rejected++;
        break;
      case 'conflict_resolved':
        conflicts++;
        break;
    }
  }

  return {
    batchId: result.ingestedAt,
    total: result.total,
    accepted,
    duplicates,
    rejected,
    conflicts,
    failed: result.status === 'failed',
    failedAtIndex: result.failedAtIndex,
    durationMs,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
