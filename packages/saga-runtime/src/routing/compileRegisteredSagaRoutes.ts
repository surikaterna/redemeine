import { deriveSagaRouteId } from '../identity/deterministicIds';
import { assertIssuedSagaRegistration, type SagaRegistration } from './registerSagaDefinition';
import { assertUniqueRoutes, assertUniqueWireTypes, compareCodeUnits, indexRoutes } from './compileSagaRoutes';
import { SagaRouteCompilationError, type CompiledSagaRoute, type CompiledSagaRoutingTable } from './contracts';

export interface RegisteredSagaStartBinding {
  readonly registration: SagaRegistration;
  readonly triggerIndex: number;
  readonly eventTypes: readonly string[];
}

function compileStart(binding: RegisteredSagaStartBinding): readonly CompiledSagaRoute[] {
  const { registration, triggerIndex, eventTypes } = binding;
  const trigger = registration.startContracts.triggers[triggerIndex];
  const correlate = registration.startContracts.correlation?.correlateBy;
  if (!Number.isSafeInteger(triggerIndex) || triggerIndex < 0 || !trigger || !correlate ||
      eventTypes.length === 0 || eventTypes.some((type) => !type)) {
    throw new SagaRouteCompilationError('invalid_start_binding', 'Start binding requires a correlated trigger and exact event types');
  }
  if (new Set(eventTypes).size !== eventTypes.length) {
    throw new SagaRouteCompilationError('duplicate_start_binding', 'A start binding must not repeat an event type');
  }
  return eventTypes.map((eventType) => Object.freeze({
    kind: 'start', definition: registration.definition, executeStart: registration.executeStart,
    sagaKey: registration.sagaKey,
    definitionVersion: registration.definitionVersion, eventType, triggerIndex,
    routeId: deriveSagaRouteId({ kind: 'start', sagaKey: registration.sagaKey,
      definitionVersion: registration.definitionVersion, triggerIndex, eventType }),
    ...(trigger.when === undefined ? {} : { when: trigger.when }),
    toStartInput: trigger.toStartInput, correlate
  }));
}

export function compileRegisteredSagaRoutes(
  registrations: readonly SagaRegistration[], bindings: readonly RegisteredSagaStartBinding[] = []
): CompiledSagaRoutingTable {
  const byKey = new Set<string>();
  for (const registration of registrations) {
    assertIssuedSagaRegistration(registration);
    if (!registration.hasStateParser || byKey.has(registration.sagaKey)) {
      throw new SagaRouteCompilationError('duplicate_active_definition', 'Missing parser or duplicate active registration');
    }
    byKey.add(registration.sagaKey);
  }
  const active = new Set(registrations);
  const starts = bindings.flatMap((binding) => {
    if (!active.has(binding.registration)) throw new SagaRouteCompilationError('invalid_start_binding', 'Start binding registration is not active');
    return compileStart(binding);
  });
  const routes = [...starts, ...registrations.flatMap((registration) => registration.onRoutes)].sort(
    (left, right) => compareCodeUnits(left.eventType, right.eventType) ||
      compareCodeUnits(left.sagaKey, right.sagaKey) || compareCodeUnits(left.routeId, right.routeId)
  );
  assertUniqueRoutes(routes);
  assertUniqueWireTypes(routes, 'start');
  assertUniqueWireTypes(routes, 'on');
  return { definitions: Object.freeze(registrations.map((registration) => registration.definition)),
    registered: Object.freeze([...registrations]), routes: Object.freeze(routes), routesByEventType: indexRoutes(routes) };
}
