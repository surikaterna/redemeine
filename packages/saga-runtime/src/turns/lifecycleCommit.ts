import { isDeepStrictEqual } from 'node:util';
import { validateBusinessState } from '../businessStateValidation';
import type { WireIntent, WireRegistryEntry } from '../intentWire';
import { decodeLifecycleProgress, decodeLifecycleTurn, LIFECYCLE_TURN_EVENT_TYPE, type LifecycleProgressV1, type LifecycleTurnV1 } from './lifecycleWire';

export interface LifecycleCommitEvent {
  readonly type: string;
  readonly payload: unknown;
}
export interface LifecycleCommitV1 {
  readonly streamId: string;
  readonly commitId: string;
  readonly expectedNextCommitSequence: number;
  readonly events: readonly LifecycleCommitEvent[];
}

export class LifecycleCommitShapeError extends Error {
  readonly code = 'invalid_lifecycle_commit_shape';

  constructor() {
    super('invalid lifecycle commit shape');
    this.name = 'LifecycleCommitShapeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireCommitEvent(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'type') ||
    typeof value.type !== 'string' ||
    !Object.hasOwn(value, 'payload') ||
    !isRecord(value.payload)
  )
    throw new LifecycleCommitShapeError();
  return value;
}

export function createLifecycleTurnCommit(
  turn: LifecycleTurnV1,
  expectedNextCommitSequence: number,
  registry: readonly WireRegistryEntry[]
): LifecycleCommitV1 {
  const validated = decodeLifecycleTurn(turn, registry);
  if (!Number.isSafeInteger(expectedNextCommitSequence) || expectedNextCommitSequence < 0) throw new TypeError('invalid OCC sequence');
  return {
    streamId: validated.instanceId,
    commitId: validated.commitId,
    expectedNextCommitSequence,
    events: [{ type: LIFECYCLE_TURN_EVENT_TYPE, payload: validated }]
  };
}

export function decodeLifecycleTurnCommit(value: unknown, registry: readonly WireRegistryEntry[]): LifecycleCommitV1 {
  if (!isRecord(value)) throw new LifecycleCommitShapeError();
  const commit = value;
  if (
    Object.keys(commit).length !== 4 ||
    !['streamId', 'commitId', 'expectedNextCommitSequence', 'events'].every((key) => Object.hasOwn(commit, key)) ||
    typeof commit.streamId !== 'string' ||
    typeof commit.commitId !== 'string' ||
    typeof commit.expectedNextCommitSequence !== 'number' ||
    !Array.isArray(commit.events) ||
    commit.events.length !== 1
  )
    throw new LifecycleCommitShapeError();
  const event = requireCommitEvent(commit.events[0]);
  validateBusinessState(value, { maxBytes: 8 * 1024 * 1024, maxDepth: 36 });
  if (event.type !== LIFECYCLE_TURN_EVENT_TYPE) throw new TypeError('unknown lifecycle event type');
  const turn = decodeLifecycleTurn(event.payload, registry);
  if (
    commit.streamId !== turn.instanceId ||
    commit.commitId !== turn.commitId ||
    typeof commit.expectedNextCommitSequence !== 'number' ||
    !Number.isSafeInteger(commit.expectedNextCommitSequence) ||
    commit.expectedNextCommitSequence < 0
  )
    throw new TypeError('lifecycle commit identity/OCC mismatch');
  return createLifecycleTurnCommit(turn, commit.expectedNextCommitSequence, registry);
}

export function equivalentLifecycleCommit(left: unknown, right: unknown, registry: readonly WireRegistryEntry[]): boolean {
  const first = decodeLifecycleTurnCommit(left, registry);
  const second = decodeLifecycleTurnCommit(right, registry);
  return first.commitId === second.commitId && first.streamId === second.streamId && isDeepStrictEqual(first.events, second.events);
}

export function assertLifecycleReplayOrder(previous: LifecycleTurnV1 | null, next: LifecycleTurnV1): void {
  if (!previous) return;
  if (
    previous.instanceId !== next.instanceId ||
    previous.sagaKey !== next.sagaKey ||
    previous.definitionVersion !== next.definitionVersion ||
    previous.commitId === next.commitId ||
    previous.terminal !== undefined
  )
    throw new TypeError('invalid lifecycle stream order or definition migration');
}

// Claim/outcome/continuation are separate stream commits, not part of the causal turn.
// The caller must resolve the originating intentId before decoding an outcome.
export function decodeLifecycleProgressEvent(value: unknown, intent: WireIntent): LifecycleProgressV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid progress event');
  const event = value as Record<string, unknown>;
  if (Object.keys(event).length !== 2 || event.type !== 'saga.lifecycle.progress.v1.event') throw new TypeError('unknown progress event');
  return decodeLifecycleProgress(event.payload, intent);
}
