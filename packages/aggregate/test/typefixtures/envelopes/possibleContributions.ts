import { createAggregate, createAggregatePlugin, createAggregatePluginFor, type AggregateEventPlugin } from '../../../src';

type PreparedHost = { prepareCommand: (...args: never[]) => unknown; process: (...args: never[]) => readonly unknown[] };
type Usable<H extends PreparedHost> = [ReturnType<H['prepareCommand']>] extends [never] ? never
  : [ReturnType<H['process']>[number]] extends [never] ? never : H;
// A never-returning host must not silently disappear when fixtures combine their result unions.
function checkedHosts<const H extends readonly PreparedHost[]>(...hosts: H & { [K in keyof H]: Usable<H[K]> }): H {
  return hosts;
}

const root = createAggregate('possibleContributions', {}).commands(() => ({ go: () => ({ type: 'changed', payload: {} }) }));
const base = root.build();
type Body = { mode: 'trace'; traceId: string } | { mode: 'audit'; auditId: number };
const union = createAggregatePlugin('union').commandEnvelope<Body>(() => ({ mode: 'trace', traceId: 'one' }))
  .eventEnvelope<Body>(() => ({ mode: 'audit', auditId: 1 })).build();
const list: (typeof union)[] = [union];
const empty: (typeof union)[] = [];
for (const host of checkedHosts(base.withPlugins(...list), root.plugins(...list).build(), base.withPlugins(...empty))) {
  const command = host.prepareCommand({}, { type: 'go', payload: {} });
  const event = host.process({}, { type: 'go', payload: {} })[0]!;
  for (const envelope of [command, event]) {
    const mode: 'trace' | 'audit' | undefined = envelope.mode;
    if (envelope.mode === 'trace') {
      const trace: string | undefined = envelope.traceId;
      // @ts-expect-error Optional discriminants do not prove writer presence.
      const required: string = envelope.traceId;
      const audit: number | undefined = envelope.auditId;
      // @ts-expect-error Possible alternatives do not promise cross-field correlation, even for one registration.
      const absent: undefined = envelope.auditId;
      void [trace, required, audit, absent];
    }
    void mode;
  }
}
const trace = createAggregatePlugin('trace').commandEnvelope(() => ({ mode: 'trace' as const, traceId: 'one' }))
  .eventEnvelope(() => ({ mode: 'trace' as const, headers: { traceId: 'one' } })).build();
const audit = createAggregatePlugin('audit').commandEnvelope(() => ({ mode: 'audit' as const, auditId: 1 }))
  .eventEnvelope(() => ({ mode: 'audit' as const, headers: { auditId: 1 } })).build();
const alternatives: (typeof trace | typeof audit)[] = [trace];
for (const host of checkedHosts(base.withPlugins(...alternatives), root.plugins(...alternatives).build())) {
  const command = host.prepareCommand({}, { type: 'go', payload: {} });
  const event = host.process({}, command)[0]!;
  const mode: 'trace' | 'audit' | undefined = command.mode;
  const eventMode: 'trace' | 'audit' | undefined = event.mode;
  // @ts-expect-error Possible writers cannot validate canonical unknown headers.
  const unsafe: string | undefined = event.headers?.traceId;
  void [mode, eventMode, unsafe];
}
const absent: AggregateEventPlugin<'absent', undefined, undefined, { mode: 'audit'; auditId: number }, { mode: 'audit'; headers: { auditId: number } }> = {
  ...createAggregatePlugin('absent').build(), commandEnvelope: undefined, eventEnvelope: undefined
};
const optionalProperty: Omit<typeof audit, 'id' | 'commandEnvelope' | 'eventEnvelope'> & {
  id: 'optionalProperty'; commandEnvelope?: typeof audit.commandEnvelope | undefined; eventEnvelope?: typeof audit.eventEnvelope | undefined;
} = { ...createAggregatePlugin('optionalProperty').build() };
const possibleTrace: (typeof trace)[] = [];
const hosts = checkedHosts(base.withPlugins(absent, trace), base.withPlugins(trace, absent),
  root.plugins(absent, trace).build(), root.plugins(trace, absent).build(),
  base.withPlugins(absent).withPlugins(trace), base.withPlugins(trace).withPlugins(absent),
  root.plugins(absent).build().withPlugins(trace), root.plugins(optionalProperty).build().withPlugins(trace),
  base.withPlugins(trace, ...alternatives), base.withPlugins(...alternatives).withPlugins(trace),
  root.plugins(...alternatives).build().withPlugins(trace), root.plugins(...possibleTrace).plugins(trace).build(),
  root.plugins(...alternatives).plugins(trace).plugins(...possibleTrace).build(),
  root.plugins(trace).plugins(...alternatives).plugins(...possibleTrace).build(),
  createAggregate('inheritedPossible', {}).extends(root.plugins(...alternatives).plugins(trace))
    .plugins(...possibleTrace).build());
for (const host of hosts) {
  const command = host.prepareCommand({}, { type: 'go', payload: {} });
  const event = host.process({}, command)[0]!;
  const commandMode: 'trace' = command.mode;
  const traceId: string = command.traceId;
  const mode: 'trace' = event.mode;
  const header: string = event.headers.traceId;
  // @ts-expect-error Possible overlapping writers do not add an unknown header index signature.
  event.headers.missing;
  // @ts-expect-error Optional audit fields never become guaranteed.
  const auditId: number = command.auditId;
  void [commandMode, traceId, mode, header, auditId];
}
const disjoint = createAggregatePlugin('disjoint').commandEnvelope(() => ({ extra: 1 })).eventEnvelope(() => ({ observed: true })).build();
const disjointList = [union, disjoint];
const disjointHost = root.plugins(...disjointList).build();
const disjointCommand = disjointHost.prepareCommand({}, { type: 'go', payload: {} });
const extra: number | undefined = disjointCommand.extra;
const disjointEvent = disjointHost.process({}, disjointCommand)[0]!;
const observed: boolean | undefined = disjointEvent.observed;
// @ts-expect-error Multiple disjoint array members are possible, not guaranteed.
const requiredExtra: number = disjointCommand.extra;
const bound = createAggregatePluginFor(base, 'bound').state(() => ({ count: 0 }))
  .commandEnvelope<Body>(() => ({ mode: 'trace', traceId: 'one' }))
  .eventEnvelope<Body>(() => ({ mode: 'audit', auditId: 1 })).build();
const boundList: (typeof bound)[] = [];
const boundHost = root.plugins(...boundList).build().withPlugins(trace);
const boundEvent = boundHost.process(boundHost.initialState, { type: 'go', payload: {} })[0]!;
const boundMode: 'trace' = boundEvent.mode;
// @ts-expect-error Array-mounted state remains optional and readonly.
boundHost.initialState.bound.count = 1;
void [extra, observed, requiredExtra, boundMode];

for (const host of checkedHosts(base.withPlugins(union), root.plugins(union).build(),
  base.withPlugins(union).withPlugins(disjoint), root.plugins(union).build().withPlugins(disjoint))) {
  const command = host.prepareCommand({}, { type: 'go', payload: {} });
  const event = host.process({}, command)[0]!;
  for (const envelope of [command, event]) {
    if (envelope.mode === 'trace') {
      const traceId: string = envelope.traceId;
      // @ts-expect-error Required tuples preserve exact union branches too.
      envelope.auditId;
      void traceId;
    } else {
      const auditId: number = envelope.auditId;
      // @ts-expect-error Required audit branches never acquire trace fields.
      envelope.traceId;
      void auditId;
    }
  }
}
const disjointShape: ReturnType<typeof disjointHost.prepareCommand> = {
  id: 'id', type: 'go', payload: {}, mode: 'trace', traceId: 'one', extra: 1
};
const absentShape: ReturnType<typeof disjointHost.prepareCommand> = { id: 'id', type: 'go', payload: {} };
const optionalOnly = base.withPlugins(absent).prepareCommand({}, { type: 'go', payload: {} });
const maybeAudit: number | undefined = optionalOnly.auditId;
// @ts-expect-error An optional descriptor cannot promise its output field.
const requiredAudit: number = optionalOnly.auditId;
const boundTuple = root.plugins(bound).build().withPlugins(disjoint);
const boundTupleCommand = boundTuple.prepareCommand(boundTuple.initialState, { type: 'go', payload: {} });
if (boundTupleCommand.mode === 'trace') {
  const boundTrace: string = boundTupleCommand.traceId;
  void boundTrace;
}
// @ts-expect-error Required stateful namespaces remain readonly.
boundTuple.initialState.bound.count = 1;
void [disjointShape, absentShape, maybeAudit, requiredAudit];

const readonlyList: readonly (typeof bound)[] = [];
const readonlyHost = base.withPlugins(...readonlyList).withPlugins(trace).withPlugins(disjoint);
const readonlyCommand = readonlyHost.prepareCommand(readonlyHost.initialState, { type: 'go', payload: {} });
const readonlyMode: 'trace' = readonlyCommand.mode;
const boundAbsent: AggregateEventPlugin<'boundAbsent', { count: number }, typeof base,
  { mode: 'audit'; auditId: number }, { mode: 'audit'; headers: { auditId: number } }> = {
  ...createAggregatePluginFor(base, 'boundAbsent').state(() => ({ count: 0 })).build(),
  commandEnvelope: undefined, eventEnvelope: undefined
};
const boundAbsentHost = root.plugins(boundAbsent).plugins(trace).build().withPlugins(disjoint);
const boundAbsentCommand = boundAbsentHost.prepareCommand(boundAbsentHost.initialState, { type: 'go', payload: {} });
const boundAbsentMode: 'trace' = boundAbsentCommand.mode;
const boundAbsentEvent = boundAbsentHost.process(boundAbsentHost.initialState, boundAbsentCommand)[0]!;
const boundAbsentHeader: string = boundAbsentEvent.headers.traceId;
// @ts-expect-error Absent source-bound descriptors cannot pollute guaranteed header keys.
boundAbsentEvent.headers.auditId;
void [readonlyMode, boundAbsentMode, boundAbsentHeader];

const optionalKey = createAggregatePlugin('optionalKey').commandEnvelope<{ mode?: 'other' }>(() => ({}))
  .eventEnvelope<{ mode?: 'other' }>(() => ({})).build();
const optionalKeyHost = base.withPlugins(optionalKey, absent);
const optionalKeyCommand = optionalKeyHost.prepareCommand({}, { type: 'go', payload: {} });
const optionalKeyEvent = optionalKeyHost.process({}, optionalKeyCommand)[0]!;
// Either writer may omit the key; an optional output key is not a collision guarantee.
const optionalKeyShape: typeof optionalKeyCommand = { id: 'id', type: 'go', payload: {}, mode: 'audit', auditId: 1 };
const optionalKeyEventShape: typeof optionalKeyEvent = { id: 'id', type: 'changed.event', payload: {}, mode: 'audit' };
void [optionalKeyShape, optionalKeyEventShape];
