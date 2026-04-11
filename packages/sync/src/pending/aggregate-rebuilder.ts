import type { ISyncEventStore } from '../store/sync-event-store';
import type { StoredEvent } from '../store/stored-event';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * A pure function that folds a single event into aggregate state.
 * Used by {@link rebuildFromConfirmed} to rehydrate an aggregate
 * from its confirmed event stream.
 */
export type EventApplier = (state: unknown, event: StoredEvent) => unknown;

/**
 * Result of rebuilding aggregate state from confirmed-only events.
 */
export interface RebuildResult {
  /** The aggregate stream that was rebuilt. */
  readonly streamId: string;

  /** The reconstructed aggregate state after folding all confirmed events. */
  readonly state: unknown;

  /** The version of the last confirmed event applied. */
  readonly version: number;

  /** Number of confirmed events that were folded into state. */
  readonly confirmedEventCount: number;

  /** Number of superseded events encountered (skipped). */
  readonly supersededEventCount: number;
}

// ---------------------------------------------------------------------------
// Rebuilder
// ---------------------------------------------------------------------------

/**
 * Rebuilds aggregate state by folding only confirmed events from the
 * store. Superseded events are counted but excluded from the fold.
 *
 * This is the safe path for rehydration after a supersession event:
 * only authoritative confirmed events contribute to the aggregate state.
 *
 * @param store      — the sync event store adapter.
 * @param streamId   — aggregate stream to rebuild.
 * @param applyEvent — pure fold function: `(state, event) => newState`.
 * @param initialState — starting state before any events are applied (defaults to `undefined`).
 */
export async function rebuildFromConfirmed(
  store: ISyncEventStore,
  streamId: string,
  applyEvent: EventApplier,
  initialState?: unknown,
): Promise<RebuildResult> {
  let state: unknown = initialState;
  let version = 0;
  let confirmedEventCount = 0;

  // Read all events (unfiltered) so we can count superseded
  const allEvents: StoredEvent[] = [];
  for await (const event of store.readStream(streamId)) {
    allEvents.push(event);
  }

  const supersededEventCount = allEvents.filter((e) => e.status === 'superseded').length;

  // Fold only confirmed events
  for await (const event of store.readStream(streamId, { confirmedOnly: true })) {
    state = applyEvent(state, event);
    version = event.version;
    confirmedEventCount++;
  }

  return {
    streamId,
    state,
    version,
    confirmedEventCount,
    supersededEventCount,
  };
}
