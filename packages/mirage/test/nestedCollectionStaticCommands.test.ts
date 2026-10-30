import { createAggregate, createEntity } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createMirage, dispatch, extractState } from '../src';

type Leaf = { id: string; value: number };
const token = Symbol('payload');
class PackedPayload {
  declare readonly id: string;
  readonly [token] = 'symbol';
  constructor(id: string) { Object.defineProperty(this, 'id', { value: id }); }
  read() { return this.id; }
  get parentsId() { return 'p'; }
}

test('root and nested packs preserve borrowed class prototypes and own descriptors', () => {
  const borrowed = Object.freeze(new PackedPayload('c'));
  const seen: PackedPayload[] = [];
  const leaf = createEntity('leaf', { id: '' }).commands(() => ({
    packed: { pack: (_id: string) => borrowed, handler(_state, payload: PackedPayload) {
      expect(payload.read()).toBe('c');
      expect(payload[token]).toBe('symbol');
      expect(Object.getOwnPropertyDescriptor(payload, 'id')).toEqual(Object.getOwnPropertyDescriptor(borrowed, 'id'));
      seen.push(payload); return [];
    } }
  }), { static: ['packed'] }).build();
  const parent = createEntity('parent', { id: '', leaves: [] as { id: string }[] }).entityList('leaves', leaf).build();
  const host = createAggregate('payloads', { leaves: [] as { id: string }[], parents: [{ id: 'p', leaves: [] as { id: string }[] }] })
    .entityList('leaves', leaf).entityList('parents', parent).build();
  const live = createMirage(host, 'root');
  live.leaves.packed('c');
  live.parents('p').leaves.packed('c');
  expect(seen[0]).toBe(borrowed);
  expect(seen[1]).not.toBe(borrowed);
  expect(Reflect.get(seen[1]!, 'parentsId')).toBe('p');
  expect(Object.hasOwn(borrowed, 'parentsId')).toBe(false);
  expect(Object.isFrozen(borrowed)).toBe(true);
});

test.each(['value', 'get'])('frozen own ancestor %s descriptors accept equal values and reject conflicts', kind => {
  const { host, seen } = nestedHost();
  const leaves = createMirage(host, 'root').parents({ region: 'r', code: 'p' }).branches({ domain: 'd', key: 'b' }).leaves;
  for (const code of ['p', 'wrong']) {
    const payload = { id: 'c', value: 1 };
    Object.defineProperty(payload, 'parentsCode', kind === 'value' ? { value: code } : { get: () => code });
    Object.freeze(payload);
    const call = () => Reflect.apply(leaves.ignore, undefined, [payload]);
    if (code === 'p') expect(call).not.toThrow();
    else expect(call).toThrow('Conflicting ancestor identity: parentsCode');
    expect(Reflect.get(payload, 'parentsCode')).toBe(code);
    expect(Object.isFrozen(payload)).toBe(true);
  }
  expect(seen).toHaveLength(1);
});
type Payload = Leaf & { parentsRegion: string; parentsCode: string; branchesDomain: string; branchesKey: string };
function nestedHost() {
  const seen: Payload[] = [];
  const packs: unknown[][] = [];
  const leaf = createEntity('leaf', { id: '', value: 0 }).events({
    changed(state, event: Event<Payload>) { state.value = event.payload.value; }
  }).commands(emit => ({
    register(_state, payload: Payload) { seen.push(payload); return emit.changed(payload); },
    optional(_state, payload?: Payload) { if (payload) seen.push(payload); return []; },
    packed: { pack(id: string, value: number) { packs.push([id, value]); return { id, value }; },
      handler(_state, payload: Payload) { seen.push(payload); return emit.changed(payload); } },
    explicit: { pack(parentsCode: string, id: string, value: number) { packs.push([parentsCode, id, value]); return { parentsCode, id, value }; },
      handler(_state, payload: Payload) { seen.push(payload); return emit.changed(payload); } },
    ignore(_state, payload: Payload) { seen.push(payload); return []; }, ordinary: () => []
  }), { static: ['register', 'optional', 'packed', 'explicit', 'ignore'] }).build();
  const branch = createEntity('branch', { domain: '', key: '', leaves: [] as Leaf[] }).entityList('leaves', leaf).build();
  const parent = createEntity('parent', { region: '', code: '', branches: [] as { domain: string; key: string; leaves: Leaf[] }[] })
    .entityList('branches', branch, { pk: ['domain', 'key'] }).build();
  const builder = createAggregate('nested', { parents: [{ region: 'r', code: 'p', branches: [{ domain: 'd', key: 'b', leaves: [] as Leaf[] }] }] })
    .entityList('parents', parent, { pk: ['region', 'code'] });
  const host = builder.build();
  return { host, builder, seen, packs };
}

test('multiple composite ancestors bind only canonical qualifiers after full authored packs', async () => {
  const { host, seen, packs } = nestedHost();
  const live = createMirage(host, 'root');
  const parent = live.parents({ region: 'r', code: 'p' });
  const branch = parent.branches({ domain: 'd', key: 'b' });
  expect(extractState(live).parents[0]!.branches[0]!.leaves).toEqual([]);
  branch.leaves.ignore({ id: 'none', value: 0 });
  expect(branch.leaves.length).toBe(0);
  const result = await branch.leaves.packed('c', 1);
  expect(result.parents[0]!.branches[0]!.leaves).toEqual([{ id: 'c', value: 1 }]);
  branch.leaves.explicit('p', 'c', 2);
  branch.leaves.register({ id: 'c', value: 3, parentsRegion: 'r', branchesKey: 'b' });
  expect(packs).toEqual([['c', 1], ['p', 'c', 2]]);
  expect(seen.map(payload => [payload.parentsRegion, payload.parentsCode, payload.branchesDomain, payload.branchesKey]))
    .toEqual(Array(4).fill(['r', 'p', 'd', 'b']));
  expect(Reflect.get(parent, 'branchesLeavesRegister')).toBeUndefined();
  expect(Reflect.get(branch, 'leavesRegister')).toBeUndefined();
  expect(Reflect.get(branch.leaves, 'ordinary')).toBeUndefined();
  expect(() => Reflect.set(branch.leaves, '0', {})).toThrow('Cannot mutate');
  expect(Reflect.set(result.parents[0]!, 'code', 'bad')).toBe(false);
});

test('conflicting qualifiers and missing final identities reject before the handler', () => {
  const { host, seen } = nestedHost();
  const leaves = createMirage(host, 'root').parents({ region: 'r', code: 'p' }).branches({ domain: 'd', key: 'b' }).leaves;
  for (const conflict of [{ parentsCode: 'wrong' }, { branchesDomain: 'wrong' }, { parentsRegion: {} }]) {
    expect(() => Reflect.apply(leaves.register, undefined, [{ id: 'c', value: 1, ...conflict }])).toThrow('Conflicting ancestor identity');
  }
  expect(() => leaves.explicit('wrong', 'c', 1)).toThrow('Conflicting ancestor identity: parentsCode');
  expect(() => Reflect.apply(leaves.ignore, undefined, [{ value: 1 }])).toThrow('Invalid mounted command target');
  expect(seen).toEqual([]);
});

test('optional shorthand payloads bind ancestors when supplied and still require final identity at runtime', () => {
  const { host, seen } = nestedHost();
  const leaves = createMirage(host, 'root').parents({ region: 'r', code: 'p' }).branches({ domain: 'd', key: 'b' }).leaves;
  leaves.optional({ id: 'c', value: 1 });
  expect(seen[0]).toMatchObject({ id: 'c', parentsCode: 'p', branchesKey: 'b' });
  expect(() => leaves.optional()).toThrow('Missing ancestor identity payload');
});

test('async interception preserves aggregate result and selected leaf command results', async () => {
  const { host } = nestedHost();
  const live = createMirage(host, 'async', { plugins: [{ key: 'async', async onBeforeCommand() {} }] });
  const leaves = live.parents({ region: 'r', code: 'p' }).branches({ domain: 'd', key: 'b' }).leaves;
  const result = leaves.packed('c', 1);
  expect(result).toBeInstanceOf(Promise);
  expect((await result).parents[0]!.branches[0]!.leaves).toEqual([{ id: 'c', value: 1 }]);
  expect(await leaves('c').packed(2)).toEqual({ id: 'c', value: 2 });
});

test('stale selected ancestors reject even no-event commands and never auto-create parents', () => {
  const { builder, seen } = nestedHost();
  const removable = builder
    .events({ removed(state) { state.parents = []; } }).commands(emit => ({ remove: () => emit.removed() })).build();
  const live = createMirage(removable, 'root');
  const leaves = live.parents({ region: 'r', code: 'p' }).branches({ domain: 'd', key: 'b' }).leaves;
  dispatch(live, removable.commandCreators.remove());
  expect(() => leaves.ignore({ id: 'c', value: 1 })).toThrow('Entity not found');
  expect(extractState(live).parents).toEqual([]);
  expect(seen).toEqual([]);
});

test.each(['push', 'then', '0', 'map'])('nested static namespace fails eagerly for %s with no parents', name => {
  const child = createEntity('child', { id: '' }).commands(() => ({ [name]: () => [] }), { static: [name] }).build();
  const parent = createEntity('parent', { id: '', children: [] as { id: string }[] }).entityList('children', child).build();
  const host = createAggregate('collision', { parents: [] as { id: string; children: { id: string }[] }[] }).entityList('parents', parent).build();
  expect(() => Reflect.apply(createMirage, undefined, [host, 'root'])).toThrow('collision');
});

test('nested wire aliases use the existing Aggregate winner even at another origin target', () => {
  const calls: string[] = [];
  const first = createEntity('first', { id: '' }).commands(() => ({ register: (_state, _payload: { id: string; parentsId?: string }) => {
    calls.push('first'); return [];
  } }), { static: ['register'] }).build();
  const winner = createEntity('winner', { id: '' }).commands(() => ({ register: (_state, payload: { id: string; parentsId?: string }) => {
    calls.push(payload.parentsId ?? 'missing'); return [];
  } }), { static: ['register'] }).build();
  const parent = createEntity('parent', { id: '', children: [] as { id: string }[] })
    .entityList('children', first, {}, { commandNameOverrides: { register: 'shared' } }).build();
  const host = createAggregate('aliases', { parents: [{ id: 'p', children: [] as { id: string }[] }], others: [] as { id: string }[] })
    .entityList('parents', parent, {}, { commandNameOverrides: { childrenRegister: 'same.command' } })
    .entityList('others', winner, {}, { commandNameOverrides: { register: 'same.command' } }).build();
  const live = createMirage(host, 'root');
  live.parents('p').children.register({ id: 'c' });
  live.others.register({ id: 'c', parentsId: 'p' });
  expect(calls).toEqual(['p', 'p']);
});

test('repeated mount spelling cannot expose a static descendant alias on a parent collection', () => {
  const leaf = createEntity('leaf', { id: '' }).commands(() => ({ register: () => [] }), { static: ['register'] }).build();
  const parent = createEntity('parent', { id: '', parents: [] as { id: string }[] }).entityList('parents', leaf).build();
  const host = createAggregate('sameSpelling', { parents: [{ id: 'p', parents: [] as { id: string }[] }] }).entityList('parents', parent).build();
  const live = createMirage(host, 'root');
  expect(Reflect.get(live.parents, 'parentsRegister')).toBeUndefined();
  expect(Reflect.get(live.parents('p'), 'parentsRegister')).toBeUndefined();
  expect(typeof live.parents('p').parents.register).toBe('function');
});
