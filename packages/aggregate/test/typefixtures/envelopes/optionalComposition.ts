import { createAggregate, createAggregatePlugin, type AggregateEventPlugin } from '../../../src';

const root = createAggregate('optionalComposition', {}).commands(() => ({ go: () => ({ type: 'changed', payload: {} }) }));
const base = root.build();
type A = { mode: 'a'; value?: string };
type B = { mode?: 'b'; value: number };
const a = createAggregatePlugin('a').commandEnvelope<A>(() => ({ mode: 'a' }))
  .eventEnvelope<A>(() => ({ mode: 'a' })).build();
const b = createAggregatePlugin('b').commandEnvelope<B>(() => ({ value: 123 }))
  .eventEnvelope<B>(() => ({ value: 123 })).build();
const list: (typeof a | typeof b)[] = [a, b];
const empty: (typeof a | typeof b)[] = [];
const optionalA: AggregateEventPlugin<'optionalA', undefined, undefined, A, A> = { ...a, id: 'optionalA' };
const optionalB: AggregateEventPlugin<'optionalB', undefined, undefined, B, B> = { ...b, id: 'optionalB' };
// The harness substitutes one host per strict program, never a union of host results.
const host = base.withPlugins(...list);
const command = host.prepareCommand({}, { type: 'go', payload: {}, rawExtra: 'discard' });
const event = host.process({}, { type: 'go', payload: {} })[0]!;
type IsNever<T> = [T] extends [never] ? true : false;
const commandExists: IsNever<typeof command> = false;
const eventExists: IsNever<typeof event> = false;
const commandValueExists: IsNever<typeof command.value> = false;
const eventValueExists: IsNever<typeof event.value> = false;
const goodCommand: typeof command = { id: 'id', type: 'go', payload: {}, mode: 'a', value: 123 };
const goodEvent: typeof event = { id: 'id', type: 'changed.event', payload: {}, mode: 'a', value: 123 };
if (command.mode === 'a' && command.value !== undefined) {
  // @ts-expect-error Another writer can supply a number when A omits its optional key.
  command.value.toUpperCase();
}
if (event.mode === 'a' && event.value !== undefined) {
  // @ts-expect-error Event composition must not falsely correlate optional anchor keys either.
  event.value.toUpperCase();
}
// @ts-expect-error Prepared commands still drop undeclared raw extras.
command.rawExtra;
void [optionalA, optionalB, empty, commandExists, eventExists, commandValueExists, eventValueExists, goodCommand, goodEvent];
