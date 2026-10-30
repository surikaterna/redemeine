import type { Event } from '@redemeine/kernel';
import { createAggregate, createEntity, createMixin } from '../src';

const item = createEntity<{ id: string; count: number }, 'item'>('item').events({
  changed(draft, event: Event<{ id: string; amount: number }>) { draft.count += event.payload.amount; }
}).commands(emit => ({
  change: {
    pack: (payload: { id: string; amount: number }) => payload,
    handler: (_state: unknown, payload: { id: string; amount: number }) => emit.changed(payload)
  }
})).build();

const initial = () => ({ rows: [{ id: 'one', count: 0 }], slots: { one: { id: 'one', count: 0 } } });
const payload = { id: 'one', key: 'one', amount: 2 };

test.each([false, true])('direct list/map mounts process and apply (inherited=%s)', inherited => {
  const parent = createAggregate('parent', initial()).entityList('rows', item).entityMap('slots', item, { knownKeys: ['one'] }, { semanticName: 'slot' });
  const host = inherited ? createAggregate('child', initial()).extends(parent).build() : parent.build();
  expect(host.mounts.rows).toMatchObject({ kind: 'list', entity: item, pk: 'id', statePath: ['rows'] });
  expect(host.mounts.slots).toMatchObject({ kind: 'map', entity: item, knownKeys: ['one'] });
  for (const name of ['rowsChange', 'slotsChange'] as const) {
    const command = host.commandCreators[name](payload);
    expect(command.type).toContain(inherited ? 'child.' : 'parent.');
    const events = host.process(host.initialState, command);
    expect(events).toHaveLength(1);
    const result = host.apply(host.initialState, events[0]!);
    expect(name === 'rowsChange' ? result.rows[0]!.count : result.slots.one.count).toBe(2);
  }
});

test('named/variadic entities and all value object forms retain metadata', () => {
  const parent = createAggregate('parent', {}).entities({ alias: item }, item)
    .valueObject('details').valueObjectList('history').valueObjectMap('labels');
  const host = createAggregate('child', {}).extends(parent).build();
  expect(Object.keys(host.mounts)).toEqual(['alias', 'item', 'details', 'history', 'labels']);
  expect(host.mounts.alias!.entity).toBe(item);
  expect(host.mounts.item!.entity).toBe(item);
  expect(host.mounts.details!.kind).toBe('valueObject');
  expect(host.mounts.history!.kind).toBe('valueObjectList');
  expect(host.mounts.labels!.kind).toBe('valueObjectMap');
  expect(Object.keys(host.commandCreators)).toEqual(expect.arrayContaining(['aliasChange', 'itemChange']));
});

test('grandchildren inherit each registration once in append-at-extends order', () => {
  const mixin = createMixin<{}>().entityList('mixed', item).build();
  const parent = createAggregate('parent', {}).entityList('direct', item).mixins(mixin);
  const child = createAggregate('child', {}).valueObject('before').extends(parent).valueObject('after');
  const grandchild = createAggregate('grandchild', {}).extends(child);
  expect(grandchild._state.entityPackages.map(mount => mount.name)).toEqual(['before', 'direct', 'mixed', 'after']);
  expect(grandchild._state.entityPackages.filter(mount => mount.component === item)).toHaveLength(2);
  expect(Object.keys(grandchild.build().mounts)).toEqual(['before', 'direct', 'mixed', 'after']);
});

test('registration snapshots isolate later additions and repeated builds preserve component identity', () => {
  const parent = createAggregate('parent', {}).entityList('rows', item);
  const snapshot = parent._state.entityPackages;
  const child = createAggregate('child', {}).extends(parent);
  parent.valueObject('parentOnly');
  child.valueObject('childOnly');
  snapshot.push({ name: 'snapshotOnly', kind: 'valueObject' });
  expect(parent._state.entityPackages.map(mount => mount.name)).toEqual(['rows', 'parentOnly']);
  expect(child._state.entityPackages.map(mount => mount.name)).toEqual(['rows', 'childOnly']);
  for (const host of [child.build(), child.build()]) {
    expect(Object.keys(host.mounts)).toEqual(['rows', 'childOnly']);
    expect(host.mounts.rows!.entity).toBe(item);
  }
  expect(child._state.entityPackages[0]).toBe(parent._state.entityPackages[0]);
});

test('inherited explicit wire names still route into nested mounts', () => {
  const parent = createAggregate('parent', initial()).entityList('rows', item, undefined, {
    commandNameOverrides: { change: 'legacy.row.change.command' },
    eventNameOverrides: { changed: 'child.row.changed.event' }
  });
  const host = createAggregate('child', initial()).extends(parent).build();
  const command = host.commandCreators.rowsChange(payload);
  expect(command.type).toBe('legacy.row.change.command');
  const events = host.process(host.initialState, command);
  expect(events[0]!.type).toBe('child.row.changed.event');
  expect(host.apply(host.initialState, events[0]!).rows[0]!.count).toBe(2);
});
