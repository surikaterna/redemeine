import { createAggregate, createAggregatePluginFor } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createDemeineBridge } from '../src';

function definition(calls: string[]) {
  const source = createAggregate('counter', { count: 0 })
    .events({ added(state, event: Event<{ amount: number }>) { calls.push('domain'); state.count += event.payload.amount; } })
    .commands(emit => ({ add: (_state, payload: { amount: number }) => emit.added(payload) })).build();
  const audit = createAggregatePluginFor(source, 'audit').state(() => ({ seen: [] as number[], all: 0 }))
    .events({ added(draft, event, context) {
      calls.push(`matched:${context.state.count}`); draft.seen.push(event.payload.amount);
    } }).onEvent(draft => { calls.push('all'); draft.all++; }).build();
  return source.withPlugins(audit);
}

test('bridge shortcuts and replay use Aggregate.apply once with independent plugin state', async () => {
  const calls: string[] = [];
  const built = definition(calls);
  const Bridge = createDemeineBridge(built);
  const live = new Bridge();
  const other = new Bridge();
  await live.add({ amount: 2 });
  expect(calls).toEqual(['domain', 'matched:2', 'all']);
  const events = await live.getUncommittedEventsAsync();
  expect(events).toHaveLength(1);
  calls.length = 0;
  const replayed = new Bridge();
  replayed.id = live.id;
  for (const event of events) replayed._apply(event, false);
  expect(calls).toEqual(['domain', 'matched:2', 'all']);
  expect(replayed._state).toEqual(live._state);
  expect(replayed.getUncommittedEvents()).toEqual([]);
  expect(other._state.audit).toEqual({ seen: [], all: 0 });
  expect(built.initialState.audit).toEqual({ seen: [], all: 0 });
  live.clearUncommittedEvents();
  expect(live._state.audit.all).toBe(1);
});

test('bridge still rejects unsupported lifecycle hooks and persistence plugins', () => {
  const built = definition([]);
  expect(() => createDemeineBridge({ ...built, hooks: { onBeforeCommand() {} } })).toThrow('hooks or plugins');
  expect(() => createDemeineBridge(built.withPlugins({ key: 'persist', onAfterCommit() {} })))
    .toThrow('hooks or plugins');
});
