import type { ISyncEventStore } from '../store/sync-event-store';
import type { StoredEvent } from '../store/stored-event';
import type { NewEvent } from '../store/sync-event-store';
import type { ReconciliationResult } from './reconciliation-result';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * An authoritative event received from an upstream node.
 * Used to reconcile against locally-produced pending events.
 */
export interface AuthoritativeEvent {
  readonly type: string;
  readonly payload: unknown;
  readonly eventId?: string;
}

/**
 * Strategy for matching a pending {@link StoredEvent} against an
 * {@link AuthoritativeEvent}. Consumers can provide custom matchers
 * to relax or tighten the comparison rules.
 */
export interface EventMatcher {
  match(pending: StoredEvent, authoritative: AuthoritativeEvent): boolean;
}

// ---------------------------------------------------------------------------
// Default matching strategy
// ---------------------------------------------------------------------------

/**
 * Recursively compares two values for structural equality.
 * Handles primitives, arrays, plain objects, and `null`.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  if (typeof a === 'object') {
    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;
    const keysA = Object.keys(objA);
    const keysB = Object.keys(objB);
    if (keysA.length !== keysB.length) return false;
    return keysA.every(
      (key) => Object.prototype.hasOwnProperty.call(objB, key) && deepEqual(objA[key], objB[key]),
    );
  }

  return false;
}

/**
 * Default matcher: events match when their `type` is identical
 * and their `payload` is structurally equal (deep comparison).
 */
export function defaultEventMatcher(): EventMatcher {
  return {
    match(pending: StoredEvent, authoritative: AuthoritativeEvent): boolean {
      return pending.type === authoritative.type && deepEqual(pending.payload, authoritative.payload);
    },
  };
}

// ---------------------------------------------------------------------------
// Reconciliation dispatcher
// ---------------------------------------------------------------------------

/**
 * Collects all events from an async iterable into an array.
 */
async function collectEvents(iterable: AsyncIterable<StoredEvent>): Promise<ReadonlyArray<StoredEvent>> {
  const events: StoredEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

/**
 * Determines whether two event sequences match element-by-element
 * using the provided matcher strategy.
 */
function sequenceMatches(
  pending: ReadonlyArray<StoredEvent>,
  authoritative: ReadonlyArray<AuthoritativeEvent>,
  matcher: EventMatcher,
): boolean {
  if (pending.length !== authoritative.length) return false;
  return pending.every((p, i) => matcher.match(p, authoritative[i]));
}

/**
 * Converts authoritative events into {@link NewEvent} records
 * suitable for the store's `saveEvents` or `supersedeEvents` calls.
 */
function toNewEvents(events: ReadonlyArray<AuthoritativeEvent>): ReadonlyArray<NewEvent> {
  return events.map((e) => ({
    type: e.type,
    payload: e.payload,
    occurredAt: new Date().toISOString(),
  }));
}

/**
 * Orchestrates the reconciliation of authoritative upstream events
 * against locally-produced pending events for a given command ID.
 *
 * Reconciliation outcomes:
 * 1. No pending events found → apply as new confirmed events.
 * 2. Pending events match authoritative → confirm pending events.
 * 3. Pending events diverge from authoritative → supersede and replace.
 * 4. Events already confirmed → idempotent no-op.
 */
export class ReconciliationDispatcher {
  private readonly store: ISyncEventStore;
  private readonly matcher: EventMatcher;

  constructor(store: ISyncEventStore, matcher?: EventMatcher) {
    this.store = store;
    this.matcher = matcher ?? defaultEventMatcher();
  }

  /**
   * Reconciles authoritative events from upstream against pending
   * events in the local store for the given command ID.
   *
   * @param commandId            — client-assigned correlation key.
   * @param streamId             — aggregate stream containing the events.
   * @param authoritativeEvents  — events from the upstream authority.
   */
  async reconcile(
    commandId: string,
    streamId: string,
    authoritativeEvents: ReadonlyArray<AuthoritativeEvent>,
  ): Promise<ReconciliationResult> {
    try {
      const allEvents = await collectEvents(this.store.readStream(streamId));

      const pendingForCommand = allEvents.filter(
        (e) => e.commandId === commandId && e.status === 'pending',
      );

      const confirmedForCommand = allEvents.filter(
        (e) => e.commandId === commandId && e.status === 'confirmed',
      );

      // Already confirmed — idempotent
      if (confirmedForCommand.length > 0) {
        return { outcome: 'already_confirmed', commandId };
      }

      // No pending events — apply as new confirmed
      if (pendingForCommand.length === 0) {
        const newEvents = toNewEvents(authoritativeEvents);
        await this.store.saveEvents(streamId, newEvents, {
          status: 'confirmed',
          commandId,
        });
        return { outcome: 'new', commandId, eventCount: authoritativeEvents.length };
      }

      // Pending events exist — check for match
      if (sequenceMatches(pendingForCommand, authoritativeEvents, this.matcher)) {
        await this.store.confirmEvents(commandId);
        return { outcome: 'confirmed', commandId, eventCount: pendingForCommand.length };
      }

      // Pending events diverge — supersede
      const replacements = toNewEvents(authoritativeEvents);
      await this.store.supersedeEvents(commandId, replacements);
      return {
        outcome: 'superseded',
        commandId,
        pendingEventCount: pendingForCommand.length,
        authoritativeEventCount: authoritativeEvents.length,
      };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return { outcome: 'error', commandId, reason };
    }
  }
}
