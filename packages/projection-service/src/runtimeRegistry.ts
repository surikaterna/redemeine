import { createHash } from 'node:crypto';
import type { ProjectionCommitDefinition } from '@redemeine/projection-runtime-core';

export interface RuntimeIdentity { readonly digest: string; readonly registryDigest: string }
export interface RuntimeRegistry<TState = unknown> {
  readonly registryDigest: string;
  definitions(generation: string): readonly { definition: ProjectionCommitDefinition<TState>; generation: string }[];
  namespace(epoch?: string): string;
}

export function applicationRegistry(digest: string, moduleHash: string, definitions: readonly ProjectionCommitDefinition<unknown>[]) {
  const metadata = definitions.map((definition) => ({ name: definition.name, aggregate: definition.fromStream.aggregate.aggregateType,
    handlers: Object.keys(definition.fromStream.handlers).sort(), projectors: Object.keys(definition.fromStream.aggregate.pure.eventProjectors).sort(),
    deduplication: definition.deduplication, afterEach: definition.hooks?.afterEach !== undefined,
    initialization: 'suffix_contributions', routing: 'event_stable_commutative' }));
  const registryDigest = createHash('sha256').update(JSON.stringify({ protocol: 'main-worker-v1', digest, moduleHash, metadata })).digest('hex');
  const identity: RuntimeIdentity = Object.freeze({ digest, registryDigest });
  const registry: RuntimeRegistry = Object.freeze({ registryDigest,
    definitions: (generation: string) => Object.freeze(definitions.map((definition) => Object.freeze({ definition, generation }))),
    namespace: (epoch?: string) => `rdm_projection_${createHash('sha256').update(JSON.stringify([registryDigest, epoch ?? null])).digest('hex')}` });
  return Object.freeze({ identity, registry, metadata: Object.freeze(metadata) });
}
