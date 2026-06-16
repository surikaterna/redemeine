/**
 * Envelope metadata carried with upstream sync envelopes.
 * Open to extension via index signature.
 */
export type EnvelopeMetadata = {
  readonly nodeId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly [key: string]: unknown;
};

/**
 * An event produced by an upstream (edge) node, included in
 * command_with_events or events_only envelopes.
 */
export type UpstreamEvent = {
  readonly type: string;
  readonly payload: unknown;
};

// ---------------------------------------------------------------------------
// Envelope discriminated union
// ---------------------------------------------------------------------------

/**
 * Envelope carrying a command without pre-computed events.
 * The runtime will resolve the aggregate, execute the command handler,
 * and produce events server-side.
 */
export type CommandOnlyEnvelope = {
  readonly type: 'command_only';
  /** Unique envelope identity (UUID/ULID). */
  readonly envelopeId: string;
  /** Client-assigned command identity (UUID/ULID). */
  readonly commandId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly commandType: string;
  readonly payload: unknown;
  /** ISO-8601 timestamp from the upstream node. */
  readonly occurredAt: string;
  /** Optional per-aggregate ordering sequence. */
  readonly sequence?: number;
  readonly metadata?: EnvelopeMetadata;
};

/**
 * Envelope carrying a command together with the events the upstream
 * node optimistically produced. The runtime may accept, reject, or
 * override those events via the conflict resolver.
 */
export type CommandWithEventsEnvelope = {
  readonly type: 'command_with_events';
  readonly envelopeId: string;
  readonly commandId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly commandType: string;
  readonly payload: unknown;
  readonly events: ReadonlyArray<UpstreamEvent>;
  readonly occurredAt: string;
  readonly sequence?: number;
  readonly metadata?: EnvelopeMetadata;
};

/**
 * Shape reserved for future use.
 * The v1 runtime rejects envelopes of this type.
 */
export type EventsOnlyEnvelope = {
  readonly type: 'events_only';
  readonly envelopeId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly events: ReadonlyArray<UpstreamEvent>;
  readonly occurredAt: string;
  readonly sequence?: number;
  readonly metadata?: EnvelopeMetadata;
};

/**
 * Top-level discriminated union of all sync envelope shapes.
 */
export type SyncEnvelope =
  | CommandOnlyEnvelope
  | CommandWithEventsEnvelope
  | EventsOnlyEnvelope;
