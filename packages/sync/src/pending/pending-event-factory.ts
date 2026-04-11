import type { NewEvent } from '../store/sync-event-store';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * An event produced by local command processing, before it is
 * persisted to the store. The factory stamps it with metadata
 * (status, version, timestamp) to create a {@link NewEvent}.
 */
export interface ProducedEvent {
  readonly type: string;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an array of {@link NewEvent} records from locally-produced
 * events, ready to be saved to the store with `pending` status.
 *
 * This is a pure function — it produces deterministic output given
 * the same inputs (when `now` is provided). Versions are assigned
 * sequentially starting from `baseVersion + 1`.
 *
 * @param producedEvents — events produced by local command processing.
 * @param now            — optional ISO-8601 timestamp override (defaults to current time).
 * @returns ordered array of {@link NewEvent} records with `occurredAt` set.
 */
export function createPendingEvents(
  producedEvents: ReadonlyArray<ProducedEvent>,
  now?: string,
): ReadonlyArray<NewEvent> {
  const timestamp = now ?? new Date().toISOString();

  return producedEvents.map((event) => ({
    type: event.type,
    payload: event.payload,
    occurredAt: timestamp,
  }));
}
