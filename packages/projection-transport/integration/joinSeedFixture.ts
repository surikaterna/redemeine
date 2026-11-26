import assert from 'node:assert/strict';
import {
  createProjection, createProjectionDispatchBindingProof, joinInitializer, matchesProjectionDispatchBinding,
  ProjectionDispatchBindingMismatchError, type JoinSeedPosition, type JoinSeedProvenance,
  type ProjectionChangesRecord, type ProjectionDispatchBindingProof, type ProjectionSourceCommit,
  type ProjectionSourceCommitStorePort, type ProjectionSourceCoverageAdvance
} from '@redemeine/projection-runtime-core';
import {
  bindJoinSeedReader, createProjectionCommitCoordinator, joinSeedDeployments,
  type JoinSeedRead, type JoinSeedReader, type ProjectionCommitRegistryDefinition
} from '@redemeine/projection-worker-core';
import { manifest, orderId } from './joinMembershipFixture';
import { createProjection as createPublicProjection, joinInitializer as publicInitializer } from '../../projection/src';

const Board = { aggregateType: 'Board', initialState: {}, pure: { eventProjectors: {
  attach: (_: unknown, _event: { payload: { seed?: boolean; cancel?: boolean } }) => {}
} } };
const Order = { aggregateType: 'Order', initialState: { warehouse: { remaining: [0] } }, pure: { eventProjectors: {
  assign: (_: unknown, _event: { payload: { to: string; amount: number } }) => {},
  delta: (_: unknown, _event: { payload: { amount: number } }) => {}, unlink: () => {}
} } };
export const OrderProjection = createPublicProjection('OrderProjection', () => ({ booking: { total: 0 } }))
  .from(Order, {
    assign(draft, event) { draft.booking.total += event.payload.amount; },
    delta(draft, event) { draft.booking.total += event.payload.amount; }
  }).deduplication({ strategy: 'in_document' }).build();
const view = joinInitializer(Order, { from: 'projection', projection: OrderProjection });
const snapshot = publicInitializer(Order, { from: 'snapshot' });
type ViewInput = ReturnType<typeof OrderProjection.initialState>;
type SnapshotInput = typeof Order.initialState;
export type State = { total: number; effects: string[] };
export const generation = 'join-init-g1';
export const path = { aggregateType: 'Order', aggregateId: orderId };

function builder(binding: typeof view | typeof snapshot) {
  return createProjection('boards', (): State => ({ total: 0, effects: [] }))
    .deduplication({ strategy: 'own_record' })
    .from(Board, { attach(draft, { payload }, ctx) {
      if (payload.seed) ctx.subscribeTo(binding, orderId);
      else ctx.subscribeTo(Order, orderId);
      if (payload.cancel) ctx.unsubscribeFrom(Order, orderId);
      draft.effects.push('attach');
    } })
    .join(Order, {
      assign(draft, event, ctx) {
        ctx.subscribeTo(binding, event.aggregateId);
        if (ctx.joinSeedCoverage === 'uncovered' || ctx.joinSeedCoverage === 'unknown') draft.total += event.payload.amount;
        draft.effects.push(`assign:${ctx.joinSeedCoverage ?? 'unseeded'}`);
      },
      delta(draft, event, ctx) {
        if (ctx.joinSeedCoverage !== 'covered') draft.total += event.payload.amount;
        draft.effects.push(`delta:${ctx.joinSeedCoverage ?? 'unseeded'}`);
      },
      unlink(draft, event, ctx) {
        ctx.unsubscribeFrom(Order, event.aggregateId);
        draft.effects.push(`unlink:${ctx.joinSeedCoverage ?? 'unseeded'}`);
      }
    })
    .joinRight(Order, { assign: (event) => event.payload.to })
    .hooks({ afterEach(draft, event) { if (event.type === 'assign') draft.effects.push(`after:${draft.total}`); } });
}

export function viewFixture(readOne: (id: string, signal: AbortSignal) => Promise<JoinSeedRead<ViewInput> | null>,
  requestDifferentBinding = false) {
  return { definition: builder(requestDifferentBinding ? snapshot : view).onJoinInitialize(view, (draft, seed, info) => {
    assert(Object.isFrozen(seed.booking));
    draft.total = seed.booking.total;
    if (info.coverage === 'uncovered' && info.event.type === 'assign') {
      const amount = info.event.payload.amount;
      if (typeof amount !== 'number') throw new Error('Fixture requires numeric amount.');
      draft.total += amount;
    }
    draft.effects.push(`view:${info.coverage}`);
  }).build(), reader: bindJoinSeedReader(view, { seedGeneration: 'producer-g1', policy: 'proven', readOne }) };
}

export function snapshotFixture(readOne: (id: string, signal: AbortSignal) => Promise<JoinSeedRead<SnapshotInput> | null>) {
  return { definition: builder(snapshot).onJoinInitialize(snapshot, (draft, seed, info) => {
    assert(Object.isFrozen(seed.warehouse.remaining));
    draft.total = seed.warehouse.remaining[0]!;
    draft.effects.push(`snapshot:${info.coverage}`);
  }).build(), reader: bindJoinSeedReader(snapshot, { seedGeneration: 'producer-g1', policy: 'bestEffort', readOne }) };
}

export function evidence(aggregateId: string, from: 'projection' | 'snapshot', position: JoinSeedPosition): JoinSeedProvenance {
  return { ...path, aggregateId, documentId: aggregateId, from, seedName: from === 'projection' ? 'OrderProjection' : 'Order',
    seedGeneration: 'producer-g1', position };
}

export interface Backend {
  store(): ProjectionSourceCommitStorePort<State>;
  history(): Promise<readonly ProjectionChangesRecord[]>;
}

export function fixtureRuntime(backend: Backend, fixture: { definition: ProjectionCommitRegistryDefinition<State>['definition'];
  reader: JoinSeedReader }, recording = true) {
  const coverage = new Map<string, number>();
  const m = manifest('seed-queue');
  const { projectionChanges: _, ...scope } = m.definitions[0]!;
  const registry = { ...m, definitions: [{
    ...scope, generation, joinSeeds: joinSeedDeployments([fixture.reader]),
    ...(recording ? { projectionChanges: 'join-changes' } : {})
  }] };
  const boundDispatchProof = createProjectionDispatchBindingProof(registry);
  const options = {
    queueBindingId: m.queueId, manifest: registry, maxBytes: 2_000_000, maxCommits: 10,
    definitions: [{ generation, definition: fixture.definition, joinSeedReaders: [fixture.reader],
      ...(recording ? { projectionChanges: 'join-changes' } : {}) }],
    sourceOrder: {
      async admitForDispatch(commit: ProjectionSourceCommit, queueBindingId: string, expected: ProjectionDispatchBindingProof) {
        if (!matchesProjectionDispatchBinding(expected, boundDispatchProof)) throw new ProjectionDispatchBindingMismatchError();
        return { dispatch: true as const, startAnchor: 0, boundDispatchProof,
          coverage: { queueBindingId, sourceId: commit.streamId, sequence: coverage.get(commit.streamId) ?? null },
          strategyScope: [{ projectionName: 'boards', generation, strategy: 'own_record' as const, stableSingleTarget: false }] };
      },
      async advanceCoverage({ queueBindingId, sourceId, sequence }: ProjectionSourceCoverageAdvance) {
        coverage.set(sourceId, sequence);
        return { queueBindingId, sourceId, sequence };
      }
    },
    rangeReader: {
      capability: { completeCommitBoundaries: true as const, unslicedCommitEvents: true as const },
      async readCompleteRange(): Promise<never> { throw new Error('Fixture delivers contiguous turns.'); }
    }
  };
  const start = (store = backend.store()) => createProjectionCommitCoordinator({ ...options, store });
  return { start, coverage, options };
}

export async function read(backend: Backend, sourceId: string, ...targetDocumentIds: string[]) {
  const result = await backend.store().loadProjectionSourceCommitSnapshot({
    projectionName: 'boards', projectionGeneration: generation, joinMembership: 'set-v1', joinSeedVersion: 1, targetDocumentIds,
    links: [path], progressStrategy: 'own_record', sourceId
  });
  return { row: result.joinMemberships![0]!, progress: result.ownRecordSequence, states: result.targets.map((target) => target.state) };
}
