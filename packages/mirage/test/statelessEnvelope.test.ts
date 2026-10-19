import { createAggregate, createAggregatePlugin } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createMirage, extractState, extractUncommittedEvents } from '../src';
import { createDepot, type EventStore } from '../src/Depot';

test('Mirage and Depot use stateless envelopes without changing domain state or replaying clocks', async () => {
  const clock = jest.fn(() => new Date('2026-10-19T00:00:00Z'));
  const plugin = createAggregatePlugin('transport')
    .commandEnvelope(() => ({ dateTime: clock() }))
    .eventEnvelope((_, ctx) => ({ executionDateTime: ctx.command.dateTime.toISOString() })).build();
  const built = createAggregate('counter', { count: 0 })
    .events({ added(state, event: Event<number>) { state.count += event.payload; } })
    .commands(emit => ({ add: (_state, amount: number) => emit.added(amount) })).build().withPlugins(plugin);
  const live = createMirage(built, 'one');
  await live.add(2);
  expect(extractState(live)).toEqual({ count: 2 });
  expect(extractUncommittedEvents(live)[0]).toHaveProperty('executionDateTime', '2026-10-19T00:00:00.000Z');
  const stream: Event[] = [];
  const store: EventStore = {
    async *readStream() { yield* structuredClone(stream); },
    async saveEvents(_id, events) { stream.push(...structuredClone(events)); }
  };
  const depot = createDepot(built, store);
  const persisted = await depot.get('two');
  await persisted.add(3);
  await depot.save(persisted);
  expect(clock).toHaveBeenCalledTimes(2);
  clock.mockImplementation(() => { throw new Error('replay clock'); });
  const replay = await depot.get('two');
  expect(extractState(replay)).toEqual({ count: 3 });
  expect(extractUncommittedEvents(replay)).toEqual([]);
});
