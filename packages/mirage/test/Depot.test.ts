
import { createAggregate } from '@redemeine/aggregate';
import { createDepot, EventStore } from '../src/Depot';
import { extractUncommittedEvents, MirageCoreSymbol } from '../src/createMirage';
import type { MirageCore } from '../src/MirageCore';
import { Event, RedemeinePlugin } from '@redemeine/kernel';

type S = { id: string; count: number };

const coreOf = (live: unknown) => (live as { [MirageCoreSymbol]: MirageCore<S> })[MirageCoreSymbol];
const incrementEvent = (amount: number): Event => ({ type: 'order.incremented.event', payload: { amount } });

function enforcingStore(initial: Event[] = []) {
  const stream = [...initial];
  const reads: Array<number | undefined> = [];
  const expectedCounts: Array<number | undefined> = [];
  const store: EventStore = {
    readStream: async function* (_id, options) {
      reads.push(options?.fromVersion);
      yield* stream.slice((options?.fromVersion ?? 1) - 1);
    },
    saveEvents: async (_id, events, expectedVersion) => {
      expectedCounts.push(expectedVersion);
      if (expectedVersion !== stream.length) throw new Error('stale event count');
      stream.push(...events);
    }
  };
  return { store, stream, reads, expectedCounts };
}

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
      increment: (state, amount: number) => emit.incremented({ amount }),
      batch: {
        pack: (amounts: number[]) => ({ amounts }),
        handler: (_state, { amounts }) => amounts.map(amount => emit.incremented({ amount }))
      }
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

    expect(requestedIds).toEqual(['o9']);
    expect(mirage.id).toBe('o9');
    expect(mirage.count).toBe(2);
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

    expect(mirage.id).toBe('streamed');
    expect(mirage.count).toBe(4);
  });

  test('replays from beginning when no snapshot is provided', async () => {
    const readOptions: Array<{ fromVersion?: number } | undefined> = [];
    const store: EventStore = {
      readStream: async function* (_id: string, options?: { fromVersion?: number }) {
        readOptions.push(options);
        yield { type: 'order.created.event', payload: { id: 'o1' } };
        yield { type: 'order.incremented.event', payload: { amount: 3 } };
      },
      saveEvents: async () => undefined
    };

    const depot = createDepot(aggregate, store);
    const mirage = await depot.get('o1');

    expect(readOptions).toEqual([undefined]);
    expect(mirage.count).toBe(3);
  });

  test('uses snapshot version boundary and skips replay when snapshot is current', async () => {
    const readOptions: Array<{ fromVersion?: number } | undefined> = [];
    const store: EventStore = {
      readStream: async function* (_id: string, options?: { fromVersion?: number }) {
        readOptions.push(options);
        const events: Array<Event<{ amount: number }> & { version: number }> = [
          { type: 'order.incremented.event', payload: { amount: 1 }, version: 1 },
          { type: 'order.incremented.event', payload: { amount: 2 }, version: 2 },
          { type: 'order.incremented.event', payload: { amount: 3 }, version: 3 }
        ];

        const fromVersion = options?.fromVersion ?? 1;
        for (const event of events) {
          if ((event as any).version >= fromVersion) {
            yield event;
          }
        }
      },
      saveEvents: async () => undefined
    };

    const depot = createDepot(aggregate, store);
    const mirage = await depot.get('o1', {
      snapshot: {
        state: { id: 'o1', count: 6 },
        version: 3
      }
    });

    expect(readOptions).toEqual([{ fromVersion: 4 }]);
    expect(mirage.count).toBe(6);
  });

  test('replays strictly after snapshot version (off-by-one semantics)', async () => {
    const readOptions: Array<{ fromVersion?: number } | undefined> = [];
    const store: EventStore = {
      readStream: async function* (_id: string, options?: { fromVersion?: number }) {
        readOptions.push(options);
        const events: Array<Event<{ amount: number }> & { version: number }> = [
          { type: 'order.incremented.event', payload: { amount: 100 }, version: 1 },
          { type: 'order.incremented.event', payload: { amount: 7 }, version: 2 }
        ];

        const fromVersion = options?.fromVersion ?? 1;
        for (const event of events) {
          if ((event as any).version >= fromVersion) {
            yield event;
          }
        }
      },
      saveEvents: async () => undefined
    };

    const depot = createDepot(aggregate, store);
    const mirage = await depot.get('o1', {
      snapshot: {
        state: { id: 'o1', count: 5 },
        version: 1
      }
    });

    expect(readOptions).toEqual([{ fromVersion: 2 }]);
    expect(mirage.count).toBe(12);
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
    expect(coreOf(mirage).version).toBe(totalEvents);
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

    mirage.increment(3);
    expect(extractUncommittedEvents(mirage).length).toBe(1);

    await depot.save(mirage);

    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].id).toBe('o1');
    expect(saveCalls[0].events.length).toBe(1);
    expect(saveCalls[0].expectedVersion).toBe(0);
    expect(extractUncommittedEvents(mirage)).toEqual([]);
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
      expectedVersion: 0,
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
    expect(coreOf(mirage).version).toBe(1);
    expect(extractUncommittedEvents(mirage)).toHaveLength(1);
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
    expect(coreOf(mirage).version).toBe(1);
    expect(extractUncommittedEvents(mirage)).toHaveLength(1);

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
    await mirage.increment(2);

    await expect(depot.save(mirage)).rejects.toMatchObject({
      name: 'RedemeinePluginHookError',
      pluginKey: 'failing-after-commit',
      hook: 'onAfterCommit',
      aggregateId: 'o1'
    });

    expect(extractUncommittedEvents(mirage)).toEqual([]);
    expect(coreOf(mirage).version).toBe(1);
  });

  test('compare-and-append accepts multi-event and accumulated commands with pre-append counts', async () => {
    const fixture = enforcingStore();
    const depot = createDepot(aggregate, fixture.store);
    const live = await depot.get('o1');
    await depot.save(live);
    live.batch([1, 2]);
    live.increment(3);
    expect(coreOf(live).version).toBe(3);
    await depot.save(live);
    live.batch([4, 5]);
    await depot.save(live);
    await depot.save(live);
    expect(fixture.expectedCounts).toEqual([0, 0, 3, 5]);
    expect(fixture.stream).toHaveLength(5);
    expect(live.count).toBe(15);
    expect(coreOf(live).version).toBe(5);
    expect(extractUncommittedEvents(live)).toEqual([]);
  });

  test.each([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1])('preserves exact Depot append counts and pending prefix at ceiling baseline %s', async (initialVersion) => {
    // Represent an authoritative persisted prefix without allocating MAX_SAFE_INTEGER events.
    let persistedCount = initialVersion;
    const appended: Event[] = [];
    const expectedCounts: Array<number | undefined> = [];
    const store: EventStore = {
      readStream: async function* (_id, options) {
        expect(options?.fromVersion).toBe(initialVersion + 1);
      },
      saveEvents: async (_id, events, expectedVersion) => {
        if (expectedVersion !== persistedCount) throw new Error('stale event count');
        if (!Number.isSafeInteger(persistedCount + events.length)) throw new RangeError('store ceiling');
        expectedCounts.push(expectedVersion);
        appended.push(...events);
        persistedCount += events.length;
      }
    };
    const depot = createDepot(aggregate, store);
    const live = await depot.get('o1', { snapshot: { state: { id: 'o1', count: 0 }, version: initialVersion } });
    const prefixCount = Number.MAX_SAFE_INTEGER - initialVersion;
    expect(() => live.batch([1, 2])).toThrow(RangeError);
    expect(coreOf(live).version).toBe(Number.MAX_SAFE_INTEGER);
    expect(live.count).toBe(prefixCount);
    expect(extractUncommittedEvents(live)).toHaveLength(prefixCount);
    expect(() => live.increment(3)).toThrow(RangeError);
    expect(extractUncommittedEvents(live)).toHaveLength(prefixCount);
    await expect(store.saveEvents('o1', [], initialVersion - 1)).rejects.toThrow('stale event count');
    await depot.save(live);
    expect(expectedCounts).toEqual([initialVersion]);
    expect(appended).toHaveLength(prefixCount);
    expect(persistedCount).toBe(Number.MAX_SAFE_INTEGER);
    expect(extractUncommittedEvents(live)).toEqual([]);
    expect(() => live.increment(4)).toThrow(RangeError);
    await depot.save(live);
    expect(expectedCounts).toEqual([initialVersion, Number.MAX_SAFE_INTEGER]);
    expect(appended).toHaveLength(prefixCount);
  });

  test.each([1, 2])('Depot accepts only a safe snapshot tail of %s events at MAX - 1', async (tailLength) => {
    const baseline = Number.MAX_SAFE_INTEGER - 1;
    const store: EventStore = {
      readStream: async function* (_id, options) {
        expect(options?.fromVersion).toBe(Number.MAX_SAFE_INTEGER);
        for (let index = 0; index < tailLength; index++) yield incrementEvent(1);
      },
      saveEvents: async () => {}
    };
    const depot = createDepot(aggregate, store);
    const loading = depot.get('o1', { snapshot: { state: { id: 'o1', count: 0 }, version: baseline } });
    if (tailLength === 2) {
      await expect(loading).rejects.toThrow(RangeError);
      return;
    }
    const live = await loading;
    expect(coreOf(live).version).toBe(Number.MAX_SAFE_INTEGER);
    expect(live.count).toBe(1);
    expect(extractUncommittedEvents(live)).toEqual([]);
  });

  test.each(['full', 'tail', 'current', 'zero', 'seed'] as const)('hydrates %s and saves against actual stream count', async (mode) => {
    const fixture = enforcingStore([incrementEvent(1), incrementEvent(2), incrementEvent(3)]);
    const depot = createDepot(aggregate, fixture.store);
    const baseline = mode === 'current' ? 3 : mode === 'tail' ? 1 : 0;
    const count = baseline === 3 ? 6 : baseline;
    const options = mode === 'full' ? undefined : mode === 'seed' ? { initialState: { id: 'o1', count: 10 } }
      : { snapshot: { state: { id: 'o1', count }, version: baseline } };
    const live = await depot.get('o1', options);
    expect(coreOf(live).version).toBe(3);
    expect(live.count).toBe(mode === 'seed' ? 16 : 6);
    expect(fixture.reads).toEqual([mode === 'full' || mode === 'seed' ? undefined : baseline + 1]);
    live.batch([4, 5]);
    await depot.save(live);
    expect(fixture.expectedCounts).toEqual([3]);
    expect(fixture.stream).toHaveLength(5);
    expect(coreOf(live).version).toBe(5);
  });

  test('stale compare-and-append rejects without losing pending state or version', async () => {
    const fixture = enforcingStore();
    const depot = createDepot(aggregate, fixture.store);
    const first = await depot.get('o1');
    const stale = await depot.get('o1');
    first.batch([1, 2]);
    await depot.save(first);
    stale.increment(3);
    await expect(depot.save(stale)).rejects.toThrow('stale event count');
    expect(fixture.stream).toHaveLength(2);
    expect(coreOf(stale).version).toBe(1);
    expect(stale.count).toBe(3);
    expect(extractUncommittedEvents(stale)).toHaveLength(1);
  });

  test('after-commit failure leaves the enforcing store appended and pending cleared', async () => {
    const fixture = enforcingStore();
    const depot = createDepot(aggregate, fixture.store, { plugins: [{ key: 'after', onAfterCommit: () => {
      throw new Error('after failed');
    } }] });
    const live = await depot.get('o1');
    live.batch([1, 2]);
    await expect(depot.save(live)).rejects.toThrow('after failed');
    expect(fixture.stream).toHaveLength(2);
    expect(fixture.expectedCounts).toEqual([0]);
    expect(coreOf(live).version).toBe(2);
    expect(extractUncommittedEvents(live)).toEqual([]);
  });

  test.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null])('rejects snapshot count %s before readStream', async (version) => {
    const readStream = jest.fn(async function* () {});
    const depot = createDepot(aggregate, { readStream, saveEvents: async () => {} });
    await expect(depot.get('o1', { snapshot: { state: { id: 'o1', count: 0 }, version: version as number } }))
      .rejects.toThrow('nonnegative safe integer');
    expect(readStream).not.toHaveBeenCalled();
  });

  test('captures pending batch and baseline before waiting for append plugins', async () => {
    const fixture = enforcingStore([incrementEvent(1)]);
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const depot = createDepot(aggregate, fixture.store, { plugins: [{ key: 'wait', onBeforeAppend: () => waiting }] });
    const live = await depot.get('o1');
    live.batch([2, 3]);
    const core = coreOf(live);
    const pending = jest.spyOn(core, 'getPendingResults');
    const versionRead = jest.fn(() => 3);
    Object.defineProperty(core, 'version', { configurable: true, get: versionRead });
    const saving = depot.save(live);
    expect(pending).toHaveBeenCalledTimes(1);
    expect(versionRead).toHaveBeenCalledTimes(1);
    expect(fixture.expectedCounts).toEqual([]);
    release();
    await saving;
    expect(versionRead).toHaveBeenCalledTimes(1);
    expect(fixture.expectedCounts).toEqual([1]);
  });

  test('intent-only commands notify and commit without advancing the event count', async () => {
    type Plugins = { intents: { audit: { sent: boolean } } };
    const builder = createAggregate<S, 'order', Record<string, unknown>, Plugins>('order', { id: 'o1', count: 0 })
      .events({})
      .commands(() => ({ audit: () => ({ events: [], intents: { audit: { sent: true } } }) }))
      .build();
    const fixture = enforcingStore();
    const after = jest.fn();
    const before = jest.fn();
    const depot = createDepot(builder, fixture.store, { plugins: [{ key: 'audit', onBeforeAppend: before, onAfterCommit: after }] });
    const live = await depot.get('o1');
    const notify = jest.fn();
    coreOf(live).subscribe(notify);
    live.audit();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(coreOf(live).version).toBe(0);
    await depot.save(live);
    expect(fixture.expectedCounts).toEqual([0]);
    expect(before).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledWith(expect.objectContaining({ events: [], intents: { audit: { sent: true } } }));
    expect(coreOf(live).getPendingResults()).toEqual({ events: [], intents: {} });
  });
});
