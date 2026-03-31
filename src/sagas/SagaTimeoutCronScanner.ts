import type { SagaCommandMap, SagaScheduleIntent } from './createSaga';
import type { PendingIntentProjection, PendingIntentRecord } from './PendingIntentProjection';

export interface SagaTimerWakeUpIntent {
  readonly type: 'saga.timer-wake-up';
  readonly sagaStreamId: string;
  readonly intentKey: string;
  readonly scheduleId: string;
  readonly dueAt: string;
  readonly metadata: {
    readonly sagaId: string;
    readonly correlationId: string;
    readonly causationId: string;
  };
}

export type SagaTimerWakeUpEmitter = (intent: SagaTimerWakeUpIntent) => unknown | Promise<unknown>;

export interface SagaTimeoutCronScannerOptions {
  readonly now?: () => string | Date;
}

function isPendingScheduleIntent<TCommandMap extends SagaCommandMap>(
  record: PendingIntentRecord<TCommandMap>
): record is PendingIntentRecord<TCommandMap> & { readonly intent: SagaScheduleIntent } {
  return record.intent.type === 'schedule';
}

export function detectDueSagaTimers<TCommandMap extends SagaCommandMap>(
  projection: PendingIntentProjection<TCommandMap>,
  now: string | Date = new Date()
): Array<PendingIntentRecord<TCommandMap> & { readonly intent: SagaScheduleIntent }> {
  return projection.getExecutablePendingIntents(now).filter(isPendingScheduleIntent);
}

export function toSagaTimerWakeUpIntent<TCommandMap extends SagaCommandMap>(
  record: PendingIntentRecord<TCommandMap> & { readonly intent: SagaScheduleIntent }
): SagaTimerWakeUpIntent {
  return {
    type: 'saga.timer-wake-up',
    sagaStreamId: record.sagaStreamId,
    intentKey: record.intentKey,
    scheduleId: record.intent.id,
    dueAt: record.dueAt,
    metadata: record.intent.metadata
  };
}

export function createSagaTimeoutCronScanner<TCommandMap extends SagaCommandMap>(
  projection: PendingIntentProjection<TCommandMap>,
  emitWakeUpIntent: SagaTimerWakeUpEmitter,
  options: SagaTimeoutCronScannerOptions = {}
): () => Promise<number> {
  const now = options.now ?? (() => new Date());

  return async () => {
    const dueTimers = detectDueSagaTimers(projection, now());

    for (const dueTimer of dueTimers) {
      await emitWakeUpIntent(toSagaTimerWakeUpIntent(dueTimer));
    }

    return dueTimers.length;
  };
}
