import { createAggregate } from '@redemeine/aggregate';
import { createDemeineBridge, type CommandSink } from '../src';

test('correlated shortcuts forward both argument tuples and preserve the creator receiver', async () => {
  const built = createAggregate('correlated', {}).events({}).commands(() => ({ go: () => [] })).build();
  const observed = jest.fn();
  const creators = {
    go(...args: ['a', { a: number }] | ['b', { b: string }]) {
      observed(this, args);
      return { ...built.commandCreators.go(), payload: args[1] };
    },
  };
  const sink: CommandSink<{}> = { sink: jest.fn((command, aggregate) => aggregate._process(command)) };
  const caller = new (createDemeineBridge({ ...built, commandCreators: creators }))(sink);
  const a = { a: 1 };
  const b = { b: 'ok' };
  await expect(caller.go('a', a)).resolves.toBe(caller);
  await expect(caller.go('b', b)).resolves.toBe(caller);
  expect(observed.mock.calls).toEqual([[creators, ['a', a]], [creators, ['b', b]]]);
  expect(observed.mock.calls[0]![0]).toBe(creators);
  expect(observed.mock.calls[1]![0]).toBe(creators);
  const calls = jest.mocked(sink.sink).mock.calls;
  expect(calls.map(([command]) => command.payload)).toEqual([a, b]);
  expect(calls[0]![0].payload).toBe(a);
  expect(calls[1]![0].payload).toBe(b);
});
