import { decideDueSagaIntentExecution } from './decision';
import { executeSagaIntentExecutionTicket } from './execute';
import type {
  RouteDueRuntimeIntentOptions,
  RuntimeIntentProjectionDueReader,
  RuntimeIntentProjectionRecord,
  RuntimeIntentProjectionRecordFor,
  SagaCommandMap,
  SagaIntentExecutionResult,
  SagaIntentWorkerHandlers,
  SagaRuntimeDepotLike
} from './contracts';

function asTypedRuntimeRecord<TCommandMap extends SagaCommandMap>(
  record: RuntimeIntentProjectionRecord
): RuntimeIntentProjectionRecordFor<TCommandMap> {
  return record as RuntimeIntentProjectionRecordFor<TCommandMap>;
}

export async function routeDueRuntimeIntentRecord<TCommandMap extends SagaCommandMap>(
  runtimeRecord: RuntimeIntentProjectionRecordFor<TCommandMap>,
  runtimeDepot: SagaRuntimeDepotLike,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: RouteDueRuntimeIntentOptions = {}
): Promise<SagaIntentExecutionResult> {
  const ticket = await decideDueSagaIntentExecution(runtimeRecord, runtimeDepot, {
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
  runtimeDepot: SagaRuntimeDepotLike,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: RouteDueRuntimeIntentOptions = {}
): () => Promise<number> {
  const now = options.now ?? (() => new Date());

  return async () => {
    const dueIntents = runtimeProjection.getDueIntents(now());
    let executedCount = 0;

    for (const dueIntent of dueIntents) {
      const result = await routeDueRuntimeIntentRecord(asTypedRuntimeRecord<TCommandMap>(dueIntent), runtimeDepot, handlers, {
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
  runtimeDepot: SagaRuntimeDepotLike,
  handlers: SagaIntentWorkerHandlers<TCommandMap>,
  options: RouteDueRuntimeIntentOptions = {}
): () => Promise<number> {
  return createRuntimeIntentProcessTick(runtimeProjection, runtimeDepot, handlers, options);
}
