import { createAggregate, createAggregatePlugin, type AggregateEventPlugin } from '../../../src';

const source = createAggregate('unions', {}).commands(() => ({ go: () => [] })).build();
type Body = { mode: 'trace'; traceId: string } | { mode: 'audit'; auditId: number };
type Correlated = { mode: 'trace'; traceBody: string; headers: { traceId: string } }
  | { mode: 'audit'; auditBody: number; headers: { auditId: number } };
const body = createAggregatePlugin('body').eventEnvelope<Body>(() => ({ mode: 'trace', traceId: 'one' })).build();
const writer = createAggregatePlugin('writer').eventEnvelope<Correlated>(() => ({ mode: 'trace', traceBody: 'body', headers: { traceId: 'one' } })).build();
const extra = createAggregatePlugin('extra').eventEnvelope(() => ({ observed: true })).build();
const possible: (typeof writer)[] = [];
const optional: AggregateEventPlugin<'optional', undefined, undefined, {}, Correlated> = {
  ...createAggregatePlugin('optional').build(), eventEnvelope: undefined
};
const optionalProperty: Omit<typeof writer, 'eventEnvelope'> & { eventEnvelope?: typeof writer.eventEnvelope | undefined } = {
  ...writer, eventEnvelope: undefined
};
const mixed = [writer, extra];

for (const host of [source.withPlugins(body), source.withPlugins(body).withPlugins(extra), source.withPlugins(extra).withPlugins(body)]) {
  const event = host.process({}, { type: 'go', payload: {} })[0]!;
  if (event.mode === 'trace') {
    const value: string = event.traceId;
    // @ts-expect-error The audit body belongs to the other branch.
    event.auditId;
    void value;
  } else {
    const value: number = event.auditId;
    // @ts-expect-error The trace body belongs to the other branch.
    event.traceId;
    void value;
  }
}

const hosts = [source.withPlugins(writer), source.withPlugins(writer).withPlugins(extra),
  source.withPlugins(extra).withPlugins(writer), source.withPlugins(optional, writer),
  source.withPlugins(writer, optional), source.withPlugins(writer, ...possible),
  source.withPlugins(writer).withPlugins(...possible), source.withPlugins(...possible).withPlugins(writer),
  source.withPlugins(writer).withPlugins(...mixed), source.withPlugins(...mixed).withPlugins(writer),
  createAggregate('configuredUnion', {}).plugins(writer).build()];
for (const host of hosts) {
  const event = host.process({}, { type: 'go', payload: {} })[0]!;
  if (event.mode === 'trace') {
    const value: string = event.headers.traceId;
    const body: string = event.traceBody;
    // @ts-expect-error No cross-product of discriminants and headers.
    event.headers.auditId;
    // @ts-expect-error Body and header alternatives remain correlated.
    event.auditBody;
    void [value, body];
  } else {
    const value: number = event.headers.auditId;
    const body: number = event.auditBody;
    // @ts-expect-error No canonical unknown index signature remains.
    event.headers.traceId;
    // @ts-expect-error Body and header alternatives remain correlated.
    event.traceBody;
    void [value, body];
  }
  type TraceHeaders = Extract<typeof event, { mode: 'trace' }>['headers'];
  const good: TraceHeaders = { traceId: 'one' };
  // @ts-expect-error An audit header cannot inhabit a trace event.
  const wrong: TraceHeaders = { auditId: 1 };
  void [good, wrong];
}

for (const host of [source.withPlugins(...possible), source.withPlugins(optional), source.withPlugins(optionalProperty),
  source.withPlugins(...mixed), source.withPlugins(optional).withPlugins(...possible)]) {
  const event = host.process({}, { type: 'go', payload: {} })[0]!;
  // @ts-expect-error Possible writers never validate canonical headers, even after narrowing the body.
  const value: string = event.headers?.traceId;
  if (event.mode === 'trace') {
    // @ts-expect-error A possible writer cannot establish header correlation.
    const trace: string = event.headers?.traceId;
    void trace;
  }
  void value;
}

const bodies: (typeof body)[] = [];
for (const host of [source.withPlugins(...bodies), source.withPlugins(extra, ...bodies), source.withPlugins(...bodies).withPlugins(extra)]) {
  const event = host.process({}, { type: 'go', payload: {} })[0]!;
  if (event.mode === 'trace') {
    const value: string | undefined = event.traceId;
    // @ts-expect-error An array may be empty, so body fields remain optional.
    const required: string = event.traceId;
    const audit: number | undefined = event.auditId;
    // @ts-expect-error Possible body fields are independent, not guaranteed absent after narrowing.
    const absent: undefined = event.auditId;
    void [value, required, audit, absent];
  }
}
