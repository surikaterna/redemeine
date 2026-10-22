import { createAggregate } from '@redemeine/aggregate';
import { Contract, ContractError, type Event } from '@redemeine/kernel';
import type { CommandSink } from 'demeine';
import { z } from 'zod';
import { createDemeineBridge } from '../src';

function definition(contract?: Contract) {
  const observed = jest.fn();
  const pack = jest.fn((_reason: string) => undefined);
  const objectPack = jest.fn((payload: { amount: number }) => payload);
  const builder = createAggregate('counter', { count: 0 })
    .events({ changed: (state, event: Event<{ amount: number }>) => { state.count += event.payload.amount; } })
    .commands(emit => ({
      confirm: () => { observed(); return { ...emit.changed({ amount: 1 }), metadata: { sibling: 'kept' } }; },
      packed: { pack, handler: () => emit.changed({ amount: 2 }) },
      object: { pack: objectPack, handler: (_state: unknown, payload: { amount: number }) => emit.changed(payload) },
    }));
  if (contract) builder.contract(contract);
  return { built: builder.build(), observed, pack, objectPack };
}

function forwardingSink(): CommandSink {
  return { sink: jest.fn((command, aggregate) => aggregate._process(command)) };
}

test.each([false, true])('zero-argument shortcut preserves its creator envelope (omitted payload=%s)', async omitted => {
  const { built } = definition();
  const native = built.commandCreators.confirm();
  expect(native.payload).toBeUndefined();
  const command = { ...native, headers: { commandSummary: 'confirm', commandStoreRef: 'commands/1' }, metadata: { extra: 'kept' } };
  if (omitted) Reflect.deleteProperty(command, 'payload');
  Object.freeze(command);
  const creator = jest.fn(() => command);
  const process = jest.spyOn(built, 'process');
  const Bridge = createDemeineBridge({ ...built, commandCreators: { ...built.commandCreators, confirm: creator } });
  const sink = forwardingSink();
  const aggregate = new Bridge(sink);
  await expect(aggregate.confirm()).resolves.toBe(aggregate);
  expect(creator).toHaveBeenCalledTimes(1);
  expect(creator).toHaveBeenCalledWith({});
  expect(sink.sink).toHaveBeenCalledTimes(1);
  expect(process).toHaveBeenCalledTimes(1);
  const forwarded = process.mock.calls[0]![1];
  expect(forwarded).not.toBe(command);
  expect(forwarded).toMatchObject({ id: command.id, payload: {}, headers: command.headers, metadata: command.metadata });
  expect(sink.sink).toHaveBeenCalledWith(forwarded, aggregate);
  expect(command.payload).toBeUndefined();
  expect(command).not.toHaveProperty('aggregateId');
  expect(aggregate.getUncommittedEvents()[0]).toMatchObject({ correlationId: command.id, metadata: {
    sibling: 'kept', command: { id: command.id, type: command.type, summary: 'confirm', storeRef: 'commands/1' },
  } });
  expect(aggregate._state.count).toBe(1);
  expect(aggregate.getVersion()).toBe(1);
});

test('empty-compatible required objects default before the creator; required payloads remain intact', async () => {
  const confirm = jest.fn((payload: { reason?: string }) => payload);
  const register = jest.fn((payload: { id: string }) => payload);
  const built = createAggregate('payment', {})
    .events({})
    .commands(() => ({
      confirm: { pack: confirm, handler: () => [] },
      register: { pack: register, handler: () => [] },
    })).build();
  const aggregate = new (createDemeineBridge(built))();
  await aggregate.confirm();
  await aggregate.confirm({ reason: 'ok' });
  const payload = { id: 'payment/1' };
  await aggregate.register(payload);
  expect(confirm.mock.calls).toEqual([[{}], [{ reason: 'ok' }]]);
  expect(register).toHaveBeenCalledWith(payload);
});

test('optional/defaulted packs distinguish no arguments from explicit undefined and preserve supplied values', async () => {
  const fallback = { reason: 'default' };
  const pack = jest.fn((payload: { reason?: string } = fallback) => payload);
  const built = createAggregate('payment', {}).events({})
    .commands(() => ({ optional: { pack, handler: () => [] } })).build();
  const sink = forwardingSink();
  const aggregate = new (createDemeineBridge(built))(sink);
  await aggregate.optional();
  await aggregate.optional(undefined);
  const supplied = { reason: 'supplied' };
  await aggregate.optional(supplied);
  expect(pack.mock.calls).toEqual([[{}], [undefined], [supplied]]);
  expect(jest.mocked(sink.sink).mock.calls.map(([command]) => command.payload)).toEqual([{}, fallback, supplied]);
});

test('multi-argument packs preserve argument count, explicit undefined and object identity', async () => {
  const pack = jest.fn((id: string, options?: { reason: string }) => ({ id, options }));
  const built = createAggregate('payment', {}).events({})
    .commands(() => ({ multiple: { pack, handler: () => [] } })).build();
  const aggregate = new (createDemeineBridge(built))();
  const options = { reason: 'ok' };
  await aggregate.multiple('payment/1', options);
  await aggregate.multiple('payment/2', undefined);
  expect(pack.mock.calls).toEqual([['payment/1', options], ['payment/2', undefined]]);
  expect(pack.mock.calls[0]![1]).toBe(options);
});

test('ordinary no-arg and intentionally undefined packing keep queue/drain and return the aggregate', async () => {
  const { built, pack } = definition();
  const process = jest.spyOn(built, 'process');
  const Bridge = createDemeineBridge(built);
  const sink = forwardingSink();
  const aggregate = new Bridge(sink);
  const first = aggregate.confirm();
  const second = aggregate.packed('ignored by pack');
  const drained = aggregate.getUncommittedEventsAsync();
  await expect(first).resolves.toBe(aggregate);
  await expect(second).resolves.toBe(aggregate);
  expect(await drained).toHaveLength(2);
  expect(sink.sink).toHaveBeenCalledTimes(2);
  expect(pack).toHaveBeenCalledTimes(1);
  expect(pack).toHaveBeenCalledWith('ignored by pack');
  const payloads = process.mock.calls.map(([, command]) => command.payload);
  expect(payloads).toEqual([{}, {}]);
  expect(payloads[0]).not.toBe(payloads[1]);
  expect(aggregate._state.count).toBe(3);
});

test('zero-argument creators accept empty legacy objects and explicit undefined', async () => {
  const built = definition().built;
  const creator = jest.fn(built.commandCreators.confirm);
  const aggregate = new (createDemeineBridge({ ...built, commandCreators: { ...built.commandCreators, confirm: creator } }))();
  await aggregate.confirm({});
  await aggregate.confirm(undefined);
  expect(creator.mock.calls).toEqual([[{}], [undefined]]);
});

test('explicit undefined reaches an optional pack before undefined-result normalization', async () => {
  const pack = jest.fn((payload?: { reason: string }) => payload);
  const built = createAggregate('payment', {}).events({})
    .commands(() => ({ optional: { pack, handler: () => [] } })).build();
  const sink = forwardingSink();
  const aggregate = new (createDemeineBridge(built))(sink);
  await aggregate.optional(undefined);
  expect(pack).toHaveBeenCalledWith(undefined);
  expect(jest.mocked(sink.sink).mock.calls[0]![0].payload).toEqual({});
});

test('custom object packing retains shared payload identity', async () => {
  const { built, objectPack } = definition();
  const process = jest.spyOn(built, 'process');
  const payload = Object.freeze({ amount: 4 });
  const Bridge = createDemeineBridge(built);
  const sink = forwardingSink();
  const aggregate = new Bridge(sink);
  await expect(aggregate.object(payload)).resolves.toBe(aggregate);
  expect(objectPack).toHaveBeenCalledTimes(1);
  expect(objectPack).toHaveBeenCalledWith(payload);
  expect(process.mock.calls[0]![1].payload).toBe(payload);
  expect(aggregate.getUncommittedEvents()[0]!.payload).toBe(payload);
  expect(sink.sink).toHaveBeenCalledTimes(1);
});

test.each([null, 1, false, 'invalid'])('null/scalar pack output %p still fails before the sink', payload => {
  const built = createAggregate('counter', { count: 0 })
    .events({ changed: (_state, _event: Event<object>) => {} })
    .commands(emit => ({ invalid: { pack: () => payload, handler: () => emit.changed({}) } }))
    .build();
  const Bridge = createDemeineBridge(built);
  const sink = forwardingSink();
  expect(() => new Bridge(sink).invalid()).toThrow('Legacy messages require object payloads');
  expect(sink.sink).not.toHaveBeenCalled();
});

test.each([null, 1, false, 'invalid'])('explicit malformed shortcut argument %p is not rewritten', payload => {
  const Bridge = createDemeineBridge(definition().built);
  const sink = forwardingSink();
  const aggregate = new Bridge(sink);
  expect(() => Reflect.apply(aggregate.confirm, aggregate, [payload])).toThrow('Legacy messages require object payloads');
  expect(sink.sink).not.toHaveBeenCalled();
});

test('the attached object contract sees the same canonical payload as the legacy sink', async () => {
  const contract = new Contract().addCommand('counter.confirm.command', z.strictObject({}));
  const { built, observed } = definition(contract);
  const process = jest.spyOn(built, 'process');
  const Bridge = createDemeineBridge(built);
  const sink = forwardingSink();
  const aggregate = new Bridge(sink);
  await expect(aggregate.confirm()).resolves.toBe(aggregate);
  expect(observed).toHaveBeenCalledTimes(1);
  expect(process.mock.calls[0]![1].payload).toEqual({});
  expect(sink.sink).toHaveBeenCalledWith(process.mock.calls[0]![1], aggregate);
});

test('void-only contracts are not bypassed or secretly given a different payload from the sink', async () => {
  const contract = new Contract().addCommand('counter.confirm.command', z.void());
  const { built, observed } = definition(contract);
  expect(built.process(built.initialState, built.commandCreators.confirm())).toHaveLength(1);
  observed.mockClear();
  const Bridge = createDemeineBridge(built);
  const sink = forwardingSink();
  const aggregate = new Bridge(sink);
  await expect(aggregate.confirm()).rejects.toThrow(ContractError);
  expect(sink.sink).toHaveBeenCalledTimes(1);
  expect(observed).not.toHaveBeenCalled();
  expect(aggregate.getVersion()).toBe(0);
  expect(await aggregate.getUncommittedEventsAsync()).toEqual([]);
});
