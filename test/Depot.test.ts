import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../src/createAggregate';
import { createDepot, EventStore } from '../src/Depot';
import { createLegacyAggregateBridge } from '../src/createMirage';
import { Event } from '../src/types';

type S = { id: string; count: number };

describe('Depot', () => {
  const aggregate = createAggregate<S, 'order'>('order', { id: 'o1', count: 0 })
    .events({
      created: (state, event: Event<{ id: string }>) => {
        state.id = event.payload.id;
      },
      incremented: (state, event: Event<{ amount: number }>) => {
        state.count += event.payload.amount;
      }
    })
    .commands((emit) => ({
      create: (state, id: string) => emit.created({ id }),
      increment: (state, amount: number) => emit.incremented({ amount })
    }))
    .build();

  test('hydrates mirage from event store', async () => {
    const requestedIds: string[] = [];
    const store: EventStore = {
      getEvents: async (id: string) => {
        requestedIds.push(id);
        return [
          { type: 'order.created.event', payload: { id: 'o9' } },
          { type: 'order.incremented.event', payload: { amount: 2 } }
        ];
      },
      saveEvents: async () => undefined
    };

    const depot = createDepot(aggregate, store);
    const mirage = await depot.get('o9');
    const bridge = createLegacyAggregateBridge(mirage);

    expect(requestedIds).toEqual(['o9']);
    expect(bridge._state.id).toBe('o9');
    expect(bridge._state.count).toBe(2);
  });

  test('persists uncommitted events and clears them', async () => {
    const saveCalls: Array<{ id: string; events: Event[]; expectedVersion?: number }> = [];
    const store: EventStore = {
      getEvents: async () => [],
      saveEvents: async (id: string, events: Event[], expectedVersion?: number) => {
        saveCalls.push({ id, events, expectedVersion });
      }
    };

    const depot = createDepot(aggregate, store);
    const mirage = await depot.get('o1');
    const bridge = createLegacyAggregateBridge(mirage);

    mirage.increment(3);
    expect(bridge.getUncommittedEvents().length).toBe(1);

    await depot.save(mirage);

    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].id).toBe('o1');
    expect(saveCalls[0].events.length).toBe(1);
    expect(saveCalls[0].expectedVersion).toBe(1);
    expect(bridge.getUncommittedEvents()).toEqual([]);
  });

  test('throws when saving non-mirage object', async () => {
    const store: EventStore = {
      getEvents: async () => [],
      saveEvents: async () => undefined
    };

    const depot = createDepot(aggregate, store);
    await expect(depot.save({} as any)).rejects.toThrow('Not a valid Mirage Instance');
  });
});
