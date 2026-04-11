// ---------------------------------------------------------------------------
// Upstream batch result — per-command outcomes from upstream processing
// ---------------------------------------------------------------------------

/** The upstream accepted the command for processing. */
export interface AcceptedCommandResult {
  readonly status: 'accepted';
  readonly commandId: string;
}

/** The upstream rejected the command with a reason. */
export interface RejectedCommandResult {
  readonly status: 'rejected';
  readonly commandId: string;
  readonly reason: string;
}

/** The upstream detected this command as a duplicate (already processed). */
export interface DuplicateCommandResult {
  readonly status: 'duplicate';
  readonly commandId: string;
}

/**
 * Per-command result from upstream processing.
 *
 * Discriminated on {@link UpstreamCommandResult.status}:
 * - `accepted` — command was accepted for processing.
 * - `rejected` — command was refused with a reason.
 * - `duplicate` — command ID was already seen; safely ack.
 */
export type UpstreamCommandResult =
  | AcceptedCommandResult
  | RejectedCommandResult
  | DuplicateCommandResult;

/** Aggregate result for a submitted batch of commands. */
export interface UpstreamBatchResult {
  /** Matches the {@link UpstreamBatchRequest.batchId} this result responds to. */
  readonly batchId: string;

  /** Per-command results in the same order as the request. */
  readonly results: ReadonlyArray<UpstreamCommandResult>;

  /** ISO-8601 timestamp when the upstream received the batch. */
  readonly receivedAt: string;
}
