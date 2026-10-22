import { createAggregate, createAggregatePlugin } from '@redemeine/aggregate';
import { createDemeineBridge } from '../src';

function source() {
  return createAggregate('capability', { count: 0 })
    .events({ added(state) { state.count++; } })
    .commands(emit => ({ add: () => ({ ...emit.added({}), headers: { ordinary: true }, extra: 'domain' }) })).build();
}

test.each(['none', 'state'] as const)('inactive %s plan permits legacy adapter changes', async mode => {
  const base = source();
  const built = mode === 'state' ? base.withPlugins(createAggregatePlugin('state').state(() => ({})).build()) : base;
  expect(built.prepareCommand).toBeInstanceOf(Function);
  const prepare = jest.spyOn(built, 'prepareCommand');
  const live = new (createDemeineBridge(built, { envelope(event) {
    Reflect.deleteProperty(event, 'headers');
    Reflect.set(event, 'extra', 'adapted');
    return event;
  } }))();
  await live.add();
  expect(live._state.count).toBe(1);
  expect(live.getUncommittedEvents()[0]).not.toHaveProperty('headers');
  expect(live.getUncommittedEvents()[0]).toHaveProperty('extra', 'adapted');
  expect(prepare).not.toHaveBeenCalled();
});

test.each(['none', 'state'] as const)('inactive %s plan preserves direct command reference and routing', async mode => {
  const base = source();
  const built = mode === 'state' ? base.withPlugins(createAggregatePlugin('state').state(() => ({})).build()) : base;
  const command = { ...built.commandCreators.add(), payload: {} };
  const handler = jest.fn((_aggregate, received) => { expect(received).toBe(command); return _aggregate; });
  const live = new (createDemeineBridge(built))(null, null, { handle: handler });
  await live._process(command);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(command).not.toHaveProperty('aggregateType');
  expect(command).not.toHaveProperty('aggregateId');
});

test.each(['command', 'event', 'headers'] as const)('%s-only plan prepares routing and protects conversion', async phase => {
  const root = createAggregatePlugin('phase').state(() => ({}));
  const plugin = phase === 'command' ? root.commandEnvelope(() => ({ commandStamp: true })).build()
    : phase === 'event' ? root.eventEnvelope(() => ({ eventStamp: true })).build()
      : createAggregatePlugin('headers').eventEnvelope((_, ctx) => ({ headers: ctx.event.headers })).build();
  const built = source().withPlugins(plugin);
  const sink = jest.fn((command, aggregate) => {
    expect(command.aggregateId).toBe(aggregate.id);
    expect(command.aggregateType).toBe('capability');
    if (phase === 'command') expect(command).toHaveProperty('commandStamp', true);
    return aggregate._process(command);
  });
  const live = new (createDemeineBridge(built, { envelope(event) {
    Reflect.deleteProperty(event, phase === 'event' ? 'eventStamp' : 'headers');
    return event;
  } }))({ sink });
  await expect(live.add()).rejects.toThrow('Envelope must preserve');
  expect(sink).toHaveBeenCalledTimes(1);
  expect(live._state.count).toBe(0);
  expect(live.getUncommittedEvents()).toEqual([]);
});

test('active descriptors require a preparation method', () => {
  const built = source();
  const { prepareCommand: _prepare, ...withoutPreparation } = built;
  expect(() => createDemeineBridge({ ...withoutPreparation, aggregatePlugins: [{ eventEnvelope: {} }] }))
    .toThrow('Envelope plugins require builder.prepareCommand');
});
