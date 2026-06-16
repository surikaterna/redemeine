/**
 * Configuration options for the aggregate sync runtime.
 */

import type { AggregateRegistration } from './runtime';
import type { IIdempotencyStore, IOrderingStore, IAuditSink } from './adapters';

// ---------------------------------------------------------------------------
// Depot (aggregate persistence adapter)
// ---------------------------------------------------------------------------

/**
 * Snapshot of an aggregate instance retrieved from the store.
 */
export type AggregateInstance = {
  readonly state: unknown;
  readonly version: number;
};

/**
 * Adapter for aggregate state persistence.
 * The runtime reads and writes aggregate instances through this contract.
 */
export type IDepot = {
  /**
   * Load the current aggregate instance, or `undefined` if it does not exist.
   */
  get(
    aggregateType: string,
    aggregateId: string,
  ): Promise<AggregateInstance | undefined>;

  /**
   * Persist new events for an aggregate instance.
   */
  save(
    aggregateType: string,
    aggregateId: string,
    events: ReadonlyArray<unknown>,
  ): Promise<void>;
};

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

/**
 * All dependencies required to construct an aggregate sync runtime instance.
 */
export type AggregateRuntimeOptions = {
  readonly registrations: ReadonlyArray<AggregateRegistration>;
  readonly idempotencyStore: IIdempotencyStore;
  readonly orderingStore: IOrderingStore;
  readonly auditSink: IAuditSink;
  readonly depot: IDepot;
};
