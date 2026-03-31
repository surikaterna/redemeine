import type { Command } from '../../../types';
import type { SagaCommandMap, SagaReducerOutput } from '../../createSaga';
import { type SagaRuntimeTranslationOptions, translateSagaReducerOutputToRuntimeCommands } from '../translateSagaReducerOutputToRuntimeCommands';

interface SagaRuntimeMirageLike {
  dispatch(command: Command): unknown;
}

interface SagaRuntimeDepotLike {
  get(id: string): Promise<SagaRuntimeMirageLike>;
  save(mirage: SagaRuntimeMirageLike): Promise<void>;
}

export interface PersistSagaReducerOutputThroughRuntimeAggregateOptions
  extends Omit<SagaRuntimeTranslationOptions, 'sagaStreamId'> {
  readonly sagaStreamId: string;
}

/**
 * Executes reducer intents through the runtime aggregate command path.
 *
 * This adapter is the seam between fluent reducer intent output and
 * Mirage+Depot aggregate command execution.
 */
export async function persistSagaReducerOutputThroughRuntimeAggregate<TState, TCommandMap extends SagaCommandMap>(
  output: SagaReducerOutput<TState, TCommandMap>,
  runtimeDepot: SagaRuntimeDepotLike,
  options: PersistSagaReducerOutputThroughRuntimeAggregateOptions
): Promise<void> {
  const runtimeAggregate = await runtimeDepot.get(options.sagaStreamId);
  const commands = translateSagaReducerOutputToRuntimeCommands(output, {
    sagaStreamId: options.sagaStreamId,
    createQueuedAt: options.createQueuedAt
  });

  for (const command of commands) {
    runtimeAggregate.dispatch(command);
  }

  await runtimeDepot.save(runtimeAggregate);
}
