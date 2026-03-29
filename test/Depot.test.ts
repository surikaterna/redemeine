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
      readStream: async function* (id: string) {
        requestedIds.push(id);
        yield { type: 'order.created.event', payload: { id: 'o9' } };
        yield { type: 'order.incremented.event', payload: { amount: 2 } };
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

  test('hydrates mirage from async iterable event replay', async () => {
    const store: EventStore = {
      readStream: async function* () {
        yield { type: 'order.created.event', payload: { id: 'streamed' } };
        yield { type: 'order.incremented.event', payload: { amount: 4 } };
      },
      saveEvents: async () => undefined
    };

    const depot = createDepot(aggregate, store);
    const mirage = await depot.get('streamed');
    const bridge = createLegacyAggregateBridge(mirage);

    expect(bridge._state.id).toBe('streamed');
    expect(bridge._state.count).toBe(4);
  });

  test('yields to event loop during long hydration replay', async () => {
    const totalEvents = 10000;
    let intervalTicks = 0;
    let replayStarted = false;
    let replayFinished = false;

    const store: EventStore = {
      readStream: async function* () {
        replayStarted = true;
        for (let index = 0; index < totalEvents; index++) {
          yield { type: 'order.incremented.event', payload: { amount: 1 } };
        }
        replayFinished = true;
      },
      saveEvents: async () => undefined
    };

    const interval = setInterval(() => {
      if (replayStarted && !replayFinished) {
        intervalTicks++;
      }
    }, 0);

    const depot = createDepot(aggregate, store);
    const mirage = await depot.get('yield-check');
    clearInterval(interval);

    expect(mirage.count).toBe(totalEvents);
    expect(intervalTicks).toBeGreaterThan(0);
  });

  test('persists uncommitted events and clears them', async () => {
    const saveCalls: Array<{ id: string; events: Event[]; expectedVersion?: number }> = [];
    const store: EventStore = {
      readStream: async function* () {},
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
      readStream: async function* () {},
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
      readStream: async function* () {
        yield { type: 'order.created.event', payload: { id: 'o1' } };
        yield { type: 'order.incremented.event', payload: { amount: 1 } };
      },
      saveEvents: async (id: string, events: Event[]) => {
        saveCalls.push({ id, events });
      }
    };

    const plugins: RedemeinePlugin[] = [
      {
        key: 'hydrate-first',
        onHydrateEvent: async (ctx) => {
          interceptOrder.push(`hydrate-1:${ctx.pluginKey}:${ctx.eventType}:${String((ctx.meta as any)?.eventMeta)}`);
          if (ctx.eventType === 'order.incremented.event') {
            return { amount: (ctx.payload as any).amount + 1 };
          }
        },
        onBeforeAppend: async (ctx) => {
          interceptOrder.push(`append-1:${ctx.pluginKey}:${ctx.eventType}`);
          if (ctx.eventType === 'order.incremented.event') {
            return { amount: (ctx.payload as any).amount + 10 };
          }
        }
      },
      {
        key: 'hydrate-second',
        onHydrateEvent: async (ctx) => {
          interceptOrder.push(`hydrate-2:${ctx.pluginKey}:${ctx.eventType}`);
          if (ctx.eventType === 'order.incremented.event') {
            (ctx.payload as any).amount += 2;
          }
        },
        onBeforeAppend: async (ctx) => {
          interceptOrder.push(`append-2:${ctx.pluginKey}:${ctx.eventType}:${String((ctx.meta as any)?.eventMeta)}`);
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
      'hydrate-1:hydrate-first:order.created.event:created',
      'hydrate-2:hydrate-second:order.created.event',
      'hydrate-1:hydrate-first:order.incremented.event:incremented',
      'hydrate-2:hydrate-second:order.incremented.event',
      'append-1:hydrate-first:order.incremented.event',
      'append-2:hydrate-second:order.incremented.event:incremented'
    ]);
  });

  test('runs onAfterCommit sequentially with normalized intents payload', async () => {
    type PluginShape = { intents: { audit: { traceId?: string; notified?: boolean } } };

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
            intents: {
              audit: {
                traceId: 'trace-123',
                notified: true
              }
            }
          })
        }
      }))
      .build();

    const calls: string[] = [];
    const savedBatches: Array<{ id: string; events: Event[]; expectedVersion?: number }> = [];
    const afterCommitPayloads: Array<{ aggregateId: string; events: Event[]; intents: Record<string, unknown> }> = [];
    const store: EventStore = {
      readStream: async function* () {},
      saveEvents: async (id: string, events: Event[], expectedVersion?: number) => {
        savedBatches.push({ id, events, expectedVersion });
        calls.push('save');
      }
    };

    const plugins: RedemeinePlugin<PluginShape>[] = [
      {
        key: 'audit-logger',
        onAfterCommit: async (ctx) => {
          afterCommitPayloads.push({
            aggregateId: ctx.aggregateId,
            events: ctx.events,
            intents: ctx.intents
          });
          calls.push(`after-1:${ctx.pluginKey}:${ctx.aggregateId}:${ctx.events.length}:${String(ctx.intents.audit.traceId)}`);
        }
      },
      {
        key: 'audit-notifier',
        onAfterCommit: async (ctx) => {
          calls.push(`after-2:${ctx.pluginKey}:${String(ctx.intents.audit.notified)}`);
        }
      }
    ];

    const depot = createDepot(aggregateWithIntents, store, { plugins });
    const mirage = await depot.get('o1');
    await mirage.increment(2);
    await depot.save(mirage);

    expect(savedBatches).toHaveLength(1);
    expect(savedBatches[0]).toMatchObject({
      id: 'o1',
      expectedVersion: 1,
      events: [{ type: 'order.incremented.event', payload: { amount: 2 } }]
    });
    expect(afterCommitPayloads).toHaveLength(1);
    expect(afterCommitPayloads[0]).toMatchObject({
      aggregateId: 'o1',
      events: [{ type: 'order.incremented.event', payload: { amount: 2 } }],
      intents: { audit: { traceId: 'trace-123', notified: true } }
    });

    expect(calls).toEqual([
      'save',
      'after-1:audit-logger:o1:1:trace-123',
      'after-2:audit-notifier:true'
    ]);
  });

  test('does not execute onAfterCommit side-effects when save fails', async () => {
    const calls: string[] = [];
    const store: EventStore = {
      readStream: async function* () {},
      saveEvents: async () => {
        calls.push('save');
        throw new Error('save-failed');
      }
    };

    const plugins: RedemeinePlugin[] = [
      {
        key: 'after-fail-check',
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

  test('does not execute side-effects when append interceptor throws and rejects cleanly', async () => {
    const calls: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.once('unhandledRejection', onUnhandledRejection);

    const store: EventStore = {
      readStream: async function* () {},
      saveEvents: async () => {
        calls.push('save');
      }
    };

    const plugins: RedemeinePlugin[] = [
      {
        key: 'append-fail',
        onBeforeAppend: async () => {
          throw new Error('append-failed');
        },
        onAfterCommit: async () => {
          calls.push('after');
        }
      }
    ];

    const depot = createDepot(aggregate, store, { plugins });
    const mirage = await depot.get('o1');
    await mirage.increment(1);

    await expect(depot.save(mirage)).rejects.toThrow('append-failed');
    expect(calls).toEqual([]);

    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener('unhandledRejection', onUnhandledRejection);
    expect(unhandled).toEqual([]);
  });

  test('composes builder plugins before depot runtime plugins', async () => {
    const calls: string[] = [];

    const aggregateWithBuilderPlugin = createAggregate<S, 'order'>('order', { id: 'o1', count: 0 })
      .plugins({
        key: 'builder',
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
      readStream: async function* () {},
      saveEvents: async () => {
        calls.push('save');
      }
    };

    const depot = createDepot(aggregateWithBuilderPlugin, store, {
      plugins: [{
        key: 'runtime',
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

  test('throws structured plugin hook error for onAfterCommit and clears pending results', async () => {
    const store: EventStore = {
      readStream: async function* () {},
      saveEvents: async () => undefined
    };

    const depot = createDepot(aggregate, store, {
      plugins: [{
        key: 'failing-after-commit',
        onAfterCommit: async () => {
          throw new Error('after-commit-failed');
        }
      }]
    });

    const mirage = await depot.get('o1');
    const bridge = createLegacyAggregateBridge(mirage);
    await mirage.increment(2);

    await expect(depot.save(mirage)).rejects.toMatchObject({
      name: 'RedemeinePluginHookError',
      pluginKey: 'failing-after-commit',
      hook: 'onAfterCommit',
      aggregateId: 'o1'
    });

    expect(bridge.getUncommittedEvents()).toEqual([]);
  });
});
