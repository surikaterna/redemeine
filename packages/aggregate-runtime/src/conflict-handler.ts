/**
 * Conflict detection and delegation for command_with_events envelopes.
 * Compares locally produced events against upstream events and delegates
 * to the per-aggregate conflict resolver when they diverge.
 */

import type { ConflictResolver, ConflictDecision } from './runtime';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input context for the conflict handler.
 */
export type ConflictHandlerContext = {
  readonly producedEvents: ReadonlyArray<unknown>;
  readonly upstreamEvents: ReadonlyArray<unknown>;
  readonly resolver: ConflictResolver | undefined;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly envelopeId: string;
};

/**
 * Discriminated union of conflict handling outcomes.
 */
export type ConflictHandlerResult =
  | { readonly outcome: 'no_conflict' }
  | { readonly outcome: 'resolved'; readonly decision: ConflictDecision; readonly events: ReadonlyArray<unknown> }
  | { readonly outcome: 'unresolved'; readonly reason: string };

// ---------------------------------------------------------------------------
// Event comparison
// ---------------------------------------------------------------------------

/**
 * Compare two event arrays for deep equality on type + payload.
 * Returns `true` if both arrays have the same length and each
 * corresponding event pair has identical type and payload values.
 */
export function eventsMatch(
  a: ReadonlyArray<unknown>,
  b: ReadonlyArray<unknown>,
): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    const eventA = a[i] as { type?: string; payload?: unknown };
    const eventB = b[i] as { type?: string; payload?: unknown };

    if (eventA.type !== eventB.type) {
      return false;
    }

    if (!deepEqual(eventA.payload, eventB.payload)) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Deep equality helper
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      return false;
    }
    if (!deepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    )) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Conflict handler
// ---------------------------------------------------------------------------

/**
 * Detect and resolve conflicts between locally produced events
 * and upstream events carried in a command_with_events envelope.
 *
 * - Events match → `no_conflict`
 * - Events differ + resolver → delegate to resolver
 * - Events differ + no resolver → `unresolved`
 */
export function handleConflict(context: ConflictHandlerContext): ConflictHandlerResult {
  if (eventsMatch(context.producedEvents, context.upstreamEvents)) {
    return { outcome: 'no_conflict' };
  }

  if (context.resolver === undefined) {
    return {
      outcome: 'unresolved',
      reason: 'no conflict resolver registered',
    };
  }

  const decision = context.resolver({
    producedEvents: context.producedEvents,
    upstreamEvents: context.upstreamEvents,
    aggregateType: context.aggregateType,
    aggregateId: context.aggregateId,
  });

  switch (decision.decision) {
    case 'accept':
      return {
        outcome: 'resolved',
        decision,
        events: context.upstreamEvents,
      };
    case 'reject':
      return {
        outcome: 'resolved',
        decision,
        events: [],
      };
    case 'override':
      return {
        outcome: 'resolved',
        decision,
        events: decision.events,
      };
  }
}
