import { createAggregate, createEntity } from '@redemeine/aggregate';
import { createProjection as createCoreProjection } from '../../projection-runtime-core/src';
import { createProjection, inherit } from '../src';

const exact = {
  aggregateType: 'order',
  types: { events: { itemAdded: 'order.item_added.event' as const } },
  pure: { eventProjectors: { itemAdded: (_state: unknown, _event: { payload: { amount: number } }) => {} } }
};
const override = { ...exact, types: { events: { itemAdded: 'external.v2' as const } } };
const broad = createAggregate('order', {})
  .events({ itemAdded: () => {} })
  .build();

const mountedRow = createEntity<{ id: string; count: number }, 'row'>('row')
  .events({
    changed(state, event: { payload: { amount: number } }) {
      state.count += event.payload.amount;
    }
  })
  .build();
const mounted = createAggregate('store', { total: 0, rows: [{ id: 'a', count: 0 }], byKey: { a: { id: 'a', count: 0 } } })
  .events({
    changed(state, event: { payload: { title: string } }) {
      state.total += event.payload.title.length;
    }
  })
  .entityList('rows', mountedRow)
  .entityMap('byKey', mountedRow)
  .valueObject('details')
  .build();

createProjection('mounted').mirror(mounted, {
  'rows:changed': (state, event) => {
    state.rows[0]!.count += event.payload.amount;
    // @ts-expect-error Root fields are not mounted payload fields.
    event.payload.title;
    // @ts-expect-error Aggregate state is inferred, not any.
    state.total = 'invalid';
  },
  'byKey:changed': inherit.extend((state, event) => {
    state.byKey.a.count += event.payload.amount;
    // @ts-expect-error Map-mounted payloads are not widened for inherit.extend.
    event.payload.missing;
  }),
  changed: (state, event) => {
    state.total += event.payload.title.length;
    // @ts-expect-error Root shorthand keeps its original payload, not the entity payload.
    event.payload.amount;
  }
});
createProjection('unknown-event').mirror(mounted, {
  // @ts-expect-error Unknown mounted event keys are rejected.
  'rows:missing': () => {}
});
createProjection('value-object').mirror(mounted, {
  // @ts-expect-error Value objects do not declare entity event handlers.
  'details:changed': () => {}
});
createProjection('wrong-payload').mirror(mounted, {
  // @ts-expect-error Mounted overrides must accept the declared entity payload.
  'rows:changed': (_state, _event: { payload: { amount: string } }) => {}
});
const onlyMounted = createAggregate('store', { rows: [{ id: 'a', count: 0 }] })
  .entityList('rows', mountedRow)
  .build();
createProjection('no-new-shorthand').mirror(onlyMounted, {
  // @ts-expect-error Only scoped direct mounted aliases are added to the typed surface.
  changed: () => {}
});

createProjection('types', () => ({ total: 0 }))
  .from(exact, {
    itemAdded: (state, event) => {
      const name: 'order.item_added.event' = event.type;
      // @ts-expect-error Authored camelCase is not the resolved wire name.
      const old: 'order.itemAdded.event' = event.type;
      state.total += event.payload.amount;
      void [name, old];
    }
  })
  .join(override, {
    itemAdded: (_state, event) => {
      const name: 'external.v2' = event.type;
      // @ts-expect-error Explicit overrides must not imply a default wire name.
      const wrong: 'order.item_added.event' = event.type;
      void [name, wrong];
    }
  });
createProjection('broad', () => ({})).from(broad, {
  itemAdded: (_state, event) => {
    const actual: string = event.type;
    // @ts-expect-error The aggregate currently exposes a broad name map, not literal precision.
    const invented: 'order.itemAdded.event' = event.type;
    void [actual, invented];
  }
});
createCoreProjection('types', () => ({ total: 0 }))
  .from(exact, {
    itemAdded: (state, event) => {
      const name: 'order.item_added.event' = event.type;
      // @ts-expect-error Authored camelCase is not the resolved wire name.
      const old: 'order.itemAdded.event' = event.type;
      state.total += event.payload.amount;
      void [name, old];
    }
  })
  .join(override, {
    itemAdded: (_state, event) => {
      const name: 'external.v2' = event.type;
      // @ts-expect-error Explicit overrides must not imply a default wire name.
      const wrong: 'order.item_added.event' = event.type;
      void [name, wrong];
    }
  });
createCoreProjection('broad', () => ({})).from(broad, {
  itemAdded: (_state, event) => {
    const actual: string = event.type;
    // @ts-expect-error The aggregate currently exposes a broad name map, not literal precision.
    const invented: 'order.itemAdded.event' = event.type;
    void [actual, invented];
  }
});
