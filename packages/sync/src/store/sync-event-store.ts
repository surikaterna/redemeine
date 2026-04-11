import type { EventStatus } from './event-status';
import type { StoredEvent } from './stored-event';
import type { AggregateSnapshot } from './aggregate-snapshot';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * Represents an event that has not yet been persisted.
 * The store adapter assigns {@link StoredEvent.id id}, {@link StoredEvent.version version},
 * and {@link StoredEvent.ingestedAt ingestedAt} at write time.
 */
export interface NewEvent {
  /** Fully-qualified event type. */
  readonly type: string;

  /** Serialized event data. */
  readonly payload: unknown;

  /** ISO-8601 timestamp when the event was originally produced. */
  readonly occurredAt: string;
}

/** Options controlling how events are persisted. */
export interface SaveEventOptions {
  /**
   * Initial lifecycle status for the saved events.
   * Typically `pending` for optimistic writes, `confirmed` for
   * authoritative upstream events.
   */
  readonly status: EventStatus;

  /**
   * Client-assigned command ID. All events in the batch share
   * this correlation key.
   */
  readonly commandId: string;
}

/** Result of a {@link ISyncEventStore.saveEvents} operation. */
export interface SaveEventResult {
  /** IDs assigned to the persisted events, in insertion order. */
  readonly eventIds: ReadonlyArray<string>;

  /** The stream version after the last event in the batch. */
  readonly nextVersion: number;
}

/** Result of a {@link ISyncEventStore.confirmEvents} operation. */
export interface ConfirmResult {
  /** Number of events transitioned from `pending` to `confirmed`. */
  readonly confirmedCount: number;
}

/** Result of a {@link ISyncEventStore.supersedeEvents} operation. */
export interface SupersedeResult {
  /** Number of events marked as `superseded`. */
  readonly supersededCount: number;

  /** IDs assigned to the replacement (authoritative) events. */
  readonly replacementEventIds: ReadonlyArray<string>;
}

/** Options for reading events from a stream. */
export interface ReadStreamOptions {
  /** When `true`, only events with status `confirmed` are returned. */
  readonly confirmedOnly?: boolean;

  /** Start reading from this version (inclusive). Defaults to `1`. */
  readonly fromVersion?: number;
}

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/**
 * Adapter contract for the sync-aware event store.
 *
 * Consumers provide a concrete implementation (IndexedDB, MongoDB,
 * in-memory, etc.) that satisfies this interface. The framework
 * interacts exclusively through these methods.
 */
export interface ISyncEventStore {
  /**
   * Persists a batch of new events for the given aggregate stream.
   *
   * @param streamId  — aggregate stream identifier.
   * @param events    — ordered batch of events to persist.
   * @param options   — write options (status, commandId).
   */
  saveEvents(
    streamId: string,
    events: ReadonlyArray<NewEvent>,
    options: SaveEventOptions,
  ): Promise<SaveEventResult>;

  /**
   * Transitions all pending events that share the given command ID
   * to `confirmed` status.
   *
   * @param commandId — client-assigned correlation key.
   */
  confirmEvents(commandId: string): Promise<ConfirmResult>;

  /**
   * Marks all pending events for the given command ID as `superseded`
   * and inserts the authoritative replacement events.
   *
   * @param commandId    — client-assigned correlation key.
   * @param replacements — authoritative events from upstream.
   */
  supersedeEvents(
    commandId: string,
    replacements: ReadonlyArray<NewEvent>,
  ): Promise<SupersedeResult>;

  /**
   * Returns an async iterable over events in the specified stream,
   * ordered by version ascending.
   *
   * @param streamId — aggregate stream identifier.
   * @param options  — optional read filters.
   */
  readStream(
    streamId: string,
    options?: ReadStreamOptions,
  ): AsyncIterable<StoredEvent>;

  /**
   * Loads the most recent snapshot for an aggregate stream, if one exists.
   *
   * @param streamId — aggregate stream identifier.
   */
  loadSnapshot(streamId: string): Promise<AggregateSnapshot | undefined>;

  /**
   * Imports a snapshot received from upstream into the local store.
   *
   * @param snapshot — the aggregate snapshot to persist.
   */
  importSnapshot(snapshot: AggregateSnapshot): Promise<void>;
}
