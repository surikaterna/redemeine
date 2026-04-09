import { describe, expect, test } from '@jest/globals';
import {
  createProjection,
  ProjectionDaemon,
  type BatchStats,
  type Checkpoint,
  type EventBatch,
  type IEventSubscription,
  type IProjectionStore,
  type ProjectionAtomicWrite,
  type ProjectionEvent,
  type ProjectionWarning
} from '../../projection-runtime-core/src';
import { InMemoryProjectionStore } from '../../projection-runtime-store-inmemory/src';
import { createMongoRuntimeCoreStore } from '../../projection-runtime-store-mongodb/test/runtimeCoreStoreHarness';

type StoreAdapterName = 'inmemory' | 'mongodb';

type ProjectionState = {
  fromEvents: number;
  joinEvents: number;
  seen: number[];
};

type StoreAdapter<TState> = {
  name: StoreAdapterName;
  store: IProjectionStore<TState>;
};

const invoiceAgg = {
  __aggregateType: 'invoice',
  initialState: {},
  pure: { eventProjectors: {} }
};

const customerAgg = {
  __aggregateType: 'customer',
  initialState: {},
  pure: { eventProjectors: {} }
};

const createInMemoryAdapter = <TState>(): StoreAdapter<TState> => ({
  name: 'inmemory',
  store: new InMemoryProjectionStore<TState>()
});

const createMongoAdapter = <TState>(): StoreAdapter<TState> => {
  const { store } = createMongoRuntimeCoreStore<TState>();
  return {
    name: 'mongodb',
    store
  };
};

const storeAdapters = [createInMemoryAdapter, createMongoAdapter] as const;

class InMemoryEventSubscription implements IEventSubscription {
  constructor(private readonly events: ProjectionEvent[]) {}

  async poll(cursor: Checkpoint, batchSize: number): Promise<EventBatch> {
    const nextEvents = this.events
      .filter((event) => event.sequence > cursor.sequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, batchSize);

    const nextCursor = nextEvents.length > 0
      ? { sequence: nextEvents[nextEvents.length - 1].sequence, timestamp: nextEvents[nextEvents.length - 1].timestamp }
      : cursor;

    return { events: nextEvents, nextCursor };
  }
}

class ScriptedEventSubscription implements IEventSubscription {
  private batchIndex = 0;

  constructor(private readonly batches: EventBatch[]) {}

  async poll(cursor: Checkpoint, _batchSize: number): Promise<EventBatch> {
    const scripted = this.batches[this.batchIndex];
    if (!scripted) {
      return { events: [], nextCursor: cursor };
    }

    this.batchIndex += 1;
    return scripted;
  }
}

class FailBeforeCommitProjectionStore<TState> extends InMemoryProjectionStore<TState> {
  private shouldFail = false;

  failNextCommit(): void {
    this.shouldFail = true;
  }

  override async commitAtomic(write: ProjectionAtomicWrite<TState>): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error('injected pre-commit failure');
    }

    await super.commitAtomic(write);
  }
}

function event(
  sequence: number,
  aggregateType: string,
  aggregateId: string,
  type: string,
  payload: Record<string, unknown>
): ProjectionEvent {
  return {
    sequence,
    aggregateType,
    aggregateId,
    type,
    payload,
    timestamp: `2026-04-09T00:00:${String(sequence).padStart(2, '0')}.000Z`
  };
}

function runCrossStore(name: string, scenario: (adapter: StoreAdapter<ProjectionState>) => Promise<void>): void {
  describe(name, () => {
    for (const createAdapter of storeAdapters) {
      test(createAdapter().name, async () => {
        await scenario(createAdapter<ProjectionState>());
      });
    }
  });
}

runCrossStore('E6.1 join unchanged semantics', async ({ store }) => {
  const projection = createProjection<ProjectionState>('e6-1-join-unchanged', () => ({ fromEvents: 0, joinEvents: 0, seen: [] }))
    .from(invoiceAgg, {
      created: (state, evt, ctx) => {
        state.fromEvents += 1;
        state.seen.push(evt.sequence);
        ctx.subscribeTo(customerAgg, String(evt.payload.customerId));
      }
    })
    .join(customerAgg, {
      updated: (state, evt) => {
        state.joinEvents += 1;
        state.seen.push(evt.sequence);
      }
    })
    .build();

  const daemon = new ProjectionDaemon<ProjectionState>({
    projection,
    subscription: new InMemoryEventSubscription([
      event(1, 'invoice', 'invoice-1', 'created', { customerId: 'customer-1' }),
      event(2, 'customer', 'customer-1', 'updated', { name: 'Nora' })
    ]),
    store,
    batchSize: 100
  });

  const stats = await daemon.processBatch();
  expect(stats.eventsProcessed).toBe(2);
  expect(await store.load('invoice-1')).toEqual({ fromEvents: 1, joinEvents: 1, seen: [1, 2] });
});

runCrossStore('E6.1 reverse/unsubscribe remove+add behavior', async ({ store }) => {
  const projection = createProjection<ProjectionState>('e6-1-relink-unsubscribe', () => ({ fromEvents: 0, joinEvents: 0, seen: [] }))
    .from(invoiceAgg, {
      created: (state, evt, ctx) => {
        state.fromEvents += 1;
        state.seen.push(evt.sequence);
        ctx.subscribeTo(customerAgg, String(evt.payload.customerId));
      },
      canceled: (state, evt, ctx) => {
        state.fromEvents += 1;
        state.seen.push(evt.sequence);
        ctx.unsubscribeFrom(customerAgg, String(evt.payload.customerId));
      },
      moved: (state, evt, ctx) => {
        state.fromEvents += 1;
        state.seen.push(evt.sequence);
        ctx.subscribeTo(customerAgg, String(evt.payload.customerId));
      }
    })
    .join(customerAgg, {
      updated: (state, evt) => {
        state.joinEvents += 1;
        state.seen.push(evt.sequence);
      }
    })
    .identity((evt) => String(evt.payload.docId ?? evt.aggregateId))
    .build();

  const daemon = new ProjectionDaemon<ProjectionState>({
    projection,
    subscription: new InMemoryEventSubscription([
      event(1, 'invoice', 'invoice-1', 'created', { customerId: 'customer-1', docId: 'doc-old' }),
      event(2, 'invoice', 'invoice-1', 'moved', { customerId: 'customer-1', docId: 'doc-new' }),
      event(3, 'invoice', 'invoice-1', 'canceled', { customerId: 'customer-1', docId: 'doc-new' }),
      event(4, 'customer', 'customer-1', 'updated', { name: 'no-route' }),
      event(5, 'invoice', 'invoice-1', 'created', { customerId: 'customer-1', docId: 'doc-new' }),
      event(6, 'customer', 'customer-1', 'updated', { name: 'route-restored' })
    ]),
    store,
    batchSize: 100
  });

  const stats = await daemon.processBatch();
  expect(stats.eventsProcessed).toBe(6);
  expect(await store.load('doc-old')).toEqual({ fromEvents: 1, joinEvents: 0, seen: [1] });
  expect(await store.load('doc-new')).toEqual({ fromEvents: 3, joinEvents: 2, seen: [2, 3, 5, 6, 4] });
});

runCrossStore('E6.1 warn-and-skip behavior', async ({ store }) => {
  const warnings: ProjectionWarning[] = [];
  const projection = createProjection<ProjectionState>('e6-1-warn-skip', () => ({ fromEvents: 0, joinEvents: 0, seen: [] }))
    .from(invoiceAgg, {
      created: (state, evt, ctx) => {
        state.fromEvents += 1;
        state.seen.push(evt.sequence);
        ctx.subscribeTo(customerAgg, String(evt.payload.customerId));
      },
      canceled: (state, evt, ctx) => {
        state.fromEvents += 1;
        state.seen.push(evt.sequence);
        ctx.unsubscribeFrom(customerAgg, String(evt.payload.customerId));
      }
    })
    .join(customerAgg, {
      updated: (state, evt) => {
        state.joinEvents += 1;
        state.seen.push(evt.sequence);
      }
    })
    .build();

  const daemon = new ProjectionDaemon<ProjectionState>({
    projection,
    subscription: new InMemoryEventSubscription([
      event(1, 'invoice', 'invoice-1', 'created', { customerId: 'customer-1' }),
      event(2, 'customer', 'customer-1', 'updated', { name: 'ok' }),
      event(3, 'customer', 'customer-missing', 'updated', { name: 'ghost' }),
      event(4, 'invoice', 'invoice-1', 'canceled', { customerId: 'customer-1' }),
      event(5, 'customer', 'customer-1', 'updated', { name: 'removed' }),
      event(6, 'invoice', 'invoice-2', 'created', { customerId: 'customer-2' }),
      event(7, 'customer', 'customer-2', 'updated', { name: 'still-routed' })
    ]),
    store,
    batchSize: 100,
    onWarning: (warning) => warnings.push(warning)
  });

  await daemon.processBatch();

  expect(await store.load('invoice-1')).toEqual({ fromEvents: 2, joinEvents: 1, seen: [1, 2, 4] });
  expect(await store.load('invoice-2')).toEqual({ fromEvents: 1, joinEvents: 1, seen: [6, 7] });
  expect(warnings).toEqual([
    {
      code: 'missing_reverse_target',
      projectionName: 'e6-1-warn-skip',
      aggregateType: 'customer',
      aggregateId: 'customer-missing',
      eventType: 'updated',
      sequence: 3
    },
    {
      code: 'missing_target_removal',
      projectionName: 'e6-1-warn-skip',
      aggregateType: 'customer',
      aggregateId: 'customer-1',
      eventType: 'updated',
      sequence: 5,
      targetDocId: 'invoice-1'
    }
  ]);
});

runCrossStore('E6.1 atomic+dedupe consistency baseline', async ({ store }) => {
  const projection = createProjection<ProjectionState>('e6-1-atomic-dedupe', () => ({ fromEvents: 0, joinEvents: 0, seen: [] }))
    .from(invoiceAgg, {
      created: (state, evt) => {
        state.fromEvents += 1;
        state.seen.push(evt.sequence);
      }
    })
    .build();

  const events = [event(1, 'invoice', 'invoice-1', 'created', {})];

  const firstDaemon = new ProjectionDaemon<ProjectionState>({
    projection,
    subscription: new InMemoryEventSubscription(events),
    store,
    batchSize: 100
  });

  const first = await firstDaemon.processBatch();
  expect(first.eventsProcessed).toBe(1);
  expect(await store.load('invoice-1')).toEqual({ fromEvents: 1, joinEvents: 0, seen: [1] });

  const restartedDaemon = new ProjectionDaemon<ProjectionState>({
    projection,
    subscription: new InMemoryEventSubscription(events),
    store,
    batchSize: 100
  });

  const replay = await restartedDaemon.processBatch();
  expect(replay.eventsProcessed).toBe(0);
  expect(await store.load('invoice-1')).toEqual({ fromEvents: 1, joinEvents: 0, seen: [1] });
  expect(await store.getDedupeCheckpoint('invoice:invoice-1:1')).toEqual({
    sequence: 1,
    timestamp: '2026-04-09T00:00:01.000Z'
  });
});

runCrossStore('E6.1 catch-up/cutover boundary basics', async ({ store }) => {
  const projection = createProjection<ProjectionState>('e6-1-cutover-basics', () => ({ fromEvents: 0, joinEvents: 0, seen: [] }))
    .from(invoiceAgg, {
      created: (state, evt) => {
        state.fromEvents += 1;
        state.seen.push(evt.sequence);
      }
    })
    .build();

  const daemon = new ProjectionDaemon<ProjectionState>({
    projection,
    subscriptions: {
      catchUp: new ScriptedEventSubscription([
        {
          events: [
            event(1, 'invoice', 'invoice-1', 'created', {})
          ],
          nextCursor: { sequence: 1, timestamp: '2026-04-09T00:00:01.000Z' }
        },
        {
          events: [],
          nextCursor: { sequence: 1, timestamp: '2026-04-09T00:00:01.000Z' }
        }
      ]),
      live: new ScriptedEventSubscription([
        {
          events: [
            event(1, 'invoice', 'invoice-1', 'created', {}),
            event(2, 'invoice', 'invoice-1', 'created', {})
          ],
          nextCursor: { sequence: 2, timestamp: '2026-04-09T00:00:02.000Z' }
        }
      ])
    },
    store,
    batchSize: 100
  });

  const cycle: BatchStats[] = [];
  cycle.push(await daemon.processBatch());
  cycle.push(await daemon.processBatch());
  cycle.push(await daemon.processBatch());
  cycle.push(await daemon.processBatch());

  expect(cycle[0]?.eventsProcessed).toBe(1);
  expect(cycle[1]?.eventsProcessed).toBe(0);
  expect(cycle[2]?.eventsProcessed).toBe(0);
  expect(cycle[3]?.eventsProcessed).toBe(2);
  expect(cycle[3]?.diagnostics.dedupeSuppressed).toBe(1);
  expect(await store.load('__checkpoint__e6-1-cutover-basics__runtime_mode')).toEqual({
    mode: 'live',
    updatedAt: expect.any(String)
  });
  expect(await store.load('invoice-1')).toEqual({ fromEvents: 2, joinEvents: 0, seen: [1, 2] });
});

describe('E6.1 atomic baseline failure injection (inmemory control)', () => {
  test('commit failure leaves no partial state and retries cleanly', async () => {
    const projection = createProjection<{ applied: number }>('e6-1-atomic-failure-control', () => ({ applied: 0 }))
      .from(invoiceAgg, {
        created: (state) => {
          state.applied += 1;
        }
      })
      .build();

    const events = [event(1, 'invoice', 'invoice-1', 'created', {})];
    const store = new FailBeforeCommitProjectionStore<{ applied: number }>();

    const daemon = new ProjectionDaemon<{ applied: number }>({
      projection,
      subscription: new InMemoryEventSubscription(events),
      store,
      batchSize: 100
    });

    store.failNextCommit();

    await expect(daemon.processBatch()).rejects.toThrow('injected pre-commit failure');
    expect(await store.load('invoice-1')).toBeNull();
    expect(await store.getCheckpoint('__cursor__e6-1-atomic-failure-control')).toBeNull();
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:1')).toBeNull();

    const retry = await daemon.processBatch();
    expect(retry.eventsProcessed).toBe(1);
    expect(await store.load('invoice-1')).toEqual({ applied: 1 });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:1')).toEqual({
      sequence: 1,
      timestamp: '2026-04-09T00:00:01.000Z'
    });
  });
});
