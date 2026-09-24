import type { ProjectionCommitDefinition, ProjectionQueueRegistryManifest } from '@redemeine/projection-runtime-core';
import { approvalDigest, normalizeProjectionRegistryDefinitions, projectionDefinitionHash,
  projectionDefinitionRegistryDigest, projectionQueueRegistryDigest, projectionRuntimeConfigurationDigest,
  type JoinedApproval } from '../src';
import { HASH, SOURCE_ID } from './realStackFixtures';

export const JOINED_NAME = 'joined-own';
export const JOINED_GENERATION = 'v1';
export const JOINED_TARGET = 'Joined:one';
export const JOINED_AGGREGATE_TYPE = 'Customer';
export const JOINED_AGGREGATE_ID = 'customer-17';
export const JOINED_BASELINE = 3;
export const JOINED_SEQUENCE = 4;
export const joinedCollections = { documents: 'joined_manual_documents', links: 'joined_manual_links',
  dedupe: 'joined_manual_dedupe', transport: 'joined_manual_transport', approvals: 'joined_manual_approvals' } as const;

export function registerJoinedQueue(queues: string[], queueId: string): void {
  if (queues.includes(queueId)) throw new Error('Joined queue already registered for cleanup.');
  queues.push(queueId);
}

export interface JoinedState { count: number; seen: number[] }

export function joinedDefinition(): { generation: string; definition: ProjectionCommitDefinition<JoinedState> } {
  return { generation: JOINED_GENERATION, definition: {
    name: JOINED_NAME,
    fromStream: { aggregate: { aggregateType: 'Root', initialState: {}, pure: { eventProjectors: {} } }, handlers: {} },
    joinStreams: [{ aggregate: { aggregateType: JOINED_AGGREGATE_TYPE }, handlers: {
      Changed(state, event) {
        state.count += Number(event.payload.amount);
        state.seen.push(Number(event.payload.amount));
      }
    } }],
    initialState: () => ({ count: 0, seen: [] }),
    identity: () => JOINED_TARGET,
    subscriptions: [],
    deduplication: { strategy: 'own_record' }
  } };
}

export function joinedManifest(queueId: string): ProjectionQueueRegistryManifest {
  const configurations = normalizeProjectionRegistryDefinitions([joinedDefinition()], [{ mode: 'manual-joined-cutover' }]);
  const config = configurations[0];
  if (!config) throw new Error('Joined runtime identity configuration missing.');
  const definitions = [{ projectionName: JOINED_NAME, generation: JOINED_GENERATION,
    definitionHash: projectionDefinitionHash(config, HASH), sourceSelectors: [JOINED_AGGREGATE_TYPE], joined: true as const }];
  const manifest = { version: 1 as const, queueId, registryGeneration: JOINED_GENERATION,
    identity: { version: 1 as const, normalizedDefinitionRegistryDigest: projectionDefinitionRegistryDigest(definitions),
      normalizedRuntimeConfigurationDigest: projectionRuntimeConfigurationDigest(configurations),
      executableCodeArtifactDigest: HASH }, definitions, sourceStartAnchors: { [SOURCE_ID]: JOINED_SEQUENCE } };
  return { ...manifest, manifestId: projectionQueueRegistryDigest(manifest) };
}

export function joinedApproval(manifest: ProjectionQueueRegistryManifest, database: string): JoinedApproval {
  const draft = { _id: `joined_approval:${manifest.queueId}`, kind: 'joined_approval' as const,
    queueBindingId: manifest.queueId, manifestId: manifest.manifestId, registryGeneration: manifest.registryGeneration,
    approvalNamespace: `${database}.${joinedCollections.approvals}`,
    transportNamespace: `${database}.${joinedCollections.transport}`,
    approvedBy: 'accepted-stack-operator', approvedAt: new Date().toISOString(), inventories: [{
      projectionName: JOINED_NAME, generation: JOINED_GENERATION,
      linkNamespace: `${database}.${joinedCollections.links}`,
      documentNamespace: `${database}.${joinedCollections.documents}`,
      expected: [{ aggregateType: JOINED_AGGREGATE_TYPE, aggregateId: JOINED_AGGREGATE_ID, targetDocId: JOINED_TARGET }],
      maxLinkRows: 1 }] };
  return { ...draft, digest: approvalDigest(draft) };
}
