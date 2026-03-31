import { decideDueSagaIntentExecution } from './decision';
import { executeSagaIntentExecutionTicket } from './execute';
import {
  MissingPendingIntentRecordForRuntimeIntentError,
  type PendingIntentRecordLookup,
  type RouteDueRuntimeIntentOptions,
  type RuntimeIntentProjectionDueReader,
  type RuntimeIntentProjectionRecord,
  type SagaCommandMap,
  type SagaIntentExecutionResult,
  type SagaIntentWorkerHandlers,
  type SagaRuntimeDepotLike
} from './contracts';

export async function routeDueRuntimeIntentRecord<TCommandMap extends SagaCommandMap>(
  runtimeRecord: RuntimeIntentProjectionRecord,
  pendingIntentLookup: PendingIntentRecordLookup<TCommandMap>,
  runtimeDepot: SagaRuntimeDepotLike,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: RouteDueRuntimeIntentOptions = {}
): Promise<SagaIntentExecutionResult> {
  const pendingRecord = pendingIntentLookup.getByIntentKey(runtimeRecord.intentKey);
  if (!pendingRecord) {
    throw new MissingPendingIntentRecordForRuntimeIntentError(runtimeRecord);
  }

  const ticket = await decideDueSagaIntentExecution(pendingRecord, runtimeDepot, {
    now: options.now
  });

  const result = await executeSagaIntentExecutionTicket(ticket, runtimeDepot, handlers, {
    createTimestamp: options.createTimestamp,
    retryJitter: options.retryJitter
  });

  options.onResult?.(result);
  return result;
}

export function createRuntimeIntentProcessTick<TCommandMap extends SagaCommandMap>(
  runtimeProjection: RuntimeIntentProjectionDueReader,
  pendingIntentLookup: PendingIntentRecordLookup<TCommandMap>,
  runtimeDepot: SagaRuntimeDepotLike,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: RouteDueRuntimeIntentOptions = {}
): () => Promise<number> {
  const now = options.now ?? (() => new Date());

  return async () => {
    const dueIntents = runtimeProjection.getDueIntents(now());
    let executedCount = 0;

    for (const dueIntent of dueIntents) {
      const result = await routeDueRuntimeIntentRecord(dueIntent, pendingIntentLookup, runtimeDepot, handlers, {
        ...options,
        now
      });
      if (result.executed) {
        executedCount += 1;
      }
    }

    return executedCount;
  };
}

export function createRuntimeStartupRecoveryScan<TCommandMap extends SagaCommandMap>(
  runtimeProjection: RuntimeIntentProjectionDueReader,
  pendingIntentLookup: PendingIntentRecordLookup<TCommandMap>,
  runtimeDepot: SagaRuntimeDepotLike,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: RouteDueRuntimeIntentOptions = {}
): () => Promise<number> {
  return createRuntimeIntentProcessTick(runtimeProjection, pendingIntentLookup, runtimeDepot, handlers, options);
}
