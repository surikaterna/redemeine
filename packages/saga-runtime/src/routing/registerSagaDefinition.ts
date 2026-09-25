import { runSagaStartHandler } from '@redemeine/saga';
import type { SagaDefinition, SagaIntentMetadata, SagaPluginManifestList, SagaResponseHandlerTokenBindings } from '@redemeine/saga';
import type { CompiledSagaRoutingTable, CompiledSagaStartRoute } from './contracts';
import { validateInitialSagaState, validateSagaRegistration } from './registrationValidation';
import { validateBusinessState } from '../businessStateValidation';
import { sagaPolicyFingerprint, verifySagaArtifact, type SagaExecutableIdentity, type TrustedSagaArtifact } from './executableIdentity';
import { startWireRegistry, validateStartIntents, type StartTurnOrigin } from './startIntentValidation';
import type { WireIntent } from '../intentWire';

const issuedRegistrations = new WeakSet<object>();

export interface SagaArtifactAuthority {
  readonly resolveArtifact: (sagaKey: string, definitionVersion: number) => TrustedSagaArtifact;
}

export class SagaStartDecisionError extends Error {
  readonly code = 'invalid_start_intent';
  constructor(cause: unknown) {
    super('Saga start emitted an invalid intent', { cause });
    this.name = 'SagaStartDecisionError';
  }
}

export interface SagaRegistration<TState extends object = object> {
  readonly definition: object;
  readonly sagaKey: string;
  readonly definitionVersion: number;
  readonly executableIdentity: SagaExecutableIdentity;
  readonly assertCurrent: () => void;
  readonly executeStart: (input: unknown, metadata: SagaIntentMetadata, origin: StartTurnOrigin, turnClock: string) => Promise<{ state: TState; intents: readonly WireIntent[] }>;
}

function captureReferences<TState, TPlugins extends SagaPluginManifestList, TBindings extends SagaResponseHandlerTokenBindings, TInput>(
  definition: SagaDefinition<TState, TPlugins, TBindings, TInput>, manifests: TPlugins
): readonly unknown[] {
  return [definition.start, definition.initialState, definition.startContracts.correlation?.correlateBy,
    ...definition.startContracts.triggers.flatMap((trigger) => [trigger.kind, trigger.when, trigger.toStartInput]),
    ...Object.entries(definition.responseHandlers).flat(), ...Object.entries(definition.errorHandlers).flat(),
    ...Object.entries(definition.retryHandlers).flat(),
    ...definition.handlers.flatMap((group) => [group.aggregateType, ...Object.entries(group.handlers).flat()]),
    ...manifests.flatMap((manifest) => Object.entries(manifest.actions).flatMap(([name, action]) => [name, action.build]))];
}

function createExecutableGuard<TState, TPlugins extends SagaPluginManifestList, TBindings extends SagaResponseHandlerTokenBindings, TInput>(
  definition: SagaDefinition<TState, TPlugins, TBindings, TInput>, manifests: TPlugins,
  bindings: TBindings, commands: readonly string[], authority: SagaArtifactAuthority
) {
  const sagaKey = definition.sagaKey;
  const definitionVersion = definition.identity.version;
  const artifactSha256 = verifySagaArtifact(authority.resolveArtifact(sagaKey, definitionVersion));
  const policySha256 = sagaPolicyFingerprint(definition, manifests, bindings, commands);
  const executableIdentity = Object.freeze({ sagaKey, definitionVersion, artifactSha256, policySha256 });
  const references = captureReferences(definition, manifests);
  const assertCurrent = () => {
    validateSagaRegistration(definition, manifests, bindings);
    const current = captureReferences(definition, manifests);
    if (definition.sagaKey !== sagaKey || definition.identity.version !== definitionVersion ||
        sagaPolicyFingerprint(definition, manifests, bindings, commands) !== policySha256 ||
        current.length !== references.length || current.some((value, index) => value !== references[index]) ||
        verifySagaArtifact(authority.resolveArtifact(sagaKey, definitionVersion)) !== artifactSha256) {
      throw new TypeError('Saga executable changed after registration');
    }
  };
  return { executableIdentity, assertCurrent };
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
  readonly canonicalCommandTypes: readonly string[];
}, authority: SagaArtifactAuthority): SagaRegistration<TState> {
  const { definition, pluginManifests, responseHandlerBindings, parseStartInput } = options;
  validateSagaRegistration(definition, pluginManifests, responseHandlerBindings);
  if (typeof parseStartInput !== 'function' || typeof definition.start !== 'function') throw new TypeError('Saga start decoder and handler required');
  if (!authority || typeof authority.resolveArtifact !== 'function') throw new TypeError('Trusted saga artifact authority required');
  const sagaKey = definition.sagaKey;
  const definitionVersion = definition.identity.version;
  const commands = [...options.canonicalCommandTypes];
  if (commands.some((command) => typeof command !== 'string' || !command) || new Set(commands).size !== commands.length) throw new TypeError('Invalid canonical command allowlist');
  const { executableIdentity, assertCurrent } = createExecutableGuard(definition, pluginManifests, responseHandlerBindings, commands, authority);
  const registration: SagaRegistration<TState> = Object.freeze({
    definition,
    sagaKey,
    definitionVersion,
    executableIdentity,
    assertCurrent,
    executeStart: makeStartExecutor(definition, parseStartInput, pluginManifests, responseHandlerBindings, commands, assertCurrent)
  });
  issuedRegistrations.add(registration);
  return registration;
}

export function bindSagaRegistrations(table: CompiledSagaRoutingTable, registrations: readonly SagaRegistration[]) {
  const active = new Set<object>(table.definitions);
  const byDefinition = new Map<object, SagaRegistration>();
  const byKey = new Set<string>();
  for (const registration of registrations) {
    if (!issuedRegistrations.has(registration)) throw new TypeError('Untrusted saga registration');
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
  return (route: CompiledSagaStartRoute): SagaRegistration => {
    const registration = byDefinition.get(route.definition);
    if (!registration || route.sagaKey !== registration.sagaKey || route.definitionVersion !== registration.definitionVersion ||
        route.definition.identity.version !== registration.definitionVersion) throw new TypeError('Unknown or changed saga version');
    registration.assertCurrent();
    return registration;
  };
}
