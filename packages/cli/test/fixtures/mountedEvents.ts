import { createAggregate, createEntity } from '../../../aggregate/src';
import type { Event } from '../../../kernel/src';

const leaf = createEntity('leaf', { stateOnly: 0 }).events({
    registered: (state, event: Event<{ label: string }>) => { state.stateOnly = event.payload.label.length; },
}).build();
const parent = createEntity('parent', { stateOnly: 0 })
    .entityMap('children', leaf, { knownKeys: ['one'] }).build();
const otherParent = createEntity('otherParent', { stateOnly: 0 }).entityList('children', parent).build();
const base = createAggregate('base', { count: 0, empty: [] as readonly string[] }).entityList('inherited', leaf);
const mixin = createAggregate('mixin', { count: 0, empty: [] as readonly string[] }).entityMap('mixed', leaf)
    .events({ mixinOnly: (_state, _event: Event<{ direct: boolean }>) => {} }).build();
export const aggregate = createAggregate('mounted', { count: 0, empty: [] as readonly string[] })
    .extends(base).mixins(mixin)
    .events({ changed: (state, event: Event<{ count: number }>) => { state.count = event.payload.count; } })
    .entityList('items', leaf)
    .entityList('items', leaf, {}, { semanticName: 'semantic', eventNameOverrides: { registered: 'full.wire.event' } })
    .entityMap('byKey', leaf, {}, { eventNameOverrides: { registered: 'relative' } })
    .entityList('parents', parent)
    .entityMap('deep', otherParent)
    .naming({ event: () => 'custom.wire.event' })
    .build();
export const collision = createAggregate('collision', { count: 0 })
    .events({ 'children.registered': (_state, _event: Event<{ root: boolean }>) => {} })
    .entityList('children', leaf).build();
