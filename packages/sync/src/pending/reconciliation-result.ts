// ---------------------------------------------------------------------------
// Reconciliation result types
// ---------------------------------------------------------------------------

/**
 * Outcome when pending events matched the authoritative events exactly.
 * The pending events were transitioned to `confirmed` status.
 */
export interface ConfirmedOutcome {
  readonly outcome: 'confirmed';
  readonly commandId: string;
  readonly eventCount: number;
}

/**
 * Outcome when authoritative events diverged from pending events.
 * Pending events were marked `superseded` and authoritative replacements
 * were inserted.
 */
export interface SupersededOutcome {
  readonly outcome: 'superseded';
  readonly commandId: string;
  readonly pendingEventCount: number;
  readonly authoritativeEventCount: number;
}

/**
 * Outcome when no pending events existed for the command ID.
 * Authoritative events were applied as new confirmed events.
 */
export interface NewOutcome {
  readonly outcome: 'new';
  readonly commandId: string;
  readonly eventCount: number;
}

/**
 * Outcome when events for this command were already confirmed.
 * No-op — idempotent reconciliation.
 */
export interface AlreadyConfirmedOutcome {
  readonly outcome: 'already_confirmed';
  readonly commandId: string;
}

/**
 * Outcome when reconciliation failed due to a store or logic error.
 */
export interface ErrorOutcome {
  readonly outcome: 'error';
  readonly commandId: string;
  readonly reason: string;
}

/**
 * Discriminated union of all possible reconciliation outcomes.
 *
 * Consumers switch on `outcome` to handle each case:
 * - `confirmed`         — pending matched authoritative exactly
 * - `superseded`        — upstream diverged, pending replaced
 * - `new`               — no pending match, applied as new confirmed
 * - `already_confirmed` — idempotent, events already confirmed
 * - `error`             — reconciliation failed
 */
export type ReconciliationResult =
  | ConfirmedOutcome
  | SupersededOutcome
  | NewOutcome
  | AlreadyConfirmedOutcome
  | ErrorOutcome;
