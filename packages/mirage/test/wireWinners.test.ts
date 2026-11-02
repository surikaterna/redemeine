import { createAggregate, createEntity, createMixin } from '../../aggregate/src';
import { createMirage, extractState, MirageCoreSymbol } from '../src';

function fixture(names: [string, string], reverse: boolean, override: boolean) {
  const pack = jest.fn((id: string, qty: number) => ({ id, qty }));
  const handler = jest.fn();
  const before = jest.fn();
  const entity = createEntity<{ id: string; qty: number }, 'row'>('row')
    .events({ changed(state, event: { payload: { qty: number } }) { state.qty = event.payload.qty; } })
    .commands(emit => ({ set: { pack, handler: (state, payload: { id: string; qty: number }) => {
      handler(state.qty); return emit.changed({ ...payload, qty: state.qty + payload.qty });
    } } })).build();
  const initial = Object.fromEntries(names.map((name, index) => [name, [{ id: 'a', qty: index + 1 }]]));
  const builder = createAggregate('store', initial);
  for (const name of reverse ? [...names].reverse() : names) {
    builder.entityList(name, entity, undefined, override ? { commandNameOverrides: { set: 'shared.set.command' } } : undefined);
  }
  const built = builder.build();
  built.hooks = { onBeforeCommand: before };
  const live = createMirage(built, 'store');
  return { built, live, pack, handler, before };
}

test.each([false, true])('explicit wire override rejects shadowed selected commands, reverse=%s', reverse => {
  const { built, live, pack, handler, before } = fixture(['left', 'right'], reverse, true);
  const loser = reverse ? 'right' : 'left';
  const winner = reverse ? 'left' : 'right';
  const state = extractState(live);
  expect(() => live[loser]('a').set(5)).toThrow(/shadowed/i);
  expect(pack).not.toHaveBeenCalled();
  expect(before).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  expect(extractState(live)).toEqual(state);
  expect(live[MirageCoreSymbol].getPendingResults().events).toEqual([]);
  const command = built.commandCreators[`${loser}Set`]!('a', 5);
  const events = built.process(built.initialState, command);
  expect(handler).toHaveBeenCalledWith(reverse ? 1 : 2);
  expect(events[0]!.metadata!.command).toEqual({ id: command.id, type: 'shared.set.command' });
  live[winner]('a').set(5);
  expect(live[winner]('a').qty).toBe((reverse ? 1 : 2) + 5);
});

test.each([false, true])('shared default semantic wire rejects shadowed selection before packing, reverse=%s', reverse => {
  const { live, pack, handler, before } = fixture(['orderLines', 'order_lines'], reverse, false);
  const loser = reverse ? 'order_lines' : 'orderLines';
  const state = extractState(live);
  expect(() => live[loser]('a').set(5)).toThrow(/shadowed/i);
  expect(pack).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  expect(before).not.toHaveBeenCalled();
  expect(extractState(live)).toEqual(state);
  expect(live[MirageCoreSymbol].getPendingResults().events).toEqual([]);
});

test('same-path same-PK different packers still reject the shadowed local registration', () => {
  const firstPack = jest.fn((id: string, qty: number) => ({ id, qty }));
  const secondPack = jest.fn((id: string, qty: number) => ({ id, qty: qty * 10 }));
  const handler = jest.fn((_state: unknown, _payload: { id: string; qty: number }) => []);
  const row = createEntity<{ id: string; qty: number }, 'row'>('row').commands(() => ({
    first: { pack: firstPack, handler }, second: { pack: secondPack, handler }
  })).build();
  const built = createAggregate('store', { rows: [{ id: 'a', qty: 1 }] }).entityList('rows', row, undefined,
    { commandNameOverrides: { first: 'shared.set.command', second: 'shared.set.command' } }).build();
  const before = jest.fn();
  built.hooks = { onBeforeCommand: before };
  const live = createMirage(built, 'store');
  expect(() => live.rows('a').first(2)).toThrow(/shadowed/i);
  expect(firstPack).not.toHaveBeenCalled();
  expect(secondPack).not.toHaveBeenCalled();
  expect(before).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  expect(live[MirageCoreSymbol].getPendingResults().events).toEqual([]);
  expect(extractState(live)).toEqual(built.initialState);
  live.rows('a').second(2);
  expect(handler.mock.calls[0]![1]).toEqual({ id: 'a', qty: 20 });
});

test('native root wire winner rejects a selected scoped local registration before its packer', () => {
  const pack = jest.fn((id: string, qty: number) => ({ id, qty }));
  const handler = jest.fn(() => []);
  const row = createEntity<{ id: string; qty: number }, 'row'>('row').commands(() => ({ set: { pack, handler } })).build();
  type State = { rows: { id: string; qty: number }[] };
  const source = createMixin<State>().entityList('rows', row).build();
  const mounted = { ...source, mountedEntities: [] };
  const root = createMixin<State>().commands(() => ({ root: () => [] })).build();
  const built = createAggregate('store', { rows: [{ id: 'a', qty: 1 }] }).mixins(mounted, root)
    .overrideCommandNames({ rowsSet: 'shared.set.command', root: 'shared.set.command' })
    .entityList('rows', row).build();
  const before = jest.fn();
  built.hooks = { onBeforeCommand: before };
  const live = createMirage(built, 'store');
  expect(() => live.rows('a').set(2)).toThrow(/shadowed/i);
  expect(pack).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  expect(before).not.toHaveBeenCalled();
  expect(extractState(live)).toEqual(built.initialState);
  expect(live[MirageCoreSymbol].getPendingResults().events).toEqual([]);
  expect(built.process(built.initialState, built.commandCreators.rowsSet('a', 2))).toEqual([]);
});
