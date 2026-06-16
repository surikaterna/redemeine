/**
 * Error codes and error class for the aggregate sync runtime.
 */

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/**
 * Well-known error codes emitted by the aggregate runtime.
 * Each value is a unique, machine-readable string constant.
 */
export const SyncErrorCode = {
  UNKNOWN_AGGREGATE: 'UNKNOWN_AGGREGATE',
  MALFORMED_ENVELOPE: 'MALFORMED_ENVELOPE',
  SEQUENCE_GAP: 'SEQUENCE_GAP',
  EVENTS_ONLY_NOT_SUPPORTED: 'EVENTS_ONLY_NOT_SUPPORTED',
  PROCESSING_ERROR: 'PROCESSING_ERROR',
} as const;

/**
 * Union type of all known sync error code strings.
 */
export type SyncErrorCode = (typeof SyncErrorCode)[keyof typeof SyncErrorCode];

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Structured error thrown by the aggregate sync runtime.
 * Carries a machine-readable `code` for programmatic handling.
 */
export class SyncRuntimeError extends Error {
  public readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = 'SyncRuntimeError';
    this.code = code;
  }
}
