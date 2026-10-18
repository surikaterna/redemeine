import { z } from 'zod';
import type { Command, Event } from '@redemeine/kernel';
import { createAggregate, createAggregatePlugin, type AggregateEventPlugin } from '../../../src';

const base = createAggregate('order', { count: 0 })
  .events({ added(state, event: Event<{ amount: number }>) { state.count += event.payload.amount; } })
  .commands(emit => ({ add: (_state, payload: { amount: number }) => emit.added(payload) })).build();
const date = createAggregatePlugin('date').state(() => ({}))
  .commandEnvelope(() => ({ dateTime: new Date() }))
  .eventEnvelope((_, context) => ({ sourceCommandDateTime: new Date(context.command.dateTime.getTime()) })).build();
const audit = createAggregatePlugin('audit').state(() => ({}))
  .commandEnvelope(() => ({ auditTag: 'prepared' }))
  .eventEnvelope(() => ({ auditRef: 'id' })).build();
const host = base.withPlugins(date).withPlugins(audit);
const raw = { ...base.commandCreators.add({ amount: 1 }), arbitrary: true, dateTime: 'unvalidated', auditTag: 3 };
const prepared = host.prepareCommand(host.initialState, raw);
const amount: number = prepared.payload.amount;
const stamp: Date = prepared.dateTime;
const tag: string = prepared.auditTag;
// @ts-expect-error arbitrary incoming extras are not preserved in the output type
prepared.arbitrary;
// @ts-expect-error raw values do not constrain the established extension
const wrong: string = prepared.dateTime;
// @ts-expect-error raw creators have no extension
base.commandCreators.add({ amount: 1 }).dateTime;
const emitted = host.process(host.initialState, raw)[0]!;
const eventDate: Date = emitted.sourceCommandDateTime;
const eventRef: string = emitted.auditRef;
// @ts-expect-error command extensions are not automatically event extensions
emitted.dateTime;
// @ts-expect-error the base process API already erases payload inference; do not claim improvement
emitted.payload.amount;

const optional = createAggregatePlugin('optional').state(() => ({})).commandEnvelope((): { maybe?: number } => ({})).build();
const maybe = base.withPlugins(optional).prepareCommand(base.withPlugins(optional).initialState, raw);
const optionalNumber: number | undefined = maybe.maybe;
const parsed = createAggregatePlugin('parsed').state(() => ({}))
  .commandEnvelope(() => ({ dateTime: new Date() }), z.object({ dateTime: z.date() })).build();
const parsedHost = base.withPlugins(parsed);
const parsedDate: Date = parsedHost.prepareCommand(parsedHost.initialState, raw).dateTime;
const builder = createAggregate('built', {}).plugins(date).plugins(audit).events({ added() {} }).build();
const builderDate: Date = builder.prepareCommand(builder.initialState, { type: 'built.add.command', payload: 1 }).dateTime;
const builderAudit: string = builder.process(builder.initialState, raw)[0]!.auditRef;
const child = createAggregate('child', {}).extends(createAggregate('parent', {}).plugins(date)).build();
const childDate: Date = child.prepareCommand(child.initialState, raw).dateTime;

const erased: AggregateEventPlugin<'erased', object> = createAggregatePlugin('erased').state(() => ({})).build();
const erasedHost = base.withPlugins(erased);
// @ts-expect-error erased/default descriptor extensions cannot recover a Date
erasedHost.prepareCommand(erasedHost.initialState, raw).dateTime;
declare const indexed: Command<number, 'indexed.command'> & Record<string, unknown>;
const indexedPrepared = host.prepareCommand(host.initialState, indexed);
const indexedNumber: number = indexedPrepared.payload;
// @ts-expect-error arbitrary index signatures on input are not propagated
indexedPrepared.unowned;
const headers = { type: 'headers.command', payload: { literal: 'value' as const }, headers: { arbitrary: { value: 1 } }, metadata: { value: 1 } };
const canonical = host.prepareCommand(host.initialState, headers);
const literal: 'value' = canonical.payload.literal;
const preservedHeader: unknown = canonical.headers?.arbitrary;
const preservedMetadata: unknown = canonical.metadata?.value;

const absent = { kind: 'aggregate-event' as const, id: 'absent' as const, source: undefined, initialize: () => ({}), events: {}, eventTypes: {}, onEvent: undefined };
const absentHost = base.withPlugins(absent);
// @ts-expect-error structurally absent descriptor cannot imply an extension
absentHost.prepareCommand(absentHost.initialState, raw).dateTime;
const maybeDescriptor: typeof absent & { commandEnvelope?: typeof date.commandEnvelope } = absent;
const maybeHost = base.withPlugins(maybeDescriptor);
const maybeDate: Date | undefined = maybeHost.prepareCommand(maybeHost.initialState, raw).dateTime;
// @ts-expect-error optional descriptor is not proof it is installed
const requiredMaybeDate: Date = maybeHost.prepareCommand(maybeHost.initialState, raw).dateTime;

function configured(enabled: boolean) {
  return { ...date, commandEnvelope: enabled ? date.commandEnvelope : undefined,
    eventEnvelope: enabled ? date.eventEnvelope : undefined };
}
const configuredHost = base.withPlugins(configured(false));
const configuredDate: Date | undefined = configuredHost.prepareCommand(configuredHost.initialState, raw).dateTime;
const configuredEventDate: Date | undefined = configuredHost.process(configuredHost.initialState, raw)[0]!.sourceCommandDateTime;
// @ts-expect-error potentially undefined command descriptor cannot guarantee Date
const requiredConfiguredDate: Date = configuredHost.prepareCommand(configuredHost.initialState, raw).dateTime;
// @ts-expect-error potentially undefined event descriptor cannot guarantee Date
const requiredConfiguredEventDate: Date = configuredHost.process(configuredHost.initialState, raw)[0]!.sourceCommandDateTime;
const reservedRoot = createAggregatePlugin('reserved').state(() => ({}));
// @ts-expect-error routing fields belong to canonical core
reservedRoot.commandEnvelope(() => ({ aggregateId: 'bad' }));
// biome-ignore lint/suspicious/noThenProperty: Deliberately invalid extension for the negative contract fixture.
const thenExtension = { then: 1 };
// @ts-expect-error then is reserved even when it is not callable
reservedRoot.eventEnvelope(() => thenExtension);

const plugins = [date, audit];
const arrayHosts = [base.withPlugins(...plugins), createAggregate('array', { count: 0 }).plugins(...plugins).build()];
for (const arrayHost of arrayHosts) {
  const command = arrayHost.prepareCommand(arrayHost.initialState, raw);
  const optionalDate: Date | undefined = command.dateTime;
  const optionalTag: string | undefined = command.auditTag;
  const event = arrayHost.process(arrayHost.initialState, raw)[0]!;
  const optionalEventDate: Date | undefined = event.sourceCommandDateTime;
  const optionalRef: string | undefined = event.auditRef;
  // @ts-expect-error ordinary arrays can be empty; no required command extension
  const requiredDate: Date = command.dateTime;
  // @ts-expect-error ordinary arrays cannot guarantee an event extension
  const requiredEventDate: Date = event.sourceCommandDateTime;
  void [optionalDate, optionalTag, optionalEventDate, optionalRef, requiredDate, requiredEventDate];
}
