import type {
  SagaCancelScheduleIntent,
  SagaCommandMap,
  SagaDispatchIntent,
  SagaIntent,
  SagaRunActivityIntent,
  SagaScheduleIntent
} from './createSaga';
import { decideIntentExecutionFromProjection } from './DedupeGuard';
import type { PendingIntentProjection, PendingIntentRecord } from './PendingIntentProjection';
import type { SagaTimerWakeUpIntent } from './SagaTimeoutCronScanner';

export const SAGA_WORKER_HANDLER_PATHS = {
  dispatch: 'worker.dispatch',
  schedule: 'worker.schedule',
  'cancel-schedule': 'worker.cancelSchedule',
  'run-activity': 'worker.runActivity'
} as const;

export type SagaIntentType = SagaIntent<SagaCommandMap>['type'];

export type SagaWorkerHandlerPath = (typeof SAGA_WORKER_HANDLER_PATHS)[SagaIntentType];

export interface SagaIntentRouteDecision {
  readonly intentKey: string;
  readonly intentType: SagaIntentType;
  readonly handlerPath: SagaWorkerHandlerPath;
}

export interface SagaIntentRouteExecutionInput<TCommandMap extends SagaCommandMap> {
  readonly record: PendingIntentRecord<TCommandMap>;
  readonly decision: SagaIntentRouteDecision;
}

export interface SagaIntentWorkerHandlers<TCommandMap extends SagaCommandMap = SagaCommandMap> {
  readonly dispatch: (
    intent: SagaDispatchIntent<TCommandMap>,
    record: PendingIntentRecord<TCommandMap>
  ) => unknown | Promise<unknown>;
  readonly schedule: (intent: SagaScheduleIntent, record: PendingIntentRecord<TCommandMap>) => unknown | Promise<unknown>;
  readonly cancelSchedule: (
    intent: SagaCancelScheduleIntent,
    record: PendingIntentRecord<TCommandMap>
  ) => unknown | Promise<unknown>;
  readonly runActivity: (
    intent: SagaRunActivityIntent,
    record: PendingIntentRecord<TCommandMap>
  ) => unknown | Promise<unknown>;
}

export class UnknownSagaIntentTypeError extends Error {
  readonly intentType: string;
  readonly intentKey: string;

  constructor(intentType: string, intentKey: string) {
    super(
      `Unknown saga intent type '${intentType}' for intent '${intentKey}'. Expected one of: dispatch, schedule, cancel-schedule, run-activity.`
    );
    this.name = 'UnknownSagaIntentTypeError';
    this.intentType = intentType;
    this.intentKey = intentKey;
  }
}

function isKnownSagaIntentType(intentType: string): intentType is SagaIntentType {
  return intentType in SAGA_WORKER_HANDLER_PATHS;
}

function resolveKnownSagaWorkerHandlerPath(intentType: SagaIntentType): SagaWorkerHandlerPath {
  return SAGA_WORKER_HANDLER_PATHS[intentType];
}

export function resolveSagaWorkerHandlerPath(intentType: string, intentKey: string): SagaWorkerHandlerPath {
  if (!isKnownSagaIntentType(intentType)) {
    throw new UnknownSagaIntentTypeError(intentType, intentKey);
  }

  return resolveKnownSagaWorkerHandlerPath(intentType);
}

export async function routePendingIntentByType<TCommandMap extends SagaCommandMap>(
  record: PendingIntentRecord<TCommandMap>,
  handlers: SagaIntentWorkerHandlers<TCommandMap>
): Promise<SagaIntentRouteDecision> {
  const decision = decidePendingIntentRoute(record);
  await executePendingIntentRouteDecision({ record, decision }, handlers);
  return decision;
}

/**
 * Decision phase: resolve handler path and routing metadata without side-effects.
 */
export function decidePendingIntentRoute<TCommandMap extends SagaCommandMap>(
  record: PendingIntentRecord<TCommandMap>
): SagaIntentRouteDecision {
  const { intent } = record;

  return {
    intentKey: record.intentKey,
    intentType: intent.type,
    handlerPath: resolveSagaWorkerHandlerPath(intent.type, record.intentKey)
  };
}

/**
 * Execution phase: invoke previously selected handler.
 */
export async function executePendingIntentRouteDecision<TCommandMap extends SagaCommandMap>(
  input: SagaIntentRouteExecutionInput<TCommandMap>,
  handlers: SagaIntentWorkerHandlers<TCommandMap>
): Promise<void> {
  const { record, decision } = input;
  const { intent } = record;

  if (decision.intentType === 'dispatch') {
    await handlers.dispatch(intent as SagaDispatchIntent<TCommandMap>, record);
    return;
  }

  if (decision.intentType === 'schedule') {
    await handlers.schedule(intent as SagaScheduleIntent, record);
    return;
  }

  if (decision.intentType === 'cancel-schedule') {
    await handlers.cancelSchedule(intent as SagaCancelScheduleIntent, record);
    return;
  }

  if (decision.intentType === 'run-activity') {
    await handlers.runActivity(intent as SagaRunActivityIntent, record);
    return;
  }

  throw new UnknownSagaIntentTypeError((intent as { type: string }).type, record.intentKey);
}

export interface SagaRouterProcessTickOptions {
  readonly now?: () => string | Date;
  readonly onRouted?: (decision: SagaIntentRouteDecision) => void;
}

export interface SagaTimeoutWakeUpRoutingOptions {
  readonly onRouted?: (decision: SagaIntentRouteDecision) => void;
}

export class MissingSagaWakeUpIntentRecordError extends Error {
  readonly intentKey: string;

  constructor(intentKey: string) {
    super(`Unable to route wake-up intent '${intentKey}' because no pending intent record exists.`);
    this.name = 'MissingSagaWakeUpIntentRecordError';
    this.intentKey = intentKey;
  }
}

export function createSagaRouterProcessTick<TCommandMap extends SagaCommandMap>(
  projection: PendingIntentProjection<TCommandMap>,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: SagaRouterProcessTickOptions = {}
): () => Promise<number> {
  const now = options.now ?? (() => new Date());

  return async () => {
    const pendingIntents = projection.getExecutablePendingIntents(now());

    for (const pending of pendingIntents) {
      const decision = await routePendingIntentByType(pending, handlers);
      options.onRouted?.(decision);
    }

    return pendingIntents.length;
  };
}

/**
 * S19 bridge for routing timeout wake-up intents through normal intent routing.
 */
export function createSagaTimeoutWakeUpIntentRouter<TCommandMap extends SagaCommandMap>(
  projection: PendingIntentProjection<TCommandMap>,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: SagaTimeoutWakeUpRoutingOptions = {}
): (wakeUpIntent: SagaTimerWakeUpIntent) => Promise<SagaIntentRouteDecision> {
  return async wakeUpIntent => {
    const record = projection.getByIntentKey(wakeUpIntent.intentKey);
    if (!record) {
      throw new MissingSagaWakeUpIntentRecordError(wakeUpIntent.intentKey);
    }

    const decision = await routePendingIntentByType(record, handlers);
    options.onRouted?.(decision);

    return decision;
  };
}

export type SagaStartupRequeueOptions = SagaRouterProcessTickOptions;

/**
 * S15 startup recovery scan.
 * Requeues executable pending intents once per process start.
 */
export function createSagaStartupRequeueScan<TCommandMap extends SagaCommandMap>(
  projection: PendingIntentProjection<TCommandMap>,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: SagaStartupRequeueOptions = {}
): () => Promise<number> {
  const now = options.now ?? (() => new Date());

  return async () => {
    const pendingIntents = projection.getExecutablePendingIntents(now());

    for (const pending of pendingIntents) {
      const executionDecision = decideIntentExecutionFromProjection(projection, pending.intentKey);
      if (!executionDecision.shouldExecute) {
        continue;
      }

      const decision = await routePendingIntentByType(pending, handlers);
      options.onRouted?.(decision);
    }

    return pendingIntents.length;
  };
}
