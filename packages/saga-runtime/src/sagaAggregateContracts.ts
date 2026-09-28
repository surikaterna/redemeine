import type { SagaCanonicalCorrelation } from './identity/canonicalCorrelation';
import type { DefinitionIdentityV1 } from './routing/executableIdentity';
import type { WireIntent } from './intentWire';
import type { TimerFactV1 } from './turns/lifecycleWire';
import type { SourceTriggerIdentityInput } from './identity/deterministicIds';

export type { SagaCanonicalCorrelation } from './identity/canonicalCorrelation';

export interface SagaRecentWindowLimits {
  transitions: number;
  events: number;
  intents: number;
  activities: number;
}

export interface SagaObservedSourceEventRecord {
  eventType: string;
  sourcePosition?: SourceTriggerIdentityInput;
  aggregateType?: string;
  aggregateId?: string;
  eventId?: string;
  sequence?: number;
  correlationId?: string;
  causationId?: string;
  observedAt: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SagaStateTransitionRecord {
  fromState: SagaLifecycleState;
  toState: SagaLifecycleState;
  reason?: string;
  transitionAt: string;
  metadata?: Record<string, unknown>;
}

export interface IntentExecutionRetryPolicySnapshot {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface IntentExecutionResponseRef {
  responseKey: string;
  responseId: string;
  receivedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaIntentLifecycleRecord {
  intentId: string;
  intentType: string;
  stage: 'created' | 'scheduled' | 'dispatched' | 'acknowledged' | 'failed' | 'cancelled';
  executionId?: string;
  retryPolicySnapshot?: IntentExecutionRetryPolicySnapshot | null;
  responseRef?: IntentExecutionResponseRef | null;
  recordedAt: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type IntentExecutionStatus = 'created' | 'scheduled' | 'in_progress' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export interface IntentExecution {
  id: string;
  sagaId: string;
  intentId: string;
  status: IntentExecutionStatus;
  attempt: number;
  retryPolicySnapshot: IntentExecutionRetryPolicySnapshot | null;
  responseRef: IntentExecutionResponseRef | null;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface IntentExecutionCreateCommandPayload {
  id: string;
  sagaId: string;
  intentId: string;
  status?: IntentExecutionStatus;
  attempt?: number;
  retryPolicySnapshot?: IntentExecutionRetryPolicySnapshot | null;
  responseRef?: IntentExecutionResponseRef | null;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface IntentExecutionRecordAttemptCommandPayload {
  id: string;
  attempt: number;
  status?: IntentExecutionStatus;
  retryPolicySnapshot?: IntentExecutionRetryPolicySnapshot | null;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface IntentExecutionRecordResponseRefCommandPayload {
  id: string;
  responseRef: IntentExecutionResponseRef;
  status?: IntentExecutionStatus;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface IntentExecutionMarkTerminalCommandPayload {
  id: string;
  status: Extract<IntentExecutionStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface IntentExecutionProjectionRecord extends IntentExecution {}

export interface IntentExecutionProjection {
  getById(id: string): IntentExecutionProjectionRecord | null;
  upsert(record: IntentExecutionProjectionRecord): void;
}

export interface SagaActivityLifecycleRecord {
  activityId: string;
  activityName: string;
  stage: 'started' | 'succeeded' | 'failed' | 'timedOut' | 'cancelled';
  attempt?: number;
  recordedAt: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export type SagaLifecycleState = 'idle' | 'active' | 'completed' | 'failed' | 'cancelled';

export interface SagaAggregateState<TState = unknown> {
  id: string | null;
  sagaType: string | null;
  sagaKey?: string | null;
  definitionVersion?: number | null;
  definitionIdentity?: DefinitionIdentityV1 | null;
  correlation?: SagaCanonicalCorrelation | null;
  businessState?: TState | null;
  lifecycleState: SagaLifecycleState;
  createdAt: string | null;
  updatedAt: string | null;
  transitionVersion: number;
  totals: {
    transitions: number;
    observedEvents: number;
    intents: number;
    activities: number;
  };
  recent: {
    transitions: SagaStateTransitionRecord[];
    events: SagaObservedSourceEventRecord[];
    intents: SagaIntentLifecycleRecord[];
    activities: SagaActivityLifecycleRecord[];
  };
}

export interface NormalizedSagaAggregateState<TState = unknown> extends SagaAggregateState<TState> {
  sagaKey: string | null;
  definitionVersion: number | null;
  definitionIdentity: DefinitionIdentityV1 | null;
  correlation: SagaCanonicalCorrelation | null;
  businessState: TState | null;
}

export interface SagaAggregateProjection<TState = unknown> {
  getById(id: string): SagaAggregateState<TState> | null;
  upsert(record: SagaAggregateState<TState>): void;
}

export interface SagaCreateInstanceCommandPayload {
  id: string;
  sagaType: string;
  lifecycleState?: SagaAggregateState['lifecycleState'];
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaRecordDefinitionIdentityCommandPayload extends DefinitionIdentityV1 {
  schemaVersion: 1;
}

export interface SagaDefinitionIdentityRecordedEventPayload extends SagaRecordDefinitionIdentityCommandPayload {}

export interface SagaObserveSourceEventCommandPayload {
  eventType: string;
  aggregateType?: string;
  aggregateId?: string;
  eventId?: string;
  sequence?: number;
  correlationId?: string;
  causationId?: string;
  observedAt?: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SagaRecordStateTransitionCommandPayload {
  fromState: SagaLifecycleState;
  toState: SagaLifecycleState;
  reason?: string;
  transitionAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaRecordIntentLifecycleCommandPayload {
  intentId: string;
  intentType: string;
  stage: SagaIntentLifecycleRecord['stage'];
  recordedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaRecordActivityLifecycleCommandPayload {
  activityId: string;
  activityName: string;
  stage: SagaActivityLifecycleRecord['stage'];
  attempt?: number;
  recordedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SagaRecordBusinessStateCommandPayload<TState = unknown> {
  schemaVersion: 1;
  sagaKey: string;
  definitionVersion: number;
  correlation: SagaCanonicalCorrelation;
  sourceTriggerId: string;
  state: TState;
  recordedAt: string;
}

export interface SagaInstanceCreatedEventPayload {
  id: string;
  sagaType: string;
  lifecycleState: SagaAggregateState['lifecycleState'];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface SagaSourceEventObservedEventPayload {
  record: SagaObservedSourceEventRecord;
}

export interface SagaStateTransitionedEventPayload {
  record: SagaStateTransitionRecord;
}

export interface SagaIntentLifecycleRecordedEventPayload {
  record: SagaIntentLifecycleRecord;
}

export interface SagaActivityLifecycleRecordedEventPayload {
  record: SagaActivityLifecycleRecord;
}

export interface SagaBusinessStateRecordedEventPayload<TState = unknown> extends SagaRecordBusinessStateCommandPayload<TState> {}

export interface SagaIntentRecordedEventPayload {
  schemaVersion: 1;
  intent: WireIntent;
}

export interface SagaTimerFactRecordedEventPayload {
  schemaVersion: 1;
  fact: TimerFactV1;
}

export type SagaTransitionInvariantCode =
  | 'saga_instance_not_created'
  | 'saga_instance_already_created'
  | 'saga_transition_from_state_mismatch'
  | 'saga_transition_invalid_lifecycle_state'
  | 'saga_transition_noop'
  | 'saga_transition_from_terminal_state';

export class SagaTransitionInvariantError extends Error {
  readonly code: SagaTransitionInvariantCode;
  readonly details: Record<string, unknown>;

  constructor(code: SagaTransitionInvariantCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SagaTransitionInvariantError';
    this.code = code;
    this.details = details;
  }
}

export function assertSagaLifecycleState(value: unknown): asserts value is SagaLifecycleState {
  if (value === 'idle' || value === 'active' || value === 'completed' || value === 'failed' || value === 'cancelled') return;
  throw new SagaTransitionInvariantError(
    'saga_transition_invalid_lifecycle_state',
    'Saga lifecycle state must be idle, active, completed, failed, or cancelled',
    { value }
  );
}
