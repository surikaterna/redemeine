import { createAggregate } from '@redemeine/aggregate';
import { createMirage } from '../src/createMirage';
import { Event } from '@redemeine/kernel';
import { MirageHydrationError } from '../src/errors';

interface TestState {
    value: number;
    items: string[];
}

const initialState: TestState = { value: 0, items: [] };

const setupBuilder = () =>
    createAggregate<TestState, 'test'>('test', initialState)
        .events({
            incremented: (state: any, event: Event<number>) => {
                state.value += event.payload;
            },
            itemAdded: (state: any, event: Event<string>) => {
                state.items.push(event.payload);
            }
        })
        .commands((emit) => ({
            increment: (state: any, v: number) => emit.incremented(v),
            addItem: (state: any, v: string) => emit.itemAdded(v)
        }))
        .build();

describe('Hydration edge cases', () => {
    test('empty event list produces initial state', async () => {
        const builder = setupBuilder();
        const live = await createMirage(builder, 'h-empty', { events: [] });

        expect(live.value).toBe(0);
        expect(live.items).toEqual([]);
    });

    test('event replay preserves order', async () => {
        const builder = setupBuilder();
        const live = await createMirage(builder, 'h-order', {
            events: [
                { type: 'test.itemAdded.event', payload: 'first' },
                { type: 'test.itemAdded.event', payload: 'second' },
                { type: 'test.itemAdded.event', payload: 'third' }
            ]
        });

        expect(live.items).toEqual(['first', 'second', 'third']);
    });

    test('multiple event types replay correctly in sequence', async () => {
        const builder = setupBuilder();
        const live = await createMirage(builder, 'h-mixed', {
            events: [
                { type: 'test.incremented.event', payload: 5 },
                { type: 'test.incremented.event', payload: 3 },
                { type: 'test.itemAdded.event', payload: 'x' }
            ]
        });

        expect(live.value).toBe(8);
        expect(live.items).toEqual(['x']);
    });

    test('throws MirageHydrationError when event handler fails', async () => {
        const builder = createAggregate<TestState, 'err'>('err', initialState)
            .events({
                broken: () => {
                    throw new Error('handler exploded');
                }
            })
            .commands(() => ({}))
            .build();

        await expect(
            createMirage(builder, 'h-err', {
                events: [{ type: 'err.broken.event', payload: null }]
            })
        ).rejects.toThrow(MirageHydrationError);
    });
});
