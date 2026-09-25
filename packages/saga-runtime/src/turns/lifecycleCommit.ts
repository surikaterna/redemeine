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
  validateBusinessState(value, { maxBytes: 8 * 1024 * 1024, maxDepth: 36 });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid lifecycle commit');
  const commit = value as Record<string, unknown>;
  if (Object.keys(commit).length !== 4 || !Object.hasOwn(commit, 'events') || !Array.isArray(commit.events) || commit.events.length !== 1)
    throw new TypeError('invalid lifecycle commit shape');
  const event = commit.events[0] as Record<string, unknown>;
  if (Object.keys(event).length !== 2 || event.type !== LIFECYCLE_TURN_EVENT_TYPE) throw new TypeError('unknown lifecycle event type');
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
