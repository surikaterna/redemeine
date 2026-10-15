import { eventTypesFor, guardCallback, snapshotEvents } from './descriptor';
import { type EnvelopeSlots, envelopeMethods } from './envelopeDescriptor';
import type {
  AggregatePluginBuilder,
  AggregatePluginEvents,
  AggregatePluginHandler,
  AggregatePluginId,
  AggregatePluginSource,
  AggregatePluginStateBuilder
} from './types';

function builder<Id extends string, S extends object, A extends AggregatePluginSource | undefined>(
  id: Id,
  source: A,
  initialize: () => S,
  events: Readonly<AggregatePluginEvents<S, A>> = Object.freeze({}) as AggregatePluginEvents<S, A>,
  onEvent?: AggregatePluginHandler<S, A>,
  envelopes: EnvelopeSlots = {}
): AggregatePluginBuilder<Id, S, A> {
  // The public builder tracks extension/phase types; runtime storage preserves each callback without invoking it.
  return Object.freeze({
    ...envelopeMethods(envelopes, (next) => builder(id, source, initialize, events, onEvent, next)),
    events: (handlers: AggregatePluginEvents<S, A>) => builder(id, source, initialize, snapshotEvents({ ...events, ...handlers }), onEvent, envelopes),
    onEvent: (handler: AggregatePluginHandler<S, A>) => builder(id, source, initialize, events, guardCallback(handler), envelopes),
    build: () =>
      Object.freeze({
        kind: 'aggregate-event' as const,
        id,
        source,
        initialize,
        events,
        eventTypes: eventTypesFor(source, Object.keys(events)),
        onEvent,
        commandEnvelope: envelopes.commandEnvelope,
        eventEnvelope: envelopes.eventEnvelope
      })
  }) as unknown as AggregatePluginBuilder<Id, S, A>;
}

function start<Id extends string, A extends AggregatePluginSource | undefined>(id: Id, source: A): AggregatePluginStateBuilder<Id, A> {
  if (!id || id === 'prototype' || id in Object.prototype) throw new TypeError('Invalid aggregate plugin id');
  return Object.freeze({
    state: <S extends object>(initialize: (() => S) & (S extends PromiseLike<unknown> ? never : unknown)) => builder(id, source, guardCallback(initialize))
  });
}

/** Declare plugin-owned state before registering synchronous event handlers. */
export function createAggregatePlugin<const Id extends string>(id: Id & AggregatePluginId<Id>): AggregatePluginStateBuilder<Id, undefined> {
  return start(id, undefined);
}

/** Infer event payloads and readonly aggregate context from a built source. */
export function createAggregatePluginFor<A extends AggregatePluginSource, const Id extends string>(
  aggregate: A,
  id: Id & AggregatePluginId<Id>
): AggregatePluginStateBuilder<Id, A> {
  return start(id, aggregate);
}
