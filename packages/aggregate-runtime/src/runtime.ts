/**
 * Runtime interfaces for aggregate registration, command handling,
 * and conflict resolution.
 */

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

/**
 * A function that processes a command against aggregate state.
 * Returns the new state or an array of domain events.
 */
export type CommandHandler = (
  state: unknown,
  payload: unknown,
) => unknown | ReadonlyArray<unknown>;

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

/**
 * Context provided to a conflict resolver when upstream events
 * diverge from locally produced events.
 */
export type ConflictContext = {
  readonly producedEvents: ReadonlyArray<unknown>;
  readonly upstreamEvents: ReadonlyArray<unknown>;
  readonly aggregateType: string;
  readonly aggregateId: string;
};

/**
 * Discriminated union of conflict resolution decisions.
 */
export type ConflictDecision =
  | { readonly decision: 'accept' }
  | { readonly decision: 'reject'; readonly reason: string }
  | { readonly decision: 'override'; readonly events: ReadonlyArray<unknown> };

/**
 * A function that decides how to resolve a conflict between
 * upstream and locally produced events.
 */
export type ConflictResolver = (context: ConflictContext) => ConflictDecision;

// ---------------------------------------------------------------------------
// Aggregate registration
// ---------------------------------------------------------------------------

/**
 * Describes a single aggregate type and its command handlers.
 * An optional conflict resolver can be supplied as a per-aggregate plugin.
 */
export type AggregateRegistration = {
  readonly aggregateType: string;
  readonly commandHandlers: Record<string, CommandHandler>;
  readonly conflictResolver?: ConflictResolver;
};
