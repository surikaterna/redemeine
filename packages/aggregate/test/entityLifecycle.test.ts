import { createAggregate, createEntity, createMixin } from '../src';
import type { Event } from '@redemeine/kernel';
import { Immer, immerable, produce } from 'immer';

type Identifier = { domain: string; authority: string; identifier: string };
const initialIdentifierState: Identifier = { domain: '', authority: '', identifier: '' };

function identifierHost() {
  const entity = createEntity('identifier', initialIdentifierState)
    .events({
      registered(state, event: Event<Identifier>) { state.identifier = event.payload.identifier; },
      amended(state, event: Event<Identifier>) { state.identifier = event.payload.identifier; }
    })
    .commands(emit => ({
      register(state, payload: Identifier, { isNew }) {
        if (!payload.domain) throw new Error('Invalid domain');
        if (isNew) return emit.registered(payload);
        return state.identifier === payload.identifier ? [] : emit.amended(payload);
      }
    }), { static: ['register'] }).build();
  return createAggregate('registry', { identifiers: [] as Identifier[] })
    .entityList('identifiers', entity, { pk: ['domain', 'authority'] }).build();
}

test('registration decisions do not insert; ordinary replay materializes the entity', () => {
  const host = identifierHost();
  const payload = { domain: 'example.org', authority: 'issuer', identifier: 'one' };
  const command = host.commandCreators.identifiersRegister(payload);
  const events = host.process(host.initialState, command);
  expect(events).toHaveLength(1);
  expect(host.initialState.identifiers).toEqual([]);
  const registered = host.apply(host.initialState, events[0]!);
  expect(registered.identifiers).toEqual([payload]);
  expect(host.process(registered, command)).toEqual([]);
  const amended = host.process(registered, host.commandCreators.identifiersRegister({ ...payload, identifier: 'two' }));
  expect(amended[0]!.type).not.toBe(events[0]!.type);
  expect(host.apply(registered, amended[0]!).identifiers[0]!.identifier).toBe('two');
  expect(() => host.process(host.initialState, host.commandCreators.identifiersRegister({ ...payload, domain: '' })))
    .toThrow('Invalid domain');
});

test('presence, not template equality, controls context; borrowed states are readonly', () => {
  const seen: boolean[] = [];
  const template = { id: 'same', nested: { count: 0 } };
  const entity = createEntity('row', template).commands(() => ({
    check(state, _payload: { id: string }, context) {
      seen.push(context.isNew);
      expect(() => { Reflect.set(state.nested, 'count', 9); }).toThrow();
      expect(Reflect.set(context, 'isNew', false)).toBe(false);
      return [];
    }
  }), { static: ['check'] }).build();
  const host = createAggregate('presence', { rows: [] as typeof template[] }).entityList('rows', entity).build();
  const command = host.commandCreators.rowsCheck({ id: 'same' });
  expect(host.process(host.initialState, command)).toEqual([]);
  expect(host.process({ rows: [template] }, command)).toEqual([]);
  expect(seen).toEqual([true, false]);
  expect(template).toEqual({ id: 'same', nested: { count: 0 } });
  expect(Object.isFrozen(template)).toBe(false);
  expect(Object.isFrozen(template.nested)).toBe(false);
  expect(host.initialState.rows).toEqual([]);
});

test('static lookup validates canonical identity, container and ambiguity before handler', () => {
  const called = jest.fn();
  const entity = createEntity('identifier', initialIdentifierState).commands(() => ({
    register(_state, _payload: Partial<Identifier>) { called(); return []; }
  }), { static: ['register'] }).build();
  const host = createAggregate('validation', { identifiers: [] as Identifier[] })
    .entityList('identifiers', entity, { pk: ['domain', 'authority'] }).build();
  const payload = { domain: 'd', authority: 'a' };
  const duplicate = { ...payload, identifier: 'one' };
  for (const [state, input] of [
    [host.initialState, { domain: 'd' }], [host.initialState, { ...payload, authority: {} }],
    [{ identifiers: {} }, payload], [{ identifiers: [duplicate, duplicate] }, payload]
  ] as const) {
    expect(() => host.process(state as typeof host.initialState,
      host.commandCreators.identifiersRegister(input as Partial<Identifier>))).toThrow('Invalid mounted command target');
  }
  expect(called).not.toHaveBeenCalled();
});

function nestedLifecycle() {
  const template = { id: '', nested: { count: 0 }, log: [] as number[] };
  const child = createEntity('child', template).events({
    changed(state, event: Event<{ id: string; parentsId: string; count: number }>) {
      state.nested.count = event.payload.count;
      state.log.push(event.payload.count);
    },
    untouched(_state, _event: Event<{ id: string; parentsId: string }>) {}
  }).commands(emit => ({
    set(_state, payload: { id: string; parentsId: string; count: number }) { return emit.changed(payload); }
  }), { static: ['set'] }).build();
  const parent = createEntity<{ id: string; children: typeof template[] }, 'parent'>('parent')
    .entityList('children', child).build();
  const host = createAggregate('nested', { parents: [{ id: 'p', children: [] as typeof template[] }] })
    .entityList('parents', parent).build();
  const event = (count: number) => host.process(host.initialState,
    host.commandCreators.parentsChildrenSet({ parentsId: 'p', id: 'c', count }))[0]!;
  return { host, template, event };
}

test('ordinary projector replay creates only the final leaf and no-op still inserts', () => {
  const { host, template, event } = nestedLifecycle();
  const changed = event(1);
  const replay = host.apply(host.initialState, changed);
  expect(replay.parents[0]!.children[0]).toEqual({ id: 'c', nested: { count: 1 }, log: [1] });
  expect(host.apply(replay, event(2)).parents[0]!.children[0]!.log).toEqual([1, 2]);
  const noop = { type: 'nested.parent.child.untouched.event', payload: { parentsId: 'p', id: 'noop' } };
  expect(host.apply(host.initialState, noop).parents[0]!.children).toEqual([{ ...template, id: 'noop' }]);
  expect(() => host.apply({ parents: [] }, changed)).toThrow('Invalid mounted command target');
  expect(() => host.process({ parents: [] }, host.commandCreators.parentsChildrenSet(changed.payload as never)))
    .toThrow('Invalid mounted command target');
  expect(template).toEqual({ id: '', nested: { count: 0 }, log: [] });
  expect(host.initialState.parents[0]!.children).toEqual([]);
});

test.each([false, true])('outer draft creates then updates without mutating borrowed ancestors (raw=%s)', raw => {
  const { host, template, event } = nestedLifecycle();
  const ancestor = { id: 'p', children: [{ id: 'sibling', nested: { count: 8 }, log: [8] }] };
  const input = raw ? { parents: [] as typeof ancestor[] } : { parents: [ancestor] };
  const before = structuredClone(input);
  const apply = (draft: Parameters<typeof host.applyToDraft>[0]) => {
    if (raw) draft.parents.push(ancestor);
    host.applyToDraft(draft, event(1));
    host.applyToDraft(draft, event(2));
  };
  expect(() => produce(input, draft => { apply(draft); throw new Error('rollback'); })).toThrow('rollback');
  expect(input).toEqual(before);
  expect(ancestor.children).toEqual([{ id: 'sibling', nested: { count: 8 }, log: [8] }]);
  const result = produce(input, apply);
  expect(result.parents[0]!.children[1]).toEqual({ id: 'c', nested: { count: 2 }, log: [1, 2] });
  expect(ancestor.children).toHaveLength(1);
  expect(template).toEqual({ id: '', nested: { count: 0 }, log: [] });
  expect(input).toEqual(before);
});

test('materialized Immer classes retain projector methods and leave templates and input unchanged', () => {
  class Row {
    [immerable] = true;
    id = 'template';
    nested = { count: 0 };
    read() { return `${this.id}:${this.nested.count}`; }
    increment() { this.nested.count++; }
  }
  const template = new Row();
  const entity = createEntity('row', template).events({
    changed(state, event: Event<{ id: string }>) {
      expect(state.read()).toBe(`${event.payload.id}:${state.nested.count}`);
      state.increment();
    }
  }).build();
  const original = new Row();
  original.id = 'existing';
  const input = { rows: [original] };
  const host = createAggregate('classes', input).entityList('rows', entity).build();
  const event = { type: 'classes.row.changed.event', payload: { id: 'new' } };
  const result = host.apply(input, event);
  expect(result.rows[1]).toBeInstanceOf(Row);
  expect(result.rows[1]!.read()).toBe('new:1');
  expect(result.rows[1]!.nested).not.toBe(template.nested);
  const updated = host.apply(result, event);
  expect(updated.rows[1]).toBeInstanceOf(Row);
  expect(updated.rows[1]!.read()).toBe('new:2');
  expect(result.rows[1]!.read()).toBe('new:1');
  expect(template.read()).toBe('template:0');
  expect(input.rows).toEqual([original]);
  expect(input.rows[0]).toBe(original);
  expect(original.read()).toBe('existing:0');
});

test.each([false, true])('ancestor copies retain own descriptors without invoking setters (raw=%s)', raw => {
  const { host, event } = nestedLifecycle();
  // Existing class drafts need strict outer copying too; raw insertions are not drafts.
  const outerProduce = raw ? produce : new Immer({ useStrictShallowCopy: true }).produce;
  const setter = jest.fn();
  const marker = Symbol('hidden');
  const visible = Symbol('visible');
  class Parent {
    [immerable] = true;
    id = 'p';
    children: { id: string; nested: { count: number }; log: number[] }[] = [];
    set note(value: string) { setter(value); }
  }
  const ancestor = new Parent();
  Object.defineProperties(ancestor, {
    note: { value: 'own note', enumerable: true, configurable: true },
    hidden: { value: 'hidden', enumerable: false, configurable: true },
    [marker]: { value: 'symbol', enumerable: false, configurable: true },
    [visible]: { value: 'visible symbol', enumerable: true, configurable: true }
  });
  Object.defineProperty(ancestor, '__proto__', { value: 'own proto', enumerable: true, configurable: true });
  const input = { parents: raw ? [] as Parent[] : [ancestor] };
  const apply = (draft: Parameters<typeof host.applyToDraft>[0]) => {
    if (raw) draft.parents.push(ancestor);
    host.applyToDraft(draft, event(1));
    host.applyToDraft(draft, event(2));
  };
  expect(() => outerProduce(input, draft => { apply(draft); throw Error('rollback'); })).toThrow('rollback');
  expect(setter).not.toHaveBeenCalled();
  expect(ancestor.children).toEqual([]);
  const result = outerProduce(input, apply).parents[0]!;
  expect(Object.getPrototypeOf(result)).toBe(Parent.prototype);
  expect(Object.getOwnPropertyDescriptor(result, 'note')?.value).toBe('own note');
  expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toBe('own proto');
  expect(Object.getOwnPropertyDescriptor(result, 'hidden')).toMatchObject({ value: 'hidden', enumerable: false });
  expect(Object.getOwnPropertyDescriptor(result, marker)).toMatchObject({ value: 'symbol', enumerable: false });
  expect(Object.getOwnPropertyDescriptor(result, visible)).toMatchObject({ value: 'visible symbol', enumerable: true });
  expect(result.children[0]!.log).toEqual([1, 2]);
  expect(setter).not.toHaveBeenCalled();
  expect(ancestor.children).toEqual([]);
  expect(input.parents).toHaveLength(raw ? 0 : 1);
});

test('undefined templates are omitted, including forwarded optional state', () => {
  type Row = { id: string; count: number };
  const forward = (state?: Row) => createEntity<Row, 'row'>('row', state);
  for (const entity of [createEntity<Row, 'row'>('row', undefined).build(), forward().build()]) {
    expect(Object.hasOwn(entity, 'initialState')).toBe(false);
  }
  expect(forward({ id: '', count: 0 }).build().initialState).toEqual({ id: '', count: 0 });
  expect(() => forward().commands(() => ({ read: () => [] }), { static: ['read'] })).toThrow('require an initial state');
  for (const invalid of [null, [], 1]) {
    expect(() => createEntity('invalid', invalid)).toThrow('initial state must be an object');
  }
});

test.each([['__proto__'], ['__proto__', 'tenant'], ['code']])('canonical own fields bypass inherited setters (%j)', (...pk) => {
  const marker = Symbol('template');
  const setter = jest.fn();
  class Row {
    [immerable] = true;
    [marker] = 'retained';
    declare __proto__: string;
    declare tenant: string;
    nested = { count: 0 };
    set code(value: string) { setter(value); }
    get code() { return 'inherited'; }
    increment() { this.nested.count++; }
  }
  const template = new Row();
  const seen: boolean[] = [];
  const payload = Object.fromEntries(pk.map(key => [key, `${key}-value`])) as Record<string, string>;
  const entity = createEntity('row', template).events({
    changed(state, event: Event<Record<string, string>>) {
      for (const key of pk) {
        expect(Object.hasOwn(state, key)).toBe(true);
        expect(Reflect.get(state, key)).toBe(event.payload[key]);
      }
      expect(state[marker]).toBe('retained');
      state.increment();
    }
  }).commands(emit => ({
    register(_state, input: Record<string, string>, { isNew }) { seen.push(isNew); return emit.changed(input); }
  }), { static: ['register'] }).build();
  const input = { rows: [] as Row[] };
  const host = createAggregate('canonical', input).entityList('rows', entity, { pk }).build();
  const command = host.commandCreators.rowsRegister(payload);
  const event = host.process(input, command)[0]!;
  const first = host.apply(input, event);
  const replay = host.apply(first, event);
  host.process(replay, command);
  expect(replay.rows).toHaveLength(1);
  expect(replay.rows[0]).toBeInstanceOf(Row);
  expect(Object.getPrototypeOf(replay.rows[0])).toBe(Row.prototype);
  expect(replay.rows[0]!.nested.count).toBe(2);
  expect(first.rows[0]!.nested.count).toBe(1);
  expect(seen).toEqual([true, false]);
  expect(setter).not.toHaveBeenCalled();
  expect(input.rows).toEqual([]);
  expect(Object.getPrototypeOf(template)).toBe(Row.prototype);
  expect(template.nested.count).toBe(0);
  for (const key of pk) expect(Object.hasOwn(template, key)).toBe(false);
  expect(Object.hasOwn(Object.prototype, 'tenant')).toBe(false);
});

test('instance commands and name-only entities keep missing behavior; map creation is unsupported', () => {
  const entity = createEntity('row', { id: '', count: 0 })
    .events({ changed(state, _event: Event<{ id: string; key?: string }>) { state.count++; } })
    .commands(() => ({ read: (_state, _payload: { id: string; key?: string }) => [] })).build();
  const plain = createEntity<{ id: string; count: number }, 'plain'>('plain').events(entity.events).build();
  const host = createAggregate('ordinary', { rows: [], plain: [], byKey: {} })
    .entityList('rows', entity).entityList('plain', plain).entityMap('byKey', entity, {}, { semanticName: 'byKey' }).build();
  expect(() => host.process(host.initialState, host.commandCreators.rowsRead({ id: 'missing' })))
    .toThrow('Invalid mounted command target');
  for (const mount of ['plain', 'byKey']) {
    const changed = { type: `ordinary.${mount}.changed.event`, payload: { id: 'missing', key: 'missing' } };
    expect(() => host.apply(host.initialState, changed)).toThrow('Invalid mounted command target');
  }
  expect(() => createEntity('invalid').commands(() => ({ read: () => [] }), { static: ['read'] }))
    .toThrow('require an initial state');
});

test('winning registrations retain or reset static classification through composition and repeated builds', () => {
  type Row = { id: string };
  const calls: boolean[] = [];
  const definition = { read: (_state: unknown, _payload: Row, { isNew }: { isNew: boolean }) => { calls.push(isNew); return []; } };
  const builder = createEntity('row', { id: '' }).commands(() => definition, { static: ['read'] });
  const staticEntity = builder.build();
  const ordinary = builder.commands(() => definition).build();
  const mounted = createMixin<{ rows: Row[] }>().entityList('rows', staticEntity).build();
  const root = createMixin<{ rows: Row[] }>().commands(() => ({ rootRead: () => [] })).build();
  const aggregate = createAggregate('composition', { rows: [] as Row[] }).mixins(mounted);
  for (const host of [aggregate.build(), aggregate.build()]) {
    host.process(host.initialState, host.commandCreators.rowsRead({ id: 'x' }));
  }
  expect(calls).toEqual([true, true]);
  const reset = createAggregate('reset', { rows: [] as Row[] }).entityList('rows', ordinary).build();
  expect(() => reset.process(reset.initialState, reset.commandCreators.rowsRead({ id: 'x' })))
    .toThrow('Invalid mounted command target');
  const replaced = createAggregate('root', { rows: [] as Row[] }).mixins({ ...mounted, mountedEntities: [] }, root)
    .overrideCommandNames({ rowsRead: 'shared.command', rootRead: 'shared.command' }).build();
  expect(replaced.process(replaced.initialState, replaced.commandCreators.rowsRead())).toEqual([]);
  const bad = createEntity('bad', { id: '' }).commands(() => ({ read: () => [] }), { static: ['missing' as 'read'] }).build();
  expect(() => createAggregate('bad', { rows: [] }).entityList('rows', bad).build()).toThrow('Unknown static entity command');
});

test('wire winner owns staticness rather than an earlier alias or reusable function', () => {
  const received: boolean[] = [];
  const read = (_state: unknown, _payload: { id: string }, { isNew }: { isNew: boolean }) => {
    received.push(isNew); return [];
  };
  for (const staticLast of [false, true]) {
    const entity = createEntity('row', { id: '' })
      .commands(() => ({ first: read }), staticLast ? undefined : { static: ['first'] })
      .commands(() => ({ last: read }), staticLast ? { static: ['last'] } : undefined)
      .overrideCommandNames({ first: 'shared', last: 'shared' }).build();
    const host = createAggregate('collision', { rows: [] as { id: string }[] }).entityList('rows', entity).build();
    const process = () => host.process(host.initialState, host.commandCreators.rowsFirst({ id: 'x' }));
    if (staticLast) expect(process()).toEqual([]);
    else expect(process).toThrow('Invalid mounted command target');
  }
  expect(received).toEqual([true]);
});
