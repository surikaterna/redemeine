import { createAggregate, createAggregatePlugin } from '../../../src';

const base = createAggregate('optionalEdges', {}).commands(() => ({ go: () => ({ type: 'changed', payload: {} }) })).build();
type A = { mode: 'a'; value?: string };
const a = createAggregatePlugin('a').commandEnvelope<A>(() => ({ mode: 'a' }))
  .eventEnvelope<A>(() => ({ mode: 'a' })).build();
const b = createAggregatePlugin('b').commandEnvelope<{ value?: number }>(() => ({ value: 123 }))
  .eventEnvelope<{ value?: number }>(() => ({ value: 123 })).build();
const host = base.withPlugins(a, b);
const command = host.prepareCommand({}, { type: 'go', payload: {} });
const event = host.process({}, { type: 'go', payload: {} })[0]!;
const numeric: typeof command = { id: 'id', type: 'go', payload: {}, mode: 'a', value: 123 };
const text: typeof command = { id: 'id', type: 'go', payload: {}, mode: 'a', value: 'text' };
const absent: typeof command = { id: 'id', type: 'go', payload: {}, mode: 'a' };
const numericEvent: typeof event = { id: 'id', type: 'changed.event', payload: {}, mode: 'a', value: 123 };
const absentEvent: typeof event = { id: 'id', type: 'changed.event', payload: {}, mode: 'a' };
type IsNever<T> = [T] extends [never] ? true : false;
const commandValueExists: IsNever<typeof command.value> = false;
const eventValueExists: IsNever<typeof event.value> = false;
// @ts-expect-error Two optional writers do not guarantee presence.
const requiredValue: string | number = command.value;
// @ts-expect-error Optional competing numbers cannot be narrowed to strings.
command.value?.toUpperCase();
// @ts-expect-error Events retain optional competing numbers as well.
event.value?.toUpperCase();

const undefinedWriter = createAggregatePlugin('undefinedWriter').commandEnvelope(() => ({ value: undefined }))
  .eventEnvelope(() => ({ value: undefined })).build();
const undefinedHost = base.withPlugins(a, undefinedWriter);
const undefinedCommand = undefinedHost.prepareCommand({}, { type: 'go', payload: {} });
const undefinedEvent = undefinedHost.process({}, { type: 'go', payload: {} })[0]!;
const commandUndefined: undefined = undefinedCommand.value;
const eventUndefined: undefined = undefinedEvent.value;
const undefinedValueExists: IsNever<typeof undefinedCommand.value> = false;
const undefinedEventValueExists: IsNever<typeof undefinedEvent.value> = false;
const ownUndefined: typeof undefinedCommand = { id: 'id', type: 'go', payload: {}, mode: 'a', value: undefined };
// @ts-expect-error Required own undefined is not an absent key, even with exact optional properties.
const missingUndefined: typeof undefinedCommand = { id: 'id', type: 'go', payload: {}, mode: 'a' };
// @ts-expect-error Required undefined cannot be narrowed into an optional writer's string.
const unsafeString: string = undefinedCommand.value;
// @ts-expect-error Events must also retain the required own undefined slot.
const missingEventUndefined: typeof undefinedEvent = { id: 'id', type: 'changed.event', payload: {}, mode: 'a' };

type Branches = { mode: 'a'; value?: string; left: true } | { mode: 'c'; value?: boolean; right: true };
const branches = createAggregatePlugin('branches').commandEnvelope<Branches>(() => ({ mode: 'a', left: true }))
  .eventEnvelope<Branches>(() => ({ mode: 'a', left: true })).build();
const required = createAggregatePlugin('required').commandEnvelope(() => ({ value: 123 }))
  .eventEnvelope(() => ({ value: 123 })).build();
const branchHost = base.withPlugins(branches).withPlugins(required);
const branchCommand = branchHost.prepareCommand({}, { type: 'go', payload: {} });
const branchEvent = branchHost.process({}, { type: 'go', payload: {} })[0]!;
const branchCommandExists: IsNever<typeof branchCommand> = false;
const branchEventExists: IsNever<typeof branchEvent> = false;
const branchValue: number = branchCommand.value;
const branchEventValue: number = branchEvent.value;
if (branchCommand.mode === 'a') {
  const left: true = branchCommand.left;
  // @ts-expect-error Guaranteed whole branches must not acquire their alternative's keys.
  branchCommand.right;
  void left;
}
if (branchEvent.mode === 'c') {
  const right: true = branchEvent.right;
  // @ts-expect-error Events preserve the same branch correlation.
  branchEvent.left;
  void right;
}
void [numeric, text, absent, numericEvent, absentEvent, commandValueExists, eventValueExists, requiredValue,
  commandUndefined, eventUndefined, undefinedValueExists, undefinedEventValueExists, ownUndefined, missingUndefined,
  unsafeString, missingEventUndefined, branchCommandExists, branchEventExists, branchValue, branchEventValue];
