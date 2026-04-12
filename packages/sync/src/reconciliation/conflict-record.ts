import type { SyncEvent } from './event-store-adapter';

/**
 * Archived record of a reconciliation conflict for ops/debugging.
 * When authoritative events from upstream diverge from local events,
 * the local events are archived here before being replaced.
 */
export interface ConflictRecord {
  /** The command ID that caused the conflict. */
  readonly commandId: string;

  /** The aggregate stream where the conflict occurred. */
  readonly streamId: string;

  /** The local events that were displaced by authoritative events. */
  readonly displacedEvents: ReadonlyArray<SyncEvent>;

  /** The authoritative events that replaced the local ones. */
  readonly authoritativeEvents: ReadonlyArray<SyncEvent>;

  /** ISO-8601 timestamp when the conflict was detected. */
  readonly detectedAt: string;
}
