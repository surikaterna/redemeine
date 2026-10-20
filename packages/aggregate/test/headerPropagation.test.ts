import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '../src';

function source() {
  return createAggregate('headers', { count: 0 })
    .events({ changed(state) { state.count++; } })
    .commands(emit => ({ change: (_state, mode: string) => ({
      ...emit.changed(), metadata: { domain: true },
      ...(mode === 'empty' ? { headers: {} } : {}),
      ...(mode === 'undefined' ? { headers: undefined } : {})
    }) })).build();
}

test.each(['absent', 'empty', 'undefined'])('inherits only absent own headers: %s', mode => {
  const base = source();
  const plugin = createAggregatePluginFor(base, 'transport').propagateCommandHeadersToEvents()
    .propagateCommandHeadersToEvents().build();
  const built = base.withPlugins(plugin, createAggregatePlugin('duplicate').propagateCommandHeadersToEvents().build());
  const headers = { principal: { user: 'one' }, nested: { value: 1 } };
  const raw = { ...built.commandCreators.change(mode), headers, id: 'command-1', aggregateId: 'one' };
  const command = built.prepareCommand(built.initialState, raw);
  headers.nested.value = 2;
  const [event] = built.process(built.initialState, command);
  expect(event!.headers).toEqual(mode === 'absent' ? { principal: { user: 'one' }, nested: { value: 1 } } : mode === 'empty' ? {} : undefined);
  expect(Object.hasOwn(event!, 'headers')).toBe(true);
  expect(event!.headers).not.toBe(command.headers);
  expect(Object.isFrozen(headers)).toBe(false);
  expect(Object.isFrozen(headers.nested)).toBe(false);
  expect(event).not.toHaveProperty('principal');
  expect(event).toMatchObject({ payload: undefined, metadata: { domain: true }, correlationId: 'command-1', aggregateId: 'one', aggregateType: 'headers' });
  expect(built.initialState).toBe(base.initialState);
  expect(built.apply(built.initialState, event!)).toEqual({ count: 1 });
  expect(event!.metadata).toEqual({ domain: true, command: { id: 'command-1', type: raw.type } });
});

test('propagation precedes every event callback, including plugins earlier in registration order', () => {
  const base = source();
  const callback = jest.fn();
  const observer = createAggregatePluginFor(base, 'observer').eventEnvelope((_, context) => {
    callback(context.event.headers);
    expect(Object.isFrozen(context.event.headers)).toBe(true);
    expect(context.ownState).toBeUndefined();
    return { observed: true };
  }).prepareEvent((_draft, context) => {
    expect(context.event.headers).toEqual({ trace: 'one' });
  }).build();
  const built = base.withPlugins(observer, createAggregatePlugin('transport').propagateCommandHeadersToEvents().build());
  const [event] = built.process(built.initialState, { ...built.commandCreators.change('absent'), headers: { trace: 'one' } });
  expect(callback).toHaveBeenCalledWith({ trace: 'one' });
  built.apply(built.initialState, event!);
  expect(callback).toHaveBeenCalledTimes(1);
});

test('no synthesis without command headers, immutable branches and stateful capability remain sound', () => {
  const root = createAggregatePlugin('transport');
  expect(root.build().propagateCommandHeadersToEvents).toBeUndefined();
  const built = source().withPlugins(root.state(() => ({ count: 0 })).propagateCommandHeadersToEvents()
    .onEvent(draft => { draft.count++; }).build());
  const [event] = built.process(built.initialState, built.commandCreators.change('absent'));
  expect(event).not.toHaveProperty('headers');
  expect(built.apply(built.initialState, event!).transport.count).toBe(1);
});

test.each(['command', 'event'] as const)('headers remain reserved in %s extensions', phase => {
  const root = createAggregatePlugin('bad').propagateCommandHeadersToEvents();
  const bad = phase === 'command' ? root.commandEnvelope(() => ({ headers: {} }) as object).build()
    : root.eventEnvelope(() => ({ headers: {} }) as object).build();
  const built = source().withPlugins(bad);
  expect(() => built.process(built.initialState, built.commandCreators.change('absent'))).toThrow('Reserved envelope extension key: headers');
});

test('an explicitly undefined prepared command header is inherited as an own undefined property', () => {
  const built = source().withPlugins(createAggregatePlugin('transport').propagateCommandHeadersToEvents().build());
  const raw = built.commandCreators.change('absent');
  Object.defineProperty(raw, 'headers', { value: undefined, enumerable: true });
  const command = built.prepareCommand(built.initialState, raw);
  const [event] = built.process(built.initialState, command);
  expect(Object.hasOwn(command, 'headers')).toBe(true);
  expect(Object.hasOwn(event!, 'headers')).toBe(true);
  expect(event!.headers).toBeUndefined();
});
