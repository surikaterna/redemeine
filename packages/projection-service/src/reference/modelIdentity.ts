import type { LiveNativeStartRecord } from '@redemeine/projection-runtime-core';
import type { LiveDeliveryScope } from '@redemeine/projection-transport';

export const modelScope: LiveDeliveryScope = Object.freeze({ sourceScopeDigest: 'model:fixed-scope-v1',
  collection: 'model-commits', partitionId: 'model-partition' });

export function modelStart(registryDigest: string): LiveNativeStartRecord {
  return Object.freeze({ mode: 'LIVE_FROM_BOUNDARY', epoch: 'model:ephemeral-epoch',
    queueName: 'rdm.projection.commits', vhost: 'model:isolated', bindingRef: 'model:intended-queue',
    registryDigest, generation: 'model:ephemeral-generation', sourceScopeDigest: modelScope.sourceScopeDigest,
    nativeStartRef: 'model:native-boundary', provisioningRef: 'model:empty-output-and-queue',
    publisherRef: 'model:serialized-publisher', orderedFeedQualificationRef: 'model:confirm-checkpoint-history-v1' });
}
