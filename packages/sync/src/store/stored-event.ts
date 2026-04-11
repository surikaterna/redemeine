import type { EventStatus } from './event-status';

/**
 * A persisted event record as stored by an {@link ISyncEventStore} adapter.
 *
 * Every stored event carries both a lifecycle {@link status} and a
 * client-assigned {@link commandId} that serves as the correlation key
 * between optimistic pending events and their authoritative counterparts.
 */
export interface StoredEvent {
  /** Unique event identifier. */
  readonly id: string;

  /** Aggregate stream this event belongs to. */
  readonly streamId: string;

  /** Fully-qualified event type (e.g. `"order.item_added.event"`). */
  readonly type: string;

  /** Serialized event data. */
  readonly payload: unknown;

  /** Lifecycle status of this event. */
  readonly status: EventStatus;

  /** Client-assigned command ID used to correlate pending ↔ authoritative events. */
  readonly commandId: string;

  /** Monotonic version within the aggregate stream. */
  readonly version: number;

  /** ISO-8601 timestamp when the event was originally produced. */
  readonly occurredAt: string;

  /** ISO-8601 timestamp when the event was ingested into the local store. */
  readonly ingestedAt: string;

  /**
   * If this event has been superseded, references the authoritative
   * replacement event's ID. Undefined when status is not `superseded`.
   */
  readonly supersededBy?: string;
}
