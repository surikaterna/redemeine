import type { SyncEvent } from './event-store-adapter';
import type { IReconciliationEventStoreAdapter } from './event-store-adapter';
import type { IConflictArchive } from './conflict-archive';
import type { ReconciliationOutcome } from './reconciliation-result';
import type { ConflictRecord } from './conflict-record';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Options for constructing a reconciliation service.
 */
export interface ReconciliationServiceOptions {
  /** Adapter for event store operations (find/replace by commandId). */
  readonly eventStoreAdapter: IReconciliationEventStoreAdapter;

  /**
   * Archive for persisting conflict records. Optional — conflicts
   * are logged but not persisted if omitted.
   */
  readonly conflictArchive?: IConflictArchive;

  /**
   * Strategy for comparing local vs authoritative events.
   * Default: compare event.type + deep-equal event.payload.
   * (event.metadata is excluded from comparison since upstream may
   * enrich metadata differently.)
   */
  readonly eventMatcher?: EventMatcher;
}

// ---------------------------------------------------------------------------
// Event matching
// ---------------------------------------------------------------------------

/**
 * Compares a local event against an authoritative event to determine
 * whether they represent the same logical outcome.
 */
export interface EventMatcher {
  match(local: SyncEvent, authoritative: SyncEvent): boolean;
}

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
      (key) =>
        Object.prototype.hasOwnProperty.call(objB, key) &&
        deepEqual(objA[key], objB[key]),
    );
  }

  return false;
}

/** Default matcher: events match when type is identical and payload is deep-equal. */
export function defaultEventMatcher(): EventMatcher {
  return {
    match(local: SyncEvent, authoritative: SyncEvent): boolean {
      return (
        local.type === authoritative.type &&
        deepEqual(local.payload, authoritative.payload)
      );
    },
  };
}

/**
 * Determines whether two event sequences match element-by-element
 * using the provided matcher strategy.
 */
function sequencesMatch(
  local: ReadonlyArray<SyncEvent>,
  authoritative: ReadonlyArray<SyncEvent>,
  matcher: EventMatcher,
): boolean {
  if (local.length !== authoritative.length) return false;
  return local.every((l, i) => matcher.match(l, authoritative[i]));
}

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

/**
 * Contract for the reconciliation service.
 * Thin interface — one method — that handles matching and replacing
 * events by commandId when authoritative events arrive from upstream.
 */
export interface IReconciliationService {
  /**
   * Reconciles authoritative events against local events for a command.
   *
   * Flow:
   * 1. Find local events for commandId in streamId
   * 2. If none exist → save authoritative events → 'applied'
   * 3. If match (same events) → no-op → 'matched'
   * 4. If mismatch → archive locals, replace with authoritative → 'conflict'
   */
  reconcile(
    commandId: string,
    streamId: string,
    authoritativeEvents: ReadonlyArray<SyncEvent>,
  ): Promise<ReconciliationOutcome>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the default IReconciliationService implementation.
 */
export function createReconciliationService(
  options: ReconciliationServiceOptions,
): IReconciliationService {
  const matcher = options.eventMatcher ?? defaultEventMatcher();

  return {
    async reconcile(
      commandId: string,
      streamId: string,
      authoritativeEvents: ReadonlyArray<SyncEvent>,
    ): Promise<ReconciliationOutcome> {
      try {
        const localEvents =
          await options.eventStoreAdapter.findEventsByCommandId(
            streamId,
            commandId,
          );

        // Case 1: No local events — apply authoritative as-is
        if (localEvents.length === 0) {
          await options.eventStoreAdapter.saveEvents(
            streamId,
            authoritativeEvents,
          );
          return {
            outcome: 'applied',
            commandId,
            eventCount: authoritativeEvents.length,
          };
        }

        // Case 2: Local events match authoritative — no-op
        if (sequencesMatch(localEvents, authoritativeEvents, matcher)) {
          return {
            outcome: 'matched',
            commandId,
            eventCount: localEvents.length,
          };
        }

        // Case 3: Conflict — archive locals, replace with authoritative
        const displacedEvents =
          await options.eventStoreAdapter.replaceEventsByCommandId(
            streamId,
            commandId,
            authoritativeEvents,
          );

        const conflictRecord: ConflictRecord = {
          commandId,
          streamId,
          displacedEvents,
          authoritativeEvents,
          detectedAt: new Date().toISOString(),
        };

        if (options.conflictArchive) {
          await options.conflictArchive.archive(conflictRecord);
        }

        return {
          outcome: 'conflict',
          commandId,
          conflictRecord,
        };
      } catch (error: unknown) {
        const reason =
          error instanceof Error ? error.message : String(error);
        return { outcome: 'error', commandId, reason };
      }
    },
  };
}
