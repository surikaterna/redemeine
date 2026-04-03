import type {
  IntentExecutionProjectionRecord,
  SagaAggregateProjection,
  SagaAggregateState,
  IntentExecutionProjection,
  IntentExecutionStatus,
  IntentExecutionResponseRef
} from './SagaAggregate';

export type SagaTriggerMisfirePolicy =
  | { readonly mode: 'catch_up_all' }
  | { readonly mode: 'catch_up_bounded'; readonly maxCatchUpCount: number }
  | { readonly mode: 'latest_only' }
  | { readonly mode: 'skip_until_next' };

export interface SagaTriggerRestartPolicy {
  readonly mode?: 'graceful' | 'force';
  readonly reason?: string;
}

export interface SagaSchedulerTriggerPolicyContract {
  readonly restart?: SagaTriggerRestartPolicy;
  readonly misfire?: SagaTriggerMisfirePolicy;
}

export interface SagaIntentMetadata {
  readonly sagaId: string;
  readonly correlationId: string;
  readonly causationId: string;
}

export interface SagaScheduleIntent {
  readonly type: 'schedule';
  readonly id: string;
  readonly delay: number;
  readonly metadata: SagaIntentMetadata;
}

export interface SagaCancelScheduleIntent {
  readonly type: 'cancel-schedule';
  readonly id: string;
  readonly metadata: SagaIntentMetadata;
}

export interface SagaRunActivityIntent<TResult = unknown> {
  readonly type: 'run-activity';
  readonly name: string;
  readonly closure: () => TResult | Promise<TResult>;
  readonly metadata: SagaIntentMetadata;
}

export interface SagaPluginOneWayIntent<
  TPluginKey extends string = string,
  TActionName extends string = string,
  TExecutionPayload = unknown
> {
  readonly type: 'plugin-one-way';
  readonly plugin_key: TPluginKey;
  readonly action_name: TActionName;
  readonly action_kind: 'void';
  readonly execution_payload: TExecutionPayload;
  readonly metadata: SagaIntentMetadata;
}

export interface SagaPluginRequestIntent<
  TPluginKey extends string = string,
  TActionName extends string = string,
  TExecutionPayload = unknown
> {
  readonly type: 'plugin-request';
  readonly plugin_key: TPluginKey;
  readonly action_name: TActionName;
  readonly action_kind: 'request_response';
  readonly execution_payload: TExecutionPayload;
  readonly routing_metadata: {
    readonly response_handler_key: string;
    readonly error_handler_key: string;
    readonly handler_data: unknown;
    readonly retry_handler_key?: string;
  };
  readonly metadata: SagaIntentMetadata;
}

export type SagaIntent =
  | SagaScheduleIntent
  | SagaCancelScheduleIntent
  | SagaRunActivityIntent
  | SagaPluginOneWayIntent
  | SagaPluginRequestIntent
  | {
    readonly type: 'dispatch';
    readonly command: string;
    readonly payload: unknown;
    readonly metadata: SagaIntentMetadata;
  };

export interface SagaRuntimePersistencePluginV1 {
  readonly sagaProjection: SagaAggregateProjection;
  readonly intentExecutionProjection: IntentExecutionProjection;
  listIntentExecutionsBySagaId(sagaId: string): readonly IntentExecutionProjectionRecord[];
}

export interface SagaRuntimeScheduledTrigger {
  readonly id: string;
  readonly sagaId: string;
  readonly runAt: string;
  readonly policy?: SagaSchedulerTriggerPolicyContract;
  readonly metadata?: Record<string, unknown>;
}

export interface SagaRuntimeSchedulerPluginV1 {
  schedule(trigger: SagaRuntimeScheduledTrigger): void;
  cancel(id: string): boolean;
  listScheduled(): readonly SagaRuntimeScheduledTrigger[];
  drainDue(nowIso: string): readonly SagaRuntimeScheduledTrigger[];
}

export type SagaRuntimeSideEffectIntent =
  | SagaPluginOneWayIntent
  | SagaPluginRequestIntent
  | SagaRunActivityIntent;

export interface SagaRuntimeSideEffectResult {
  readonly status: Extract<IntentExecutionStatus, 'succeeded' | 'failed'>;
  readonly responseRef?: IntentExecutionResponseRef;
  readonly output?: unknown;
  readonly error?: string;
}

export interface SagaRuntimeSideEffectsPluginV1 {
  execute(intent: SagaRuntimeSideEffectIntent): Promise<SagaRuntimeSideEffectResult>;
  listHandled(): readonly SagaRuntimeSideEffectIntent[];
}

export interface SagaRuntimeTelemetryEvent {
  readonly name: string;
  readonly tags?: Record<string, string>;
  readonly at: string;
}

export interface SagaRuntimeTelemetrySnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly events: readonly SagaRuntimeTelemetryEvent[];
}

export interface SagaRuntimeTelemetryPluginV1 {
  count(metric: string, delta?: number): void;
  event(name: string, tags?: Record<string, string>): void;
  snapshot(): SagaRuntimeTelemetrySnapshot;
}

export interface SagaRuntimeReferenceAdapters {
  readonly persistence: SagaRuntimePersistencePluginV1;
  readonly scheduler: SagaRuntimeSchedulerPluginV1;
  readonly sideEffects: SagaRuntimeSideEffectsPluginV1;
  readonly telemetry: SagaRuntimeTelemetryPluginV1;
}

export interface SagaRuntimeReferenceFlowInput {
  readonly sagaId: string;
  readonly intents: readonly SagaIntent[];
  readonly schedulerPolicy?: SagaSchedulerTriggerPolicyContract;
  readonly nowIso?: string;
}

export interface SagaRuntimeReferenceFlowResult {
  readonly processedIntents: number;
  readonly persistedExecutions: readonly string[];
  readonly scheduledTriggerIds: readonly string[];
  readonly responseCorrelations: readonly SagaRuntimeResponseCorrelation[];
}

export interface SagaRuntimeResponseCorrelation {
  readonly executionId: string;
  readonly intentId: string;
  readonly status: Extract<IntentExecutionStatus, 'succeeded' | 'failed'>;
  readonly responseRef?: IntentExecutionResponseRef;
  readonly error?: string;
}

export function createInMemoryPersistencePluginV1(): SagaRuntimePersistencePluginV1 {
  const sagaState = new Map<string, SagaAggregateState>();
  const executions = new Map<string, IntentExecutionProjectionRecord>();

  return {
    sagaProjection: {
      getById(id) {
        return sagaState.get(id) ?? null;
      },
      upsert(record) {
        if (!record.id) {
          return;
        }

        sagaState.set(record.id, record);
      }
    },
    intentExecutionProjection: {
      getById(id) {
        return executions.get(id) ?? null;
      },
      upsert(record) {
        executions.set(record.id, record);
      }
    },
    listIntentExecutionsBySagaId(sagaId) {
      return Array.from(executions.values()).filter((record) => record.sagaId === sagaId);
    }
  };
}

export function createInMemorySchedulerPluginV1(): SagaRuntimeSchedulerPluginV1 {
  const scheduled = new Map<string, SagaRuntimeScheduledTrigger>();

  return {
    schedule(trigger) {
      scheduled.set(trigger.id, trigger);
    },
    cancel(id) {
      return scheduled.delete(id);
    },
    listScheduled() {
      return Array.from(scheduled.values()).sort((a, b) => a.runAt.localeCompare(b.runAt));
    },
    drainDue(nowIso) {
      const due = Array.from(scheduled.values())
        .filter((trigger) => trigger.runAt <= nowIso)
        .sort((a, b) => a.runAt.localeCompare(b.runAt));

      for (const trigger of due) {
        scheduled.delete(trigger.id);
      }

      return due;
    }
  };
}

export function createInMemorySideEffectsPluginV1(
  executeIntent?: (intent: SagaRuntimeSideEffectIntent) => SagaRuntimeSideEffectResult | Promise<SagaRuntimeSideEffectResult>
): SagaRuntimeSideEffectsPluginV1 {
  const handled: SagaRuntimeSideEffectIntent[] = [];

  return {
    async execute(intent) {
      handled.push(intent);

      if (executeIntent) {
        return await executeIntent(intent);
      }

      if (intent.type === 'plugin-request') {
        return {
          status: 'succeeded',
          responseRef: {
            responseKey: `${intent.plugin_key}.${intent.action_name}`,
            responseId: `${intent.metadata.correlationId}:${intent.action_name}`,
            receivedAt: new Date().toISOString()
          }
        };
      }

      if (intent.type === 'run-activity') {
        return {
          status: 'succeeded',
          output: await intent.closure()
        };
      }

      return { status: 'succeeded' };
    },
    listHandled() {
      return handled;
    }
  };
}

export function createInMemoryTelemetryPluginV1(): SagaRuntimeTelemetryPluginV1 {
  const counters = new Map<string, number>();
  const events: SagaRuntimeTelemetryEvent[] = [];

  return {
    count(metric, delta = 1) {
      counters.set(metric, (counters.get(metric) ?? 0) + delta);
    },
    event(name, tags) {
      events.push({
        name,
        tags,
        at: new Date().toISOString()
      });
    },
    snapshot() {
      return {
        counters: Object.freeze(Object.fromEntries(counters.entries())),
        events
      };
    }
  };
}

export function createReferenceAdaptersV1(): SagaRuntimeReferenceAdapters {
  return {
    persistence: createInMemoryPersistencePluginV1(),
    scheduler: createInMemorySchedulerPluginV1(),
    sideEffects: createInMemorySideEffectsPluginV1(),
    telemetry: createInMemoryTelemetryPluginV1()
  };
}

const asScheduleIntent = (intent: SagaIntent): SagaScheduleIntent | null => intent.type === 'schedule' ? intent : null;
const asCancelIntent = (intent: SagaIntent): SagaCancelScheduleIntent | null => intent.type === 'cancel-schedule' ? intent : null;

const asSideEffectIntent = (intent: SagaIntent): SagaRuntimeSideEffectIntent | null => {
  if (intent.type === 'plugin-one-way' || intent.type === 'plugin-request' || intent.type === 'run-activity') {
    return intent;
  }

  return null;
};

const createExecutionRecord = (
  executionId: string,
  sagaId: string,
  intentId: string,
  nowIso: string,
  status: IntentExecutionStatus,
  responseRef: IntentExecutionResponseRef | null = null
): IntentExecutionProjectionRecord => ({
  id: executionId,
  sagaId,
  intentId,
  attempt: 1,
  status,
  retryPolicySnapshot: null,
  responseRef,
  createdAt: nowIso,
  updatedAt: nowIso
});

export async function runReferenceAdapterFlowV1(
  adapters: SagaRuntimeReferenceAdapters,
  input: SagaRuntimeReferenceFlowInput
): Promise<SagaRuntimeReferenceFlowResult> {
  const persistedExecutionIds: string[] = [];
  const scheduledTriggerIds: string[] = [];
  const responseCorrelations: SagaRuntimeResponseCorrelation[] = [];
  const nowIso = input.nowIso ?? new Date().toISOString();
  const sideEffectExecutions: Array<{
    executionId: string;
    intentId: string;
    intent: SagaRuntimeSideEffectIntent;
  }> = [];

  for (let index = 0; index < input.intents.length; index += 1) {
    const intent = input.intents[index];
    adapters.telemetry.count('saga.intent.received');

    const schedule = asScheduleIntent(intent);
    if (schedule) {
      const runAt = new Date(Date.parse(nowIso) + schedule.delay).toISOString();
      adapters.scheduler.schedule({
        id: schedule.id,
        sagaId: input.sagaId,
        runAt,
        policy: input.schedulerPolicy,
        metadata: { correlationId: schedule.metadata.correlationId }
      });
      adapters.telemetry.count('saga.intent.scheduled');
      adapters.telemetry.event('saga.schedule.created', { sagaId: input.sagaId, intentId: schedule.id });
      scheduledTriggerIds.push(schedule.id);
      continue;
    }

    const cancel = asCancelIntent(intent);
    if (cancel) {
      adapters.scheduler.cancel(cancel.id);
      adapters.telemetry.count('saga.intent.cancelled_schedule');
      adapters.telemetry.event('saga.schedule.cancelled', { sagaId: input.sagaId, intentId: cancel.id });
      continue;
    }

    const sideEffectIntent = asSideEffectIntent(intent);
    if (!sideEffectIntent) {
      adapters.telemetry.count('saga.intent.skipped');
      continue;
    }

    const executionId = `${input.sagaId}:intent:${index + 1}`;
    const intentId = `${sideEffectIntent.type}:${index + 1}`;

    adapters.persistence.intentExecutionProjection.upsert(
      createExecutionRecord(executionId, input.sagaId, intentId, nowIso, 'in_progress')
    );

    sideEffectExecutions.push({
      executionId,
      intentId,
      intent: sideEffectIntent
    });
    persistedExecutionIds.push(executionId);
  }

  const completed = await Promise.all(sideEffectExecutions.map(async (execution) => {
    const result = await adapters.sideEffects.execute(execution.intent);
    adapters.persistence.intentExecutionProjection.upsert(
      createExecutionRecord(
        execution.executionId,
        input.sagaId,
        execution.intentId,
        new Date().toISOString(),
        result.status,
        result.responseRef ?? null
      )
    );

    adapters.telemetry.count('saga.intent.executed');
    adapters.telemetry.count(
      result.status === 'succeeded'
        ? 'saga.intent.execution_succeeded'
        : 'saga.intent.execution_failed'
    );
    adapters.telemetry.event('saga.intent.executed', {
      sagaId: input.sagaId,
      executionId: execution.executionId,
      status: result.status
    });

    return {
      executionId: execution.executionId,
      intentId: execution.intentId,
      status: result.status,
      responseRef: result.responseRef,
      error: result.error
    };
  }));

  responseCorrelations.push(...completed);

  return {
    processedIntents: input.intents.length,
    persistedExecutions: persistedExecutionIds,
    scheduledTriggerIds,
    responseCorrelations
  };
}
