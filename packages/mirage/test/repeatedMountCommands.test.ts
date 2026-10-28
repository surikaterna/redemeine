import type { Event } from '@redemeine/kernel';
import { commandMetadata, createAggregate, createEntity, createMixin } from '../../aggregate/src';
import { createMirage, extractState, MirageCoreSymbol } from '../src';

type Row = { id: string; code: string; domain: string; authority: string; qty: number };
type PK = string | readonly string[];
const initial = () => [
  { id: 'id-a', code: 'code-a', domain: 'd-a', authority: 'auth-a', qty: 1 },
  { id: 'code-a', code: 'code-b', domain: 'd-b', authority: 'auth-b', qty: 10 }
];
const before = jest.fn();
const handled = jest.fn();

function first(pk: PK) {
  return createEntity<Row, 'first'>('first')
    .events({ firstChanged(state, event: Event<Record<string, unknown> & { qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({
      setFirst(state, payload: Record<string, unknown>) { handled(payload); return emit.firstChanged({ ...payload, qty: state.qty + 1 }); },
      packedFirst: { pack: (...ids: unknown[]) => Object.fromEntries((typeof pk === 'string' ? [pk] : pk).map((key, index) => [key, ids[index]])),
        handler: (state, payload: Record<string, unknown>) => { handled(payload); return emit.firstChanged({ ...payload, qty: state.qty + 1 }); } },
      badFirst: { pack: () => ({ id: 'code-a' }), handler: () => { handled(); } }
    })).build();
}

function second(pk: PK) {
  return createEntity<Row, 'second'>('second')
    .events({ secondChanged(state, event: Event<Record<string, unknown> & { qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({
      other(state, payload: Record<string, unknown>) { handled(payload); return emit.secondChanged({ ...payload, qty: state.qty + 1 }); },
      packedOther: { pack: (...ids: unknown[]) => Object.fromEntries((typeof pk === 'string' ? [pk] : pk).map((key, index) => [key, ids[index]])),
        handler: (state, payload: Record<string, unknown>) => { handled(payload); return emit.secondChanged({ ...payload, qty: state.qty + 1 }); } }
    })).build();
}

function fixture(oldPk: PK, livePk: PK, rows = initial()) {
  const role = second(livePk);
  const host = createAggregate('store', { rows }).entityList('rows', first(oldPk), { pk: oldPk })
    .entityList('rows', role, { pk: livePk })
    .selectors(({ bindContext }) => ({ chosen: state => bindContext(state.rows[0], role, { mount: 'rows' }) })).build();
  host.hooks = { onBeforeCommand: before };
  const live = createMirage(host, 'store');
  const raw = typeof livePk === 'string' ? Reflect.get(rows[0]!, livePk) : Object.fromEntries(livePk.map(key => [key, Reflect.get(rows[0]!, key)]));
  return { live, host, selected: Reflect.apply(live.rows, undefined, [raw]) };
}

beforeEach(() => { before.mockClear(); handled.mockClear(); });

test('explicit earlier role admits surviving registrations and hides other role commands', () => {
  const old = first('id');
  const host = createAggregate('store', { rows: initial() }).entityList('rows', old)
    .entityList('rows', second('code'), { pk: 'code' })
    .selectors(({ bindContext }) => ({ chosen: state => bindContext(state.rows[0], old, { mount: 'rows' }) })).build();
  const live = createMirage(host, 'store');
  const bound = live.chosen()!;
  bound.setFirst({});
  expect(extractState(live).rows.map(row => row.qty)).toEqual([2, 10]);
  expect(handled.mock.calls[0]![0].id).toBe('id-a');
  expect(Reflect.get(bound, 'other')).toBeUndefined();
  expect(Reflect.get(bound, 'packedOther')).toBeUndefined();
});

test.each(['missing', 'root', 'kind', 'path'])('compiled registration ignores a %s compatibility-view edit', failure => {
  const old = first('id');
  const host = createAggregate('store', { rows: initial() }).entityList('rows', old)
    .entityList('rows', second('code'), { pk: 'code' })
    .selectors(({ bindContext }) => ({ chosen: state => bindContext(state.rows[0], old, { mount: 'rows' }) })).build();
  const targets = { ...Reflect.get(host.pure, 'commandTargets') };
  const registration = commandMetadata(host, 'rowsSetFirst');
  if (failure === 'missing') Reflect.deleteProperty(targets, 'rowsSetFirst');
  if (failure === 'root') Reflect.set(targets, 'rowsSetFirst', []);
  if (failure === 'kind') Reflect.set(targets, 'rowsSetFirst', [{ kind: 'map', statePath: ['rows'], commandPrefix: 'rows' }]);
  if (failure === 'path') Reflect.set(targets, 'rowsSetFirst', [{ kind: 'list', statePath: ['other'], commandPrefix: 'rows' }]);
  expect(Reflect.set(host.pure, 'commandTargets', targets)).toBe(true);
  host.hooks = { onBeforeCommand: before };
  expect(commandMetadata(host, 'rowsSetFirst')).toBe(registration);
  const chosen = createMirage(host, 'store').chosen();
  expect(before).not.toHaveBeenCalled();
  expect(handled).not.toHaveBeenCalled();
  chosen!.setFirst({});
  expect(handled.mock.calls[0]![0].id).toBe('id-a');
});

test('explicit unrelated role with absent commands is rejected', () => {
  const old = first('id');
  const unrelated = createEntity<Row, 'unrelated'>('unrelated').commands(() => ({ absent: () => [] })).build();
  const host = createAggregate('store', { rows: initial() }).entityList('rows', old)
    .entityList('rows', second('code'), { pk: 'code' })
    .selectors(({ bindContext }) => ({ chosen: state => bindContext(state.rows[0], unrelated, { mount: 'rows' }) })).build();
  expect(() => createMirage(host, 'store').chosen()).toThrow(/absent/i);
});

test('scoped primitive shorthand rejects before hooks and state changes', () => {
  const { live, selected } = fixture('id', 'code');
  for (const payload of [2, 'bad', false, null, [], () => {}]) {
    expect(() => Reflect.apply(selected.setFirst, undefined, [payload])).toThrow(TypeError);
  }
  expect(before).not.toHaveBeenCalled();
  expect(handled).not.toHaveBeenCalled();
  expect(extractState(live).rows).toEqual(initial());
  expect(live[MirageCoreSymbol].getPendingResults().events).toEqual([]);
});

test('natural business-only calls retain old id and new code on the selected row', () => {
  const old = createEntity<Row, 'old'>('old')
    .events({ oldChanged(state, event: Event<{ id: string; qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ setOld: (state, payload: { id: string; qty: number }) => emit.oldChanged(payload) })).build();
  const latest = createEntity<Row, 'latest'>('latest')
    .events({ newChanged(state, event: Event<{ code: string; qty: number }>) { state.qty = event.payload.qty; } })
    .commands(emit => ({ setNew: (state, payload: { code: string; qty: number }) => emit.newChanged(payload) })).build();
  const host = createAggregate('store', { rows: initial() }).entityList('rows', old)
    .entityList('rows', latest, { pk: 'code' }).build();
  const live = createMirage(host, 'store');
  live.rows('code-a').setOld({ qty: 7 });
  live.rows('code-a').setNew({ qty: 8 });
  expect(extractState(live).rows.map(row => row.qty)).toEqual([8, 10]);
});

test.each([
  ['id', 'code'], ['code', 'id'], ['code', ['domain', 'authority']],
  [['domain', 'authority'], 'code'], [['domain', 'authority'], ['authority', 'domain']],
  [['id', 'domain', 'authority'], ['authority', 'domain']]
] satisfies [PK, PK][])('command identity follows its registration (%j then %j)', (oldPk, livePk) => {
  const { live, selected } = fixture(oldPk, livePk);
  for (const name of ['setFirst', 'other', 'packedFirst', 'packedOther']) {
    const result = Reflect.apply(Reflect.get(selected, name), undefined, name.startsWith('packed') ? [] : [{}]);
    expect(result.id).toBe('id-a');
    const pk = name.endsWith('First') ? oldPk : livePk;
    const payload = handled.mock.calls.at(-1)![0];
    for (const field of typeof pk === 'string' ? [pk] : pk) expect(payload[field]).toBe(Reflect.get(initial()[0]!, field));
  }
  expect(extractState(live).rows.map(row => row.qty)).toEqual([5, 10]);
});

test('direct/index/iteration/bound-selector paths share command context and original return view', () => {
  const { live, selected } = fixture('id', 'code');
  for (const view of [selected, live.rows[0], [...live.rows][0], live.chosen()]) {
    expect(Reflect.apply(Reflect.get(view, 'setFirst'), undefined, [{}]).id).toBe('id-a');
  }
  expect(extractState(live).rows.map(row => row.qty)).toEqual([5, 10]);
});

test('shorthand and final packed canonical conflicts fail before hooks', () => {
  const { selected } = fixture('id', 'code');
  for (const payload of [{ id: 'code-a' }, { id: false }, { id: {} }]) {
    expect(() => Reflect.apply(selected.setFirst, undefined, [payload])).toThrow(/identity/i);
  }
  expect(() => Reflect.apply(selected.badFirst, undefined, [])).toThrow(/identity/i);
  const composite = fixture(['domain', 'authority'], 'code').selected;
  expect(() => Reflect.apply(composite.setFirst, undefined, [{ domain: 'd-b', authority: 'auth-a' }])).toThrow(/identity/i);
  expect(before).not.toHaveBeenCalled();
  expect(handled).not.toHaveBeenCalled();
});

test('missing old primary key fails before hooks; duplicate old identity remains Aggregate policy', () => {
  const missing = initial();
  Reflect.deleteProperty(missing[0]!, 'id');
  expect(() => Reflect.apply(fixture('id', 'code', missing).selected.setFirst, undefined, [{}])).toThrow(/primary key/i);
  expect(before).not.toHaveBeenCalled();
  const duplicate = initial();
  duplicate[1]!.id = 'id-a';
  expect(() => Reflect.apply(fixture('id', 'code', duplicate).selected.setFirst, undefined, [{}])).toThrow('Invalid mounted command target');
  expect(handled).not.toHaveBeenCalled();
});

test('map commands use the own entry key rather than value id', () => {
  const host = createAggregate('store', { rows: { chosen: initial()[0]! } })
    .entityMap('rows', first('key')).entityMap('rows', second('key')).build();
  const live = createMirage(host, 'store');
  Reflect.apply(live.rows.chosen!.packedFirst, undefined, []);
  expect(handled.mock.calls[0]![0].key).toBe('chosen');
  expect(extractState(live).rows.chosen.qty).toBe(2);
});

test('missing registration and incompatible mount kinds reject before hooks', () => {
  const { host } = fixture('id', 'code');
  Reflect.deleteProperty(host.pure, 'commandTargets');
  const unregistered = createMirage({ ...host }, 'store').rows('code-a');
  expect(() => Reflect.apply(unregistered.setFirst, undefined, [{}])).toThrow(/registration/i);
  const incompatible = createAggregate('store', { rows: initial() }).entityMap('rows', first('key'))
    .entityList('rows', second('code'), { pk: 'code' }).build();
  incompatible.hooks = { onBeforeCommand: before };
  const live = createMirage(incompatible, 'store');
  expect(() => Reflect.apply(live.rows('code-a').setFirst, undefined, [{}])).toThrow(/registration/i);
  expect(before).not.toHaveBeenCalled();
  expect(handled).not.toHaveBeenCalled();
});

test('selected scalar identities keep numeric/string/bigint equivalence', () => {
  const item = createEntity<{ id: bigint; code: string }, 'item'>('item')
    .commands(() => ({ read: (_state, _payload: Record<string, unknown>) => { handled(); return []; } })).build();
  const other = createEntity<{ id: bigint; code: string }, 'other'>('other').build();
  const host = createAggregate('store', { rows: [{ id: 0n, code: '' }] })
    .entityList('rows', item).entityList('rows', other, { pk: 'code' }).build();
  host.hooks = { onBeforeCommand: before };
  const live = createMirage(host, 'store');
  for (const id of [0n, 0, '0']) Reflect.apply(live.rows('').read, undefined, [{ id }]);
  expect(handled).toHaveBeenCalledTimes(3);
  expect(() => Reflect.apply(live.rows('').read, undefined, [{ id: false }])).toThrow(/identity/i);
  expect(before).toHaveBeenCalledTimes(3);
});

test('root-winning selected command rejects before hooks while bare root invocation stays root', () => {
  const state = { rows: initial() };
  const old = first('id');
  const source = createMixin<typeof state>().entityList('rows', old).build();
  const root = createMixin<typeof state>().commands(() => ({ rowsSetFirst: () => { handled(); return []; } })).build();
  const host = createAggregate('store', state).mixins({ ...source, mountedEntities: [] }, root).entityList('rows', second('code'), { pk: 'code' })
    .selectors(({ bindContext }) => ({ chosen: state => bindContext(state.rows[0], old, { mount: 'rows' }) })).build();
  host.hooks = { onBeforeCommand: before };
  const live = createMirage(host, 'store');
  expect(() => Reflect.apply(live.rows('code-a').setFirst, undefined, [{}])).toThrow(/registration/i);
  expect(() => live.chosen()).toThrow(/registration/i);
  expect(before).not.toHaveBeenCalled();
  expect(handled).not.toHaveBeenCalled();
  live.rowsSetFirst();
  expect(handled).toHaveBeenCalledTimes(1);
});
