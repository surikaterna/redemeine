import type { SagaCommandMap } from './createSaga';
import { PendingIntentProjection, type PendingIntentRecord } from './PendingIntentProjection';
import type { SagaIntentRecordedEvent, SagaLifecycleEvent } from './SagaEventStore';

export type SagaExecutionDecisionReason =
  | 'execute'
  | 'no-op-already-dispatched'
  | 'no-op-already-succeeded'
  | 'skip-intent-not-found';

export interface SagaExecutionDecision {
  readonly shouldExecute: boolean;
  readonly reason: SagaExecutionDecisionReason;
}

export interface SagaEventStoreIntentReader<TCommandMap extends SagaCommandMap = SagaCommandMap> {
  loadIntentRecordedEvents(sagaStreamId: string): Promise<readonly SagaIntentRecordedEvent<TCommandMap>[]>;
  loadLifecycleEvents(sagaStreamId: string): Promise<readonly SagaLifecycleEvent[]>;
}

function decideFromIntentRecord<TCommandMap extends SagaCommandMap>(
  intent: PendingIntentRecord<TCommandMap> | undefined
): SagaExecutionDecision {
  if (!intent) {
    return {
      shouldExecute: false,
      reason: 'skip-intent-not-found'
    };
  }

  if (intent.status === 'dispatched') {
    return {
      shouldExecute: false,
      reason: 'no-op-already-dispatched'
    };
  }

  if (intent.status === 'succeeded') {
    return {
      shouldExecute: false,
      reason: 'no-op-already-succeeded'
    };
  }

  return {
    shouldExecute: true,
    reason: 'execute'
  };
}

export function decideIntentExecutionFromProjection<TCommandMap extends SagaCommandMap>(
  projection: PendingIntentProjection<TCommandMap>,
  intentKey: string
): SagaExecutionDecision {
  return decideFromIntentRecord(projection.getByIntentKey(intentKey));
}

export async function decideIntentExecutionFromEventStore<TCommandMap extends SagaCommandMap>(
  eventStore: SagaEventStoreIntentReader<TCommandMap>,
  sagaStreamId: string,
  intentKey: string
): Promise<SagaExecutionDecision> {
  const [recordedEvents, lifecycleEvents] = await Promise.all([
    eventStore.loadIntentRecordedEvents(sagaStreamId),
    eventStore.loadLifecycleEvents(sagaStreamId)
  ]);

  const projection = new PendingIntentProjection<TCommandMap>();
  projection.projectEvents(recordedEvents, lifecycleEvents);

  return decideIntentExecutionFromProjection(projection, intentKey);
}
