import type { Event } from '@redemeine/kernel';
import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '../src';

function source() {
  return createAggregate('counter', { count: 0, nested: { unchanged: true } })
    .events({ added(state, event: Event<number>) { state.count += event.payload; } })
    .commands(emit => ({ add: (_state, payload: number) => emit.added(payload) })).build();
}

test('stateless envelopes preserve state shape/reference and use readonly domain context without ownState', () => {
  const host = source();
  const clock = jest.fn(() => new Date('2026-10-19T00:00:00Z'));
  const plugin = createAggregatePluginFor(host, 'transport')
    .commandEnvelope((input, context) => {
      expect(context.state.count).toBe(0);
      expect(context.ownState).toBeUndefined();
      expect(Reflect.set(context.state.nested, 'unchanged', false)).toBe(false);
      return { dateTime: input.dateTime instanceof Date ? input.dateTime : clock() };
    })
    .eventEnvelope((_, context) => ({ executionDateTime: context.command.dateTime.toISOString() })).build();
  expect(plugin.initialize).toBeUndefined();
  const built = host.withPlugins(plugin);
  expect(built.initialState).toBe(host.initialState);
  expect(built.commandCreators).toBe(host.commandCreators);
  const command = built.prepareCommand(built.initialState, built.commandCreators.add(2));
  const [event] = built.process(built.initialState, command);
  expect(clock).toHaveBeenCalledTimes(1);
  expect(event).toHaveProperty('executionDateTime', '2026-10-19T00:00:00.000Z');
  const next = built.apply(built.initialState, event!);
  expect(next).toEqual({ count: 2, nested: { unchanged: true } });
  expect(next.nested).toBe(host.initialState.nested);
  expect(built.validateState?.(next)).toBeUndefined();
  clock.mockImplementation(() => { throw new Error('replay clock'); });
  expect(built.apply(next, event!).count).toBe(4);
});

test('empty state remains stateful; mixed arrays and builder registration only mount declared state', () => {
  const transport = createAggregatePlugin('transport').commandEnvelope(() => ({ tag: 'host' })).build();
  const audit = createAggregatePlugin('audit').state(() => ({ count: 0 })).onEvent(draft => { draft.count++; }).build();
  const plugins = [transport, audit];
  const built = source().withPlugins(...plugins);
  expect(built.initialState).toEqual({ count: 0, nested: { unchanged: true }, audit: { count: 0 } });
  expect(built.apply(built.initialState, { type: 'counter.added.event', payload: 1 }).audit).toEqual({ count: 1 });
  expect(() => built.prepareCommand(source().initialState, built.commandCreators.add(1))).toThrow('namespace: audit');
  const empty = createAggregatePlugin('empty').state(() => ({})).build();
  expect(() => source().withPlugins(empty).validateState?.(source().initialState)).toThrow('namespace: empty');
  const fromBuilder = createAggregate('plain', { count: 0 }).plugins(transport).build();
  expect(fromBuilder.initialState).toEqual({ count: 0 });
  expect(fromBuilder.prepareCommand(fromBuilder.initialState, { type: 'noop', payload: {} })).toHaveProperty('tag', 'host');
});

test('identity/source checks still apply without state, including repeated decoration', () => {
  const host = source();
  const first = createAggregatePluginFor(host, 'transport').build();
  const sameId = createAggregatePlugin('transport').build();
  const built = host.withPlugins(first);
  expect(() => built.withPlugins(sameId)).toThrow('collision');
  const duplicateArray = [first, sameId];
  expect(() => host.withPlugins(...duplicateArray)).toThrow('collision');
  expect(() => source().withPlugins(first)).toThrow('Incompatible aggregate plugin source');
  expect(built.withPlugins(createAggregatePluginFor(built, 'other').build()).initialState).toBe(host.initialState);
});

test('stateless builder branches have no reducers and preserve envelope phase/parser guards', () => {
  const root = createAggregatePlugin('transport');
  expect(Reflect.get(root, 'events')).toBeUndefined();
  expect(Reflect.get(root, 'onEvent')).toBeUndefined();
  const configured = root.commandEnvelope(() => ({ value: '1' }), { parse: () => ({ value: 1 }) })
    .prepareCommand(draft => { draft.value++; }).build();
  expect(root.build().commandEnvelope).toBeUndefined();
  expect(root.state(() => ({})).build().initialize).toBeInstanceOf(Function);
  expect(() => source().withPlugins({ ...root.build(), onEvent: () => undefined })).toThrow('require declared state');
  const host = source().withPlugins(configured);
  expect(host.prepareCommand(host.initialState, host.commandCreators.add(1))).toHaveProperty('value', 1);
  const bad = createAggregatePlugin('bad').commandEnvelope(() => ({ headers: {} }) as object).build();
  const invalid = source().withPlugins(bad);
  expect(() => invalid.prepareCommand(invalid.initialState, invalid.commandCreators.add(1))).toThrow();
});

test('event-only stateless plugins prepare events without extending commands or mounting state', () => {
  const plugin = createAggregatePlugin('eventOnly')
    .eventEnvelope((_, context) => {
      expect(context.ownState).toBeUndefined();
      return { version: 1 };
    }).prepareEvent(draft => { draft.version++; }).build();
  const host = source().withPlugins(plugin);
  const command = host.prepareCommand(host.initialState, host.commandCreators.add(1));
  expect(command).not.toHaveProperty('version');
  const [event] = host.process(host.initialState, command);
  expect(event).toHaveProperty('version', 2);
  expect(host.apply(host.initialState, event!)).toEqual({ count: 1, nested: { unchanged: true } });
});
