import { createAggregate, createAggregatePlugin, type AggregateEventPlugin } from '../../../src';

const source = createAggregate('headers', {}).commands(() => ({ go: () => [] })).build();
type Headers = { traceId: string };
const explicit = createAggregatePlugin('explicit').eventEnvelope<{ headers: Headers | undefined }>(() => ({ headers: undefined }))
  .prepareEvent((draft, ctx) => {
    if (draft.headers) draft.headers.traceId = 'prepared';
    // @ts-expect-error Context headers are unknown, not this callback's output.
    const trace: string = ctx.event.headers!.traceId;
    void trace;
  }).build();
const inferred = createAggregatePlugin('inferred').eventEnvelope(() => ({ headers: { traceId: 'one' } })).build();
const events = source.withPlugins(inferred).process({}, { type: 'go', payload: {} });
const trace: string = events[0]!.headers.traceId;
// @ts-expect-error Known header contracts do not retain the generic unknown index signature.
events[0]!.headers.missing;
const optionalValue = source.withPlugins(explicit).process({}, { type: 'go', payload: {} })[0]!.headers;
const faithful: Headers | undefined = optionalValue;
if (optionalValue) {
  const optionalTrace: string = optionalValue.traceId;
  // @ts-expect-error Optional header values do not regain an unknown index signature.
  optionalValue.missing;
  void optionalTrace;
}
// @ts-expect-error An undefined header value must remain visible.
const required: Headers = optionalValue;
// @ts-expect-error Optional header property cannot establish writer presence.
createAggregatePlugin('optional').eventEnvelope<{ headers?: Headers }>(() => ({}));
// @ts-expect-error Conditional writer contracts cannot establish writer presence.
createAggregatePlugin('conditional').eventEnvelope<{} | { headers: Headers }>(() => ({}));
// @ts-expect-error Inferred conditional writers are rejected too.
createAggregatePlugin('branch').eventEnvelope(() => Math.random() ? {} : { headers: { traceId: 'one' } });
// @ts-expect-error Invalid header values are not records.
createAggregatePlugin('null').eventEnvelope(() => ({ headers: null }));
// @ts-expect-error Arrays are not header records.
createAggregatePlugin('array').eventEnvelope(() => ({ headers: [] }));
// @ts-expect-error Reserved fields remain protected on events.
createAggregatePlugin('identity').eventEnvelope(() => ({ headers: {}, id: 'bad' }));
// @ts-expect-error Parsers must also guarantee writer presence.
createAggregatePlugin('parser').eventEnvelope(() => ({}), { parse: (): { headers?: Headers } => ({}) });
// @ts-expect-error Command headers cannot be declared even with optional presence.
createAggregatePlugin('command').commandEnvelope<{ headers?: Headers }>(() => ({}));
// @ts-expect-error Conditional reserved fields remain reserved on events.
createAggregatePlugin('reservedBranch').eventEnvelope<{} | { metadata: {} }>(() => ({}));
const headerless = createAggregatePlugin('headerless').eventEnvelope(() => ({ observed: true })).build();
const baseline: unknown = source.withPlugins(headerless).process({}, { type: 'go', payload: {} })[0]!.headers?.traceId;
const selected = createAggregatePlugin('selected')
  .commandEnvelope(input => {
    const selected = input.selected;
    if (selected !== undefined && typeof selected !== 'string') throw new TypeError('Expected selected trace');
    return { selected };
  })
  .eventEnvelope((_, ctx) => {
    const selected: string | undefined = ctx.command.selected;
    // @ts-expect-error Canonical command header fields remain unknown until validation.
    const traceId: string = ctx.command.headers!.traceId;
    void traceId;
    return { headers: selected === undefined ? undefined : { traceId: selected } };
  }).build();
const selectedHeaders: Headers | undefined = source.withPlugins(selected).process({}, { type: 'go', payload: {} })[0]!.headers;
const parsed = createAggregatePlugin('parsed').eventEnvelope(() => ({}), {
  parse: (_value: unknown) => ({ headers: { traceId: 'parsed' } })
}).build();
const parsedTrace: string = source.withPlugins(parsed).process({}, { type: 'go', payload: {} })[0]!.headers.traceId;
void [trace, required, faithful, baseline, selectedHeaders, parsedTrace];

const raw = createAggregate('raw', {}).commands(() => ({
  go: () => ({ type: 'changed', payload: {}, headers: { traceId: 123 } })
})).build();
const possibleWriters: (typeof inferred)[] = [];
const absent: AggregateEventPlugin<'absent', undefined, undefined, {}, { headers: Headers }> = {
  ...createAggregatePlugin('absent').build(), eventEnvelope: undefined
};
const possibleArray = raw.withPlugins(...possibleWriters);
const possibleDescriptor = raw.withPlugins(absent);
const possibleChained = possibleArray.withPlugins(absent);
for (const host of [possibleArray, possibleDescriptor, possibleChained]) {
  const value: unknown = host.process({}, raw.commandCreators.go())[0]!.headers?.traceId;
  // @ts-expect-error A possible writer cannot validate canonical headers.
  const text: string | undefined = host.process({}, raw.commandCreators.go())[0]!.headers?.traceId;
  // @ts-expect-error Unknown canonical fields cannot be used as strings.
  host.process({}, raw.commandCreators.go())[0]!.headers?.traceId?.toUpperCase();
  void [value, text];
}
const possibleOther = createAggregatePlugin('other').eventEnvelope(() => ({ headers: { other: true } })).build();
const otherWriters: (typeof possibleOther)[] = [];
const absentOther: AggregateEventPlugin<'absentOther', undefined, undefined, {}, { headers: { other: boolean } }> = {
  ...createAggregatePlugin('absentOther').build(), eventEnvelope: undefined
};
// @ts-expect-error An absent descriptor cannot add fields alongside a guaranteed writer.
raw.withPlugins(absentOther, inferred).process({}, raw.commandCreators.go())[0]!.headers.other;
// @ts-expect-error A chained possible array cannot add fields to a previous guaranteed writer.
raw.withPlugins(inferred).withPlugins(...otherWriters).process({}, raw.commandCreators.go())[0]!.headers.other;
// @ts-expect-error A later guaranteed writer cannot inherit fields from a previous possible array.
raw.withPlugins(...otherWriters).withPlugins(inferred).process({}, raw.commandCreators.go())[0]!.headers.other;
const guaranteedHosts = [
  raw.withPlugins(absent, inferred),
  raw.withPlugins(inferred, absent),
  possibleArray.withPlugins(inferred),
  raw.withPlugins(inferred).withPlugins(...otherWriters),
  raw.withPlugins(...otherWriters).withPlugins(inferred),
  createAggregate('configured', {}).plugins(absent, inferred).build()
];
for (const host of guaranteedHosts) {
  const headers = host.process({}, { type: 'go', payload: {} })[0]!.headers;
  const text: string = headers.traceId;
  // @ts-expect-error Possible writers cannot add fields to guaranteed output.
  headers.other;
  // @ts-expect-error Guaranteed output does not inherit the canonical index signature.
  headers.missing;
  void text;
}
const maybeUndefined = possibleDescriptor.withPlugins(explicit).withPlugins(...otherWriters)
  .process({}, raw.commandCreators.go())[0]!.headers;
const honest: Headers | undefined = maybeUndefined;
// @ts-expect-error A guaranteed writer may explicitly publish undefined.
const dishonest: Headers = maybeUndefined;
void [honest, dishonest];
