import { createProjection, joinInitializer, type JoinSeed, type ProjectionCommitDefinition as PublicCommitDefinition,
  type ProjectionContext as PublicContext } from '@redemeine/projection';
import {
  createProjection as createCore,
  joinInitializer as coreInitializer,
  type ProjectionCommitDefinition, type ProjectionContext, type ProjectionStreamDefinition
} from '@redemeine/projection-runtime-core';
import type { Draft } from 'immer';
import { bindJoinSeedReader, createProjectionCommitCoordinator, type ProjectionCommitCoordinatorInput, type ProjectionCommitCoordinatorOptions,
  type ProjectionCommitRegistryDefinition } from '@redemeine/projection-worker-core';

const Order = { aggregateType: 'Order' as const, initialState: { inventory: { counts: [1] } },
  pure: { eventProjectors: { changed: () => {} } } };
const Other = { ...Order, aggregateType: 'Other' as const };
const Sailing = { ...Order, aggregateType: 'Sailing' as const };
const OrderProjection = createProjection('OrderProjection', () => ({ summary: { totals: [1] } })).from(Order, {}).build();
type Booking = { readonly metric: readonly number[] };
const target = (): Booking => ({ metric: [] });
const publicSnapshot = joinInitializer(Order, { from: 'snapshot' });
const publicView = joinInitializer(Order, { from: 'projection', projection: OrderProjection });
const coreSnapshot = coreInitializer(Order, { from: 'snapshot' });
const coreView = coreInitializer(Order, { from: 'projection', projection: OrderProjection });
const publicForwardCall: Parameters<PublicContext['subscribeTo']> = [{ aggregateType: 'Order' }, '42'];
const publicInitializeCall: Parameters<PublicContext['subscribeTo']> = [publicView, '42'];
const coreForwardCall: Parameters<ProjectionContext['subscribeTo']> = [{ aggregateType: 'Order' }, '42'];
const coreInitializeCall: Parameters<ProjectionContext['subscribeTo']> = [coreSnapshot, '42'];
declare const coreStream: ProjectionStreamDefinition<Booking>;
const coreHandlerKeys = Object.keys(coreStream.aggregate.pure.eventProjectors);

// @ts-expect-error A binding retains the distinguishable aggregate type and cannot be rebound to Other.
const wrongSource: JoinSeed<typeof Other, typeof Order.initialState> = publicSnapshot;
// @ts-expect-error The initializer is not itself an aggregate and cannot be used as a join event source.
createProjection('wrong-source', target).from(Sailing, {}).join(publicView, {});

const publicAggregate: PublicCommitDefinition<Booking> = createProjection('public-snapshot', target)
  .deduplication({ strategy: 'own_record' })
  .from(Sailing, { changed(_draft, e, ctx) { ctx.subscribeTo(publicSnapshot, e.aggregateId); } })
  .join(Order, { changed(_draft, e, ctx) { ctx.unsubscribeFrom(Order, e.aggregateId); } })
  .onJoinInitialize(publicSnapshot, (draft, seed) => {
    const actual: Draft<Booking> = draft;
    actual.metric.push(seed.inventory.counts[0]!);
    // @ts-expect-error Not the projection seed shape.
    void seed.summary;
    // @ts-expect-error The seed is recursively readonly.
    seed.inventory.counts.push(2);
  }).build();

const publicProjection: PublicCommitDefinition<Booking> = createProjection('public-projection', target)
  .from(Sailing, { changed(_draft, e, ctx) { ctx.subscribeTo(Order, e.aggregateId); } })
  .join(Order, { changed(_draft, e, ctx) { ctx.subscribeTo(publicView, e.aggregateId); } })
  .onJoinInitialize(publicView, (draft, seed) => {
    draft.metric.push(seed.summary.totals[0]!);
    // @ts-expect-error Not aggregate snapshot state.
    void seed.inventory;
    // @ts-expect-error Nested source lists are readonly.
    seed.summary.totals[0] = 4;
  }).deduplication({ strategy: 'own_record' }).build();

const coreAggregate = createCore('core-snapshot', target)
  .from(Sailing, { changed(_draft, e, ctx) { ctx.subscribeTo(coreSnapshot, e.aggregateId); } })
  .join(Order, {})
  .onJoinInitialize(coreSnapshot, (draft, seed) => {
    draft.metric.push(seed.inventory.counts[0]!);
    // @ts-expect-error Not the projection seed shape.
    void seed.summary;
    // @ts-expect-error Nested source lists are readonly.
    seed.inventory.counts[0] = 4;
  }).deduplication({ strategy: 'own_record' }).build() satisfies ProjectionCommitDefinition<Booking>;

const coreProjection = createCore('core-projection', target)
  .deduplication({ strategy: 'own_record' })
  .from(Sailing, { changed(_draft, e, ctx) { ctx.subscribeTo(coreView, e.aggregateId); } })
  .join(Order, {})
  .onJoinInitialize(coreView, (draft, seed) => {
    draft.metric.push(seed.summary.totals[0]!);
    // @ts-expect-error Not the aggregate seed shape.
    void seed.inventory;
    // @ts-expect-error Nested source lists are readonly.
    seed.summary.totals.push(4);
  }).build() satisfies ProjectionCommitDefinition<Booking>;

const legacyRegistry: readonly ProjectionCommitRegistryDefinition<Booking>[] = [{
  generation: 'old-generation', definition: createCore('legacy-registry', target).from(Sailing, {})
    .deduplication({ strategy: 'own_record' }).build()
}];
const legacyProjectors = legacyRegistry[0]!.definition.fromStream.aggregate.pure.eventProjectors;
declare const priorOptions: ProjectionCommitCoordinatorOptions<Booking>;
const priorOptionProjectors = priorOptions.definitions[0]!.definition.fromStream.aggregate.pure.eventProjectors;
const registry: ProjectionCommitCoordinatorInput<Booking>['definitions'] = [
  ...legacyRegistry,
  { generation: 'public-view', definition: publicProjection, joinSeedReaders: [
    bindJoinSeedReader(publicView, { seedGeneration: 'view-v1', policy: 'proven', async readOne() { return null; } })
  ] },
  { generation: 'public-snapshot', definition: publicAggregate },
  { generation: 'core-view', definition: coreProjection },
  { generation: 'core-snapshot', definition: coreAggregate }
];
const initializeCoordinator = () => createProjectionCommitCoordinator({ ...priorOptions, definitions: registry });
const weakened: ProjectionCommitRegistryDefinition<Booking> = { generation: 'bad', definition: {
  // @ts-expect-error The legacy exported registry type must require the full core aggregate.
  ...coreProjection, fromStream: { ...coreProjection.fromStream, aggregate: { aggregateType: 'Sailing' } }
} };
bindJoinSeedReader(coreSnapshot, { seedGeneration: 'snapshot-v1', policy: 'proven',
  // @ts-expect-error A projection-shaped value cannot be returned from a snapshot reader.
  async readOne() { return { state: { summary: { totals: [1] } }, provenance: {} }; }
});

// @ts-expect-error A join initializer cannot return a promise.
createCore('async', target).onJoinInitialize(publicView, async () => {});
// @ts-expect-error The removed third-argument form is not public API.
const old = (ctx: import('@redemeine/projection').ProjectionContext) => ctx.subscribeTo(Order, 'id', { initialize: publicView });
// @ts-expect-error A lookalike without the binding's type evidence is not valid.
const fake = (ctx: import('@redemeine/projection').ProjectionContext) => ctx.subscribeTo({
  kind: 'join-seed-v1', sourceAggregateType: 'Order', from: 'snapshot', seedName: 'Order'
}, 'id');

void [publicAggregate, publicProjection, coreAggregate, coreProjection, publicForwardCall, publicInitializeCall,
  coreForwardCall, coreInitializeCall, coreHandlerKeys, legacyProjectors, priorOptionProjectors, initializeCoordinator, weakened];
