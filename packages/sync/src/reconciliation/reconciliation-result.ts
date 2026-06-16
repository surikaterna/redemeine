import type { ConflictRecord } from './conflict-record';

/** Local events matched authoritative exactly — command acked, no replacement needed. */
export interface MatchedOutcome {
  readonly outcome: 'matched';
  readonly commandId: string;
  readonly eventCount: number;
}

/** Local events diverged from authoritative — replaced, conflict archived. */
export interface ConflictOutcome {
  readonly outcome: 'conflict';
  readonly commandId: string;
  readonly conflictRecord: ConflictRecord;
}

/** No local events existed — authoritative events written as-is. */
export interface AppliedOutcome {
  readonly outcome: 'applied';
  readonly commandId: string;
  readonly eventCount: number;
}

/** Reconciliation failed due to an error. */
export interface ErrorOutcome {
  readonly outcome: 'error';
  readonly commandId: string;
  readonly reason: string;
}

/**
 * Discriminated union of reconciliation outcomes.
 * Simplified to match/conflict/applied/error.
 */
export type ReconciliationOutcome =
  | MatchedOutcome
  | ConflictOutcome
  | AppliedOutcome
  | ErrorOutcome;
