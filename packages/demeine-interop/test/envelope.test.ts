import type { CommandSink } from 'demeine';
import { createDemeineBridge, type BridgeEvent } from '../src';
import { definition } from './fixture';

test('builder metadata and post-sink command reach one envelope conversion', async () => {
  const built = definition();
  const envelope = jest.fn((event: BridgeEvent) => structuredClone(event));
  const Bridge = createDemeineBridge(built, { envelope });
  const aggregate = new Bridge();
  const command = {
    ...built.commandCreators.add(2), id: 'command-id', aggregateId: aggregate.id,
    headers: { commandSummary: { safe: true }, commandStoreRef: 'commands/1', other: 'private' },
  };
  await aggregate._sink(command);
  const [event] = aggregate.getUncommittedEvents();
  expect(event).toMatchObject({
    aggregateId: aggregate.id, correlationId: 'command-id',
    metadata: { sibling: 'kept', command: { id: 'command-id', type: command.type, summary: { safe: true }, storeRef: 'commands/1' } },
  });
  expect(envelope).toHaveBeenCalledTimes(1);
  expect(envelope.mock.calls[0]![0].id).toBe(event!.id);
  expect(envelope).toHaveBeenCalledWith(expect.anything(), command, aggregate);
  const replay = new Bridge();
  replay.id = aggregate.id;
  await replay._rehydrate([event!]);
  expect(envelope).toHaveBeenCalledTimes(1);
  expect(Object.keys(envelope.mock.calls[0]![0].metadata!.command!)).toEqual(['id', 'type', 'summary', 'storeRef']);
});

test('sink header reset is authoritative; no erased summary/storeRef recovered', async () => {
  const built = definition();
  const sink: CommandSink = { sink(command, aggregate) {
    Object.assign(command, { headers: {} });
    return aggregate._process(command);
  } };
  const Bridge = createDemeineBridge(built);
  const aggregate = new Bridge(sink);
  await aggregate._sink({ ...built.commandCreators.add(1), aggregateId: aggregate.id, headers: { commandSummary: 'lost', commandStoreRef: 'lost' } });
  expect(aggregate.getUncommittedEvents()[0]).toMatchObject({ metadata: { command: { id: expect.any(String), type: 'counter.add.command' } } });
  expect(Reflect.get(aggregate.getUncommittedEvents()[0]!, 'metadata').command).not.toHaveProperty('summary');
  expect(Reflect.get(aggregate.getUncommittedEvents()[0]!, 'metadata').command).not.toHaveProperty('storeRef');
});

test('raw/replayed events gain no synthesized command metadata', async () => {
  const built = definition();
  built.process = () => [{ id: 'raw', type: 'counter.added.event', payload: { amount: 1 } }];
  const Bridge = createDemeineBridge(built);
  const aggregate = new Bridge();
  await aggregate.add(1);
  expect(aggregate.getUncommittedEvents()[0]).not.toHaveProperty('metadata');
  const raw = { type: 'counter.added.event', aggregateId: aggregate.id, payload: { amount: 2 } };
  await aggregate._rehydrate([raw]);
  expect(raw).not.toHaveProperty('metadata');
});

test.each(['id', 'aggregateId', 'correlationId', 'metadata'])('envelope cannot discard %s', async field => {
  const Bridge = createDemeineBridge(definition(), { envelope(event) {
    Reflect.deleteProperty(event, field);
    return event;
  } });
  const aggregate = new Bridge();
  await expect(aggregate.add(1)).rejects.toThrow('preserve');
  expect(aggregate.getVersion()).toBe(0);
});

test('metadata nested mutation is rejected before event application', async () => {
  const Bridge = createDemeineBridge(definition(), { envelope(event) {
    Reflect.set(event.metadata!.command!, 'type', 'changed.command');
    return event;
  } });
  const aggregate = new Bridge();
  await expect(aggregate.add(1)).rejects.toThrow('preserve');
  expect(aggregate._state.count).toBe(0);
});

test('inspectable hooks/plugins and even empty declared intents are unsupported', async () => {
  for (const unsupported of [{ hooks: { afterCommit() {} } }, { plugins: [{}] }]) {
    expect(() => createDemeineBridge({ ...definition(), ...unsupported })).toThrow('hooks or plugins');
  }
  for (const intents of [{}, [], { work: [] }]) {
    const built = definition();
    const process = built.process;
    built.process = (state, command) => Object.defineProperty(process(state, command), '__intents', { value: intents });
    const Bridge = createDemeineBridge(built);
    const aggregate = new Bridge();
    await expect(aggregate.add(1)).rejects.toThrow('intents');
    expect(aggregate.getVersion()).toBe(0);
    expect(aggregate._state.count).toBe(0);
  }
});

test('envelope cannot replace an opaque summary with an empty object', async () => {
  const built = definition();
  const Bridge = createDemeineBridge(built, { envelope(event) {
    Reflect.set(event.metadata!.command!, 'summary', {});
    return event;
  } });
  const aggregate = new Bridge();
  const command = { ...built.commandCreators.add(1), aggregateId: aggregate.id, headers: { commandSummary: new Map([['key', 'value']]) } };
  await expect(aggregate._sink(command)).rejects.toThrow('preserve');
  expect(aggregate.getVersion()).toBe(0);
});
