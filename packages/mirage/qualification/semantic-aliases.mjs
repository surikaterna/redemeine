import assert from 'node:assert/strict';
import { createAggregate, createEntity, createMixin } from '@redemeine/aggregate';
import { createMirage } from '@redemeine/mirage';

const row = createEntity('row', { id: '' }).commands(() => ({ custom: () => [] }), { static: ['custom'] }).build();
for (const options of [undefined, {}, { commandNameOverrides: {} }, { semanticName: 'credential' }, { semanticName: 'left' }, { semanticName: 'right' }]) {
  const state = { rows: [{ id: 'r' }] };
  const parentState = { id: 'p', ...state };
  const parent = createEntity('parent', parentState).entityList('rows', row, {}, options).build();
  const mixin = createMixin().entityList('rows', row, {}, options).build();
  const lives = [
    createMirage(createAggregate('aggregate', state).entityList('rows', row, {}, options).build(), 'root'),
    createMirage(createAggregate('entity', { parents: [parentState] }).entityList('parents', parent).build(), 'root').parents('p'),
    createMirage(createAggregate('mixin', state).mixins(mixin).build(), 'root')
  ];
  const actual = options?.semanticName ?? 'row';
  for (const live of lives) {
    for (const name of ['row', 'credential', 'left', 'right']) {
      const alias = `custom${name[0].toUpperCase()}${name.slice(1)}`;
      assert.equal(typeof Reflect.get(live, alias), name === actual ? 'function' : 'undefined');
    }
    await live.rows.custom({ id: 'r' });
    await live[`custom${actual[0].toUpperCase()}${actual.slice(1)}`]({ id: 'r' });
  }
}
console.log('PASS actual semantic aliases across Aggregate, Entity and Mixin');
