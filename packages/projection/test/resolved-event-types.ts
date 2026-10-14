import { createAggregate } from '@redemeine/aggregate';
import { createProjection } from '../src';
import { createProjection as createCoreProjection } from '../../projection-runtime-core/src';

const exact = { aggregateType: 'order', types: { events: { itemAdded: 'order.item_added.event' as const } },
  pure: { eventProjectors: { itemAdded: (_state: unknown, _event: { payload: { amount: number } }) => {} } }
};
const override = { ...exact, types: { events: { itemAdded: 'external.v2' as const } } };
const broad = createAggregate('order', {}).events({ itemAdded: () => {} }).build();

  createProjection('types', () => ({ total: 0 }))
    .from(exact, { itemAdded: (state, event) => {
      const name: 'order.item_added.event' = event.type;
      // @ts-expect-error Authored camelCase is not the resolved wire name.
      const old: 'order.itemAdded.event' = event.type;
      state.total += event.payload.amount;
      void [name, old];
    } })
    .join(override, { itemAdded: (_state, event) => {
      const name: 'external.v2' = event.type;
      // @ts-expect-error Explicit overrides must not imply a default wire name.
      const wrong: 'order.item_added.event' = event.type;
      void [name, wrong];
    } });
  createProjection('broad', () => ({})).from(broad, { itemAdded: (_state, event) => {
    const actual: string = event.type;
    // @ts-expect-error The aggregate currently exposes a broad name map, not literal precision.
    const invented: 'order.itemAdded.event' = event.type;
    void [actual, invented];
  } });
  createCoreProjection('types', () => ({ total: 0 }))
    .from(exact, { itemAdded: (state, event) => {
      const name: 'order.item_added.event' = event.type;
      // @ts-expect-error Authored camelCase is not the resolved wire name.
      const old: 'order.itemAdded.event' = event.type;
      state.total += event.payload.amount;
      void [name, old];
    } })
    .join(override, { itemAdded: (_state, event) => {
      const name: 'external.v2' = event.type;
      // @ts-expect-error Explicit overrides must not imply a default wire name.
      const wrong: 'order.item_added.event' = event.type;
      void [name, wrong];
    } });
  createCoreProjection('broad', () => ({})).from(broad, { itemAdded: (_state, event) => {
    const actual: string = event.type;
    // @ts-expect-error The aggregate currently exposes a broad name map, not literal precision.
    const invented: 'order.itemAdded.event' = event.type;
    void [actual, invented];
  } });
