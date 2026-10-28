import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from '@redemeine/aggregate';
import { createMirage, extractState } from '@redemeine/mirage';

for (const api of [esm, createRequire(import.meta.url)('@redemeine/aggregate')]) {
  const child = api.createEntity('child')
    .events({ changed(state, event) { state.qty = event.payload.qty; } })
    .commands(emit => ({ read: (state, payload) => emit.changed({ ...payload, qty: state.qty + 1 }) })).build();
  for (const childKind of ['entityList', 'entityMap']) {
    const parent = api.createEntity('parent')[childKind]('children', child)
      .events({ touched(state, event) { state.qty = event.payload.qty; } })
      .commands(emit => ({ touch: (state, payload) => emit.touched({ ...payload, qty: state.qty + 1 }) })).build();
    const later = api.createEntity('later').commands(() => ({ other: () => [] })).build();
    for (const earlier of [false, true]) {
      const row = { id: 'p', qty: 0, children: childKind === 'entityList' ? [{ id: 'c', qty: 10 }] : { c: { qty: 10 } } };
      const base = api.createAggregate('store', { parents: [row] }).entityList('parents', parent);
      const builder = (earlier ? base.entityList('parents', later) : base)
        .selectors(({ bindContext }) => ({ chosen: state => bindContext(state.parents[0], parent, { mount: 'parents' }) }));
      const original = builder.build();
      const inherited = api.createAggregate('inherited', original.initialState).extends(builder).build();
      for (const host of [original, inherited, original.withPlugins()]) {
        const registration = api.commandMetadata(host, 'parentsChildrenRead');
        assert.equal(registration.targets.length, 2);
        const live = createMirage(host, 'store');
        for (const selected of [live.parents('p'), live.parents[0], [...live.parents][0], live.chosen()]) {
          assert.equal(Reflect.get(selected, 'childrenRead'), undefined);
          assert.equal(typeof selected.touch, 'function');
          selected.touch({});
        }
        assert.equal(Reflect.get(live.chosen(), 'other'), undefined);
        assert.equal(extractState(live).parents[0].qty, 4);
        const events = host.process(host.initialState, host.commandCreators.parentsChildrenRead({ parentsId: 'p', id: 'c', key: 'c' }));
        const replay = events.reduce((state, event) => host.apply(state, event), host.initialState);
        assert.equal(childKind === 'entityList' ? replay.parents[0].children[0].qty : replay.parents[0].children.c.qty, 11);
      }
    }
  }
}
console.log('PASS selected descendants: ESM/CJS, child list/map, role orders, inheritance, decoration and flat replay');
