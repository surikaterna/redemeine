import { randomUUID } from 'node:crypto';
import {
  createProjection, createProjectionDispatchBindingProof, type ProjectionCommitDefinition, type ProjectionJsonObject,
  type ProjectionQueueRegistryManifest, type ProjectionSourceCommit, type ProjectionSourceCommitStorePort
} from '@redemeine/projection-runtime-core';
import { createProjectionCommitCoordinator, type ProjectionCommitCoordinatorOptions } from '@redemeine/projection-worker-core';

export const orderId = 'order-42';
const root = { aggregateType: 'Board', initialState: {}, pure: { eventProjectors: {
  attach: (_state: unknown, _event: { payload: { order?: string; cancel?: boolean } }) => {}, detach: () => {}, direct: () => {}
} } };
const order = { aggregateType: 'Order', pure: { eventProjectors: {
  routed: (_state: unknown, _event: { payload: {
    targets?: string | string[]; to?: string; from?: string; skip?: boolean; canceled?: boolean; attachAll?: boolean; extra?: string
  } }) => {},
  ordinary: () => {}, unlink: (_state: unknown, _event: { payload: { only?: string } }) => {}
} }, types: { events: { routed: 'custom.order.route' as const } } };

export type State = { id: string; visits: string[] };
export const strategy = { strategy: 'own_record' } as const;
export const path = { aggregateType: 'Order', aggregateId: orderId };

export function definition(deduplication: ProjectionCommitDefinition<State>['deduplication'] = strategy) {
  return createProjection('boards', (id): State => ({ id, visits: [] }))
    .from(root, {
      attach(draft, e, ctx) {
        const id = String(e.payload.order ?? orderId);
        ctx.subscribeTo(order, id);
        if (e.payload.cancel) ctx.unsubscribeFrom(order, id);
        draft.visits.push('root-attach');
      },
      detach(draft, _e, ctx) { ctx.unsubscribeFrom(order, orderId); draft.visits.push('root-detach'); },
      direct(draft) { draft.visits.push('direct'); }
    })
    .join(order, {
      routed(draft, e, ctx) {
        if (e.payload.skip) return;
        if (e.payload.attachAll || draft.id === e.payload.to) ctx.subscribeTo(order, e.aggregateId);
        if (e.payload.extra) ctx.subscribeTo(order, e.payload.extra);
        if (draft.id === e.payload.from) ctx.unsubscribeFrom(order, e.aggregateId);
        draft.visits.push('routed');
        if (e.payload.canceled) draft.visits.pop();
      },
      ordinary(draft) { draft.visits.push('ordinary'); },
      unlink(draft, e, ctx) {
        if (e.payload.only && e.payload.only !== draft.id) return;
        ctx.unsubscribeFrom(order, e.aggregateId);
        draft.visits.push('unlink');
      }
    })
    .joinRight(order, { routed: (e) => e.payload.targets })
    .deduplication(deduplication).buildCommitDefinition();
}

export const routed = order.types.events.routed;
export function turn(source: string, sequence: number, id: string, events: readonly [string, ProjectionJsonObject?][],
  aggregateType = 'Order'): ProjectionSourceCommit {
  return { streamId: source, commitId: randomUUID(), commitSequence: sequence, events: events.map(([type, payload], eventIndex) => ({
    eventId: randomUUID(), eventIndex, streamVersion: sequence * 100 + eventIndex, aggregateType, aggregateId: id,
    type, payload: payload ?? {}, timestamp: '2026-11-19T00:00:00.000Z'
  })) as unknown as ProjectionSourceCommit['events'] };
}

const hash = `sha256:${'b'.repeat(64)}` as const;
export function manifest(queueId = 'join-set', sourceStartAnchors: Readonly<Record<string, number>> = {}): ProjectionQueueRegistryManifest {
  return { version: 1, queueId, manifestId: hash, registryGeneration: 'set-generation',
    identity: { version: 1, normalizedDefinitionRegistryDigest: hash, normalizedRuntimeConfigurationDigest: hash,
      executableCodeArtifactDigest: hash },
    definitions: [{ projectionName: 'boards', generation: 'set-generation', joined: true, joinMembership: 'set-v1',
      sourceSelectors: ['Order', 'Board'], definitionHash: hash, projectionChanges: 'join-changes' }], sourceStartAnchors };
}

export function fixtureOptions(store: ProjectionSourceCommitStorePort<State>, commits: readonly ProjectionSourceCommit[] = [],
  deduplication: ProjectionCommitDefinition<State>['deduplication'] = strategy): ProjectionCommitCoordinatorOptions<State> {
  const coverage = new Map<string, number>();
  return {
    store, queueBindingId: 'join-set', manifest: manifest(), maxCommits: 10, maxBytes: 2_000_000,
    definitions: [{ generation: 'set-generation', definition: definition(deduplication), projectionChanges: 'join-changes' }],
    sourceOrder: {
      async admitForDispatch(commit, queueBindingId, proof) {
        return { dispatch: true, startAnchor: 0, boundDispatchProof: proof,
          coverage: { queueBindingId, sourceId: commit.streamId, sequence: coverage.get(commit.streamId) ?? null },
          strategyScope: [{ projectionName: 'boards', generation: 'set-generation', strategy: deduplication.strategy,
            stableSingleTarget: false }] };
      },
      async advanceCoverage({ queueBindingId, sourceId, sequence }) {
        coverage.set(sourceId, sequence);
        return { queueBindingId, sourceId, sequence };
      }
    },
    rangeReader: {
      capability: { completeCommitBoundaries: true, unslicedCommitEvents: true },
      async readCompleteRange({ sourceId, afterSequence, throughSequence, maxCommits }) {
        const values = commits.filter((item) => item.streamId === sourceId && item.commitSequence > (afterSequence ?? -1)
          && item.commitSequence <= throughSequence).slice(0, maxCommits);
        const last = values.at(-1)?.commitSequence ?? afterSequence;
        return { status: 'complete', commits: values.map((commit) => ({ commit, encodedByteLength: 100 })),
          encodedByteLength: values.length * 100, continuationAfterSequence: last, hasMore: (last ?? -1) < throughSequence };
      }
    }
  };
}

export function coordinator(options: ProjectionCommitCoordinatorOptions<State>) {
  return createProjectionCommitCoordinator(options);
}

export async function fixtureCoverage(options: ProjectionCommitCoordinatorOptions<State>, commit: ProjectionSourceCommit) {
  return (await options.sourceOrder.admitForDispatch(commit, options.queueBindingId,
    createProjectionDispatchBindingProof(options.manifest))).coverage.sequence;
}

export function snapshot(store: ProjectionSourceCommitStorePort<State>, sourceId: string,
  targetDocumentIds: readonly string[] = [], links = [path]) {
  return store.loadProjectionSourceCommitSnapshot({
    projectionName: 'boards', projectionGeneration: 'set-generation', joinMembership: 'set-v1', targetDocumentIds,
    links, progressStrategy: 'own_record', sourceId
  });
}
