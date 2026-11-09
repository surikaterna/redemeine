import { createAggregate, createEntity } from '../../../aggregate/src';
import type { Event } from '../../../kernel/src';

const child = createEntity('semanticChild', { key: '', label: '' }).events({
    registered: (state, event: Event<{ key: string; label: string }>) => { state.label = event.payload.label; },
}).commands(emit => ({ register: {
    pack: (label: string) => ({ key: 'one', label: label.trim() }),
    handler: (_state, payload: { key: string; label: string }) => [emit.registered(payload)],
} })).build();
const parent = createEntity('semanticParent', { id: '' }).entityMap('children', child).build();
export const aggregate = createAggregate('bindings', { count: 0 })
    .events({ changed: (state, event: Event<{ count: number }>) => { state.count = event.payload.count; } })
    .commands(() => ({ create: { pack: (count: string) => ({ count: Number(count) }),
        handler: (_state: { readonly count: number }, _payload: { count: number }) => [] } }))
    .overrideEventNames({ changed: 'shared.event' })
    .entityMap('items', child, {}, { semanticName: 'notTheSchemaId', eventNameOverrides: { registered: 'shared.event' } })
    .entityList('parents', parent)
    .naming({ command: (aggregate, member, scope) => `custom/${aggregate}/${scope ?? 'root'}/${member}` })
    .build();
