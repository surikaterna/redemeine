import type { Event } from '@redemeine/kernel';
import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '../src';
import * as data from '../src/plugins/envelopeData';

function parentBuilder() {
  return createAggregate('parent', { count: 0 }).events({
    changed(_state, _event: Event<number>) {},
    other(_state, _event: Event<number>) {}
  });
}

test('rejects erased source-bound attachments to replaced matched projectors before initialization', () => {
  const parent = parentBuilder();
  const initialize = jest.fn(() => ({}));
  const handler = jest.fn((_value: string) => undefined);
  const plugin = createAggregatePluginFor(parent.build(), 'audit').state(initialize)
    .events({ changed(_draft, event) { handler(event.payload.toFixed(2)); } }).build();
  const child = createAggregate('child', { count: 0 }).extends(parent)
    .events({ changed(_state, _event: Event<string>) {} })
    .commands(emit => ({ change: (_state, value: string) => emit.changed(value) })).build();
  expect(() => Reflect.apply(child.withPlugins, child, [plugin])).toThrow('event contract: audit.changed');
  expect(initialize).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});

test('allows inherited matched keys, renamed routes and unrelated replacements/additions', () => {
  const parent = parentBuilder();
  const plugin = createAggregatePluginFor(parent.build(), 'audit').state(() => ({ value: '' }))
    .events({ changed(draft, event) { draft.value = event.payload.toFixed(2); } }).build();
  const child = createAggregate('child', { count: 0 }).extends(parent)
    .events({ other(_state, _event: Event<string>) {}, extra() {} })
    .overrideEventNames({ changed: 'renamed.event' }).build().withPlugins(plugin);
  expect(child.apply(child.initialState, { type: 'renamed.event', payload: 2 }).audit.value).toBe('2.00');
});

test('catchall-only source plugins do not impose matched payload contracts', () => {
  const parent = parentBuilder();
  const plugin = createAggregatePluginFor(parent.build(), 'audit').state(() => ({})).onEvent(() => {}).build();
  const child = createAggregate('child', { count: 0 }).extends(parent)
    .events({ changed(_state, _event: Event<string>) {} }).build();
  expect(() => child.withPlugins(plugin)).not.toThrow();
});

test('compatible replacement projectors require rebinding because runtime payload types are erased', () => {
  const parent = parentBuilder();
  const plugin = createAggregatePluginFor(parent.build(), 'audit').state(() => ({}))
    .events({ changed(_draft, event) { event.payload.toFixed(2); } }).build();
  const child = createAggregate('child', { count: 0 }).extends(parent)
    .events({ changed(_state, _event: Event<number>) {} }).build();
  expect(() => child.withPlugins(plugin)).toThrow('bind the plugin to the host');
  const rebound = createAggregatePluginFor(child, 'audit').state(() => ({}))
    .events({ changed(_draft, event) { event.payload.toFixed(2); } }).build();
  expect(() => child.withPlugins(rebound)).not.toThrow();
});

test.each(['empty', 'unmatched', 'envelope'] as const)('%s plugins take no application snapshots without callbacks', kind => {
  const base = createAggregatePlugin('audit').state(() => ({}));
  const plugin = kind === 'unmatched' ? base.events({ other() {} }).build()
    : kind === 'envelope' ? base.eventEnvelope(() => ({ tag: 'ok' })).build() : base.build();
  const host = createAggregate('host', { date: new Date(123) }).events({ changed() {} }).plugins(plugin).build();
  const snapshot = jest.spyOn(data, 'envelopeSnapshot');
  try {
    host.apply(host.initialState, { type: 'host.changed.event', payload: null });
    expect(snapshot).not.toHaveBeenCalled();
  } finally { snapshot.mockRestore(); }
});

test('matched and catchall callbacks get separate event and post-write state snapshots', () => {
  const contexts: unknown[] = [];
  const events: unknown[] = [];
  const plugin = createAggregatePlugin('audit').state(() => ({ count: 0 })).events({
    changed(draft, event, context) { contexts.push(context); events.push(event); draft.count++; }
  }).onEvent((_draft, event, context) => { contexts.push(context); events.push(event); }).build();
  const host = createAggregate('host', {}).events({ changed() {} }).plugins(plugin).build();
  const event = { type: 'host.changed.event', payload: { value: 1 } };
  const snapshot = jest.spyOn(data, 'envelopeSnapshot');
  try {
    host.apply(host.initialState, event);
    expect(snapshot).toHaveBeenCalledTimes(4);
    expect(contexts[0]).toMatchObject({ state: { audit: { count: 0 } } });
    expect(contexts[1]).toMatchObject({ state: { audit: { count: 1 } } });
    expect(contexts[0]).not.toBe(contexts[1]);
    expect(events[0]).not.toBe(events[1]);
    expect(events[0]).not.toBe(event);
    expect(Object.isFrozen(events[0])).toBe(true);
  } finally { snapshot.mockRestore(); }
});
