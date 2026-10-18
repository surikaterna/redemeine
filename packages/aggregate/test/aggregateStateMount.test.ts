import { immerable, produce } from 'immer';
import type { Event } from '@redemeine/kernel';
import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '../src';

test('mounting shares untouched branches and initializes only new registrations', () => {
  const template = { domain: { values: [1] }, untouched: { value: 2 }, fn: () => 3 };
  const source = createAggregate('sharing', template).events({
    changed(draft, event: Event<number>) { draft.domain.values.push(event.payload); }
  }).build();
  expect(source.initialState).toBe(template);
  expect(Object.isFrozen(template)).toBe(false);
  let calls = 0;
  const plugin = createAggregatePluginFor(source, 'audit').state(() => {
    calls++;
    return { values: [] as number[] };
  }).events({ changed(draft, event) { draft.values.push(event.payload); } }).build();
  const first = source.withPlugins(plugin);
  const second = first.withPlugins(createAggregatePlugin('next').state(() => ({ count: 0 })).build());
  const independent = source.withPlugins(plugin);
  expect(calls).toBe(2);
  expect(first.initialState).not.toBe(template);
  expect(second.initialState).not.toBe(first.initialState);
  expect(second.initialState.domain).toBe(template.domain);
  expect(second.initialState.audit).toBe(first.initialState.audit);
  expect(independent.initialState.audit).not.toBe(first.initialState.audit);
  expect(first.initialState.fn).toBe(template.fn);
  expect(Object.isFrozen(template.domain)).toBe(true);
  const event = { type: 'sharing.changed.event', payload: 4 };
  const result = second.apply(second.initialState, event);
  expect(result.domain).not.toBe(template.domain);
  expect(result.audit).not.toBe(first.initialState.audit);
  expect(result.untouched).toBe(template.untouched);
  expect(result.next).toBe(second.initialState.next);
  expect(template.domain.values).toEqual([1]);
  expect(first.initialState.audit.values).toEqual([]);
  expect(produce(second.initialState, draft => second.applyToDraft(draft, event))).toEqual(result);
});

test('Immer-compatible class roots retain their prototype and methods', () => {
  class Model {
    [immerable] = true;
    count = 0;
    read() { return this.count; }
  }
  const template = new Model();
  const source = createAggregate('class', template).events({ changed(draft) { draft.count++; } }).build();
  const plugin = createAggregatePluginFor(source, 'audit').state(() => ({ count: 0 })).events({
    changed(draft, _event, context) { draft.count = context.state.read(); }
  }).build();
  const host = source.withPlugins(plugin);
  expect(host.initialState).toBeInstanceOf(Model);
  expect(host.initialState.read).toBe(template.read);
  expect(host.apply(host.initialState, { type: 'class.changed.event', payload: null }).read()).toBe(1);
  expect(host.apply(host.initialState, { type: 'class.changed.event', payload: null }).audit.count).toBe(1);
  expect(template.count).toBe(0);
});

test('empty and legacy-only attachments preserve object and array state identity', () => {
  const source = createAggregate('identity', { values: [1] }).build();
  expect(source.withPlugins().initialState).toBe(source.initialState);
  const array = createAggregate('array', [1, 2]).build();
  expect(array.withPlugins().initialState).toBe(array.initialState);
  expect(array.withPlugins({ key: 'legacy' }).initialState).toBe(array.initialState);
});

test('invalid registrations fail before initialization and non-draftable roots fail naturally', () => {
  let calls = 0;
  const plugin = createAggregatePlugin('audit').state(() => { calls++; return {}; }).build();
  const host = createAggregate('collision', { audit: {} }).build();
  // @ts-expect-error exercise runtime collision validation
  expect(() => host.withPlugins(plugin)).toThrow('collision');
  expect(calls).toBe(0);
  class Unsupported { count = 0; }
  expect(() => createAggregate('unsupported', new Unsupported()).build().withPlugins(plugin)).toThrow('draftable');
  expect(calls).toBe(0);
});
