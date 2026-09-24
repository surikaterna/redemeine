import {
  type ProjectionJsonObject,
  type ProjectionSourceCommit,
  validateProjectionSourceCommit
} from '@redemeine/projection-runtime-core';
import type { IBaseEvent, ICommit } from 'tapeworm';

export interface TapewormProjectionEvent extends IBaseEvent {
  aggregateType: string;
  aggregateId: string;
  payload: ProjectionJsonObject;
  timestamp: string;
  headers?: ProjectionJsonObject;
  metadata?: ProjectionJsonObject;
}

export interface TapewormProjectionCommit extends ICommit<TapewormProjectionEvent> {
  headers?: ProjectionJsonObject;
  metadata?: ProjectionJsonObject;
}

export type DecodeTapewormCommitResult =
  | { status: 'valid'; commit: ProjectionSourceCommit }
  | { status: 'malformed'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSourceCommit(wire: Record<string, unknown>): unknown {
  const events = Array.isArray(wire.events)
    ? wire.events.map((candidate, eventIndex) => {
        if (!isRecord(candidate)) return candidate;
        return {
          eventId: candidate.id,
          eventIndex,
          streamVersion: candidate.version,
          aggregateType: candidate.aggregateType,
          aggregateId: candidate.aggregateId,
          type: candidate.type,
          payload: candidate.payload,
          timestamp: candidate.timestamp,
          ...('headers' in candidate ? { headers: candidate.headers } : {}),
          ...('metadata' in candidate ? { metadata: candidate.metadata } : {})
        };
      })
    : wire.events;
  return {
    streamId: wire.streamId,
    commitId: wire.id,
    commitSequence: wire.commitSequence,
    events,
    ...('headers' in wire ? { headers: wire.headers } : {}),
    ...('metadata' in wire ? { metadata: wire.metadata } : {})
  };
}

export function decodeTapewormProjectionCommit(
  candidate: unknown,
  expectedMessageId?: string
): DecodeTapewormCommitResult {
  if (!isRecord(candidate)) return { status: 'malformed', reason: 'Commit wire must be an object.' };
  if (expectedMessageId === undefined || expectedMessageId.length === 0) {
    return { status: 'malformed', reason: 'Rabbit messageId is required.' };
  }
  if (candidate.id !== expectedMessageId) {
    return { status: 'malformed', reason: 'Rabbit messageId must equal the Tapeworm commit id.' };
  }
  const decoded = toSourceCommit(candidate);
  const validation = validateProjectionSourceCommit(decoded);
  return validation.valid
    ? { status: 'valid', commit: validation.value }
    : { status: 'malformed', reason: `Invalid Tapeworm commit: ${validation.issues.join(',')}` };
}
