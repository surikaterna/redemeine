import { createAggregate, createAggregatePlugin, type AggregateEventPlugin } from '../../../src';

const root = createAggregate('builderHeaders', {}).commands(() => ({
  go: () => ({ type: 'changed', payload: {}, headers: { traceId: 123 } })
}));
const absent: AggregateEventPlugin<'absent', undefined, undefined, {}, { headers: { traceId: string } }> = {
  ...createAggregatePlugin('absent').build(), eventEnvelope: undefined
};
const extra = createAggregatePlugin('extra').eventEnvelope(() => ({ observed: true })).build();
const optional = root.plugins(absent).build();
const optionalEvent = optional.process({}, optional.commandCreators.go())[0]!;
const raw: unknown = optionalEvent.headers?.traceId;
// @ts-expect-error An absent descriptor cannot validate raw numeric headers as strings.
const unsafe: string | undefined = optionalEvent.headers?.traceId;
// @ts-expect-error Canonical unknown headers cannot be treated as strings.
optionalEvent.headers?.traceId?.toUpperCase();
const chained = optional.withPlugins(extra).process({}, optional.commandCreators.go())[0]!;
// @ts-expect-error The builder phantom must not carry absent header guarantees into attachment.
const chainedUnsafe: string | undefined = chained.headers?.traceId;
const writer = createAggregatePlugin('writer').eventEnvelope(() => ({ headers: { traceId: 'one' } })).build();
const possible: (typeof writer)[] = [];
const arrayEvent = root.plugins(...possible).build().process({}, optional.commandCreators.go())[0]!;
// @ts-expect-error An ordinary array may be empty and cannot validate headers.
const arrayUnsafe: string | undefined = arrayEvent.headers?.traceId;
const arrayChain = root.plugins(...possible).build().withPlugins(extra).process({}, optional.commandCreators.go())[0]!;
// @ts-expect-error Empty-array guarantees cannot leak through the builder phantom either.
const arrayChainUnsafe: string | undefined = arrayChain.headers?.traceId;
const optionalProperty: Omit<typeof writer, 'eventEnvelope'> & { eventEnvelope?: typeof writer.eventEnvelope | undefined } = {
  ...writer, eventEnvelope: undefined
};
// @ts-expect-error An optional descriptor property is not proof of a header writer.
const propertyUnsafe: string | undefined = root.plugins(optionalProperty).build().process({}, optional.commandCreators.go())[0]!.headers?.traceId;
// @ts-expect-error Headerless builders retain canonical unknown headers.
const noPluginUnsafe: string | undefined = root.build().process({}, optional.commandCreators.go())[0]!.headers?.traceId;
const guaranteed = root.plugins(writer).build().process({}, optional.commandCreators.go())[0]!;
const trace: string = guaranteed.headers.traceId;
// @ts-expect-error Guaranteed headers replace the canonical unknown index signature.
guaranteed.headers.missing;
type Correlated = { mode: 'trace'; traceBody: string; headers: { traceId: string } }
  | { mode: 'audit'; auditBody: number; headers: { auditId: number } };
const union = createAggregatePlugin('union').eventEnvelope<Correlated>(() => ({
  mode: 'trace', traceBody: 'body', headers: { traceId: 'one' }
})).build();
const built = root.plugins(union).build();
type TraceHeaders = Extract<ReturnType<typeof built.process>[number], { mode: 'trace' }>['headers'];
const exact: TraceHeaders = { traceId: 'one' };
// @ts-expect-error The builder alone must remove the canonical header index signature.
const extraHeader: TraceHeaders = { traceId: 'one', missing: true };
// @ts-expect-error The builder alone must preserve branch-specific header requirements.
const wrongHeader: TraceHeaders = { auditId: 1 };
const before = root.plugins(absent).build();
for (const host of [built, built.withPlugins(extra), before.withPlugins(union)]) {
  const event = host.process({}, optional.commandCreators.go())[0]!;
  if (event.mode === 'trace') {
    const header: string = event.headers.traceId;
    const body: string = event.traceBody;
    // @ts-expect-error Header branches remain correlated with the discriminant.
    event.headers.auditId;
    // @ts-expect-error Body branches remain correlated with headers.
    event.auditBody;
    void [header, body];
  } else {
    const header: number = event.headers.auditId;
    const body: number = event.auditBody;
    // @ts-expect-error Known headers have no canonical unknown index signature.
    event.headers.traceId;
    // @ts-expect-error No cross-product of body and header branches.
    event.traceBody;
    void [header, body];
  }
}
void [raw, unsafe, chainedUnsafe, arrayUnsafe, arrayChainUnsafe, propertyUnsafe, noPluginUnsafe, trace, exact, extraHeader, wrongHeader];
