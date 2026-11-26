import { createAggregate, createEntity, createMixin } from '../../../aggregate/src';
import type { Event } from '../../../kernel/src';

type State = { count: number };
const audited = createMixin<State>().events({
    audited: (state, event: Event<{ code: string }>) => { state.count = event.payload.code.length; },
}).build();
const counted = createMixin<State>().events({
    counted: (state, event: Event<{ amount: number }>) => { state.count = event.payload.amount; },
}).build();
const row = createEntity('row', { id: '', value: 0 }).events({
    changed: (state, event: Event<{ value: number }>) => { state.value = event.payload.value; },
}).build();
const mounted = createMixin<State>().entityMap('rows', row).build();
const combined = createMixin<State>().events({
    combined: (_state, _event: Event<{ enabled: boolean }>) => {},
}).entityList('items', row).build();
const base = createAggregate('base', { count: 0 }).mixins(audited);
export const aggregate = createAggregate('host', { count: 0 }).extends(base)
    .mixins(counted, mounted).mixins(combined).build();
export const together = createAggregate('host', { count: 0 }).mixins(audited, counted).build();
export const separate = createAggregate('host', { count: 0 }).mixins(audited).mixins(counted).build();
type Registry = NonNullable<typeof aggregate.__registryType>;
const mapKind: Registry['rows']['kind'] = 'map';
const listKind: Registry['items']['kind'] = 'list';
const typedEmitter = createAggregate('typed', { count: 0 }).events({ root: () => {} }).mixins(audited).build();
// @ts-expect-error direct mixins must not broaden the root emitter's declared E
const untyped: { code: string } = typedEmitter.eventCreators.audited({ code: 'unchanged root API' }).payload;
// @ts-expect-error direct mixins do not become root pure declarations
typedEmitter.pure.eventProjectors.audited;
export const repeated = createAggregate('host', { count: 0 }).mixins(audited, audited).build();
export const rootCollision = createAggregate('host', { count: 0 })
    .events({ audited: (_state, _event: Event<{ other: number }>) => {} }).mixins(audited).build();
export const mixinCollision = createAggregate('host', { count: 0 }).mixins(audited,
    createMixin<State>().events({ audited: (_state, _event: Event<{ other: boolean }>) => {} }).build()).build();
export const dottedCollision = createAggregate('host', { count: 0 }).mixins(
    createMixin<State>().events({ 'rows.changed': (_state, _event: Event<{ other: boolean }>) => {} }).build(), mounted).build();
export const structural = createAggregate('host', { count: 0 }).mixins({
    __stateType: undefined as State | undefined,
    projectors: { fake: (_state: State, _event: Event<{ value: number }>) => {} },
}).build();
const replaced = { ...audited, projectors: {
    structural: (_state: State, _event: Event<{ value: number }>) => {},
} };
export const replacedProjectors = createAggregate('host', { count: 0 }).mixins(replaced).build();
const intersected: typeof audited & { projectors: typeof replaced.projectors } = { ...audited,
    projectors: { ...audited.projectors, ...replaced.projectors },
};
export const intersectedProjectors = createAggregate('host', { count: 0 }).mixins(intersected).build();
const { projectors: _projectors, ...withoutProjectors } = audited;
const eventsOnly: Omit<typeof audited, 'projectors'> = withoutProjectors;
export const eventsFallback = createAggregate('host', { count: 0 }).mixins(eventsOnly).build();
const undefinedOnly: typeof eventsOnly & { projectors: undefined } = { ...eventsOnly, projectors: undefined };
export const undefinedProjectors = createAggregate('host', { count: 0 })
    .mixins(undefinedOnly).build();
const replacedEvents: Omit<typeof audited, 'events'> & { events: typeof replaced.projectors } = { ...audited,
    events: { structural: (_state: State, _event: Event<{ value: number }>) => {} },
};
export const ignoredEvents = createAggregate('host', { count: 0 }).mixins(replacedEvents).build();
const optionalProjectors: Omit<typeof audited, 'projectors'> & { projectors?: typeof audited.projectors } = audited;
export const uncertainProjectors = createAggregate('host', { count: 0 }).mixins(optionalProjectors).build();
export const prototypeEvents = createAggregate('host', { count: 0 }).mixins(createMixin<State>().events({
    ['__proto__']: (state: State, event: Event<{ count: number }>) => { state.count = event.payload.count; },
    constructor: (state: State, event: Event<{ count: number }>) => { state.count = event.payload.count + 1; },
    toString: (state: State, event: Event<{ count: number }>) => { state.count = event.payload.count + 2; },
}).build()).build();
throw Error('APPLICATION_EXECUTED');
