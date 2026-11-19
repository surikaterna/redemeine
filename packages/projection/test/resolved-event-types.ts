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

const joined = createAggregate('joined', { amount: 0 }).events({
  moved: (state, event: { payload: { destination: string } }) => { state.amount += event.payload.destination.length; },
  ignored: () => {}
}).build();

const publicRight = createProjection('right', () => ({}));
publicRight.join(joined, { moved: () => {} }).joinRight(joined, {
  moved: (event) => {
    const destination: string = event.payload.destination;
    // @ts-expect-error Payload narrows to the selected event.
    void event.payload.typo;
    return [destination];
  }
});
// @ts-expect-error Selector keys are aggregate event keys, not arbitrary strings.
publicRight.joinRight(joined, { mvoved: () => 'target' });
// @ts-expect-error Selectors cannot return numbers.
publicRight.joinRight(joined, { moved: () => [123] });
// @ts-expect-error Selectors cannot receive a context.
publicRight.joinRight(joined, { moved: (_event, ctx: object) => String(ctx) });

const coreRight = createCoreProjection('right', () => ({}));
coreRight.joinRight(override, {
  itemAdded: (event) => {
    const wireName: 'external.v2' = event.type;
    const amount: number = event.payload.amount;
    void [wireName, amount];
    return null;
  }
});
// @ts-expect-error Selectors use local keys, not overridden wire names.
coreRight.joinRight(override, { 'external.v2': () => 'target' });
// @ts-expect-error Asynchronous selectors are not supported.
coreRight.joinRight(override, { itemAdded: async () => 'target' });
