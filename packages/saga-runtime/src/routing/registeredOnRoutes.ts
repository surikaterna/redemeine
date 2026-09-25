import { runSagaHandler } from '@redemeine/saga';
import type { SagaDefinition, SagaIntentMetadata, SagaPluginManifestList, SagaResponseHandlerTokenBindings } from '@redemeine/saga';
import type { SagaTurnAggregateEvent } from '../turns/aggregateEvent';
import { validateInitialSagaState } from './registrationValidation';
import { getRuntimeEventTypes, resolveCorrelation } from './compileSagaRoutes';
import { SagaRouteCompilationError, type CompiledSagaOnRoute } from './contracts';
import { deriveSagaRouteId } from '../identity/deterministicIds';

export function registeredOnRoutes<TState extends object, TPlugins extends SagaPluginManifestList,
  TBindings extends SagaResponseHandlerTokenBindings, TInput>(
  definition: SagaDefinition<TState, TPlugins, TBindings, TInput>,
  parseState: (state: unknown) => TState,
  parseEvent: (event: unknown) => SagaTurnAggregateEvent,
  plugins: TPlugins, bindings: TBindings, assertCurrent: () => void
): readonly CompiledSagaOnRoute[] {
  const routes: CompiledSagaOnRoute[] = [];
  for (const group of definition.handlers) {
    const eventTypes = getRuntimeEventTypes(group.aggregate);
    const correlate = resolveCorrelation(definition, group.aggregate);
    for (const [handlerKey, handler] of Object.entries(group.handlers)) {
      const eventType = eventTypes[handlerKey];
      if (!eventType) throw new SagaRouteCompilationError('unknown_handler_event', `Handler ${group.aggregateType}.${handlerKey} has no runtime event type`);
      routes.push(Object.freeze({
        kind: 'on', sagaKey: definition.sagaKey, definitionVersion: definition.identity.version,
        aggregateType: group.aggregateType, handlerKey, eventType, definition,
        correlate: (event: unknown) => { assertCurrent(); return correlate(event); },
        routeId: deriveSagaRouteId({ kind: 'on', sagaKey: definition.sagaKey,
          definitionVersion: definition.identity.version, aggregateType: group.aggregateType, handlerKey, eventType }),
        executeOn: async (state: unknown, event: unknown, metadata: SagaIntentMetadata) => {
          assertCurrent();
          const decodedState = parseState(state);
          validateInitialSagaState(decodedState);
          const decodedEvent = parseEvent(event);
          if (decodedEvent.type !== eventType) throw new TypeError('Saga event type mismatch');
          const decision = await runSagaHandler(decodedState, decodedEvent, handler, metadata, bindings, plugins);
          validateInitialSagaState(decision.state);
          assertCurrent();
          if (decision.intents.length > 0) throw new TypeError('Saga on intents are not yet supported');
          return decision;
        }
      }));
    }
  }
  return Object.freeze(routes);
}
