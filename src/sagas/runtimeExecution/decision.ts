import { decidePendingIntentRoute } from '../SagaIntentRouter';
import type { PendingIntentRecord } from '../PendingIntentProjection';
import type { SagaRuntimeIntentState } from '../SagaRuntimeAggregate';
import type { SagaIntentRouteDecision } from '../SagaIntentRouter';
import type { SagaCommandMap } from '../createSaga';
import type {
  DecideDueSagaIntentExecutionOptions,
  SagaIntentExecutionDecision,
  SagaIntentExecutionTicket,
  SagaRuntimeDepotLike
} from './contracts';

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function decideFromRuntimeIntentState<TCommandMap extends SagaCommandMap>(
  record: PendingIntentRecord<TCommandMap>,
  routeDecision: SagaIntentRouteDecision,
  runtimeIntentState: SagaRuntimeIntentState | undefined,
  now: string
): SagaIntentExecutionDecision<TCommandMap> {
  if (!runtimeIntentState) {
    return {
      shouldExecute: false,
      reason: 'skip-intent-not-found',
      record,
      routeDecision
    };
  }

  if (runtimeIntentState.status === 'completed') {
    return {
      shouldExecute: false,
      reason: 'no-op-already-completed',
      record,
      routeDecision
    };
  }

  if (runtimeIntentState.status === 'dead_lettered') {
    return {
      shouldExecute: false,
      reason: 'no-op-already-dead-lettered',
      record,
      routeDecision
    };
  }

  if (runtimeIntentState.status === 'in_progress') {
    return {
      shouldExecute: false,
      reason: 'no-op-already-in-progress',
      record,
      routeDecision
    };
  }

  if (runtimeIntentState.status === 'failed') {
    return {
      shouldExecute: false,
      reason: 'skip-failed-awaiting-transition',
      record,
      routeDecision
    };
  }

  if (runtimeIntentState.status === 'retry_scheduled' && runtimeIntentState.nextAttemptAt && runtimeIntentState.nextAttemptAt > now) {
    return {
      shouldExecute: false,
      reason: 'skip-not-due',
      record,
      routeDecision
    };
  }

  return {
    shouldExecute: true,
    reason: 'execute',
    record,
    routeDecision
  };
}

/**
 * Decision phase for due intent execution.
 *
 * Loads runtime state through Depot and decides if execution should proceed,
 * without invoking worker side-effects.
 */
export async function decideDueSagaIntentExecution<TCommandMap extends SagaCommandMap>(
  record: PendingIntentRecord<TCommandMap>,
  runtimeDepot: SagaRuntimeDepotLike,
  options: DecideDueSagaIntentExecutionOptions = {}
): Promise<SagaIntentExecutionTicket<TCommandMap>> {
  const now = toIsoString((options.now ?? (() => new Date()))());
  const runtimeAggregate = await runtimeDepot.get(record.sagaStreamId);
  const routeDecision = decidePendingIntentRoute(record);
  const runtimeIntentState = runtimeAggregate.intents[record.intentKey];

  return {
    decision: decideFromRuntimeIntentState(record, routeDecision, runtimeIntentState, now),
    runtimeAggregate
  };
}
