import { createAggregate, createAggregatePlugin, createAggregatePluginFor, type AggregateEventPlugin } from '../../../src';
import type { Event, RedemeinePlugin, ExtractPluginExtensions } from '@redemeine/kernel';

const Order = createAggregate('order', { amount: 0 })
  .events({ added(state, event: Event<number>) { state.amount += event.payload; } })
  .commands(emit => ({ add: (_state, payload: number) => emit.added(payload) }))
  .selectors({ amount: state => state.amount }).build();
const totals = createAggregatePluginFor(Order, 'totals').state(() => ({ count: 0 }))
  .events({ added(draft, event) { draft.count += event.payload; } }).build();
const decorated = Order.withPlugins(totals);
const count: number = decorated.initialState.totals.count;
decorated.commandCreators.add(1);
decorated.selectors.amount(decorated.initialState);
decorated.apply(decorated.initialState, { type: 'order.added.event', payload: 1 });
// @ts-expect-error snapshot must include plugin namespace
decorated.apply(Order.initialState, { type: 'added', payload: 1 });
// @ts-expect-error duplicate namespace
decorated.withPlugins(totals);
const collision = createAggregatePlugin('amount').state(() => ({})).build();
// @ts-expect-error domain collision
Order.withPlugins(collision);
const builder = createAggregate('builder', { amount: 0 }).plugins(totals)
  .events({ added(state, _event: Event<number>) { state.amount++; } })
  .selectors({ amount: state => state.amount }).build();
const builderCount: number = builder.initialState.totals.count;
// @ts-expect-error duplicate namespace in same registration
Order.withPlugins(totals, totals);
// @ts-expect-error duplicate builder namespace
createAggregate('duplicate', {}).plugins(totals).plugins(totals);
void [count, builderCount];
const parent = createAggregate('parent', { amount: 0 }).plugins(totals);
const child = createAggregate('child', { amount: 0 }).extends(parent).build();
const childCount: number = child.initialState.totals.count;
const dependent = createAggregatePluginFor(decorated, 'dependent').state(() => ({})).build();
// @ts-expect-error source prerequisite totals is missing
Order.withPlugins(dependent);
decorated.withPlugins(dependent);
void childCount;
type LegacyExtensions = { intents: { log: string }; meta: { tag: string } };
const legacy: RedemeinePlugin<LegacyExtensions> = { key: 'legacy', onBeforeAppend: ctx => ctx.meta?.tag };
const legacyHost = createAggregate('legacy', {}).plugins(legacy)
  .commands(() => ({ record: () => ({ events: [], intents: { log: 'ok' } }) })).build();
const mixed = legacyHost.withPlugins(createAggregatePlugin('mounted').state(() => ({})).build());
const extension: ExtractPluginExtensions<NonNullable<typeof mixed.plugins>[number]>['intents']['log'] = 'ok';
const legacyAfter = Order.withPlugins(legacy);
const afterExtension: ExtractPluginExtensions<NonNullable<typeof legacyAfter.plugins>[number]>['meta']['tag'] = 'tag';
void [extension, afterExtension];
const supplied = { ...decorated.initialState, amount: 0 as const, extra: 'input only' as const };
const applied = decorated.apply(supplied, { type: 'order.added.event', payload: 2 });
// @ts-expect-error mutation must not preserve arbitrary input literals
const falseLiteral: 0 = applied.amount;
// @ts-expect-error output promises only the actual aggregate state contract
applied.extra;
void falseLiteral;

const exact = createAggregatePlugin('audit').state(() => ({ count: 0 })).build();
const wide: AggregateEventPlugin<string, { count: number }> = exact;
const unionId: AggregateEventPlugin<'audit' | 'other', { count: number }> = exact;
// @ts-expect-error attachment must reject an ordinary widened const
Order.withPlugins(wide);
// @ts-expect-error builder attachment must reject a widened ID
createAggregate('wide', { amount: 0 }).plugins(wide);
// @ts-expect-error attachment must reject union IDs
Order.withPlugins(unionId);
// @ts-expect-error builder attachment must reject union IDs
createAggregate('unionId', {}).plugins(unionId);
// @ts-expect-error explicit contextual tuple cannot bypass widened-ID validation
Order.withPlugins<readonly [AggregateEventPlugin<string, { count: number }>]>(exact);
// @ts-expect-error explicit builder tuple cannot bypass widened-ID validation
createAggregate('contextualWide', {}).plugins<readonly [AggregateEventPlugin<string, { count: number }>]>(exact);
// @ts-expect-error contextual inference must not widen an exact collision
Order.withPlugins({ ...exact, id: 'amount' });
// @ts-expect-error contextual inference must not widen a builder collision
createAggregate('contextual', { amount: 0 }).plugins({ ...exact, id: 'amount' });
type UnionState = { kind: 'a'; audit: number } | { kind: 'b'; other: number };
const unionState: UnionState = { kind: 'b', other: 0 } as UnionState;
const unionBuilder = createAggregate('union', unionState);
// @ts-expect-error collision in a non-common union branch
unionBuilder.plugins(exact);
// @ts-expect-error collision in a non-common union branch after build
unionBuilder.build().withPlugins(exact);
const optionalState: { audit?: number } = {};
// @ts-expect-error optional domain namespace is reserved even when absent
createAggregate('optional', optionalState).plugins(exact);
// @ts-expect-error optional built domain namespace is reserved even when absent
createAggregate('optional', optionalState).build().withPlugins(exact);
const indexedState: Record<string, number> = {};
// @ts-expect-error index signatures reserve every possible namespace
createAggregate('indexed', indexedState).plugins(exact);
// @ts-expect-error built index signatures reserve every possible namespace
createAggregate('indexed', indexedState).build().withPlugins(exact);
const contextualExact = Order.withPlugins({ ...exact, id: 'contextualAudit' });
const contextualCount: number = contextualExact.initialState.contextualAudit.count;
const contextualDomain: number = contextualExact.initialState.amount;
void [contextualCount, contextualDomain];

const inlineBuilder = createAggregate('inline', {}).plugins({
  key: 'inline',
  onBeforeAppend: ctx => ctx.eventType.toUpperCase(),
  onHydrateEvent: ctx => ctx.eventType.toUpperCase(),
  onBeforeCommand: ctx => { const command: string = ctx.commandType; void command; },
  onAfterCommit: ctx => { const events: Event<unknown, string>[] = ctx.events; void events; }
}).build();
Order.withPlugins({ key: 'inline', onBeforeAppend: ctx => ctx.eventType.toUpperCase() });
const inlineMixedBuilder = createAggregate('mixed', {}).plugins(
  exact, { key: 'inline', onBeforeAppend: ctx => ctx.eventType.toUpperCase() }, legacy
).build();
const inlineMixedBuilt = Order.withPlugins(
  legacy, { key: 'inline', onBeforeAppend: ctx => ctx.eventType.toUpperCase() }, exact
);
const mixedBuilderExtension: ExtractPluginExtensions<typeof inlineMixedBuilder.plugins[number]>['meta']['tag'] = 'ok';
const mixedBuiltExtension: ExtractPluginExtensions<typeof inlineMixedBuilt.plugins[number]>['intents']['log'] = 'ok';
const mixedCount: number = inlineMixedBuilt.initialState.audit.count;
void [inlineBuilder, mixedBuilderExtension, mixedBuiltExtension, mixedCount];

const array = createAggregate('array', [] as number[])
  .events({ added(state, event: Event<number>) { state.push(event.payload); } }).build();
const legacyArray = array.withPlugins({ key: 'inline', onBeforeAppend: ctx => ctx.eventType });
const arrayResult: number[] = legacyArray.apply(legacyArray.initialState, { type: 'array.added.event', payload: 1 });
array.withPlugins().initialState.push(1);
void arrayResult;
