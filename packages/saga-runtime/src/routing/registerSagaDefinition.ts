import { runSagaStartHandler } from '@redemeine/saga';
import type { SagaDefinition, SagaIntentMetadata, SagaPluginManifestList, SagaResponseHandlerTokenBindings } from '@redemeine/saga';
import type { CompiledSagaOnRoute, CompiledSagaRoute, CompiledSagaRoutingTable, SagaRouteDefinitionIdentity } from './contracts';
import type { SagaTurnAggregateEvent } from '../turns/aggregateEvent';
import { registeredOnRoutes } from './registeredOnRoutes';
import { validateInitialSagaState, validateSagaRegistration } from './registrationValidation';
import { validateBusinessState } from '../businessStateValidation';
import { sagaPolicyFingerprint, type DeclaredSchemaIdentity, type DefinitionIdentityV1 } from './executableIdentity';
import { startWireRegistry, validateStartIntents, type StartTurnOrigin } from './startIntentValidation';
import type { WireIntent } from '../intentWire';

const issuedRegistrations = new WeakSet<object>();

export class SagaStartDecisionError extends Error {
  readonly code = 'invalid_start_intent';
  constructor(cause: unknown) {
    super('Saga start emitted an invalid intent', { cause });
    this.name = 'SagaStartDecisionError';
  }
}

export interface SagaRegistration<TState extends object = object> {
  readonly definition: SagaRouteDefinitionIdentity;
  readonly sagaKey: string;
  readonly definitionVersion: number;
  readonly definitionIdentity: DefinitionIdentityV1;
  readonly releaseId?: string;
  readonly assertCurrent: () => void;
  readonly executeStart: (input: unknown, metadata: SagaIntentMetadata, origin: StartTurnOrigin, turnClock: string) => Promise<{ state: TState; intents: readonly WireIntent[] }>;
  readonly startContracts: SagaDefinition['startContracts'];
  readonly onRoutes: readonly CompiledSagaOnRoute[];
  readonly hasStateParser: boolean;
  readonly executeOn: (state: unknown, event: unknown, metadata: SagaIntentMetadata, handlerKey: string) => Promise<{ state: unknown; intents: readonly unknown[] }>;
}

export type SagaTurnRegistration = Pick<SagaRegistration, 'definition' | 'sagaKey' | 'definitionVersion' | 'definitionIdentity' | 'assertCurrent'>;

function captureReferences<TState, TPlugins extends SagaPluginManifestList, TBindings extends SagaResponseHandlerTokenBindings, TInput>(
  definition: SagaDefinition<TState, TPlugins, TBindings, TInput>, manifests: TPlugins
): readonly unknown[] {
  return [definition.start, definition.initialState, definition.startContracts.correlation?.correlateBy,
    ...definition.startContracts.triggers.flatMap((trigger) => [trigger.kind, trigger.when, trigger.toStartInput]),
    ...Object.entries(definition.responseHandlers).flat(), ...Object.entries(definition.errorHandlers).flat(),
    ...Object.entries(definition.retryHandlers).flat(),
    ...definition.correlations.flatMap((entry) => [entry, entry.aggregateType, entry.sagaType,
      entry.sagaUrn, entry.aggregate, entry.correlate]),
    ...definition.handlers.flatMap((group) => [group.aggregateType, ...Object.entries(group.handlers).flat()]),
    ...manifests.flatMap((manifest) => Object.entries(manifest.actions).flatMap(([name, action]) => [name, action.build]))];
}

function createExecutableGuard<TState, TPlugins extends SagaPluginManifestList, TBindings extends SagaResponseHandlerTokenBindings, TInput>(
  definition: SagaDefinition<TState, TPlugins, TBindings, TInput>, manifests: TPlugins,
  bindings: TBindings, commands: readonly string[], schemas: readonly DeclaredSchemaIdentity[]
) {
  const sagaKey = definition.sagaKey;
  const definitionVersion = definition.identity.version;
  const policySha256 = sagaPolicyFingerprint(manifests, bindings, commands, schemas);
  const definitionIdentity: DefinitionIdentityV1 = Object.freeze({ sagaKey, definitionVersion, policySha256 });
  const references = captureReferences(definition, manifests);
  const assertCurrent = () => {
    validateSagaRegistration(definition, manifests, bindings);
    const current = captureReferences(definition, manifests);
    if (definition.sagaKey !== sagaKey || definition.identity.version !== definitionVersion ||
        sagaPolicyFingerprint(manifests, bindings, commands, schemas) !== policySha256 ||
        current.length !== references.length || current.some((value, index) => value !== references[index])) {
      throw new TypeError('Saga definition changed after registration');
    }
  };
  return { definitionIdentity, assertCurrent };
}

function makeStartExecutor<TState extends object, TInput, TPlugins extends SagaPluginManifestList, TBindings extends SagaResponseHandlerTokenBindings>(
  definition: SagaDefinition<TState, TPlugins, TBindings, TInput>, parseStartInput: (input: unknown) => TInput,
  plugins: TPlugins, bindings: TBindings, commands: readonly string[], assertCurrent: () => void
): SagaRegistration<TState>['executeStart'] {
  const guardedDefinition: SagaDefinition<TState, TPlugins, TBindings, TInput> = {
    ...definition,
    initialState: () => {
      const state = definition.initialState();
      validateInitialSagaState(state);
      return state;
    }
  };
  return async (input, metadata, origin, turnClock) => {
    assertCurrent();
    if (origin?.sagaKey !== definition.sagaKey) throw new TypeError('Saga turn key mismatch');
    const registry = startWireRegistry(plugins, commands);
    try {
      validateStartIntents([], origin, metadata, registry, bindings, turnClock);
    } catch (error) {
      throw new SagaStartDecisionError(error);
    }
    const startInput = parseStartInput(input);
    validateBusinessState(startInput, { maxBytes: 8 * 1024 * 1024, maxDepth: 32, maxNodes: 100_000 });
    const decision = await runSagaStartHandler({
      definition: guardedDefinition, startInput, metadata, plugins, responseHandlers: bindings
    });
    validateInitialSagaState(decision.state);
    assertCurrent();
    try {
      const intents = validateStartIntents(decision.intents, origin, metadata, registry, bindings, turnClock);
      return { state: decision.state, intents };
    } catch (error) {
      throw new SagaStartDecisionError(error);
    }
  };
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
  readonly parseState?: (state: unknown) => TState;
  readonly parseOnEvent?: (event: unknown) => SagaTurnAggregateEvent;
  readonly canonicalCommandTypes: readonly string[];
  readonly declaredSchemas?: readonly DeclaredSchemaIdentity[];
  readonly releaseId?: string;
}): SagaRegistration<TState> {
  const { definition, pluginManifests, responseHandlerBindings, parseStartInput } = options;
  validateSagaRegistration(definition, pluginManifests, responseHandlerBindings);
  if (typeof parseStartInput !== 'function' || typeof definition.start !== 'function') throw new TypeError('Saga start decoder and handler required');
  const sagaKey = definition.sagaKey;
  const definitionVersion = definition.identity.version;
  const commands = [...options.canonicalCommandTypes];
  const schemas = options.declaredSchemas ? [...options.declaredSchemas] : [];
  if (options.releaseId !== undefined && (typeof options.releaseId !== 'string' || !options.releaseId || options.releaseId.length > 256 || [...options.releaseId].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw new TypeError('Invalid opaque release ID');
  const { definitionIdentity, assertCurrent } = createExecutableGuard(definition, pluginManifests, responseHandlerBindings, commands, schemas);
  const onRoutes = options.parseState && options.parseOnEvent
    ? registeredOnRoutes(definition, options.parseState, options.parseOnEvent, pluginManifests, responseHandlerBindings, assertCurrent)
    : [];
  const registration: SagaRegistration<TState> = Object.freeze({
    definition,
    sagaKey,
    definitionVersion,
    definitionIdentity,
    startContracts: definition.startContracts,
    onRoutes,
    hasStateParser: options.parseState !== undefined && options.parseOnEvent !== undefined,
    ...(options.releaseId === undefined ? {} : { releaseId: options.releaseId }),
    assertCurrent,
    executeStart: makeStartExecutor(definition, parseStartInput, pluginManifests, responseHandlerBindings, commands, assertCurrent),
    executeOn: (state: unknown, event: unknown, metadata: SagaIntentMetadata, handlerKey: string) => {
      assertCurrent();
      const route = onRoutes.find((candidate) => candidate.handlerKey === handlerKey && candidate.eventType === (typeof event === 'object' && event !== null && 'type' in event ? event.type : undefined));
      if (!route?.executeOn) throw new TypeError('Unknown saga on route');
      return route.executeOn(state, event, metadata);
    }
  });
  issuedRegistrations.add(registration);
  return registration;
}

export function registerSagaTurnDefinition(options: {
  readonly definition: SagaDefinition;
  readonly pluginManifests: SagaPluginManifestList;
  readonly responseHandlerBindings: SagaResponseHandlerTokenBindings;
  readonly canonicalCommandTypes: readonly string[];
  readonly declaredSchemas?: readonly DeclaredSchemaIdentity[];
}): SagaTurnRegistration {
  const { definition, pluginManifests, responseHandlerBindings } = options;
  validateSagaRegistration(definition, pluginManifests, responseHandlerBindings);
  const guard = createExecutableGuard(definition, pluginManifests, responseHandlerBindings,
    [...options.canonicalCommandTypes], options.declaredSchemas ? [...options.declaredSchemas] : []);
  const registration = Object.freeze({ definition, sagaKey: definition.sagaKey,
    definitionVersion: definition.identity.version, ...guard });
  issuedRegistrations.add(registration);
  return registration;
}

export function bindSagaRegistrations(table: CompiledSagaRoutingTable, registrations: readonly SagaTurnRegistration[]) {
  const active = new Set<object>(table.definitions);
  const byDefinition = new Map<object, SagaTurnRegistration>();
  const byKey = new Set<string>();
  for (const registration of registrations) {
    if (!issuedRegistrations.has(registration)) throw new TypeError('Untrusted saga registration');
    if (table.registered && !table.registered.includes(registration)) throw new TypeError('Mismatched saga registration handle');
    registration.assertCurrent();
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
  return (route: CompiledSagaRoute): SagaTurnRegistration => {
    if (table.registered && !table.routes.includes(route)) throw new TypeError('Unknown saga route');
    const registration = byDefinition.get(route.definition);
    if (!registration || route.sagaKey !== registration.sagaKey || route.definitionVersion !== registration.definitionVersion ||
        route.definition.identity.version !== registration.definitionVersion) throw new TypeError('Unknown or changed saga version');
    registration.assertCurrent();
    return registration;
  };
}

export function assertIssuedSagaRegistration(registration: SagaTurnRegistration): void {
  if (!issuedRegistrations.has(registration)) throw new TypeError('Untrusted saga registration');
  registration.assertCurrent();
}
