import { produce } from 'immer';
import type { Event } from '@redemeine/kernel';
import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '../src';

function source() {
  return createAggregate('order', { amount: 0 })
    .events({ added(state, event: Event<number>) { state.amount += event.payload; } })
    .commands(emit => ({ add: (_state, payload: number) => emit.added(payload) }))
    .onUnmatchedEvent(() => {}).build();
}

describe('Aggregate event plugin attachment', () => {
  test.each([1, null, undefined, 'invalid', false])('rejects invalid JS initializer %s atomically', value => {
    const host = source();
    const first = jest.fn(() => ({ nested: { count: 0 } }));
    const last = jest.fn(() => value);
    // Intentional JS boundary: the public object constraint cannot protect runtime callers.
    const invalid = last as unknown as () => object;
    const good = createAggregatePlugin('first').state(first).build();
    const bad = createAggregatePlugin('last').state(invalid).build();
    expect(first).not.toHaveBeenCalled();
    expect(last).not.toHaveBeenCalled();
    let returned: unknown;
    expect(() => { returned = host.withPlugins(good, bad); }).toThrow(/plugin last initializer must return a non-null object/);
    expect(returned).toBeUndefined();
    expect(first).toHaveBeenCalledTimes(1);
    expect(last).toHaveBeenCalledTimes(1);
    expect(host.initialState).toEqual({ amount: 0 });
    expect(host.aggregatePlugins).toEqual([]);
    expect(host.withPlugins(good).initialState.first).toEqual({ nested: { count: 0 } });
  });

  test('array plugin state remains a valid object and receives nested Immer drafts', () => {
    const initialize = jest.fn(() => [{ nested: { count: 0 } }]);
    const plugin = createAggregatePlugin('list').state(initialize)
      .onEvent(draft => { draft[0]!.nested.count++; draft.push({ nested: { count: 2 } }); }).build();
    expect(initialize).not.toHaveBeenCalled();
    const host = source().withPlugins(plugin);
    expect(initialize).toHaveBeenCalledTimes(1);
    const next = host.apply(host.initialState, { type: 'order.added.event', payload: 1 });
    expect(next.list).toEqual([{ nested: { count: 1 } }, { nested: { count: 2 } }]);
    expect(host.initialState.list).toEqual([{ nested: { count: 0 } }]);
  });

  test('no-op and legacy-only decoration preserve array state shape and reference', () => {
    const initialState: number[] = [];
    const array = createAggregate('array', initialState)
      .events({ added(state, event: Event<number>) { state.push(event.payload); } }).build();
    const legacy = { key: 'legacy' };
    for (const host of [array.withPlugins(), array.withPlugins(legacy)]) {
      expect(host.initialState).toBe(array.initialState);
      expect(Array.isArray(host.initialState)).toBe(true);
      expect(host.apply(host.initialState, { type: 'array.added.event', payload: 2 })).toEqual([2]);
      expect(produce(host.initialState, draft => host.applyToDraft(draft, { type: 'array.added.event', payload: 3 }))).toEqual([3]);
    }
    const builder = createAggregate('array', initialState).plugins(legacy)
      .events({ added(state, event: Event<number>) { state.push(event.payload); } }).build();
    expect(builder.initialState).toBe(initialState);
    expect(builder.apply(builder.initialState, { type: 'array.added.event', payload: 4 })).toEqual([4]);
    const plugin = createAggregatePlugin('audit').state(() => ({})).build();
    expect(() => array.withPlugins(plugin)).toThrow('require object aggregate state');
  });

  test('domain then matched then catchall; immutable decoration and replay', () => {
    const Order = source();
    const calls: string[] = [];
    let initialized = 0;
    const totals = createAggregatePluginFor(Order, 'totals').state(() => {
      initialized++;
      return { sum: 0 };
    }).events({ added(draft, event, context) {
      calls.push(`matched:${context.aggregateType}:${context.state.amount}`);
      draft.sum += event.payload;
    } }).onEvent(draft => { calls.push(`all:${draft.sum}`); }).build();
    expect(initialized).toBe(0);
    const decorated = Order.withPlugins(totals);
    const twice = decorated.withPlugins(createAggregatePlugin('audit').state(() => ({ count: 0 }))
      .onEvent(draft => { calls.push('audit'); draft.count++; }).build());
    expect(initialized).toBe(1);
    expect(Order.initialState).toEqual({ amount: 0 });
    expect(twice.commandCreators).toBe(Order.commandCreators);
    expect(twice.mounts).toBe(Order.mounts);
    const event: Event<number> = { type: 'order.added.event', payload: 2 };
    const result = twice.apply(twice.initialState, event);
    expect(result).toEqual({ amount: 2, totals: { sum: 2 }, audit: { count: 1 } });
    expect(calls).toEqual(['matched:order:2', 'all:2', 'audit']);
    calls.length = 0;
    expect(produce(twice.initialState, draft => twice.applyToDraft(draft, event))).toEqual(result);
    expect(calls).toEqual(['matched:order:2', 'all:2', 'audit']);
    expect(twice.initialState.totals.sum).toBe(0);
    calls.length = 0;
    twice.process(twice.initialState, twice.commandCreators.add(2));
    expect(calls).toEqual([]);
    const unknown = twice.apply(result, { type: 'future.event', payload: null });
    expect(unknown.audit.count).toBe(2);
    expect(calls).toEqual(['all:2', 'audit']);
  });

  test('builder registration resolves custom names and isolates legacy lifecycle plugins', () => {
    const legacy = { key: 'legacy' };
    const plugin = createAggregatePlugin('log').state(() => ({ calls: [] as string[] }))
      .events({ changed(draft) { draft.calls.push('matched'); } })
      .onEvent(draft => { draft.calls.push('all'); }).build();
    const host = createAggregate('custom', { count: 0 }).plugins(legacy, plugin)
      .events({ changed(state) { state.count++; } })
      .naming({ event: (_name, key) => `custom/${key}.event` }).build();
    expect(host.plugins).toEqual([legacy]);
    expect(host.aggregatePlugins).toEqual([plugin]);
    expect(host.apply(host.initialState, { type: 'custom/changed.event', payload: {} }))
      .toEqual({ count: 1, log: { calls: ['matched', 'all'] } });
  });

  test('missing snapshot namespace fails before domain mutation', () => {
    let runs = 0;
    const host = createAggregate('order', { count: 0 }).events({ changed(state) { runs++; state.count++; } })
      .plugins(createAggregatePlugin('log').state(() => ({})).build()).build();
    expect(() => host.apply({ count: 0 } as typeof host.initialState, { type: 'order.changed.event', payload: {} }))
      .toThrow('migrate');
    expect(runs).toBe(0);
  });

  test('throws roll back domain and earlier plugin writes for direct and caller draft application', () => {
    const Order = source();
    const host = Order.withPlugins(createAggregatePlugin('failure').state(() => ({ count: 0 }))
      .onEvent(draft => { draft.count++; throw new Error('failure'); }).build());
    const event: Event<number> = { type: 'order.added.event', payload: 3 };
    expect(() => host.apply(host.initialState, event)).toThrow('failure');
    expect(() => produce(host.initialState, draft => host.applyToDraft(draft, event))).toThrow('failure');
    expect(host.initialState).toEqual({ amount: 0, failure: { count: 0 } });
  });

  test('rejects async work without unhandled rejections or retained domain/plugin writes', async () => {
    const rejected: () => undefined = (() => Promise.reject(new Error('async failure'))) as unknown as () => undefined;
    const Order = source();
    const badInitializer = createAggregatePlugin('async').state((() => Promise.reject(new Error('initialize'))) as unknown as () => object).build();
    expect(() => Order.withPlugins(badInitializer)).toThrow('synchronous');
    const host = Order.withPlugins(createAggregatePlugin('async').state(() => ({ count: 0 }))
      .onEvent(rejected).build());
    const event: Event<number> = { type: 'order.added.event', payload: 3 };
    expect(() => host.apply(host.initialState, event)).toThrow('synchronous');
    expect(() => produce(host.initialState, draft => host.applyToDraft(draft, event))).toThrow('synchronous');
    expect(host.initialState).toEqual({ amount: 0, async: { count: 0 } });
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  test('domain thenables abort before plugins and are observed', async () => {
    let plugins = 0;
    const host = createAggregate('asyncdomain', { count: 0 }).events({ changed(state) {
      state.count++;
      return Promise.reject(new Error('domain async'));
    } }).plugins(createAggregatePlugin('log').state(() => ({})).onEvent(() => { plugins++; }).build()).build();
    expect(() => host.apply(host.initialState, { type: 'asyncdomain.changed.event', payload: {} })).toThrow('synchronous');
    expect(host.initialState.count).toBe(0);
    expect(plugins).toBe(0);
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  test('fallback keys receive unknown applied events after unmatched handler returns', () => {
    const order: string[] = [];
    const host = createAggregate('empty', {}).onUnmatchedEvent(() => { order.push('domain'); })
      .plugins(createAggregatePlugin('log').state(() => ({ count: 0 })).events({
        'unknown.event'(draft) { order.push('matched'); draft.count++; }
      }).onEvent(() => { order.push('all'); }).build()).build();
    expect(host.apply(host.initialState, { type: 'unknown.event', payload: null }).log.count).toBe(1);
    expect(order).toEqual(['domain', 'matched', 'all']);
  });

  test('source-bound descendants resolve host names and report actual host context', () => {
    const parent = createAggregate('parent', { count: 0 }).events({ changed(state) { state.count++; } });
    const childBuilder = createAggregate('child', { count: 0 }).extends(parent);
    const Parent = parent.build();
    const seen: string[] = [];
    const plugin = createAggregatePluginFor(Parent, 'log').state(() => ({ count: 0 })).events({
      changed(draft, _event, context) {
        seen.push(`${context.aggregateType}:${context.state.count}`);
        expect(Object.isFrozen(context.state)).toBe(true);
        draft.count++;
      }
    }).build();
    const child = childBuilder.overrideEventNames({ changed: 'custom.changed.event' }).plugins(plugin).build();
    expect(child.apply(child.initialState, { type: 'custom.changed.event', payload: {} }).log.count).toBe(1);
    expect(seen).toEqual(['child:1']);
  });

  test('inherits live plugin registrations and preserves commands, selectors and legacy lifecycle arrays', () => {
    const legacy = { key: 'legacy' };
    const plugin = createAggregatePlugin('audit').state(() => ({ count: 0 })).onEvent(draft => { draft.count++; }).build();
    const parent = createAggregate('parent', { count: 0 }).plugins(legacy, plugin)
      .events({ changed(state, _event: Event<{}>) { state.count++; } })
      .commands(emit => ({ change: () => emit.changed({}) }))
      .selectors({ count: state => state.count });
    const child = createAggregate('child', { count: 0 }).extends(parent).build();
    expect(child.plugins).toEqual([legacy]);
    expect(child.aggregatePlugins).toEqual([plugin]);
    const event = child.process(child.initialState, child.commandCreators.change())[0]!;
    const state = child.apply(child.initialState, event);
    expect(child.selectors.count(state)).toBe(1);
    expect(state.audit.count).toBe(1);
  });

  test('rejects ambiguous resolved routes and domain collisions', () => {
    const plugin = createAggregatePlugin('audit').state(() => ({}))
      .events({ first() {}, second() {} }).build();
    expect(() => createAggregate('ambiguous', {}).events({ first() {}, second() {} })
      .overrideEventNames({ first: 'same.event', second: 'same.event' }).plugins(plugin).build())
      .toThrow('Ambiguous');
    const collision = createAggregatePlugin('amount').state(() => ({})).build();
    // @ts-expect-error runtime defense for domain key collision
    expect(() => source().withPlugins(collision)).toThrow('collision');
  });

  test('source identity, descendant prerequisites, duplicate IDs and mount collisions', () => {
    const builder = createAggregate('order', { count: 0 });
    const Order = builder.build();
    const plugin = createAggregatePluginFor(Order, 'audit').state(() => ({})).build();
    expect(() => createAggregate('order', { count: 0 }).build().withPlugins(plugin)).toThrow('source');
    const child = createAggregate('child', { count: 0 }).extends(builder).build();
    expect(() => child.withPlugins(plugin)).not.toThrow();
    const decorated = Order.withPlugins(plugin);
    const requiresAudit = createAggregatePluginFor(decorated, 'next').state(() => ({})).build();
    // @ts-expect-error runtime defense for missing source prerequisites
    expect(() => Order.withPlugins(requiresAudit)).toThrow('source');
    expect(() => decorated.withPlugins(requiresAudit)).not.toThrow();
    // @ts-expect-error runtime duplicate namespace defense
    expect(() => decorated.withPlugins(plugin)).toThrow('collision');
    const generic = createAggregatePlugin('audit').state(() => ({})).build();
    // @ts-expect-error runtime mount namespace collision defense
    expect(() => createAggregate('mount', {}).valueObject('audit').build().withPlugins(generic)).toThrow('collision');
  });
});
