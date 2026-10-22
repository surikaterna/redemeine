import { createAggregate, createEntity } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createDemeineBridge } from '../src';

test('bridge invokes an inherited mounted command and applies its event', async () => {
  const item = createEntity<{ id: string; count: number }, 'item'>('item').events({
    changed(draft, event: Event<{ id: string; amount: number }>) { draft.count += event.payload.amount; }
  }).commands(emit => ({
    change: {
      pack: (payload: { id: string; amount: number }) => payload,
      handler: (_state: unknown, payload: { id: string; amount: number }) => emit.changed(payload)
    }
  })).build();
  const state = { rows: [{ id: 'one', count: 0 }] };
  const parent = createAggregate('parent', state).entityList('rows', item);
  const host = createAggregate('child', state).extends(parent).build();
  const bridge = new (createDemeineBridge(host))();
  await bridge.rowsChange({ id: 'one', amount: 3 });
  expect(bridge._state.rows[0]!.count).toBe(3);
  expect(bridge.getUncommittedEvents()).toHaveLength(1);
});
