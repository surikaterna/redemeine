/**
 * Per-aggregate sequence enforcement.
 * Ensures envelopes for a given (aggregateType, aggregateId) stream
 * arrive in strict sequential order. Delegates persistence to IOrderingStore.
 */

import type { IOrderingStore } from './adapters';

// ---------------------------------------------------------------------------
// Result discriminated union
// ---------------------------------------------------------------------------

/** Sequence is valid — either the next expected value, or no sequence was provided. */
export type SequenceOk = { readonly status: 'ok' };

/** A gap was detected between the last processed sequence and the received one. */
export type SequenceGap = {
  readonly status: 'gap';
  readonly expected: number;
  readonly received: number;
};

/** The received sequence has already been processed. */
export type SequenceDuplicate = {
  readonly status: 'duplicate_sequence';
  readonly sequence: number;
};

/** The received sequence is below the last processed — out of order. */
export type SequenceOutOfOrder = {
  readonly status: 'out_of_order';
  readonly expected: number;
  readonly received: number;
};

/**
 * Discriminated union of all sequence enforcement outcomes.
 */
export type SequenceCheckResult =
  | SequenceOk
  | SequenceGap
  | SequenceDuplicate
  | SequenceOutOfOrder;

// ---------------------------------------------------------------------------
// Enforcer interface
// ---------------------------------------------------------------------------

/**
 * Stateless per-aggregate sequence enforcer.
 * All state flows through the ordering store adapter.
 */
export type SequenceEnforcer = {
  /**
   * Check whether the given sequence is valid for the aggregate stream.
   * If valid, persists the new sequence through the ordering store.
   *
   * When `sequence` is `undefined`, enforcement is skipped (always ok).
   */
  enforce(
    aggregateType: string,
    aggregateId: string,
    sequence: number | undefined,
  ): Promise<SequenceCheckResult>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a sequence enforcer backed by the given ordering store.
 */
export function createSequenceEnforcer(
  orderingStore: IOrderingStore,
): SequenceEnforcer {
  return {
    async enforce(
      aggregateType: string,
      aggregateId: string,
      sequence: number | undefined,
    ): Promise<SequenceCheckResult> {
      // No sequence → no enforcement
      if (sequence === undefined) {
        return { status: 'ok' };
      }

      const lastSequence = await orderingStore.getLastSequence(
        aggregateType,
        aggregateId,
      );

      // First envelope for this stream — accept any sequence
      if (lastSequence === undefined) {
        await orderingStore.saveSequence(aggregateType, aggregateId, sequence);
        return { status: 'ok' };
      }

      // Exact duplicate
      if (sequence === lastSequence) {
        return { status: 'duplicate_sequence', sequence };
      }

      // Valid next sequence
      if (sequence === lastSequence + 1) {
        await orderingStore.saveSequence(aggregateType, aggregateId, sequence);
        return { status: 'ok' };
      }

      // Gap — sequence is ahead of expected
      if (sequence > lastSequence + 1) {
        return {
          status: 'gap',
          expected: lastSequence + 1,
          received: sequence,
        };
      }

      // Out of order — sequence is behind last processed
      return {
        status: 'out_of_order',
        expected: lastSequence + 1,
        received: sequence,
      };
    },
  };
}
