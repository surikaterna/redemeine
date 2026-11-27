import { createProjection } from '@redemeine/projection';
import type { ProjectionQueueRegistryManifest, ProjectionSourceCommit, ProjectionSourceCommitStorePort } from '@redemeine/projection-runtime-core';
import { createProjectionCommitCoordinator, type ProjectionCommitRegistryDefinition,
  type ProjectionCommitCoordinatorOptions } from '@redemeine/projection-worker-core';

type View = { count: number };
const board = { aggregateType: 'Board', pure: { eventProjectors: {} } };
const order = { aggregateType: 'Order', pure: { eventProjectors: {
  added: (_state: unknown, _event: { payload: { boardId: string; amount: number } }) => undefined
} } };
const definition = createProjection('boards', (): View => ({ count: 0 }))
  .from(board, {})
  .join(order, { added(view, event, ctx) {
    view.count += event.payload.amount;
    ctx.subscribeTo(order, event.aggregateId);
  } })
  .joinRight(order, { added: (event) => event.payload.boardId })
  .deduplication({ strategy: 'own_record' })
  .build();

// Full registry records and existing typed options still expose the runtime aggregate metadata to readers.
function readFullRegistry(entry: ProjectionCommitRegistryDefinition<View>, options: ProjectionCommitCoordinatorOptions<View>) {
  return [entry.definition.fromStream.aggregate.initialState, options.definitions[0]?.definition.fromStream.aggregate.pure.eventProjectors];
}
void readFullRegistry;

const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const sourceId = '00000000-0000-4000-8000-000000000010';
const queue = 'boards-queue';
const manifest: ProjectionQueueRegistryManifest = {
  version: 1, manifestId: digest, queueId: queue, registryGeneration: 'v1',
  identity: { version: 1, normalizedDefinitionRegistryDigest: digest, normalizedRuntimeConfigurationDigest: digest,
    executableCodeArtifactDigest: digest },
  definitions: [{ projectionName: 'boards', generation: 'v1', definitionHash: digest, sourceSelectors: ['Board', 'Order'],
    joined: true, joinMembership: 'set-v1', projectionChanges: 'changes' }],
  sourceStartAnchors: { [sourceId]: 0 }
};
const input: ProjectionSourceCommit = { streamId: sourceId, commitId: '00000000-0000-4000-8000-000000000011',
  commitSequence: 0, events: [{ eventId: '00000000-0000-4000-8000-000000000012', eventIndex: 0, streamVersion: 0,
    aggregateType: 'Order', aggregateId: 'one', type: 'added', timestamp: '2026-11-19T00:00:00.000Z',
    payload: { boardId: 'chosen', amount: 4 } }] };
export async function verifyAuthoredDispatch(store: ProjectionSourceCommitStorePort<View>) {
  let covered: number | null = null;
  const coordinator = createProjectionCommitCoordinator({
    queueBindingId: queue, manifest, store, maxCommits: 2, maxBytes: 100_000,
    definitions: [{ definition, generation: 'v1', projectionChanges: 'changes' }],
    sourceOrder: {
      async admitForDispatch(_commit, queueBindingId, proof) {
        return { dispatch: true, coverage: { queueBindingId, sourceId, sequence: covered }, startAnchor: 0,
          boundDispatchProof: proof, strategyScope: [{ projectionName: 'boards', generation: 'v1', strategy: 'own_record',
            stableSingleTarget: false }] };
      },
      async advanceCoverage({ queueBindingId, sequence }) {
        covered = sequence;
        return { queueBindingId, sourceId, sequence };
      }
    },
    rangeReader: {
      capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
      async readCompleteRange() { throw new Error('Unexpected gap'); }
    }
  });
  const result = await coordinator.process(input);
  const snapshot = await store.loadProjectionSourceCommitSnapshot({ projectionName: 'boards', projectionGeneration: 'v1',
    joinMembership: 'set-v1', targetDocumentIds: ['chosen'], links: [{ aggregateType: 'Order', aggregateId: 'one' }],
    progressStrategy: 'own_record', sourceId, changeIdentity: { sourceId, commitId: input.commitId, commitSequence: 0, collection: 'changes' } });
  if (result.status !== 'completed' || covered !== 0 || snapshot.targets[0]?.state?.count !== 4
    || snapshot.joinMemberships?.[0]?.targetDocumentIds.join() !== 'chosen' || snapshot.changeReceipt !== 'committed') {
    throw new Error(`Authored native set-mode dispatch failed: ${JSON.stringify({ result, covered, snapshot })}`);
  }
}
