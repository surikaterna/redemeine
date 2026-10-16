import type { Event } from '@redemeine/kernel';
import { createAggregate, createAggregatePluginFor } from '../src';

test('matched plugins receive null, undefined and void payloads without coercion', () => {
  const source = createAggregate('nullable', {}).events({
    nil(_state, _event: Event<null>) {},
    absent(_state, _event: Event<undefined>) {},
    nothing(_state, _event: Event<void>) {},
    changed(_state, _event: Event<{ value: number } | null>) {}
  }).build();
  const seen: unknown[] = [];
  const plugin = createAggregatePluginFor(source, 'audit').state(() => ({})).events({
    nil(_draft, event) { seen.push(event.payload); },
    absent(_draft, event) { seen.push(event.payload); },
    nothing(_draft, event) { seen.push(event.payload); },
    changed(_draft, event) { seen.push(event.payload); }
  }).build();
  const host = source.withPlugins(plugin);
  for (const [key, payload] of [['nil', null], ['absent', undefined], ['nothing', undefined], ['changed', null], ['changed', { value: 1 }]] as const) {
    host.apply(host.initialState, { type: `nullable.${key}.event`, payload });
  }
  expect(seen).toEqual([null, undefined, undefined, null, { value: 1 }]);
});

test('Date readers remain callable in event payloads and nested nullable context', () => {
  const date = new Date('2026-01-01T00:00:00.000Z');
  const source = createAggregate('dates', { nested: { date: date as Date | null } })
    .events({ changed(_state, _event: Event<{ date: Date }>) {} }).build();
  const plugin = createAggregatePluginFor(source, 'audit').state(() => ({ time: 0, iso: '' })).events({
    changed(draft, event, context) {
      draft.time = event.payload.date.getTime();
      draft.iso = context.state.nested.date?.toISOString() ?? '';
    }
  }).build();
  const host = source.withPlugins(plugin);
  expect(host.apply(host.initialState, { type: 'dates.changed.event', payload: { date } }).audit)
    .toEqual({ time: date.getTime(), iso: date.toISOString() });
});
