import { createAggregate, createEntity } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';

const child = createEntity('child', { id: '', value: '' }).events({
    changed: (state, event: Event<{ value: string }>) => { state.value = event.payload.value; },
}).commands(emit => ({ change: {
    pack: (input: { raw: string }) => ({ id: 'child', value: input.raw.trim() }),
    handler: (_state, payload: { id: string; value: string }) => [emit.changed(payload)],
} })).build();

const selectors: { getCoreState: (state: { count: number }) => { count: number } } = { getCoreState: state => state };
export const builder = createAggregate('registryCommands', { count: 0 })
    .selectors({ ...selectors, getCount: (state): number => state.count })
    .events({ accepted: (state, event: Event<{ count: number }>) => { state.count = event.payload.count; } })
    .commands(emit => ({ accept: (_state, payload: { count: number }) => [emit.accepted(payload)] }))
    .entityList('line', child).entityMap('note', child);
export const aggregate: ReturnType<typeof builder.build> = builder.build();

throw Error('REGISTRY_SOURCE_EXECUTED');
