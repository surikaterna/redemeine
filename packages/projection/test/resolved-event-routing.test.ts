import { createAggregate, createEntity, namingStrategies } from '@redemeine/aggregate';
import type { Event } from '../../kernel/src';
import { createProjection } from '../src';
import { createProjection as createCoreProjection, ProjectionDaemon, type ProjectionEvent, type ProjectionContext } from '../../projection-runtime-core/src';
import { InMemoryProjectionStore } from '../../projection-runtime-store-inmemory/src';
import { InMemoryCursorStoreAdapter, InMemoryProjectionPersistenceAdapter, ProjectionRuntimeProcessor } from '../../projection-runtime/src';

type State = { total: number };
const builders = ['public', 'core'] as const;

function aggregate(name: string, mode: string) {
  const builder = createAggregate(name, { total: 0 })
    .events({ itemAdded: (state, event: Event<{ amount: number }>) => { state.total += event.payload.amount; } })
    .commands(emit => ({ add: (_state, amount: number) => emit.itemAdded({ amount }) }));
  if (mode === 'targeted') return builder.naming(namingStrategies.targeted).build();
  if (mode === 'override') return builder.overrideEventNames({ itemAdded: `${name}.external.v2.event` }).build();
  if (mode === 'scoped-custom') return builder.naming({ event: (name, key) => `${name}.lines.${key}.event` }).build();
  return builder.build();
}

function fixture(build: typeof builders[number], mode: string) {
  const source = aggregate('order', mode);
  const joined = aggregate('customer', mode);
  const fromHandlers = { itemAdded: (state: State, event: { payload: unknown }, context: ProjectionContext) => {
      state.total += amount(event.payload);
      context.subscribeTo(joined, 'customer-1');
    } };
  const joinHandlers = { itemAdded: (state: State, event: { payload: unknown }) => { state.total += amount(event.payload); } };
  const definition = build === 'public'
    ? createProjection('resolved-names', () => ({ total: 0 })).from(source, fromHandlers).join(joined, joinHandlers).build()
    : createCoreProjection('resolved-names', () => ({ total: 0 })).from(source, fromHandlers).join(joined, joinHandlers).build();
  const projection = { ...definition, fromStream: { ...definition.fromStream, aggregate: source } };
  const events = [source, joined].map((definition, index) => projectionEvent(
    definition.process(definition.initialState, definition.commandCreators.add(index + 2))[0]!,
    definition.aggregateType, index === 0 ? 'order-1' : 'customer-1', index + 1
  ));
  return { projection, events };
}

function projectionEvent(event: Event, aggregateType: string, aggregateId: string, sequence: number): ProjectionEvent {
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected object fixture payload');
  return { ...event, payload: Object.fromEntries(Object.entries(payload)), aggregateType, aggregateId, sequence,
    timestamp: '2026-10-13T00:00:00Z' };
}

function amount(payload: unknown): number {
  if (!payload || typeof payload !== 'object' || !('amount' in payload)) throw new Error('Missing amount');
  return Number(payload.amount);
}

describe.each(builders)('resolved names from builder %p', build => {
  test.each(['default', 'targeted', 'override', 'scoped-custom'])('daemon applies from and join: %s', async mode => {
    const { projection, events } = fixture(build, mode);
    const store = new InMemoryProjectionStore<State>();
    const daemon = new ProjectionDaemon({ projection, store, subscription: {
      poll: async () => ({ events, nextCursor: { sequence: 2 } })
    } });
    await daemon.processBatch();
    expect(await store.load('order-1')).toEqual({ total: 5 });
  });

  test.each(['default', 'targeted', 'override', 'scoped-custom'])('commit processor applies from and join: %s', async mode => {
    const { projection, events } = fixture(build, mode);
    type RuntimeDefinition = ConstructorParameters<typeof ProjectionRuntimeProcessor<State>>[0]['projection'];
    const adapt = (handlers: typeof projection.fromStream.handlers): RuntimeDefinition['fromStream']['handlers'] =>
      Object.fromEntries(Object.entries(handlers).map(([key, handler]) => [key,
        (state: State, event: ProjectionEvent, context: Parameters<RuntimeDefinition['fromStream']['handlers'][string]>[2]) =>
          handler(state, event, { ...context, unsubscribeFrom() { throw new Error('Not used by this fixture'); } })
      ]));
    const persistence = new InMemoryProjectionPersistenceAdapter();
    const links = new Map<string, string>();
    const processor = new ProjectionRuntimeProcessor({
      projection: { ...projection,
        fromStream: { ...projection.fromStream, handlers: adapt(projection.fromStream.handlers) },
        joinStreams: projection.joinStreams?.map(stream => ({ ...stream, handlers: adapt(stream.handlers) }))
      },
      commitFeed: { readAfter: async () => ({ commits: events, nextCheckpoint: { sequence: 2 } }) },
      cursorStore: new InMemoryCursorStoreAdapter(),
      linkStore: {
        add: async link => { links.set(link.key.aggregateId, link.targetDocumentId); },
        removeForTarget: async () => {},
        resolveTargets: async key => links.has(key.aggregateId) ? [links.get(key.aggregateId)!] : []
      },
      persistence: {
        async loadDocument(name, id) {
          const document = await persistence.loadDocument(name, id);
          if (!document) return null;
          if (typeof document.total !== 'number') throw new Error('Invalid stored total');
          return { ...document, total: document.total };
        },
        persistDocument: change => persistence.persistDocument(change)
      }
    });
    await processor.processNextBatch();
    expect((await persistence.loadDocument('resolved-names', 'order-1'))?.total).toBe(5);
  });
});

test.each(builders)('retains explicit mounted wire keys without guessing camelCase: %s', async build => {
  const line = createEntity<{ id: string; qty: number }, 'line'>('line')
    .events({ qtyUpdated: (state, event: Event<{ id: string; qty: number }>) => { state.qty = event.payload.qty; } })
    .commands(emit => ({ update: (_state, payload: { id: string; qty: number }) => emit.qtyUpdated(payload) })).build();
  const source = createAggregate('order', { lines: [{ id: 'l1', qty: 0 }] })
    .entityList('lines', line).events({}).commands(() => ({})).build();
  const emitted = source.process(source.initialState, source.commandCreators.linesUpdate({ id: 'l1', qty: 7 }))[0]!;
  expect(emitted.type).toBe('order.line.qty_updated.event');
  const handlers = { [emitted.type]: (state: State) => { state.total += 7; } };
  const definition = build === 'public'
    ? createProjection('mounted', () => ({ total: 0 })).from(source, handlers).build()
    : createCoreProjection('mounted', () => ({ total: 0 })).from(source, handlers).build();
  const store = new InMemoryProjectionStore<State>();
  const daemon = new ProjectionDaemon({ projection: { ...definition, fromStream: { ...definition.fromStream, aggregate: source } }, store,
    subscription: { poll: async () => ({ events: [projectionEvent(emitted, 'order', 'one', 1)], nextCursor: { sequence: 1 } }) }
  });
  await daemon.processBatch();
  expect(await store.load('one')).toEqual({ total: 7 });
});

test.each(builders)('rejects ambiguous resolved names instead of overwriting a handler', build => {
  const source = { aggregateType: 'order', pure: { eventProjectors: {
    first: (_state: unknown, _event: { payload: number }) => {},
    second: (_state: unknown, _event: { payload: number }) => {}
  } }, types: { events: { first: 'order.same.event', second: 'order.same.event' } } };
  expect(() => build === 'public'
    ? createProjection('collision', () => ({ total: 0 })).from(source, { first() {}, second() {} })
    : createCoreProjection('collision', () => ({ total: 0 })).from(source, { first() {}, second() {} })
  ).toThrow('Ambiguous projection event handler');
});
