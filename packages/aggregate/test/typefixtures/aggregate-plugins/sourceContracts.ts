import type { Event } from '@redemeine/kernel';
import { createAggregate, createAggregatePluginFor } from '../../../src';

const parent = createAggregate('parent', { count: 0 }).events({
  changed(_state, _event: Event<number>) {}, other(_state, _event: Event<number>) {}
});
const source = parent.build();
const plugin = createAggregatePluginFor(source, 'audit').state(() => ({}))
  .events({ changed(_draft, event) { event.payload.toFixed(2); } }).build();
const child = createAggregate('child', { count: 0 }).extends(parent)
  .events({ changed(_state, _event: Event<string>) {} })
  .commands(emit => ({ change: (_state, value: string) => emit.changed(value) })).build();
// @ts-expect-error actual generated descendant has a string payload, not the source number
child.withPlugins(plugin);
// @ts-expect-error arrays must check matched source contracts too
child.withPlugins(...[plugin]);
const inherited = createAggregate('inherited', { count: 0 }).extends(parent)
  .events({ other(_state, _event: Event<string>) {}, extra() {} })
  .overrideEventNames({ changed: 'renamed.event' }).build();
inherited.withPlugins(plugin);
inherited.withPlugins(...[plugin]);
const all = createAggregatePluginFor(source, 'all').state(() => ({})).onEvent(() => {}).build();
child.withPlugins(all);
const compatible = createAggregate('compatible', { count: 0 }).extends(parent)
  .events({ changed(_state, _event: Event<1>) {} }).build();
// Payload assignability is valid statically; replacement still requires rebinding at runtime.
compatible.withPlugins(plugin);
const registered = createAggregate('registered', { count: 0 }).extends(parent).plugins(plugin)
  .events({ changed(_state, _event: Event<string>) {} });
// @ts-expect-error final builder contract must reject overrides after registration too
registered.build();
const missing = createAggregate('missing', { count: 0 }).plugins(plugin);
// @ts-expect-error a matched source key must exist on the final host
missing.build();
const overrideFirst = createAggregate('overrideFirst', { count: 0 })
  .events({ changed(_state, _event: Event<string>) {} }).extends(parent)
  .commands(emit => ({ change: (_state, value: string) => emit.changed(value) })).build();
// @ts-expect-error extending later must preserve the host's explicit string override
overrideFirst.withPlugins(plugin);
const chained = createAggregatePluginFor(source, 'chained').state(() => ({}))
  .events({ changed() {} }).commandEnvelope(() => ({ stamp: true }))
  .prepareCommand(() => {}).events({ other() {} }).onEvent(() => {}).build();
// @ts-expect-error matched key tracking survives envelope methods and repeated event registration
child.withPlugins(chained);
createAggregatePluginFor(source, 'keys').state(() => ({})).events({
  changed() {},
  // @ts-expect-error tracking matched keys must not permit extra source keys
  typo() {}
});
