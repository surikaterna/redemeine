import { normalizeSagaIdentity } from '@redemeine/saga';
import type { SagaDefinition, SagaPluginManifestList, SagaPluginRegistryEntry, SagaResponseHandlerTokenBindings } from '@redemeine/saga';
import { validateBusinessState } from '../businessStateValidation';

function reject(message: string): never {
  throw new TypeError(`Invalid saga registration: ${message}`);
}

function ownEntries(value: object): [string, unknown][] {
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) reject('non-plain registry');
  if (Reflect.ownKeys(value).length !== Object.keys(value).length) reject('non-enumerable or symbol registry entry');
  return Object.entries(value);
}

function exactNames(actual: readonly string[], expected: readonly string[], label: string): void {
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length ||
      actual.length !== expected.length || actual.some((name) => !expected.includes(name))) reject(`${label} names differ or repeat`);
}

export function validateSagaRegistration<TState, TPlugins extends SagaPluginManifestList, TBindings extends SagaResponseHandlerTokenBindings, TInput>(
  definition: SagaDefinition<TState, TPlugins, TBindings, TInput>,
  manifests: TPlugins,
  bindings: TBindings
): void {
  if (!definition.identity || typeof definition.identity.namespace !== 'string' || typeof definition.identity.name !== 'string' ||
      !Number.isSafeInteger(definition.identity.version) || definition.identity.version < 1) reject('identity');
  const identity = normalizeSagaIdentity(definition.identity);
  if (definition.sagaKey !== identity.sagaKey || definition.sagaType !== identity.sagaType || definition.sagaUrn !== identity.sagaUrn) reject('identity mismatch');
  if (!Array.isArray(definition.plugins) || !Array.isArray(manifests)) reject('plugin registry');
  const registry = new Map<string, SagaPluginRegistryEntry>();
  for (const entry of definition.plugins) {
    if (typeof entry.plugin_key !== 'string' || !entry.plugin_key || registry.has(entry.plugin_key) ||
        entry.plugin_kind !== 'manifest' || !Array.isArray(entry.action_names) ||
        entry.action_names.some((name: string) => typeof name !== 'string' || !name) ||
        (Object.hasOwn(entry, 'version') && typeof entry.version !== 'string')) reject('registry metadata');
    registry.set(entry.plugin_key, entry);
  }
  const seen = new Set<string>();
  for (const manifest of manifests) {
    if (!manifest || typeof manifest.plugin_key !== 'string' || !manifest.plugin_key || seen.has(manifest.plugin_key)) reject('duplicate or invalid manifest key');
    seen.add(manifest.plugin_key);
    const entry = registry.get(manifest.plugin_key);
    if (!entry || Object.hasOwn(entry, 'version') !== Object.hasOwn(manifest, 'version') || entry.version !== manifest.version ||
        (Object.hasOwn(manifest, 'version') && typeof manifest.version !== 'string')) reject('manifest key or version mismatch');
    if (!manifest.actions || typeof manifest.actions !== 'object' || Array.isArray(manifest.actions)) reject('invalid actions');
    const actions = ownEntries(manifest.actions);
    exactNames(actions.map(([name]) => name), entry.action_names, manifest.plugin_key);
    for (const [name, descriptor] of actions) {
      if (!descriptor || typeof descriptor !== 'object' ||
          !('interaction' in descriptor) || !('build' in descriptor) ||
          (descriptor.interaction !== 'fire_and_forget' && descriptor.interaction !== 'request_response') ||
          typeof descriptor.build !== 'function') reject(`invalid action ${name}`);
    }
  }
  if (seen.size !== registry.size) reject('missing manifests');
  validateTokenBindings(definition, bindings);
}

function validateTokenBindings<TState, TPlugins extends SagaPluginManifestList, TBindings extends SagaResponseHandlerTokenBindings, TInput>(
  definition: SagaDefinition<TState, TPlugins, TBindings, TInput>, bindings: TBindings
): void {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) reject('invalid bindings');
  const tokens = ownEntries(bindings);
  const expected = new Map<string, string>();
  for (const [phase, handlers] of [
    ['response', definition.responseHandlers], ['error', definition.errorHandlers], ['retry', definition.retryHandlers]
  ] as const) {
    for (const [name] of ownEntries(handlers)) {
      if (expected.has(name)) reject('duplicate token across phases');
      expected.set(name, phase);
    }
  }
  if (tokens.length !== expected.size) reject('token count mismatch');
  for (const [name, token] of tokens) {
    if (!token || typeof token !== 'object' || !('phase' in token) || token.phase !== expected.get(name)) reject(`token phase mismatch: ${name}`);
  }
}

export function validateInitialSagaState(value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) reject('initial state must be a plain record');
  validateBusinessState(value, { maxBytes: 8 * 1024 * 1024, maxDepth: 32, maxNodes: 100_000 });
}
