import { createAggregate, createAggregatePlugin, createAggregatePluginFor, type AggregateEventPlugin } from '../../../src';

type Host = { prepareCommand: (...args: never[]) => unknown; process: (...args: never[]) => readonly unknown[] };
type Usable<H extends Host> = [ReturnType<H['prepareCommand']>] extends [never] ? never
  : [ReturnType<H['process']>[number]] extends [never] ? never : H;
type Actual<T extends string> = { id: string; type: T; payload: {}; mode: 'a'; value: number };
type AdmitsActual<H extends Host> = Actual<'go'> extends ReturnType<H['prepareCommand']>
  ? Actual<'changed.event'> extends ReturnType<H['process']>[number] ? Usable<H> : never : never;
function checked<const H extends readonly Host[]>(...hosts: H & { [K in keyof H]: AdmitsActual<H[K]> }): H {
  return hosts;
}
const root = createAggregate('compositionSoundness', {}).commands(() => ({ go: () => ({ type: 'changed', payload: {} }) }));
const base = root.build();
type Body = { mode?: 'a'; value?: string } | { mode?: 'b'; value?: number };
const a = createAggregatePlugin('a').commandEnvelope<Body>(() => ({ mode: 'a' }))
  .eventEnvelope<Body>(() => ({ mode: 'a' })).build();
const b = createAggregatePlugin('b').commandEnvelope<Body>(() => ({ value: 123 }))
  .eventEnvelope<Body>(() => ({ value: 123 })).build();
const list: (typeof a | typeof b)[] = [a, b];
const empty: (typeof a | typeof b)[] = [];
const optionalA: AggregateEventPlugin<'a', undefined, undefined, Body, Body> = a;
const optionalB: AggregateEventPlugin<'b', undefined, undefined, Body, Body> = b;
const bound = createAggregatePluginFor(base, 'bound').commandEnvelope<Body>(() => ({ value: 123 }))
  .eventEnvelope<Body>(() => ({ value: 123 })).build();
const boundList: (typeof bound)[] = [];
for (const host of checked(base.withPlugins(...list), base.withPlugins(...empty), root.plugins(...list).build(),
  root.plugins(...empty).build(), base.withPlugins(optionalA, optionalB),
  base.withPlugins(optionalB).withPlugins(optionalA), root.plugins(optionalA).plugins(optionalB).build(),
  createAggregate('inherited', {}).extends(root.plugins(...list)).build(), root.plugins(...boundList).build(),
  base.withPlugins(optionalA), root.plugins(optionalB).build())) {
  const command = host.prepareCommand(host.initialState, { type: 'go', payload: {} });
  const event = host.process(host.initialState, command)[0]!;
  const actualCommand: typeof command = { id: 'id', type: 'go', payload: {}, mode: 'a', value: 123 };
  const actualEvent: typeof event = { id: 'id', type: 'changed.event', payload: {}, mode: 'a', value: 123 };
  for (const envelope of [command, event]) {
    if (envelope.mode === 'a' && envelope.value !== undefined) {
      // @ts-expect-error Possible fields are independent, even for structurally identical output unions.
      envelope.value.toUpperCase();
    }
  }
  void [actualCommand, actualEvent];
}

type Pattern = Record<`extra_${string}`, string>;
type Broad = Record<string, string>;
type Open = { [key: `extra_${string}`]: string; marker: boolean };
const pattern = createAggregatePlugin('pattern').commandEnvelope<Pattern>(() => ({})).eventEnvelope<Pattern>(() => ({})).build();
// Structural registration probes composition without bypassing the builder's reserved-key validation.
const broad: AggregateEventPlugin<'broad', undefined, undefined, Broad, {}, true, false> = {
  ...createAggregatePlugin('broad').build(),
  commandEnvelope: { initialize: () => ({}), parser: undefined, recipes: [] }
};
const open = createAggregatePlugin('open').commandEnvelope<Open>(() => ({ marker: true }))
  .eventEnvelope<Open>(() => ({ marker: true })).build();
const literal = createAggregatePlugin('literal').commandEnvelope(() => ({ extra_value: 123 }))
  .eventEnvelope(() => ({ extra_value: 123 })).build();
const headers = createAggregatePlugin('headers').eventEnvelope(() => ({ headers: { traceId: 'one' } })).build();
type Exact<H extends Host> = ReturnType<H['prepareCommand']> extends { extra_value: number }
  ? ReturnType<H['process']>[number] extends { extra_value: number } ? Usable<H> : never : never;
function exact<const H extends readonly Host[]>(...hosts: H & { [K in keyof H]: Exact<H[K]> }): H {
  return hosts;
}
const possiblePattern: (typeof pattern)[] = [];
for (const host of exact(base.withPlugins(pattern, literal), base.withPlugins(literal, pattern),
  root.plugins(pattern, literal).build(), root.plugins(literal, pattern).build(),
  base.withPlugins(pattern).withPlugins(literal), base.withPlugins(literal).withPlugins(pattern),
  root.plugins(pattern).plugins(literal).build(), root.plugins(literal).plugins(pattern).build(),
  createAggregate('inheritedPattern', {}).extends(root.plugins(pattern)).plugins(literal).build(),
  base.withPlugins(broad, literal), base.withPlugins(literal, broad),
  root.plugins(broad, literal).build(), root.plugins(literal, broad).build(),
  base.withPlugins(broad).withPlugins(literal), base.withPlugins(literal).withPlugins(broad),
  root.plugins(broad).plugins(literal).build(), root.plugins(literal).plugins(broad).build(),
  base.withPlugins(open, literal), base.withPlugins(literal, open),
  root.plugins(open, literal).build(), root.plugins(literal, open).build(),
  base.withPlugins(open).withPlugins(literal), base.withPlugins(literal).withPlugins(open),
  root.plugins(open).plugins(literal).build(), root.plugins(literal).plugins(open).build(),
  root.plugins(...possiblePattern).plugins(literal).build(), base.withPlugins(literal).withPlugins(...possiblePattern))) {
  const command = host.prepareCommand(host.initialState, { type: 'go', payload: {} });
  const event = host.process(host.initialState, command)[0]!;
  const c: number = command.extra_value;
  const e: number = event.extra_value;
  // @ts-expect-error Open extension slots cannot promise a string from an unenumerated writer.
  const unsafe: string | undefined = command.extra_other;
  void [c, e, unsafe];
}
const withHeaders = root.plugins(pattern, literal, headers).build();
const headerEvent = withHeaders.process({}, { type: 'go', payload: {} })[0]!;
const requiredHeader: string = headerEvent.headers.traceId;
const requiredNumber: number = headerEvent.extra_value;
// @ts-expect-error Guaranteed headers remain exact, not an open unknown record.
headerEvent.headers.missing;
void [requiredHeader, requiredNumber];
const openCommand = base.withPlugins(pattern, literal).prepareCommand({}, { type: 'go', payload: {} });
const unknownSlot: unknown = openCommand.extra_other;
// @ts-expect-error Unenumerated pattern slots are unknown, not string or undefined.
const unsafeSlot: string | undefined = openCommand.extra_other;
const canonicalId: string | undefined = openCommand.id;
const canonicalPayload: {} = openCommand.payload;
void [unknownSlot, unsafeSlot, canonicalId, canonicalPayload];
