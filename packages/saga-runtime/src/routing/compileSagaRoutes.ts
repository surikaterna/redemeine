import type { SagaAggregateDefinition, SagaDefinition } from '@redemeine/saga';
import { deriveSourceTriggerId } from '../identity/deterministicIds';
import {
  type CompiledSagaOnRoute,
  type CompiledSagaRoute,
  type CompiledSagaRoutingTable,
  type CompiledSagaStartRoute,
  type MatchedSagaRoute,
  type RuntimeAggregateDefinition,
  SagaRouteCompilationError,
  type SagaRouteSourceEvent,
  type SagaStartEventBinding
} from './contracts';

function assertUniqueDefinitions(definitions: readonly SagaDefinition[]): void {
  const sagaKeys = new Set<string>();
  for (const definition of definitions) {
    if (sagaKeys.has(definition.sagaKey)) {
      throw new SagaRouteCompilationError('duplicate_active_definition', `Exactly one active definition is allowed for sagaKey ${definition.sagaKey}`);
    }
    sagaKeys.add(definition.sagaKey);
  }
}

function assertExactEventTypes(eventTypes: readonly string[]): void {
  if (eventTypes.length === 0 || eventTypes.some((eventType) => eventType.length === 0)) {
    throw new SagaRouteCompilationError('invalid_start_binding', 'Start bindings require at least one non-empty exact event type');
  }
  if (new Set(eventTypes).size !== eventTypes.length) {
    throw new SagaRouteCompilationError('duplicate_start_binding', 'A start binding must not repeat an event type');
  }
}

function compileStartRoutes(binding: SagaStartEventBinding): CompiledSagaStartRoute[] {
  const { definition, triggerIndex } = binding;
  const trigger = definition.startContracts.triggers[triggerIndex];
  const correlate = definition.startContracts.correlation?.correlateBy;
  if (!Number.isSafeInteger(triggerIndex) || triggerIndex < 0 || !trigger || !correlate) {
    throw new SagaRouteCompilationError(
      'invalid_start_binding',
      `Start binding ${definition.sagaKey}[${triggerIndex}] does not reference a correlated trigger`
    );
  }
  assertExactEventTypes(binding.eventTypes);
  return binding.eventTypes.map((eventType) => ({
    kind: 'start',
    routeId: `start:${triggerIndex}:${eventType}`,
    sagaKey: definition.sagaKey,
    definitionVersion: definition.identity.version,
    eventType,
    triggerIndex,
    definition,
    toStartInput: trigger.toStartInput,
    correlate
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRuntimeAggregate(aggregate: SagaAggregateDefinition): RuntimeAggregateDefinition {
  const types: unknown = 'types' in aggregate ? aggregate.types : undefined;
  const events: unknown = isRecord(types) ? types.events : undefined;
  if (!isRecord(events) || Object.values(events).some((eventType) => typeof eventType !== 'string')) {
    throw new SagaRouteCompilationError('missing_event_type_map', 'Saga .on aggregate must expose its built runtime event type map');
  }
  return aggregate as RuntimeAggregateDefinition;
}

function resolveCorrelation(definition: SagaDefinition, aggregate: SagaAggregateDefinition) {
  const matches = definition.correlations.filter((candidate) => candidate.aggregate === aggregate);
  if (matches.length === 0) {
    throw new SagaRouteCompilationError('missing_route_correlation', `No correlation is registered for ${aggregate.aggregateType}`);
  }
  if (matches.length > 1) {
    throw new SagaRouteCompilationError('duplicate_route_correlation', `Multiple correlations are registered for ${aggregate.aggregateType}`);
  }
  return matches[0]!.correlate;
}

function compileOnRoutes(definition: SagaDefinition): CompiledSagaOnRoute[] {
  const routes: CompiledSagaOnRoute[] = [];
  for (const group of definition.handlers) {
    const aggregate = getRuntimeAggregate(group.aggregate);
    const correlate = resolveCorrelation(definition, group.aggregate);
    for (const [handlerKey, handler] of Object.entries(group.handlers)) {
      const eventType = aggregate.types.events[handlerKey];
      if (!eventType) {
        throw new SagaRouteCompilationError('unknown_handler_event', `Handler ${group.aggregateType}.${handlerKey} has no runtime event type`);
      }
      routes.push({
        kind: 'on',
        routeId: `on:${group.aggregateType}:${handlerKey}:${eventType}`,
        sagaKey: definition.sagaKey,
        definitionVersion: definition.identity.version,
        eventType,
        aggregateType: group.aggregateType,
        handlerKey,
        definition,
        handler,
        correlate
      });
    }
  }
  return routes;
}

function assertUniqueRoutes(routes: readonly CompiledSagaRoute[]): void {
  const registrations = new Set<string>();
  for (const route of routes) {
    const key = `${route.sagaKey}\0${route.kind}\0${route.routeId}`;
    if (registrations.has(key)) {
      const code = route.kind === 'start' ? 'duplicate_start_binding' : 'duplicate_handler_route';
      throw new SagaRouteCompilationError(code, `Duplicate ${route.kind} route ${route.routeId}`);
    }
    registrations.add(key);
  }
}

function indexRoutes(routes: readonly CompiledSagaRoute[]): ReadonlyMap<string, readonly CompiledSagaRoute[]> {
  const mutable = new Map<string, CompiledSagaRoute[]>();
  for (const route of routes) {
    const existing = mutable.get(route.eventType) ?? [];
    existing.push(route);
    mutable.set(route.eventType, existing);
  }
  return mutable;
}

export function compileSagaRoutes(definitions: readonly SagaDefinition[], startEventBindings: readonly SagaStartEventBinding[] = []): CompiledSagaRoutingTable {
  assertUniqueDefinitions(definitions);
  const activeDefinitions = new Set(definitions);
  const startRoutes = startEventBindings.flatMap((binding) => {
    if (!activeDefinitions.has(binding.definition)) {
      throw new SagaRouteCompilationError('invalid_start_binding', 'Start binding definition is not active');
    }
    return compileStartRoutes(binding);
  });
  const routes = [...startRoutes, ...definitions.flatMap(compileOnRoutes)].sort(
    (left, right) => left.eventType.localeCompare(right.eventType) || left.sagaKey.localeCompare(right.sagaKey) || left.routeId.localeCompare(right.routeId)
  );
  assertUniqueRoutes(routes);
  return { definitions: [...definitions], routes, routesByEventType: indexRoutes(routes) };
}

export function createStartEventBindings<const TBindings extends readonly SagaStartEventBinding[]>(...bindings: TBindings): TBindings {
  return bindings;
}

export function matchSagaRoutes(table: CompiledSagaRoutingTable, event: SagaRouteSourceEvent): readonly MatchedSagaRoute[] {
  const sourceTriggerId = deriveSourceTriggerId(event);
  return (table.routesByEventType.get(event.type) ?? []).map((route) => ({
    route,
    sourceTriggerId,
    eventId: event.eventId
  }));
}
