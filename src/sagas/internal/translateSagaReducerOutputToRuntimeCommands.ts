import type { Command } from '../../types';
import type { SagaCommandMap, SagaIntent, SagaReducerOutput } from '../createSaga';

type SagaRuntimeQueueIntentCommandType = 'sagaRuntime.queueIntent.command';

interface SagaRuntimeQueueIntentCommandPayload<TCommandMap extends SagaCommandMap> {
  readonly intentOrdinal: number;
  readonly intent: SagaIntent<TCommandMap>;
}

type SagaRuntimeQueueIntentCommand<TCommandMap extends SagaCommandMap> = Command<
  SagaRuntimeQueueIntentCommandPayload<TCommandMap>,
  SagaRuntimeQueueIntentCommandType
>;

/**
 * Internal seam that adapts reducer intent output into runtime aggregate queue commands.
 */
export function translateSagaReducerOutputToRuntimeCommands<TState, TCommandMap extends SagaCommandMap>(
  output: SagaReducerOutput<TState, TCommandMap>
): readonly SagaRuntimeQueueIntentCommand<TCommandMap>[] {
  return output.intents.map((intent, intentOrdinal) => ({
    type: 'sagaRuntime.queueIntent.command',
    payload: {
      intentOrdinal,
      intent
    }
  }));
}
