import { describe, expect, test } from '@jest/globals';
import {
  createProjection,
  ProjectionDaemon,
  type Checkpoint,
  type EventBatch,
  type IEventSubscription,
  type IProjectionStore,
  type ProjectionAtomicWrite,
  type ProjectionEvent,
  type ProjectionWarning
} from '../../projection-runtime-core/src';

type ProjectionState = {
  fromEvents: number;
  joinEvents: number;
};

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

class RecordingProjectionStore<TState> implements IProjectionStore<TState> {
  readonly atomicWrites: ProjectionAtomicWrite<TState>[] = [];
  private readonly documents = new Map<string, { state: TState; checkpoint: Checkpoint }>();
  private readonly links = new Map<string, string>();
  private readonly dedupe = new Map<string, Checkpoint>();

  async load(documentId: string): Promise<TState | null> {
    return this.documents.get(documentId)?.state ?? null;
  }

  async save(documentId: string, state: TState, checkpoint: Checkpoint): Promise<void> {
    this.documents.set(documentId, { state, checkpoint });
  }

  async commitAtomic(write: ProjectionAtomicWrite<TState>): Promise<void> {
    this.atomicWrites.push(write);

    for (const document of write.documents) {
      this.documents.set(document.documentId, {
        state: document.state,
        checkpoint: document.checkpoint
      });
    }

    for (const link of write.links) {
      const key = `${link.aggregateType}:${link.aggregateId}`;

      if (link.op === 'remove') {
        const current = this.links.get(key);
        if (current === link.targetDocId) {
          this.links.delete(key);
        }
        continue;
      }

      if (!this.links.has(key)) {
        this.links.set(key, link.targetDocId);
      }
    }

    for (const entry of write.dedupe.upserts) {
      this.dedupe.set(entry.key, entry.checkpoint);
    }

    this.documents.set(write.cursorKey, {
      state: {} as TState,
      checkpoint: write.cursor
    });
  }

  async resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> {
    return this.links.get(`${aggregateType}:${aggregateId}`) ?? null;
  }

  async getCheckpoint(key: string): Promise<Checkpoint | null> {
    return this.documents.get(key)?.checkpoint ?? null;
  }

  async getDedupeCheckpoint(eventKey: string): Promise<Checkpoint | null> {
    return this.dedupe.get(eventKey) ?? null;
  }

  getDocument(documentId: string): TState | null {
    return this.documents.get(documentId)?.state ?? null;
  }

  getCursor(checkpointKey: string): Checkpoint | null {
    return this.documents.get(checkpointKey)?.checkpoint ?? null;
  }
}

class FailBeforeCommitProjectionStore<TState> extends RecordingProjectionStore<TState> {
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

describe('runtime-core E3.2 unsubscribe/relink semantics', () => {
  test('unsubscribeFrom removes pending link and prevents join routing', async () => {
    const projection = createProjection<ProjectionState>('unsubscribe-flow', () => ({ fromEvents: 0, joinEvents: 0 }))
      .from(invoiceAgg, {
        created: (state, evt, ctx) => {
          state.fromEvents += 1;
          const customerId = String(evt.payload.customerId);
          ctx.subscribeTo(customerAgg, customerId);
        },
        canceled: (state, evt, ctx) => {
          state.fromEvents += 1;
          const customerId = String(evt.payload.customerId);
          ctx.unsubscribeFrom(customerAgg, customerId);
        }
      })
      .join(customerAgg, {
        updated: (state) => {
          state.joinEvents += 1;
        }
      })
      .build();

    const store = new RecordingProjectionStore<ProjectionState>();
    const daemon = new ProjectionDaemon<ProjectionState>({
      projection,
      subscription: new InMemoryEventSubscription([
        event(1, 'invoice', 'invoice-1', 'created', { customerId: 'customer-1' }),
        event(2, 'invoice', 'invoice-1', 'canceled', { customerId: 'customer-1' }),
        event(3, 'customer', 'customer-1', 'updated', { name: 'Alex' })
      ]),
      store,
      batchSize: 100
    });

    await daemon.processBatch();

    const state = store.getDocument('invoice-1');
    expect(state).toEqual({ fromEvents: 2, joinEvents: 0 });

    const links = store.atomicWrites[0]?.links ?? [];
    expect(links).toEqual([
      {
        op: 'remove',
        aggregateType: 'customer',
        aggregateId: 'customer-1',
        targetDocId: 'invoice-1'
      }
    ]);
  });

  test('relink emits explicit remove + add operations (no replace semantics)', async () => {
    const projection = createProjection<ProjectionState>('relink-flow', () => ({ fromEvents: 0, joinEvents: 0 }))
      .from(invoiceAgg, {
        created: (state, evt, ctx) => {
          state.fromEvents += 1;
          ctx.subscribeTo(customerAgg, String(evt.payload.customerId));
        },
        moved: (state, evt, ctx) => {
          state.fromEvents += 1;
          ctx.subscribeTo(customerAgg, String(evt.payload.customerId));
        }
      })
      .join(customerAgg, {
        updated: (state) => {
          state.joinEvents += 1;
        }
      })
      .identity((evt) => String(evt.payload.docId ?? evt.aggregateId))
      .build();

    const store = new RecordingProjectionStore<ProjectionState>();
    const daemon = new ProjectionDaemon<ProjectionState>({
      projection,
      subscription: new InMemoryEventSubscription([
        event(1, 'invoice', 'invoice-1', 'created', { customerId: 'customer-1', docId: 'doc-old' }),
        event(2, 'invoice', 'invoice-1', 'moved', { customerId: 'customer-1', docId: 'doc-new' })
      ]),
      store,
      batchSize: 100
    });

    await daemon.processBatch();

    const links = store.atomicWrites[0]?.links ?? [];
    expect(links).toEqual([
      {
        op: 'remove',
        aggregateType: 'customer',
        aggregateId: 'customer-1',
        targetDocId: 'doc-old'
      },
      {
        op: 'add',
        aggregateType: 'customer',
        aggregateId: 'customer-1',
        targetDocId: 'doc-new'
      }
    ]);
  });

  test('join routing remains unchanged for active subscriptions', async () => {
    const projection = createProjection<ProjectionState>('join-unchanged', () => ({ fromEvents: 0, joinEvents: 0 }))
      .from(invoiceAgg, {
        created: (state, evt, ctx) => {
          state.fromEvents += 1;
          ctx.subscribeTo(customerAgg, String(evt.payload.customerId));
        }
      })
      .join(customerAgg, {
        updated: (state) => {
          state.joinEvents += 1;
        }
      })
      .build();

    const store = new RecordingProjectionStore<ProjectionState>();
    const daemon = new ProjectionDaemon<ProjectionState>({
      projection,
      subscription: new InMemoryEventSubscription([
        event(1, 'invoice', 'invoice-1', 'created', { customerId: 'customer-1' }),
        event(2, 'customer', 'customer-1', 'updated', { name: 'Nora' })
      ]),
      store,
      batchSize: 100
    });

    await daemon.processBatch();

    const state = store.getDocument('invoice-1');
    expect(state).toEqual({ fromEvents: 1, joinEvents: 1 });
  });

  test('warns and skips missing reverse targets while continuing batch processing', async () => {
    const warnings: ProjectionWarning[] = [];
    const projection = createProjection<ProjectionState>('warn-missing-target', () => ({ fromEvents: 0, joinEvents: 0 }))
      .from(invoiceAgg, {
        created: (state, evt, ctx) => {
          state.fromEvents += 1;
          ctx.subscribeTo(customerAgg, String(evt.payload.customerId));
        }
      })
      .join(customerAgg, {
        updated: (state) => {
          state.joinEvents += 1;
        }
      })
      .build();

    const store = new RecordingProjectionStore<ProjectionState>();
    const daemon = new ProjectionDaemon<ProjectionState>({
      projection,
      subscription: new InMemoryEventSubscription([
        event(1, 'invoice', 'invoice-1', 'created', { customerId: 'customer-1' }),
        event(2, 'customer', 'customer-1', 'updated', { name: 'Nora' }),
        event(3, 'customer', 'customer-missing', 'updated', { name: 'Ghost' }),
        event(4, 'customer', 'customer-1', 'updated', { name: 'Nora-2' })
      ]),
      store,
      batchSize: 100,
      onWarning: (warning) => warnings.push(warning)
    });

    await daemon.processBatch();

    const state = store.getDocument('invoice-1');
    expect(state).toEqual({ fromEvents: 1, joinEvents: 2 });
    expect(warnings).toEqual([
      {
        code: 'missing_reverse_target',
        projectionName: 'warn-missing-target',
        aggregateType: 'customer',
        aggregateId: 'customer-missing',
        eventType: 'updated',
        sequence: 3
      }
    ]);
  });

  test('warns on missing-target removal and still processes other targets', async () => {
    const warnings: ProjectionWarning[] = [];
    const projection = createProjection<ProjectionState>('warn-missing-removal', () => ({ fromEvents: 0, joinEvents: 0 }))
      .from(invoiceAgg, {
        created: (state, evt, ctx) => {
          state.fromEvents += 1;
          ctx.subscribeTo(customerAgg, String(evt.payload.customerId));
        },
        canceled: (state, evt, ctx) => {
          state.fromEvents += 1;
          ctx.unsubscribeFrom(customerAgg, String(evt.payload.customerId));
        }
      })
      .join(customerAgg, {
        updated: (state) => {
          state.joinEvents += 1;
        }
      })
      .build();

    const store = new RecordingProjectionStore<ProjectionState>();
    const daemon = new ProjectionDaemon<ProjectionState>({
      projection,
      subscription: new InMemoryEventSubscription([
        event(1, 'invoice', 'invoice-1', 'created', { customerId: 'customer-1' }),
        event(2, 'invoice', 'invoice-1', 'canceled', { customerId: 'customer-1' }),
        event(3, 'customer', 'customer-1', 'updated', { name: 'NoRoute' }),
        event(4, 'invoice', 'invoice-2', 'created', { customerId: 'customer-2' }),
        event(5, 'customer', 'customer-2', 'updated', { name: 'StillRouted' })
      ]),
      store,
      batchSize: 100,
      onWarning: (warning) => warnings.push(warning)
    });

    await daemon.processBatch();

    expect(store.getDocument('invoice-1')).toEqual({ fromEvents: 2, joinEvents: 0 });
    expect(store.getDocument('invoice-2')).toEqual({ fromEvents: 1, joinEvents: 1 });
    expect(warnings).toEqual([
      {
        code: 'missing_target_removal',
        projectionName: 'warn-missing-removal',
        aggregateType: 'customer',
        aggregateId: 'customer-1',
        eventType: 'updated',
        sequence: 3,
        targetDocId: 'invoice-1'
      }
    ]);
  });
});

describe('runtime-core E4.3 atomic+dedupe consistency', () => {
  test('in-memory path keeps writes all-or-nothing and recovers on retry/restart without double-apply', async () => {
    const projection = createProjection<{ applied: number }>('atomic-dedupe-consistency', () => ({ applied: 0 }))
      .from(invoiceAgg, {
        created: (state) => {
          state.applied += 1;
        }
      })
      .build();

    const events = [event(1, 'invoice', 'invoice-1', 'created', {})];
    const subscription = new InMemoryEventSubscription(events);
    const store = new FailBeforeCommitProjectionStore<{ applied: number }>();
    const daemon = new ProjectionDaemon<{ applied: number }>({
      projection,
      subscription,
      store,
      batchSize: 100
    });

    store.failNextCommit();

    await expect(daemon.processBatch()).rejects.toThrow('injected pre-commit failure');
    expect(store.getDocument('invoice-1')).toBeNull();
    expect(store.getCursor('__cursor__atomic-dedupe-consistency')).toBeNull();
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:1')).toBeNull();

    const retryStats = await daemon.processBatch();
    expect(retryStats.eventsProcessed).toBe(1);
    expect(store.getDocument('invoice-1')).toEqual({ applied: 1 });
    expect(store.getCursor('__cursor__atomic-dedupe-consistency')).toEqual({
      sequence: 1,
      timestamp: '2026-04-09T00:00:01.000Z'
    });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:1')).toEqual({
      sequence: 1,
      timestamp: '2026-04-09T00:00:01.000Z'
    });

    // Simulate process restart: new daemon instance on same durable store.
    const restartedDaemon = new ProjectionDaemon<{ applied: number }>({
      projection,
      subscription: new InMemoryEventSubscription(events),
      store,
      batchSize: 100
    });

    const restartStats = await restartedDaemon.processBatch();
    expect(restartStats.eventsProcessed).toBe(0);
    expect(store.getDocument('invoice-1')).toEqual({ applied: 1 });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:1')).toEqual({
      sequence: 1,
      timestamp: '2026-04-09T00:00:01.000Z'
    });
    expect(store.getCursor('__cursor__atomic-dedupe-consistency')).toEqual({
      sequence: 1,
      timestamp: '2026-04-09T00:00:01.000Z'
    });
  });
});

describe('runtime-core E5.2 automatic catch-up to live cutover', () => {
  test('transitions catching_up -> ready_to_cutover -> live and persists restart-safe mode metadata', async () => {
    const projection = createProjection<{ applied: number }>('auto-cutover-state-machine', () => ({ applied: 0 }))
      .from(invoiceAgg, {
        created: (state) => {
          state.applied += 1;
        }
      })
      .build();

    const store = new RecordingProjectionStore<{ applied: number }>();

    const catchUpSubscription = new InMemoryEventSubscription([
      event(1, 'invoice', 'invoice-1', 'created', {})
    ]);

    const liveSubscription = new InMemoryEventSubscription([
      // Deliberate overlap with catch-up stream; durable dedupe must suppress this.
      event(1, 'invoice', 'invoice-1', 'created', {}),
      event(2, 'invoice', 'invoice-1', 'created', {})
    ]);

    const daemon = new ProjectionDaemon<{ applied: number }>({
      projection,
      subscriptions: {
        catchUp: catchUpSubscription,
        live: liveSubscription
      },
      store,
      batchSize: 100
    });

    // catch_up applies sequence=1
    const first = await daemon.processBatch();
    expect(first.eventsProcessed).toBe(1);
    expect(store.getDocument('invoice-1')).toEqual({ applied: 1 });

    // no catch-up events -> persist ready_to_cutover
    const second = await daemon.processBatch();
    expect(second.eventsProcessed).toBe(0);
    expect(store.getDocument('__checkpoint__auto-cutover-state-machine__runtime_mode')).toEqual({
      mode: 'ready_to_cutover',
      updatedAt: expect.any(String)
    });

    // ready_to_cutover -> live persisted durably
    const third = await daemon.processBatch();
    expect(third.eventsProcessed).toBe(0);
    expect(store.getDocument('__checkpoint__auto-cutover-state-machine__runtime_mode')).toEqual({
      mode: 'live',
      updatedAt: expect.any(String)
    });

    // live stream overlap sequence=1 is skipped by cursor (>1) and dedupe; sequence=2 applies once.
    const fourth = await daemon.processBatch();
    expect(fourth.eventsProcessed).toBe(1);
    expect(store.getDocument('invoice-1')).toEqual({ applied: 2 });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:1')).toEqual({
      sequence: 1,
      timestamp: '2026-04-09T00:00:01.000Z'
    });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:2')).toEqual({
      sequence: 2,
      timestamp: '2026-04-09T00:00:02.000Z'
    });
  });

  test('resumes cutover from persisted ready_to_cutover after restart', async () => {
    const projection = createProjection<{ applied: number }>('auto-cutover-restart', () => ({ applied: 0 }))
      .from(invoiceAgg, {
        created: (state) => {
          state.applied += 1;
        }
      })
      .build();

    const store = new RecordingProjectionStore<{ applied: number }>();
    const catchUpEvents = [event(1, 'invoice', 'invoice-1', 'created', {})];
    const liveEvents = [event(2, 'invoice', 'invoice-1', 'created', {})];

    const firstDaemon = new ProjectionDaemon<{ applied: number }>({
      projection,
      subscriptions: {
        catchUp: new InMemoryEventSubscription(catchUpEvents),
        live: new InMemoryEventSubscription(liveEvents)
      },
      store,
      batchSize: 100
    });

    await firstDaemon.processBatch(); // catching_up applies seq=1
    await firstDaemon.processBatch(); // persist ready_to_cutover

    // Simulated process restart in mid-transition.
    const restartedDaemon = new ProjectionDaemon<{ applied: number }>({
      projection,
      subscriptions: {
        catchUp: new InMemoryEventSubscription(catchUpEvents),
        live: new InMemoryEventSubscription(liveEvents)
      },
      store,
      batchSize: 100
    });

    const transition = await restartedDaemon.processBatch(); // ready_to_cutover -> live
    expect(transition.eventsProcessed).toBe(0);
    expect(store.getDocument('__checkpoint__auto-cutover-restart__runtime_mode')).toEqual({
      mode: 'live',
      updatedAt: expect.any(String)
    });

    const applyLive = await restartedDaemon.processBatch();
    expect(applyLive.eventsProcessed).toBe(1);
    expect(store.getDocument('invoice-1')).toEqual({ applied: 2 });
    expect(store.getCursor('__cursor__auto-cutover-restart')).toEqual({
      sequence: 2,
      timestamp: '2026-04-09T00:00:02.000Z'
    });
  });
});
