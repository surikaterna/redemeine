import { createAggregate } from '../createAggregate';
import type { Event } from '../types';

export const SAGA_RUNTIME_COMMAND_TAXONOMY = [
  'observeEvent',
  'queueIntent',
  'startIntent',
  'completeIntent',
  'failIntent',
  'scheduleRetry',
  'deadLetterIntent'
] as const;

export type SagaRuntimeCommandName = (typeof SAGA_RUNTIME_COMMAND_TAXONOMY)[number];

export const SAGA_RUNTIME_EVENT_TAXONOMY = [
  'eventObserved',
  'started',
  'intentQueued',
  'intentStarted',
  'intentCompleted',
  'intentFailed',
  'intentRetryScheduled',
  'intentDeadLettered'
] as const;

export type SagaRuntimeEventName = (typeof SAGA_RUNTIME_EVENT_TAXONOMY)[number];

export interface SagaRuntimeState {
  lifecycle: 'idle' | 'active';
  sagaInstanceKey: string | null;
  correlationId: string | null;
  startedAt: string | null;
  observedCount: number;
  lastObservedAt: string | null;
}

export interface SagaRuntimeObserveEventPayload {
  readonly sagaType: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly isStart: boolean;
  readonly observedAt: string;
}

export interface SagaRuntimeObservedEventPayload {
  readonly sagaType: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly sagaInstanceKey: string;
  readonly isStart: boolean;
  readonly observedAt: string;
}

export interface SagaRuntimeStartedEventPayload {
  readonly sagaType: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly sagaInstanceKey: string;
  readonly startedAt: string;
}

export function shouldActivateSagaFromObservation(
  state: SagaRuntimeState,
  payload: SagaRuntimeObserveEventPayload
): boolean {
  return state.lifecycle === 'idle' && payload.isStart;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`);

  return `{${entries.join(',')}}`;
}

function hashString(value: string): string {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deterministic instance-key derivation for one saga type + correlation value.
 */
export function deriveSagaRuntimeInstanceKey(
  sagaType: string,
  correlation: unknown
): string {
  return `${sagaType}:${hashString(stableSerialize(correlation))}`;
}

const INITIAL_SAGA_RUNTIME_STATE: SagaRuntimeState = {
  lifecycle: 'idle',
  sagaInstanceKey: null,
  correlationId: null,
  startedAt: null,
  observedCount: 0,
  lastObservedAt: null
};

/**
 * Hidden/internal runtime aggregate contract for saga execution bookkeeping.
 */
export const SagaRuntimeAggregate = createAggregate<SagaRuntimeState, 'sagaRuntime'>('sagaRuntime', INITIAL_SAGA_RUNTIME_STATE)
  .events({
    eventObserved: (state, event: Event<SagaRuntimeObservedEventPayload>) => {
      state.observedCount += 1;
      state.lastObservedAt = event.payload.observedAt;
    },
    started: (state, event: Event<SagaRuntimeStartedEventPayload>) => {
      state.lifecycle = 'active';
      state.sagaInstanceKey = event.payload.sagaInstanceKey;
      state.correlationId = event.payload.correlationId;
      state.startedAt = event.payload.startedAt;
    },
    intentQueued: (_state) => {
      // R1 scaffold: state transitions are implemented in downstream bead.
    },
    intentStarted: (_state) => {
      // R1 scaffold: state transitions are implemented in downstream bead.
    },
    intentCompleted: (_state) => {
      // R1 scaffold: state transitions are implemented in downstream bead.
    },
    intentFailed: (_state) => {
      // R1 scaffold: state transitions are implemented in downstream bead.
    },
    intentRetryScheduled: (_state) => {
      // R1 scaffold: state transitions are implemented in downstream bead.
    },
    intentDeadLettered: (_state) => {
      // R1 scaffold: state transitions are implemented in downstream bead.
    }
  })
  .commands((emit) => ({
    observeEvent: (state, payload: SagaRuntimeObserveEventPayload) => {
      const sagaInstanceKey = deriveSagaRuntimeInstanceKey(payload.sagaType, payload.correlationId);

      if (state.lifecycle === 'active' && state.sagaInstanceKey && state.sagaInstanceKey !== sagaInstanceKey) {
        throw new Error(
          `Saga runtime correlation mismatch: expected '${state.sagaInstanceKey}' but observed '${sagaInstanceKey}'.`
        );
      }

      const events: Event[] = [
        emit.eventObserved({
          sagaType: payload.sagaType,
          correlationId: payload.correlationId,
          causationId: payload.causationId,
          sagaInstanceKey,
          isStart: payload.isStart,
          observedAt: payload.observedAt
        })
      ];

      if (shouldActivateSagaFromObservation(state, payload)) {
        events.push(emit.started({
          sagaType: payload.sagaType,
          correlationId: payload.correlationId,
          causationId: payload.causationId,
          sagaInstanceKey,
          startedAt: payload.observedAt
        }));
      }

      return events;
    }
  }))
  .build();
