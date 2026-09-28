import { createHash } from 'node:crypto';
import type { SagaPluginManifestList, SagaResponseHandlerTokenBindings } from '@redemeine/saga';

export interface DefinitionIdentityV1 {
  readonly sagaKey: string;
  readonly definitionVersion: number;
  readonly policySha256: string;
}

export interface DeclaredSchemaIdentity {
  readonly id: string;
  readonly version: number;
}

const domain = 'redemeine.saga.definition-policy.v1\n';
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function boundedName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new TypeError('Invalid saga policy name');
  }
  return value;
}

function uniqueNames(names: readonly string[]): void {
  if (names.length > 256 || new Set(names).size !== names.length) throw new TypeError('Duplicate or oversized saga policy entries');
}

export function sagaPolicyFingerprint(
  manifests: SagaPluginManifestList, bindings: SagaResponseHandlerTokenBindings,
  commandTypes: readonly string[], schemas: readonly DeclaredSchemaIdentity[] = []
): string {
  if (manifests.length > 256 || schemas.length > 256) throw new TypeError('Oversized saga policy');
  const plugins = manifests.map((manifest) => {
    const key = boundedName(manifest.plugin_key);
    const version = Object.hasOwn(manifest, 'version') ? boundedName(manifest.version) : null;
    const actions: [string, string][] = Object.entries(manifest.actions).map(([name, action]) => {
      boundedName(name);
      if (action.interaction !== 'fire_and_forget' && action.interaction !== 'request_response') throw new TypeError('Invalid interaction');
    return [name, action.interaction];
    });
    uniqueNames(actions.map(([name]) => name));
    actions.sort(([a], [b]) => compare(a, b));
    return { key, version, actions };
  });
  uniqueNames(plugins.map(({ key }) => key));
  plugins.sort((a, b) => compare(a.key, b.key));
  const tokens: [string, string][] = Object.entries(bindings).map(([name, binding]) => {
    boundedName(name);
    if (binding.phase !== 'response' && binding.phase !== 'error' && binding.phase !== 'retry') throw new TypeError('Invalid token phase');
    return [name, binding.phase];
  });
  uniqueNames(tokens.map(([name]) => name));
  tokens.sort(([a], [b]) => compare(a, b));
  const commands = commandTypes.map(boundedName);
  uniqueNames(commands);
  commands.sort(compare);
  const declaredSchemas = schemas.map(({ id, version }) => {
    boundedName(id);
    if (!Number.isSafeInteger(version) || version < 1) throw new TypeError('Invalid schema version');
    return [id, version] as const;
  });
  uniqueNames(declaredSchemas.map(([id]) => id));
  declaredSchemas.sort(([a], [b]) => compare(a, b));
  const policy = JSON.stringify([plugins, tokens, commands, declaredSchemas]);
  if (Buffer.byteLength(policy, 'utf8') > 64 * 1024) throw new TypeError('Oversized saga policy');
  return createHash('sha256').update(domain).update(policy).digest('hex');
}
