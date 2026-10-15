import { createAggregate, createAggregatePlugin } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createDemeineBridge } from '../src';

type Graph = { a: { value: number }; b: { value: number }; c: { value: number }; self?: Graph };

function definition(cyclic = false) {
  const item = { value: 7 };
  const data: Graph = { a: item, b: item, c: { value: 7 } };
  if (cyclic) data.self = data;
  const source = createAggregate('graph', { count: 0 })
    .events({ added(state, event: Event<{ amount: number }>) { state.count += event.payload.amount; } })
    .commands(emit => ({ add: (_state, payload: { amount: number }) => [emit.added(payload), emit.added(payload)] })).build();
  const plugin = createAggregatePlugin('graphAudit').state(() => ({ applied: 0 }))
    .eventEnvelope(() => ({ data, optionalDate: new Date(NaN) }))
    .onEvent((state, event) => {
      const graph: unknown = Reflect.get(event, 'data');
      if (!graph || typeof graph !== 'object') throw new Error('missing graph');
      expect(Reflect.get(graph, 'a')).toBe(Reflect.get(graph, 'b'));
      state.applied++;
    }).build();
  return source.withPlugins(plugin);
}

test('default adapter accepts unchanged optional invalid Dates', async () => {
  const built = definition();
  const live = new (createDemeineBridge(built))();
  await live._sink({ ...built.commandCreators.add({ amount: 2 }), aggregateId: live.id,
    headers: { commandSummary: { optionalDate: new Date(NaN) } } });
  expect(live._state).toEqual({ count: 4, graphAudit: { applied: 2 } });
  expect(live.getUncommittedEvents()).toHaveLength(2);
});

test.each([false, true])('structuredClone preserves prepared aliases and cycles (cyclic=%s)', async cyclic => {
  const live = new (createDemeineBridge(definition(cyclic), { envelope: event => structuredClone(event) }))();
  await live.add({ amount: 2 });
  expect(live._state).toEqual({ count: 4, graphAudit: { applied: 2 } });
  const event = live.getUncommittedEvents()[0];
  if (!event) throw new Error('missing event');
  const graph: unknown = Reflect.get(event, 'data');
  if (!graph || typeof graph !== 'object') throw new Error('missing graph');
  expect(Reflect.get(graph, 'a')).toBe(Reflect.get(graph, 'b'));
  if (cyclic) expect(Reflect.get(graph, 'self')).toBe(graph);
});

test.each(['mutate', 'erase', 'split-alias', 'collapse-alias', 'break-cycle', 'getter', 'prototype'])
('rejects second-event graph %s before any application', async mode => {
  let conversions = 0;
  const live = new (createDemeineBridge(definition(true), { envelope(event) {
    if (++conversions === 1) return structuredClone(event);
    const converted = mode === 'mutate' ? event : structuredClone(event);
    const graph: unknown = Reflect.get(converted, 'data');
    if (!graph || typeof graph !== 'object') throw new Error('missing graph');
    const item: unknown = Reflect.get(graph, 'a');
    if (!item || typeof item !== 'object') throw new Error('missing item');
    if (mode === 'mutate') Reflect.set(item, 'value', 9);
    if (mode === 'erase') Reflect.deleteProperty(graph, 'b');
    if (mode === 'split-alias') Reflect.set(graph, 'b', { value: 7 });
    if (mode === 'collapse-alias') Reflect.set(graph, 'c', item);
    if (mode === 'break-cycle') Reflect.set(graph, 'self', { a: item, b: item });
    if (mode === 'getter') Object.defineProperty(graph, 'a', { get() { throw new Error('getter invoked'); } });
    if (mode === 'prototype') Object.setPrototypeOf(graph, new Date());
    return converted;
  } }))();
  const before = live._state;
  await expect(live.add({ amount: 2 })).rejects.toThrow('Envelope must preserve');
  expect(conversions).toBe(2);
  expect(live._state).toBe(before);
  expect(live._version).toBe(0);
  expect(live.getUncommittedEvents()).toEqual([]);
});
