import type { Event } from '@redemeine/kernel';
import { createAggregate, createAggregatePlugin, createAggregatePluginFor, type AggregateEventPlugin } from '../../../src';

const source = createAggregate('counter', { count: 0 })
  .events({ added(state, event: Event<number>) { state.count += event.payload; } })
  .commands(emit => ({ add: (_state, payload: number) => emit.added(payload) })).build();
const plugin = createAggregatePluginFor(source, 'transport')
  .commandEnvelope((_, context) => {
    const count: number = context.state.count;
    const own: undefined = context.ownState;
    // @ts-expect-error Stateless plugins have no own state to mutate.
    context.ownState.count = 1;
    // @ts-expect-error The domain context stays readonly.
    context.state.count = 1;
    return { dateTime: new Date(), observed: count, absent: own };
  })
  .prepareCommand((draft, context) => { draft.observed = context.state.count; })
  .eventEnvelope((_, context) => ({ executionDateTime: context.command.dateTime.toISOString() }))
  .prepareEvent(draft => { draft.executionDateTime = 'prepared'; }).build();
const decorated = source.withPlugins(plugin);
const initial: typeof source.initialState = decorated.initialState;
const supplied: typeof decorated.initialState = source.initialState;
const prepared = decorated.prepareCommand(initial, decorated.commandCreators.add(1));
const date: Date = prepared.dateTime;
const execution: string = decorated.process(supplied, prepared)[0]!.executionDateTime;
// @ts-expect-error Command creators have not run preparation.
decorated.commandCreators.add(1).dateTime;
// @ts-expect-error No namespace is added to the state.
decorated.initialState.transport;
// @ts-expect-error No state means no state reducers.
createAggregatePlugin('noState').events({});
// @ts-expect-error No state means no catchall reducer, including after envelope configuration.
createAggregatePlugin('noState').commandEnvelope(() => ({})).onEvent(() => undefined);
// @ts-expect-error Envelope initializers cannot return protected core fields.
createAggregatePlugin('reserved').commandEnvelope(() => ({ headers: {} }));
// @ts-expect-error Stateless plugin IDs must still be unique within a tuple.
source.withPlugins(plugin, plugin);
const audit = createAggregatePlugin('audit').state(() => ({ seen: 0 })).onEvent(draft => { draft.seen++; }).build();
const mixed = source.withPlugins(plugin, audit);
const seen: number = mixed.initialState.audit.seen;
// @ts-expect-error Only the stateful plugin mounts state.
mixed.initialState.transport;
const plugins = [plugin, audit];
const array = source.withPlugins(...plugins);
const optionalSeen: number | undefined = array.initialState.audit?.seen;
// @ts-expect-error Stateless array members don't add optional namespaces either.
array.initialState.transport;
const builder = createAggregate('builder', { count: 0 }).plugins(createAggregatePlugin('stamp').commandEnvelope(() => ({ stamp: 1 })).build()).build();
const stamp: number = builder.prepareCommand(builder.initialState, { type: 'noop', payload: {} }).stamp;
void [date, execution, seen, optionalSeen, stamp];

const descriptor: AggregateEventPlugin<'manual', undefined> = createAggregatePlugin('manual').build();
// @ts-expect-error Public stateless descriptors cannot declare a catchall reducer.
const catchall: typeof descriptor = { ...descriptor, onEvent: () => undefined };
// @ts-expect-error Public stateless descriptors cannot declare matched reducers.
const matched: typeof descriptor = { ...descriptor, events: { added: () => undefined } };
// @ts-expect-error Inferred descriptors enforce the same constraint.
const inferred: typeof plugin = { ...plugin, events: { added: () => undefined } };
void [catchall, matched, inferred];

const headerOnly = createAggregatePluginFor(source, 'headers').eventEnvelope((_, context) => {
    // @ts-expect-error Context event headers are readonly.
    context.event.headers!.trace = 'changed';
    // @ts-expect-error Command headers remain readonly too.
    context.command.headers!.trace = 'changed';
    return { observed: true };
  }).build();
const headerHost = source.withPlugins(headerOnly);
const sameState: typeof source.initialState = headerHost.initialState;
// @ts-expect-error Header-only plugins do not mount state.
headerHost.initialState.headers;
void sameState;
