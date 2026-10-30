import { createAggregate, createEntity, createMixin } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createMirage, extractState, MirageCoreSymbol } from '../src';

function fixture() {
  const calls: string[] = [];
  const leaf = createEntity('identifier', { id: '', value: '' }).events({
    changed(state, event: Event<{ id: string; value: string }>) { state.value = event.payload.value; }
  }).commands(emit => ({
    amend(_state, payload: { parentsRegion?: string; parentsCode?: string; id: string; value: string }) {
      calls.push(payload.value); return emit.changed(payload);
    },
    register: () => [],
    packed: { pack: (id: string, value: string) => ({ id, value }),
      handler(_state, payload: { id: string; value: string }) { calls.push(payload.value); return emit.changed(payload); } }
  }), { static: ['amend', 'packed'] }).build();
  const parent = createEntity('parent', { region: '', code: '', children: [] as { id: string; value: string }[] })
    .entityList('children', leaf, {}, { semanticName: 'credential' }).build();
  const host = createAggregate('aliases', { rows: [] as { id: string; value: string }[],
    parents: [{ region: 'r', code: 'p', children: [] as { id: string; value: string }[] }] })
    .entityList('rows', leaf).entityList('parents', parent, { pk: ['region', 'code'] }).build();
  return { host, calls };
}

test('root and selected-parent aliases reuse collection calls, without another execution or inferred navigation suffix', async () => {
  const { host, calls } = fixture();
  const live = createMirage(host, 'root');
  expect(await live.amendIdentifier({ id: 'one', value: 'a' })).toEqual(await live.rows.amend({ id: 'one', value: 'a' }));
  const parent = live.parents({ region: 'r', code: 'p' });
  expect(await parent.packedCredential('two', 'b')).toEqual(await parent.children.packed('two', 'b'));
  expect(calls).toEqual(['a', 'a', 'b', 'b']);
  expect(live[MirageCoreSymbol].version).toBe(4);
  expect(Reflect.get(live, 'registerIdentifier')).toBeUndefined();
  expect(Reflect.get(parent, 'amendChildren')).toBeUndefined();
  expect(Reflect.get(live.parents, 'packedCredential')).toBeUndefined();
  expect(host.commandCreators.rowsAmend({ id: 'one', value: 'flat' }).type).toBe('aliases.identifier.amend.command');
  expect(extractState(live).parents[0]!.children).toEqual([{ id: 'two', value: 'b' }]);
});

test('bound composite ancestors remain authoritative; async results are readonly aggregate state', async () => {
  const { host, calls } = fixture();
  const live = createMirage(host, 'async', { plugins: [{ key: 'async', async onBeforeCommand() {} }] });
  const parent = live.parents({ region: 'r', code: 'p' });
  const result = parent.amendCredential({ id: 'c', value: 'one' });
  expect(result).toBeInstanceOf(Promise);
  const state = await result;
  expect(state).toEqual({ rows: [], parents: [{ region: 'r', code: 'p', children: [{ id: 'c', value: 'one' }] }] });
  expect(Reflect.set(state.parents[0]!, 'code', 'wrong')).toBe(false);
  expect(() => parent.amendCredential({ parentsCode: 'wrong', id: 'c', value: 'bad' })).toThrow('Conflicting ancestor identity');
  expect(() => live.parents({ region: 'r', code: 'missing' })).toThrow('Entity not found');
  expect(calls).toEqual(['one']);
});

test('aliases preserve complete authored packs, including explicit ancestor arguments', () => {
  const seen: unknown[] = [];
  const leaf = createEntity('leaf', { id: '' }).commands(() => ({
    custom: { pack: (parentsId: string, id: string, business: number) => ({ parentsId, id, business }),
      handler(_state, payload: { parentsId: string; id: string; business: number }) { seen.push(payload); return []; } }
  }), { static: ['custom'] }).build();
  const parent = createEntity('parent', { id: '', leaves: [] as { id: string }[] }).entityList('leaves', leaf).build();
  const host = createAggregate('packs', { parents: [{ id: 'p', leaves: [] as { id: string }[] }] }).entityList('parents', parent).build();
  const selected = createMirage(host, 'root').parents('p');
  selected.customLeaf('p', 'c', 2);
  expect(seen).toEqual([{ parentsId: 'p', id: 'c', business: 2 }]);
  expect(() => selected.customLeaf('wrong', 'c', 2)).toThrow('Conflicting ancestor identity');
});

test('distinct semantic aliases with a shared wire retain Aggregate winner dispatch', async () => {
  const row = createEntity('row', { id: '', value: '' }).events({
    changed(state, event: Event<{ id: string; value: string }>) { state.value = event.payload.value; }
  }).commands(emit => ({ write: (_state, payload: { id: string; value: string }) => emit.changed(payload) }), { static: ['write'] }).build();
  const host = createAggregate('winner', { left: [] as { id: string; value: string }[], right: [] as { id: string; value: string }[] })
    .entityList('left', row, {}, { semanticName: 'left', commandNameOverrides: { write: 'shared' } })
    .entityList('right', row, {}, { semanticName: 'right', commandNameOverrides: { write: 'shared' } }).build();
  const live = createMirage(host, 'root');
  const payload = { id: 'c', value: 'one' };
  expect(await live.writeLeft(payload)).toEqual({ left: [], right: [payload] });
  expect(await live.writeRight(payload)).toEqual(await live.left.write(payload));
});

test.each(['state', 'command', 'selector', 'siblings'])('root aliases reject %s ambiguity at construction', kind => {
  const row = createEntity('row', { id: '' }).commands(() => ({ write: () => [] }), { static: ['write'] }).build();
  const host = createAggregate('collision', { rows: [] as { id: string }[], siblings: [] as { id: string }[], ...(kind === 'state' ? { writeRow: 0 } : {}) })
    .entityList('rows', row);
  if (kind === 'command') host.commands(() => ({ writeRow: () => [] }));
  if (kind === 'selector') host.selectors({ writeRow: () => 1 });
  if (kind === 'siblings') host.entityList('siblings', row);
  expect(() => createMirage(host.build(), 'root')).toThrow(/parent alias collision.*writeRow/);
});

test.each(['template', 'entry', 'command', 'siblings'])('nested alias collisions reject on %s, including empty parents', kind => {
  const leaf = createEntity('leaf', { id: '' }).commands(() => ({ write: () => [] }), { static: ['write'] }).build();
  const template = { id: '', children: [] as { id: string }[], siblings: [] as { id: string }[], ...(kind === 'template' ? { writeLeaf: 0 } : {}) };
  const parent = createEntity('parent', template).entityList('children', leaf);
  if (kind === 'command') parent.commands(() => ({ writeLeaf: () => [] }));
  if (kind === 'siblings') parent.entityList('siblings', leaf);
  const parents = kind === 'entry' ? [{ ...template, id: 'p', writeLeaf: 0 }] : [];
  const host = createAggregate('collision', { parents }).entityList('parents', parent.build()).build();
  expect(() => createMirage(host, 'root')).toThrow(/parent alias collision.*writeLeaf/);
});

test('widened semantic names still exist at runtime; maps, ordinary commands and navigation names do not infer aliases', () => {
  const semanticName: string = 'dynamic';
  const row = createEntity('row', { id: '' }).commands(() => ({ custom: () => [], ordinary: () => [] }), { static: ['custom'] }).build();
  const host = createAggregate('wide', { rows: [] as { id: string }[], mapped: {} as Record<string, { id: string }> })
    .entityList('rows', row, {}, { semanticName }).entityMap('mapped', row).build();
  const live = createMirage(host, 'root');
  expect(typeof Reflect.get(live, 'customDynamic')).toBe('function');
  expect(Reflect.get(live, 'ordinaryDynamic')).toBeUndefined();
  expect(Reflect.get(live, 'customRows')).toBeUndefined();
  expect(Reflect.get(live, 'customRow')).toBeUndefined();
});

test('named, package and inherited mixin registrations preserve semantic metadata', () => {
  const row = createEntity('row', { id: '' }).commands(() => ({ custom: () => [] }), { static: ['custom'] }).build();
  const named = createAggregate('named', { rows: [] as { id: string }[] }).entities({ rows: row }).build();
  const packaged = createAggregate('packaged', { row: [] as { id: string }[] }).entities({}, row).build();
  expect(typeof createMirage(named, 'root').customRow).toBe('function');
  expect(typeof createMirage(packaged, 'root').customRow).toBe('function');
  const state = { rows: [] as { id: string }[] };
  const mixin = createMixin<typeof state>().entityList('rows', row, {}, { semanticName: 'mixed' }).build();
  const base = createAggregate('base', state).mixins(mixin);
  const inherited = createAggregate('inherited', state).extends(base).build();
  expect(typeof createMirage(inherited, 'root').customMixed).toBe('function');
});

test.each([{}, { semanticName: 'credential' }, { semanticName: 'left' }, { semanticName: 'right' }])(
  'runtime aliases reflect only the actual semantic override %j', options => {
    const row = createEntity('row', { id: '' }).commands(() => ({ custom: () => [] }), { static: ['custom'] }).build();
    const state = { rows: [{ id: 'r' }] };
    const parentState = { id: 'p', ...state };
    const parent = createEntity('parent', parentState).entityList('rows', row, {}, options).build();
    const mixin = createMixin<typeof state>().entityList('rows', row, {}, options).build();
    const lives = [
      createMirage(createAggregate('aggregate', state).entityList('rows', row, {}, options).build(), 'root'),
      createMirage(createAggregate('entity', { parents: [parentState] }).entityList('parents', parent).build(), 'root').parents('p'),
      createMirage(createAggregate('mixin', state).mixins(mixin).build(), 'root')
    ];
    for (const live of lives) {
      for (const name of ['row', 'credential', 'left', 'right']) {
        expect(typeof Reflect.get(live, `custom${name[0]!.toUpperCase()}${name.slice(1)}`))
          .toBe(name === (options.semanticName ?? 'row') ? 'function' : 'undefined');
      }
      expect(typeof live.rows.custom).toBe('function');
    }
  }
);

test.each([false, true])('generated reserved protocol aliases reject at construction (nested: %s)', nested => {
  const row = createEntity('JSON', { id: '' }).commands(() => ({ to: () => [] }), { static: ['to'] }).build();
  const parent = createEntity('parent', { id: '', children: [] as { id: string }[] }).entityList('children', row).build();
  const host = nested
    ? createAggregate('nestedProtocol', { parents: [] as { id: string; children: { id: string }[] }[] }).entityList('parents', parent).build()
    : createAggregate('protocol', { rows: [] as { id: string }[] }).entityList('rows', row).build();
  expect(() => createMirage(host, 'root')).toThrow(/parent alias collision.*toJSON/);
});

test('aliases belong to selected list navigation, not selector-bound roles or map parents', () => {
  const leaf = createEntity('leaf', { id: '' }).commands(() => ({ custom: () => [] }), { static: ['custom'] }).build();
  const parent = createEntity('parent', { id: '', children: [] as { id: string }[] }).entityList('children', leaf).build();
  const state = { parents: [{ id: 'p', children: [] as { id: string }[] }], mapped: { p: { id: 'p', children: [] as { id: string }[] } } };
  const host = createAggregate('navigationOnly', state).entityList('parents', parent).entityMap('mapped', parent)
    .selectors(({ bindContext }) => ({ chosen: value => bindContext(value.parents[0], parent, { mount: 'parents' }) })).build();
  const live = createMirage(host, 'root');
  expect(typeof live.parents('p').customLeaf).toBe('function');
  expect(typeof live.parents[0]!.customLeaf).toBe('function');
  expect(Reflect.get(live.chosen()!, 'customLeaf')).toBeUndefined();
  expect(Reflect.get(live.mapped.p!, 'customLeaf')).toBeUndefined();
});
