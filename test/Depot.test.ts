import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../src/createAggregate';
import { createDepot, EventStore } from '../src/Depot';
import { createLegacyAggregateBridge } from '../src/createMirage';
import { Event, RedemeinePlugin } from '../src/types';

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

  test('runs hydrate and append plugins sequentially with payload mutation support', async () => {
    const interceptOrder: string[] = [];

    const aggregateWithMeta = createAggregate<S, 'order'>('order', { id: 'o1', count: 0 })
      .events({
        created: {
          projector: (state: S, event: Event<{ id: string }>) => {
            state.id = event.payload.id;
          },
          meta: { eventMeta: 'created' }
        },
        incremented: {
          projector: (state: S, event: Event<{ amount: number }>) => {
            state.count += event.payload.amount;
          },
          meta: { eventMeta: 'incremented' }
        }
      })
      .commands(() => ({
        create: (state, id: string) => ({ type: 'order.created.event', payload: { id } }),
        increment: {
          handler: (state: S, amount: number) => ({ type: 'order.incremented.event', payload: { amount } }),
          meta: { commandMeta: 'increment' }
        }
      }))
      .build();

    const saveCalls: Array<{ id: string; events: Event[] }> = [];
    const store: EventStore = {
      getEvents: async () => [
        { type: 'order.created.event', payload: { id: 'o1' } },
        { type: 'order.incremented.event', payload: { amount: 1 } }
      ],
      saveEvents: async (id: string, events: Event[]) => {
        saveCalls.push({ id, events });
      }
    };

    const plugins: RedemeinePlugin[] = [
      {
        onHydrateEvent: async (ctx) => {
          interceptOrder.push(`hydrate-1:${ctx.eventType}:${String((ctx.meta as any)?.eventMeta)}`);
          if (ctx.eventType === 'order.incremented.event') {
            return { amount: (ctx.payload as any).amount + 1 };
          }
        },
        onBeforeAppend: async (ctx) => {
          interceptOrder.push(`append-1:${ctx.eventType}`);
          if (ctx.eventType === 'order.incremented.event') {
            return { amount: (ctx.payload as any).amount + 10 };
          }
        }
      },
      {
        onHydrateEvent: async (ctx) => {
          interceptOrder.push(`hydrate-2:${ctx.eventType}`);
          if (ctx.eventType === 'order.incremented.event') {
            (ctx.payload as any).amount += 2;
          }
        },
        onBeforeAppend: async (ctx) => {
          interceptOrder.push(`append-2:${ctx.eventType}:${String((ctx.meta as any)?.eventMeta)}`);
          if (ctx.eventType === 'order.incremented.event') {
            (ctx.payload as any).amount += 20;
          }
        }
      }
    ];

    const depot = createDepot(aggregateWithMeta, store, { plugins });
    const mirage = await depot.get('o1');

    expect(mirage.count).toBe(4);

    await mirage.increment(3);
    await depot.save(mirage);

    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0].events[0].payload).toEqual({ amount: 33 });
    expect(interceptOrder).toEqual([
      'hydrate-1:order.created.event:created',
      'hydrate-2:order.created.event',
      'hydrate-1:order.incremented.event:incremented',
      'hydrate-2:order.incremented.event',
      'append-1:order.incremented.event',
      'append-2:order.incremented.event:incremented'
    ]);
  });

  test('runs onAfterCommit sequentially with normalized intents payload', async () => {
    type PluginShape = { intents: { traceId?: string; notified?: boolean } };

    const aggregateWithIntents = createAggregate<S, 'order', Record<string, unknown>, PluginShape>('order', { id: 'o1', count: 0 })
      .events({
        incremented: (state, event: Event<{ amount: number }>) => {
          state.count += event.payload.amount;
        }
      })
      .commands(() => ({
        increment: {
          handler: (state: S, amount: number) => ({
            events: [{ type: 'order.incremented.event', payload: { amount } }],
            traceId: 'trace-123',
            notified: true
          })
        }
      }))
      .build();

    const calls: string[] = [];
    const store: EventStore = {
      getEvents: async () => [],
      saveEvents: async () => {
        calls.push('save');
      }
    };

    const plugins: RedemeinePlugin<PluginShape>[] = [
      {
        onAfterCommit: async (ctx) => {
          calls.push(`after-1:${ctx.aggregateId}:${ctx.events.length}:${String(ctx.intents.traceId)}`);
        }
      },
      {
        onAfterCommit: async (ctx) => {
          calls.push(`after-2:${String(ctx.intents.notified)}`);
        }
      }
    ];

    const depot = createDepot(aggregateWithIntents, store, { plugins });
    const mirage = await depot.get('o1');
    await mirage.increment(2);
    await depot.save(mirage);

    expect(calls).toEqual([
      'save',
      'after-1:o1:1:trace-123',
      'after-2:true'
    ]);
  });

  test('does not execute onAfterCommit side-effects when save fails', async () => {
    const calls: string[] = [];
    const store: EventStore = {
      getEvents: async () => [],
      saveEvents: async () => {
        calls.push('save');
        throw new Error('save-failed');
      }
    };

    const plugins: RedemeinePlugin[] = [
      {
        onAfterCommit: async () => {
          calls.push('after');
        }
      }
    ];

    const depot = createDepot(aggregate, store, { plugins });
    const mirage = await depot.get('o1');
    await mirage.increment(1);

    await expect(depot.save(mirage)).rejects.toThrow('save-failed');
    expect(calls).toEqual(['save']);
  });

  test('composes builder plugins before depot runtime plugins', async () => {
    const calls: string[] = [];

    const aggregateWithBuilderPlugin = createAggregate<S, 'order'>('order', { id: 'o1', count: 0 })
      .plugins({
        onBeforeAppend: async () => {
          calls.push('builder-before-append');
        }
      })
      .events({
        incremented: (state, event: Event<{ amount: number }>) => {
          state.count += event.payload.amount;
        }
      })
      .commands((emit) => ({
        increment: (state, amount: number) => emit.incremented({ amount })
      }))
      .build();

    const store: EventStore = {
      getEvents: async () => [],
      saveEvents: async () => {
        calls.push('save');
      }
    };

    const depot = createDepot(aggregateWithBuilderPlugin, store, {
      plugins: [{
        onBeforeAppend: async () => {
          calls.push('runtime-before-append');
        }
      }]
    });

    const mirage = await depot.get('o1');
    await mirage.increment(1);
    await depot.save(mirage);

    expect(calls).toEqual(['builder-before-append', 'runtime-before-append', 'save']);
  });
});
