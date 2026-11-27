import projection = require('@redemeine/projection');

const Order = { aggregateType: 'Order' as const, initialState: { snapshotTotal: 0 },
  pure: { eventProjectors: { changed: () => {} } } };
const Board = { ...Order, aggregateType: 'Board' as const };
const view = projection.createProjection('view', () => ({ viewTotal: 0 })).from(Order, {}).build();
const snapshotBinding = projection.joinInitializer(Order, { from: 'snapshot' });
const viewBinding = projection.joinInitializer(Order, { from: 'projection', projection: view });
const start = () => projection.createProjection('board', () => ({ total: 0 })).deduplication({ strategy: 'own_record' });
start().from(Board, { changed(_draft, _event, ctx) { ctx.subscribeTo(snapshotBinding, 'id'); } }).join(Order, {})
  .onJoinInitialize(snapshotBinding, (draft, state) => {
    draft.total = state.snapshotTotal;
    // @ts-expect-error The snapshot reader does not use view state.
    void state.viewTotal;
  }).build();
start().from(Board, { changed(_draft, _event, ctx) { ctx.subscribeTo(viewBinding, 'id'); } }).join(Order, {})
  .onJoinInitialize(viewBinding, (draft, state) => {
    draft.total = state.viewTotal;
    // @ts-expect-error The named view does not use aggregate state.
    void state.snapshotTotal;
  }).build();
