import type { Event } from '@redemeine/kernel';

/** Shorthand for a kernel Event with relaxed type and payload constraints. */
export type SyncEvent = Event<unknown, string>;

/**
 * Adapter contract for event store operations needed by reconciliation.
 * Extends Mirage EventStore with command-ID lookup and stream replacement.
 * Consumers provide a concrete implementation.
 */
export interface IReconciliationEventStoreAdapter {
  /**
   * Returns all events in the given stream that were produced by the
   * specified command (matched via event.metadata.command.id).
   */
  findEventsByCommandId(
    streamId: string,
    commandId: string,
  ): Promise<ReadonlyArray<SyncEvent>>;

  /**
   * Replaces events in a stream for a given commandId with
   * authoritative events. Implementation should:
   * 1. Archive the old events (for conflict record)
   * 2. Remove/mark old events in the stream
   * 3. Insert the authoritative events at the correct position
   *
   * Returns the archived (displaced) local events for the conflict record.
   */
  replaceEventsByCommandId(
    streamId: string,
    commandId: string,
    authoritativeEvents: ReadonlyArray<SyncEvent>,
  ): Promise<ReadonlyArray<SyncEvent>>;

  /**
   * Saves authoritative events to a stream (no local events to replace).
   * Equivalent to EventStore.saveEvents but accepting kernel Events.
   */
  saveEvents(
    streamId: string,
    events: ReadonlyArray<SyncEvent>,
  ): Promise<void>;

  /**
   * Imports a snapshot received from upstream into the local store.
   * Delegates to whatever snapshot mechanism the app uses.
   */
  importSnapshot(snapshot: UpstreamSnapshot): Promise<void>;
}

/** Snapshot data received from upstream for an aggregate stream. */
export interface UpstreamSnapshot {
  readonly streamId: string;
  readonly version: number;
  readonly state: unknown;
  readonly snapshotAt: string;
}
