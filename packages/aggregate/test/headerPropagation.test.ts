import { createAggregate, createAggregatePlugin, createAggregatePluginFor, type AggregateEventPlugin } from '../src';

function source() {
  return createAggregate('headers', { count: 0 })
    .events({ changed(state) { state.count++; } })
    .commands(emit => ({ change: (_state, mode: string) => ({
      ...emit.changed(), metadata: { domain: true },
      ...(mode === 'empty' ? { headers: {} } : {}),
      ...(mode === 'undefined' ? { headers: undefined } : {})
    }) })).build();
}

test.each(['absent', 'empty', 'undefined'])('plugin chooses presence-based fallback: %s', mode => {
  const base = source();
  const plugin = createAggregatePluginFor(base, 'transport').eventEnvelope((_, { event, command }) => ({
    headers: Object.hasOwn(event, 'headers') ? event.headers : command.headers
  })).build();
  const built = base.withPlugins(plugin);
  const headers = { principal: { user: 'one' }, nested: { value: 1 } };
  const raw = { ...built.commandCreators.change(mode), headers, id: 'command-1', aggregateId: 'one' };
  const command = built.prepareCommand(built.initialState, raw);
  headers.nested.value = 2;
  const [event] = built.process(built.initialState, command);
  expect(event!.headers).toEqual(mode === 'absent' ? { principal: { user: 'one' }, nested: { value: 1 } } : mode === 'empty' ? {} : undefined);
  expect(Object.hasOwn(event!, 'headers')).toBe(true);
  expect(event!.headers).not.toBe(command.headers);
  expect(Object.isFrozen(headers.nested)).toBe(false);
  expect(event).not.toHaveProperty('principal');
  expect(event).toMatchObject({ metadata: { domain: true }, correlationId: 'command-1', aggregateId: 'one', aggregateType: 'headers' });
  expect(built.initialState).toBe(base.initialState);
  expect(built.apply(built.initialState, event!)).toEqual({ count: 1 });
  expect(event!.metadata).toEqual({ domain: true, command: { id: 'command-1', type: raw.type } });
});

test('registration order is visible, recipe drafts headers without installing its own output early', () => {
  const base = source();
  const seen: unknown[] = [];
  const before = createAggregatePlugin('before').eventEnvelope((_, ctx) => { seen.push(ctx.event.headers); return {}; }).build();
  const external = { traceId: 'one' };
  const writer = createAggregatePlugin('writer').eventEnvelope(() => ({ headers: external }))
    .prepareEvent((draft, ctx) => {
      expect(ctx.event.headers).toBeUndefined();
      draft.headers.traceId = 'two';
    }).build();
  const after = createAggregatePlugin('after').eventEnvelope((_, ctx) => { seen.push(ctx.event.headers); return {}; }).build();
  const built = base.withPlugins(before, writer, after);
  const [event] = built.process(built.initialState, built.commandCreators.change('absent'));
  expect(seen).toEqual([undefined, { traceId: 'two' }]);
  expect(event!.headers).toEqual({ traceId: 'two' });
  expect(external).toEqual({ traceId: 'one' });
  expect(Object.isFrozen(external)).toBe(false);
  built.apply(built.initialState, event!);
  expect(seen).toHaveLength(2);
});

test('writer may replace raw headers; header-free plugins do not copy command headers', () => {
  const base = source();
  const untouched = base.withPlugins(createAggregatePlugin('none').eventEnvelope(() => ({})).build());
  const [plain] = untouched.process(untouched.initialState, { ...base.commandCreators.change('absent'), headers: { traceId: 'command' } });
  expect(plain).not.toHaveProperty('headers');
  const built = base.withPlugins(createAggregatePluginFor(base, 'stateful').state(() => ({ count: 0 }))
    .eventEnvelope(() => ({ headers: undefined })).onEvent(draft => { draft.count++; }).build());
  const [event] = built.process(built.initialState, base.commandCreators.change('empty'));
  expect(Object.hasOwn(event!, 'headers')).toBe(true);
  expect(event!.headers).toBeUndefined();
  expect(built.apply(built.initialState, event!).stateful.count).toBe(1);
});

test.each([undefined, {}])('second own header writer collides even for %p', headers => {
  const built = source().withPlugins(
    createAggregatePlugin('first').eventEnvelope(() => ({ headers })).build(),
    createAggregatePlugin('second').eventEnvelope(() => ({ headers })).build()
  );
  expect(() => built.process(built.initialState, built.commandCreators.change('absent'))).toThrow('collision: headers');
});

test.each([null, [], () => 1, new Date(), { trace: () => 1 },
  Object.defineProperty({}, 'trace', { get() { throw new Error('invoked'); }, enumerable: true }),
  Object.defineProperty({}, 'trace', { value: 'hidden' })
])('rejects unsupported event header output case %#', headers => {
  const built = source().withPlugins(createAggregatePlugin('bad').eventEnvelope(() => ({ headers }) as object).build());
  expect(() => built.process(built.initialState, built.commandCreators.change('absent'))).toThrow();
});

test.each(['headers', 'id', 'metadata', 'payload', 'aggregateId', 'prototype'])('command extension still reserves %s', key => {
  const built = source().withPlugins(createAggregatePlugin('bad').commandEnvelope(() => ({ [key]: {} }) as object).build());
  expect(() => built.process(built.initialState, built.commandCreators.change('absent'))).toThrow('Reserved envelope extension key');
});

test('untyped conditional output only claims writer ownership when it actually owns headers', () => {
  const built = source().withPlugins(
    createAggregatePlugin('conditional').eventEnvelope(() => ({}) as object).build(),
    createAggregatePlugin('writer').eventEnvelope(() => ({ headers: undefined })).build()
  );
  expect(built.process(built.initialState, built.commandCreators.change('absent'))[0]).toHaveProperty('headers', undefined);
});

test('only final published output claims the header slot', () => {
  const built = source().withPlugins(
    createAggregatePlugin('stripped').eventEnvelope(() => ({ headers: {} }), { parse: () => ({ observed: true }) }).build(),
    createAggregatePlugin('parsed').eventEnvelope(() => ({}), { parse: () => ({ headers: undefined }) }).build()
  );
  const [event] = built.process(built.initialState, built.commandCreators.change('empty'));
  expect(event).toMatchObject({ observed: true });
  expect(Object.hasOwn(event!, 'headers')).toBe(true);
  expect(event!.headers).toBeUndefined();
});

test('empty writer arrays and absent descriptors preserve raw headers until a guaranteed writer runs', () => {
  const base = createAggregate('raw', {}).commands(() => ({
    go: () => ({ type: 'changed', payload: {}, headers: { traceId: 123 } })
  })).build();
  const writer = createAggregatePlugin('writer').eventEnvelope(() => ({ headers: { traceId: 'validated' } })).build();
  const possibleWriters: (typeof writer)[] = [];
  const absent: AggregateEventPlugin<'absent', undefined, undefined, {}, { headers: { other: boolean } }> = {
    ...createAggregatePlugin('absent').build(), eventEnvelope: undefined
  };
  const possible = base.withPlugins(...possibleWriters);
  const optional = base.withPlugins(absent);
  for (const host of [possible, optional, possible.withPlugins(absent)]) {
    expect(host.process({}, base.commandCreators.go())[0]!.headers).toEqual({ traceId: 123 });
  }
  for (const host of [possible.withPlugins(writer), optional.withPlugins(writer), base.withPlugins(writer).withPlugins(absent)]) {
    expect(host.process({}, base.commandCreators.go())[0]!.headers).toEqual({ traceId: 'validated' });
  }
});

test('header parser validates initializer and recipe output, not raw wire headers', () => {
  const parse = jest.fn((value: unknown) => {
    const headers: unknown = Reflect.get(value as object, 'headers');
    if (!headers || typeof headers !== 'object' || typeof Reflect.get(headers, 'traceId') !== 'string') throw new Error('Invalid trace');
    return { headers: { traceId: String(Reflect.get(headers, 'traceId')).trim() } };
  });
  const built = source().withPlugins(createAggregatePlugin('parsed')
    .eventEnvelope(() => ({ headers: { traceId: ' one ' } }), { parse })
    .prepareEvent(draft => { draft.headers.traceId += ' two '; }).build());
  const [event] = built.process(built.initialState, built.commandCreators.change('empty'));
  expect(event!.headers).toEqual({ traceId: 'one two' });
  expect(parse).toHaveBeenCalledTimes(2);
  expect(parse.mock.calls[0]![0]).toEqual({ headers: { traceId: ' one ' } });
});

test.each(['initializer', 'parser', 'recipe'])('header guards apply to %s output', phase => {
  const root = createAggregatePlugin('bad');
  const plugin = phase === 'initializer'
    ? root.eventEnvelope(() => ({ headers: null }) as object, { parse: () => ({ headers: {} }) }).build()
    : phase === 'parser'
      ? root.eventEnvelope(() => ({}), { parse: (): object => ({ headers: [] }) }).build()
      : root.eventEnvelope(() => ({ headers: {} })).prepareEvent(draft => { Reflect.set(draft, 'headers', null); }).build();
  const built = source().withPlugins(plugin);
  expect(() => built.process(built.initialState, built.commandCreators.change('absent'))).toThrow('Event headers');
});

test.each(['id', 'type', 'payload', 'metadata', 'aggregateId', 'aggregateType', 'correlationId', 'causationId',
  'address', 'correlation', 'then', '__proto__', 'constructor', 'prototype', 'toString'])('event header writers still reserve %s', key => {
  const built = source().withPlugins(createAggregatePlugin('bad')
    .eventEnvelope((): object => Object.fromEntries([['headers', {}], [key, 1]])).build());
  expect(() => built.process(built.initialState, built.commandCreators.change('absent'))).toThrow('Reserved');
});
