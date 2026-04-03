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
  readonly execution?: SagaRuntimeScheduledTriggerExecution;
  readonly policyOutcome?: SagaRuntimeSchedulerPolicyOutcome;
}

export interface SagaRuntimeScheduledTriggerExecution {
  readonly triggerId: string;
  readonly ordinal: number;
  readonly scheduledFor: string;
}

export interface SagaRuntimeSchedulerPolicyOutcome {
  readonly drainedAt: string;
  readonly wasMisfire: boolean;
  readonly misfireMode: SagaTriggerMisfirePolicy['mode'];
  readonly dueCount: number;
  readonly executedCount: number;
  readonly skippedCount: number;
  readonly restartMode?: 'graceful' | 'force';
  readonly restartReason?: string;
  readonly nextRunAt?: string;
}

export interface SagaRuntimeSchedulerPolicyOutcomeRecord {
  readonly triggerId: string;
  readonly sagaId: string;
  readonly runAt: string;
  readonly outcome: SagaRuntimeSchedulerPolicyOutcome;
}

export interface SagaRuntimeSchedulerPluginV1 {
  schedule(trigger: SagaRuntimeScheduledTrigger): void;
  cancel(id: string): boolean;
  listScheduled(): readonly SagaRuntimeScheduledTrigger[];
  drainDue(nowIso: string): readonly SagaRuntimeScheduledTrigger[];
  listPolicyOutcomes(): readonly SagaRuntimeSchedulerPolicyOutcomeRecord[];
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
  const policyOutcomes: SagaRuntimeSchedulerPolicyOutcomeRecord[] = [];

  const toFinitePositiveInteger = (value: unknown): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return undefined;
    }

    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
  };

  const parseTriggerIntervalMs = (trigger: SagaRuntimeScheduledTrigger): number | undefined => {
    const intervalFromMetadata = trigger.metadata?.['intervalMs'];
    return toFinitePositiveInteger(intervalFromMetadata);
  };

  const buildDueOccurrences = (
    runAtMs: number,
    nowMs: number,
    intervalMs: number | undefined
  ): readonly string[] => {
    const maxDueCount = typeof intervalMs === 'number'
      ? Math.floor((nowMs - runAtMs) / intervalMs) + 1
      : 1;

    const dueCount = Math.max(1, maxDueCount);
    const due: string[] = [];

    for (let index = 0; index < dueCount; index += 1) {
      const scheduledForMs = typeof intervalMs === 'number'
        ? runAtMs + (index * intervalMs)
        : runAtMs;

      due.push(new Date(scheduledForMs).toISOString());
    }

    return due;
  };

  const resolveMisfireExecution = (
    trigger: SagaRuntimeScheduledTrigger,
    nowIso: string
  ): {
    readonly executions: readonly SagaRuntimeScheduledTrigger[];
    readonly outcome: SagaRuntimeSchedulerPolicyOutcome;
  } => {
    const runAtMs = Date.parse(trigger.runAt);
    const nowMs = Date.parse(nowIso);
    const intervalMs = parseTriggerIntervalMs(trigger);
    const dueOccurrences = buildDueOccurrences(runAtMs, nowMs, intervalMs);
    const wasMisfire = nowMs > runAtMs;
    const misfirePolicy = trigger.policy?.misfire;
    const misfireMode = misfirePolicy?.mode ?? 'latest_only';

    let scheduledForToExecute: readonly string[] = dueOccurrences;

    if (wasMisfire) {
      if (misfireMode === 'skip_until_next') {
        scheduledForToExecute = [];
      } else if (misfireMode === 'latest_only') {
        scheduledForToExecute = [dueOccurrences[dueOccurrences.length - 1]];
      } else if (misfireMode === 'catch_up_bounded') {
        const bounded = toFinitePositiveInteger(
          misfirePolicy && misfirePolicy.mode === 'catch_up_bounded'
            ? misfirePolicy.maxCatchUpCount
            : undefined
        ) ?? 1;
        scheduledForToExecute = dueOccurrences.slice(0, bounded);
      }
    } else {
      scheduledForToExecute = [dueOccurrences[0]];
    }

    const nextRunAt = typeof intervalMs === 'number'
      ? new Date(runAtMs + (dueOccurrences.length * intervalMs)).toISOString()
      : undefined;

    const outcome: SagaRuntimeSchedulerPolicyOutcome = {
      drainedAt: nowIso,
      wasMisfire,
      misfireMode,
      dueCount: dueOccurrences.length,
      executedCount: scheduledForToExecute.length,
      skippedCount: dueOccurrences.length - scheduledForToExecute.length,
      restartMode: trigger.policy?.restart?.mode,
      restartReason: trigger.policy?.restart?.reason,
      nextRunAt
    };

    const executions = scheduledForToExecute.map((scheduledFor, index, list) => {
      const executionId = list.length > 1
        ? `${trigger.id}:exec:${index + 1}`
        : trigger.id;

      return {
        ...trigger,
        id: executionId,
        runAt: scheduledFor,
        execution: {
          triggerId: trigger.id,
          ordinal: index + 1,
          scheduledFor
        },
        policyOutcome: outcome
      };
    });

    return {
      executions,
      outcome
    };
  };

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
        .sort((a, b) => {
          const runAtCompare = a.runAt.localeCompare(b.runAt);
          if (runAtCompare !== 0) {
            return runAtCompare;
          }

          return a.id.localeCompare(b.id);
        });

      const drained: SagaRuntimeScheduledTrigger[] = [];

      for (const trigger of due) {
        const { executions, outcome } = resolveMisfireExecution(trigger, nowIso);

        policyOutcomes.push({
          triggerId: trigger.id,
          sagaId: trigger.sagaId,
          runAt: trigger.runAt,
          outcome
        });

        if (outcome.nextRunAt) {
          scheduled.set(trigger.id, {
            ...trigger,
            runAt: outcome.nextRunAt
          });
        } else {
          scheduled.delete(trigger.id);
        }

        drained.push(...executions);
      }

      return drained;
    },
    listPolicyOutcomes() {
      return policyOutcomes;
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
  const nowIso = input.nowIso ?? new Date().toISOString();

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

    const result = await adapters.sideEffects.execute(sideEffectIntent);
    adapters.persistence.intentExecutionProjection.upsert(
      createExecutionRecord(
        executionId,
        input.sagaId,
        intentId,
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
      executionId,
      status: result.status
    });

    persistedExecutionIds.push(executionId);
  }

  return {
    processedIntents: input.intents.length,
    persistedExecutions: persistedExecutionIds,
    scheduledTriggerIds
  };
}
