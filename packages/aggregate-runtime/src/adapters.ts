/**
 * Adapter contracts for pluggable infrastructure concerns.
 * Consumers provide implementations; the runtime codes to these interfaces.
 */

// ---------------------------------------------------------------------------
// Audit signals
// ---------------------------------------------------------------------------

/**
 * Discriminated union of audit signals emitted during envelope processing.
 */
export type AuditSignal =
  | { readonly type: 'accepted'; readonly envelopeId: string; readonly aggregateType: string; readonly aggregateId: string }
  | { readonly type: 'duplicate'; readonly envelopeId: string; readonly aggregateType: string; readonly aggregateId: string }
  | { readonly type: 'rejected'; readonly envelopeId: string; readonly reason: string }
  | { readonly type: 'conflict'; readonly envelopeId: string; readonly aggregateType: string; readonly aggregateId: string; readonly decision: string }
  | { readonly type: 'batch_failed'; readonly envelopeId: string; readonly reason: string };

// ---------------------------------------------------------------------------
// Idempotency store
// ---------------------------------------------------------------------------

/**
 * Tracks whether an envelope has already been processed.
 * `reserve` must be atomic — only one caller wins per envelopeId.
 */
export type IIdempotencyStore = {
  /**
   * Attempt to reserve an envelope id for processing.
   * Returns `true` if the caller won the reservation (first time),
   * `false` if the envelope was already processed or reserved.
   */
  reserve(envelopeId: string): Promise<boolean>;

  /**
   * Check whether an envelope has already been processed.
   */
  isProcessed(envelopeId: string): Promise<boolean>;
};

// ---------------------------------------------------------------------------
// Ordering store
// ---------------------------------------------------------------------------

/**
 * Tracks per-aggregate sequence numbers for ordering enforcement.
 */
export type IOrderingStore = {
  /**
   * Returns the last processed sequence for a given aggregate instance,
   * or `undefined` if no sequence has been recorded.
   */
  getLastSequence(
    aggregateType: string,
    aggregateId: string,
  ): Promise<number | undefined>;

  /**
   * Persists the latest processed sequence for a given aggregate instance.
   */
  saveSequence(
    aggregateType: string,
    aggregateId: string,
    sequence: number,
  ): Promise<void>;
};

// ---------------------------------------------------------------------------
// Audit sink
// ---------------------------------------------------------------------------

/**
 * Receives audit signals from the runtime for observability.
 */
export type IAuditSink = {
  emit(signal: AuditSignal): void;
};
