import { createDraft, finishDraft, type Draft } from 'immer';
import { createSagaDispatchContext } from '../createSaga';
import type {
  SagaDefinition,
  SagaIntent,
  SagaIntentMetadata,
  SagaPluginManifestList,
  SagaReducerOutput
} from '../createSaga';
import type { SagaResponseHandlerTokenBindings } from '../definition/responseTokens';

export interface RunSagaStartInput<
  TState extends Record<string, unknown>,
  TStartInput,
  TPlugins extends SagaPluginManifestList = readonly [],
  TBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
> {
  readonly definition: SagaDefinition<TState, TPlugins, TBindings, TStartInput>;
  readonly startInput: TStartInput;
  readonly metadata: SagaIntentMetadata;
  readonly plugins?: TPlugins;
  readonly responseHandlers?: TBindings;
}

/** Execute a start decision in memory; the caller owns validation and durable commit. */
export async function runSagaStartHandler<
  TState extends Record<string, unknown>,
  TStartInput,
  TPlugins extends SagaPluginManifestList = readonly [],
  TBindings extends SagaResponseHandlerTokenBindings = Record<never, never>
>(input: RunSagaStartInput<TState, TStartInput, TPlugins, TBindings>): Promise<SagaReducerOutput<TState>> {
  const { definition, startInput, metadata } = input;
  if (definition.start === undefined) {
    throw new Error('Saga has no start handler');
  }

  const draft = createDraft(definition.initialState());
  const intents: SagaIntent[] = [];
  const ctx = createSagaDispatchContext<TPlugins, TBindings>(
    metadata,
    intents,
    input.responseHandlers,
    input.plugins
  );
  await definition.start(draft as Draft<TState>, startInput, ctx);
  return { state: finishDraft(draft) as TState, intents };
}
