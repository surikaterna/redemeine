import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SagaDefinition, SagaPluginManifestList, SagaResponseHandlerTokenBindings } from '@redemeine/saga';

export interface TrustedSagaArtifact {
  readonly bundlePath: string;
  readonly expectedSha256: string;
}

export interface SagaExecutableIdentity {
  readonly sagaKey: string;
  readonly definitionVersion: number;
  readonly artifactSha256: string;
  readonly policySha256: string;
}

export function verifySagaArtifact(artifact: TrustedSagaArtifact): string {
  if (typeof artifact.bundlePath !== 'string' || !artifact.bundlePath.endsWith('.js') ||
      typeof artifact.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.expectedSha256)) {
    throw new TypeError('Trusted saga JS artifact path and SHA256 required');
  }
  const bytes = readFileSync(artifact.bundlePath);
  if (bytes.length === 0) throw new TypeError('Empty saga executable artifact');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== artifact.expectedSha256) throw new TypeError('Trusted saga artifact digest mismatch');
  return digest;
}

export function sagaPolicyFingerprint<TState, TPlugins extends SagaPluginManifestList, TBindings extends SagaResponseHandlerTokenBindings, TInput>(
  definition: SagaDefinition<TState, TPlugins, TBindings, TInput>, manifests: TPlugins,
  bindings: TBindings, commandTypes: readonly string[]
): string {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const plugins = manifests.map((manifest) => ({
    key: manifest.plugin_key, version: Object.hasOwn(manifest, 'version') ? manifest.version : null,
    actions: Object.entries(manifest.actions).map(([name, descriptor]) => [name, descriptor.interaction]).sort(([a], [b]) => compare(String(a), String(b)))
  })).sort((a, b) => compare(a.key, b.key));
  const tokens = Object.entries(bindings).map(([key, value]) => [key, value.phase]).sort(([a], [b]) => compare(String(a), String(b)));
  const policy = JSON.stringify([definition.sagaKey, definition.identity.version, plugins, tokens, [...commandTypes].sort()]);
  return createHash('sha256').update(policy).digest('hex');
}

// A verified bundle digest assumes deployment supplied an independent expected digest.
// It does not fingerprint closure captures; vpwm.2 must persist and check this identity on hydration.
