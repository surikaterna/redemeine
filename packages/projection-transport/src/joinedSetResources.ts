import type { ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import type { JoinedInventory } from './joinedCutover';

/** Check only native resources, once per transport instance; approval and scalar collation are independent. */
export async function verifyJoinedSetResourceCollations(manifest: ProjectionQueueRegistryManifest, resources: readonly JoinedInventory[]) {
  for (const [index, definition] of manifest.definitions.filter(({ joined }) => joined === true).entries()) {
    if (definition.joinMembership !== 'set-v1') continue;
    const resource = resources[index];
    if (!resource) throw new Error('Missing joined membership collection handles.');
    for (const collection of [resource.links, resource.documents]) {
      const { collation } = await collection.options();
      if (collation !== undefined && collation?.locale !== 'simple') {
        throw new Error(`Joined set resource ${collection.namespace} requires simple collation.`);
      }
    }
  }
}
