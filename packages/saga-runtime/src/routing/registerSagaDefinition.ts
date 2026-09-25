import { runSagaStartHandler } from '@redemeine/saga';
import type { SagaDefinition, SagaIntentMetadata, SagaPluginManifestList, SagaReducerOutput, SagaResponseHandlerTokenBindings } from '@redemeine/saga';
import type { CompiledSagaRoutingTable, CompiledSagaStartRoute } from './contracts';
import { validateInitialSagaState, validateSagaRegistration } from './registrationValidation';
import { validateBusinessState } from '../businessStateValidation';

export interface SagaRegistration<TState extends object = object> {
  readonly definition: object;
  readonly sagaKey: string;
  readonly definitionVersion: number;
  readonly executeStart: (input: unknown, metadata: SagaIntentMetadata) => Promise<SagaReducerOutput<TState>>;
}

export function registerSagaDefinition<
  TState extends object,
  TStartInput,
  TPlugins extends SagaPluginManifestList,
  TBindings extends SagaResponseHandlerTokenBindings
>(options: {
  readonly definition: SagaDefinition<TState, TPlugins, TBindings, TStartInput>;
  readonly pluginManifests: NoInfer<TPlugins>;
  readonly responseHandlerBindings: NoInfer<TBindings>;
  readonly parseStartInput: (input: unknown) => TStartInput;
}): SagaRegistration<TState> {
  const { definition, pluginManifests, responseHandlerBindings, parseStartInput } = options;
  validateSagaRegistration(definition, pluginManifests, responseHandlerBindings);
  if (typeof parseStartInput !== 'function' || typeof definition.start !== 'function') throw new TypeError('Saga start decoder and handler required');
  const sagaKey = definition.sagaKey;
  const definitionVersion = definition.identity.version;
  const guardedDefinition: SagaDefinition<TState, TPlugins, TBindings, TStartInput> = {
    ...definition,
    initialState: () => {
      const state = definition.initialState();
      validateInitialSagaState(state);
      return state;
    }
  };
  return {
    definition,
    sagaKey,
    definitionVersion,
    executeStart: async (input, metadata) => {
      if (definition.sagaKey !== sagaKey || definition.identity.version !== definitionVersion) {
        throw new TypeError('Saga identity changed after registration');
      }
      validateSagaRegistration(definition, pluginManifests, responseHandlerBindings);
      const startInput = parseStartInput(input);
      validateBusinessState(startInput, { maxBytes: 8 * 1024 * 1024, maxDepth: 32, maxNodes: 100_000 });
      const decision = await runSagaStartHandler({
        definition: guardedDefinition, startInput, metadata, plugins: pluginManifests, responseHandlers: responseHandlerBindings
      });
      validateInitialSagaState(decision.state);
      return decision;
    }
  };
}

export function bindSagaRegistrations(table: CompiledSagaRoutingTable, registrations: readonly SagaRegistration[]) {
  const active = new Set<object>(table.definitions);
  const byDefinition = new Map<object, SagaRegistration>();
  const byKey = new Set<string>();
  for (const registration of registrations) {
    if (!active.has(registration.definition) || byDefinition.has(registration.definition) || byKey.has(registration.sagaKey) ||
        !table.definitions.some((definition) => definition === registration.definition && definition.sagaKey === registration.sagaKey && definition.identity.version === registration.definitionVersion)) {
      throw new TypeError('Unexpected, duplicate, or changed saga registration');
    }
    byDefinition.set(registration.definition, registration);
    byKey.add(registration.sagaKey);
  }
  if (byDefinition.size !== active.size) throw new TypeError('Missing saga registration');
  for (const definition of active) {
    if (!byDefinition.has(definition)) throw new TypeError('Missing saga registration');
  }
  return (route: CompiledSagaStartRoute): SagaRegistration => {
    const registration = byDefinition.get(route.definition);
    if (!registration || route.sagaKey !== registration.sagaKey || route.definitionVersion !== registration.definitionVersion ||
        route.definition.identity.version !== registration.definitionVersion) throw new TypeError('Unknown or changed saga version');
    return registration;
  };
}
