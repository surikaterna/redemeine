// ---------------------------------------------------------------------------
// Event Stream Lane — Envelope Types
// ---------------------------------------------------------------------------

/**
 * A single event received from an upstream authority via the event stream lane.
 *
 * Carries enough metadata for the downstream node to persist the event
 * into its local store and correlate with pending events via {@link commandId}.
 */
export interface DownstreamEvent {
  /** Unique upstream event identifier. */
  readonly eventId: string;

  /** Fully-qualified event type. */
  readonly type: string;

  /** Serialized event data. */
  readonly payload: unknown;

  /** Client-assigned command ID — correlation key for reconciliation. */
  readonly commandId: string;

  /** Monotonic version within the aggregate stream. */
  readonly version: number;

  /** ISO-8601 timestamp when the event was originally produced. */
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// Envelope variants
// ---------------------------------------------------------------------------

/**
 * Prepped write model state for an aggregate stream.
 * Used to bootstrap or fast-forward a downstream aggregate
 * without replaying the full event history.
 */
export interface EventStreamSnapshot {
  readonly type: 'snapshot';
  readonly streamId: string;
  readonly aggregateType: string;
  readonly state: unknown;
  readonly version: number;
  /** ISO-8601 timestamp when the snapshot was captured. */
  readonly snapshotAt: string;
}

/**
 * An ordered batch of events appended to an aggregate stream.
 * Downstream uses these to keep its local projection of the
 * aggregate up to date and to reconcile pending events.
 */
export interface EventStreamEvents {
  readonly type: 'events';
  readonly streamId: string;
  readonly aggregateType: string;
  readonly events: ReadonlyArray<DownstreamEvent>;
  readonly fromVersion: number;
  readonly toVersion: number;
}

/**
 * Lifecycle signal: a new aggregate stream is now available
 * for this downstream node. Upstream will begin delivering
 * snapshots and events for this stream.
 */
export interface EventStreamAdded {
  readonly type: 'stream_added';
  readonly streamId: string;
  readonly aggregateType: string;
  /** ISO-8601 timestamp when the stream was added to the feed. */
  readonly addedAt: string;
}

/**
 * Lifecycle signal: an aggregate stream is no longer relevant
 * for this downstream node. Downstream may prune local data.
 */
export interface EventStreamRemoved {
  readonly type: 'stream_removed';
  readonly streamId: string;
  readonly aggregateType: string;
  /** ISO-8601 timestamp when the stream was removed from the feed. */
  readonly removedAt: string;
}

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all envelope types delivered on the
 * event stream lane. Consumers switch on {@link EventStreamEnvelope.type type}
 * to handle each variant.
 */
export type EventStreamEnvelope =
  | EventStreamSnapshot
  | EventStreamEvents
  | EventStreamAdded
  | EventStreamRemoved;
