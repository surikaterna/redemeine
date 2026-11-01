import { fixtureRegistry, type CounterState } from './fixtureRegistry';
import type { RuntimeIdentity, RuntimeRegistry } from './runtimeRegistry';

export function referenceRegistry(identity: RuntimeIdentity): RuntimeRegistry<CounterState> {
  return Object.freeze({ registryDigest: identity.registryDigest, definitions: (generation: string) => fixtureRegistry(generation),
    namespace: (epoch?: string) => `rdm_fixture_${identity.registryDigest}${epoch ? `_${epoch}` : ''}` });
}
