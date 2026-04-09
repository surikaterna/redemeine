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

class FailOnRuntimeModeCommitProjectionStore<TState> extends RecordingProjectionStore<TState> {
  private pendingModeFailure: 'ready_to_cutover' | 'live' | null = null;

  failNextRuntimeModeCommit(mode: 'ready_to_cutover' | 'live'): void {
    this.pendingModeFailure = mode;
  }

  override async commitAtomic(write: ProjectionAtomicWrite<TState>): Promise<void> {
    const runtimeModeDoc = write.documents.find((document) =>
      document.documentId.includes('__runtime_mode')
    );
    const requestedMode = (runtimeModeDoc?.state as { mode?: string } | undefined)?.mode;

    if (this.pendingModeFailure && requestedMode === this.pendingModeFailure) {
      this.pendingModeFailure = null;
      throw new Error(`injected runtime-mode commit failure: ${requestedMode}`);
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

describe('runtime-core E5.3 cutover dedupe overlap validation', () => {
  test('suppresses delayed live overlap after catch-up replay and exposes cutover diagnostics', async () => {
    const projection = createProjection<{ applied: number; seen: number[] }>('cutover-overlap', () => ({ applied: 0, seen: [] }))
      .from(invoiceAgg, {
        created: (state, evt) => {
          state.applied += 1;
          state.seen.push(evt.sequence);
        }
      })
      .build();

    const store = new RecordingProjectionStore<{ applied: number; seen: number[] }>();

    const catchupDaemon = new ProjectionDaemon<{ applied: number; seen: number[] }>({
      projection,
      subscription: new ScriptedEventSubscription([
        {
          events: [
            event(1, 'invoice', 'invoice-1', 'created', {}),
            event(2, 'invoice', 'invoice-1', 'created', {}),
            event(3, 'invoice', 'invoice-1', 'created', {})
          ],
          nextCursor: { sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' }
        }
      ]),
      store,
      batchSize: 100
    });

    const catchupStats = await catchupDaemon.processBatch();
    expect(catchupStats.diagnostics).toEqual({
      cursorStart: { sequence: 0 },
      cursorEnd: { sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' },
      dedupeSuppressed: 0,
      warnings: 0
    });

    const liveDaemon = new ProjectionDaemon<{ applied: number; seen: number[] }>({
      projection,
      subscription: new ScriptedEventSubscription([
        {
          events: [
            event(2, 'invoice', 'invoice-1', 'created', {}),
            event(3, 'invoice', 'invoice-1', 'created', {}),
            event(4, 'invoice', 'invoice-1', 'created', {})
          ],
          nextCursor: { sequence: 4, timestamp: '2026-04-09T00:00:04.000Z' }
        }
      ]),
      store,
      batchSize: 100
    });

    const liveStats = await liveDaemon.processBatch();
    expect(liveStats.diagnostics).toEqual({
      cursorStart: { sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' },
      cursorEnd: { sequence: 4, timestamp: '2026-04-09T00:00:04.000Z' },
      dedupeSuppressed: 2,
      warnings: 0
    });

    expect(store.getDocument('invoice-1')).toEqual({ applied: 4, seen: [1, 2, 3, 4] });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:1')).toEqual({ sequence: 1, timestamp: '2026-04-09T00:00:01.000Z' });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:2')).toEqual({ sequence: 2, timestamp: '2026-04-09T00:00:02.000Z' });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:3')).toEqual({ sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:4')).toEqual({ sequence: 4, timestamp: '2026-04-09T00:00:04.000Z' });
  });

  test('restart during cutover keeps single-apply semantics and reports overlap diagnostics', async () => {
    const projection = createProjection<{ applied: number; seen: number[] }>('cutover-restart', () => ({ applied: 0, seen: [] }))
      .from(invoiceAgg, {
        created: (state, evt) => {
          state.applied += 1;
          state.seen.push(evt.sequence);
        }
      })
      .build();

    const store = new FailBeforeCommitProjectionStore<{ applied: number; seen: number[] }>();

    const catchupDaemon = new ProjectionDaemon<{ applied: number; seen: number[] }>({
      projection,
      subscription: new ScriptedEventSubscription([
        {
          events: [
            event(1, 'invoice', 'invoice-1', 'created', {}),
            event(2, 'invoice', 'invoice-1', 'created', {}),
            event(3, 'invoice', 'invoice-1', 'created', {})
          ],
          nextCursor: { sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' }
        }
      ]),
      store,
      batchSize: 100
    });

    await catchupDaemon.processBatch();
    expect(store.getDocument('invoice-1')).toEqual({ applied: 3, seen: [1, 2, 3] });

    store.failNextCommit();

    const failingCutoverDaemon = new ProjectionDaemon<{ applied: number; seen: number[] }>({
      projection,
      subscription: new ScriptedEventSubscription([
        {
          events: [
            event(3, 'invoice', 'invoice-1', 'created', {}),
            event(4, 'invoice', 'invoice-1', 'created', {})
          ],
          nextCursor: { sequence: 4, timestamp: '2026-04-09T00:00:04.000Z' }
        }
      ]),
      store,
      batchSize: 100
    });

    await expect(failingCutoverDaemon.processBatch()).rejects.toThrow('injected pre-commit failure');
    expect(store.getDocument('invoice-1')).toEqual({ applied: 3, seen: [1, 2, 3] });
    expect(store.getCursor('__cursor__cutover-restart')).toEqual({ sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:4')).toBeNull();

    const restartedCutoverDaemon = new ProjectionDaemon<{ applied: number; seen: number[] }>({
      projection,
      subscription: new ScriptedEventSubscription([
        {
          events: [
            event(3, 'invoice', 'invoice-1', 'created', {}),
            event(4, 'invoice', 'invoice-1', 'created', {})
          ],
          nextCursor: { sequence: 4, timestamp: '2026-04-09T00:00:04.000Z' }
        }
      ]),
      store,
      batchSize: 100
    });

    const recoveredStats = await restartedCutoverDaemon.processBatch();
    expect(recoveredStats.diagnostics).toEqual({
      cursorStart: { sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' },
      cursorEnd: { sequence: 4, timestamp: '2026-04-09T00:00:04.000Z' },
      dedupeSuppressed: 1,
      warnings: 0
    });

    expect(store.getDocument('invoice-1')).toEqual({ applied: 4, seen: [1, 2, 3, 4] });
    expect(store.getCursor('__cursor__cutover-restart')).toEqual({ sequence: 4, timestamp: '2026-04-09T00:00:04.000Z' });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:4')).toEqual({ sequence: 4, timestamp: '2026-04-09T00:00:04.000Z' });
  });
});

describe('runtime-core E6.2 failure-mode and restart validation', () => {
  test('suppresses duplicate deliveries within and across batches and preserves single-apply on restart replay', async () => {
    const projection = createProjection<{ applied: number; seen: number[] }>('dedupe-duplicates', () => ({ applied: 0, seen: [] }))
      .from(invoiceAgg, {
        created: (state, evt) => {
          state.applied += 1;
          state.seen.push(evt.sequence);
        }
      })
      .build();

    const store = new RecordingProjectionStore<{ applied: number; seen: number[] }>();

    const daemon = new ProjectionDaemon<{ applied: number; seen: number[] }>({
      projection,
      subscription: new ScriptedEventSubscription([
        {
          events: [
            event(1, 'invoice', 'invoice-1', 'created', {}),
            event(1, 'invoice', 'invoice-1', 'created', {}),
            event(2, 'invoice', 'invoice-1', 'created', {})
          ],
          nextCursor: { sequence: 2, timestamp: '2026-04-09T00:00:02.000Z' }
        },
        {
          events: [
            event(2, 'invoice', 'invoice-1', 'created', {}),
            event(3, 'invoice', 'invoice-1', 'created', {})
          ],
          nextCursor: { sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' }
        }
      ]),
      store,
      batchSize: 100
    });

    const firstBatch = await daemon.processBatch();
    expect(firstBatch.eventsProcessed).toBe(2);
    expect(firstBatch.diagnostics.dedupeSuppressed).toBe(0);

    const secondBatch = await daemon.processBatch();
    expect(secondBatch.eventsProcessed).toBe(2);
    expect(secondBatch.diagnostics.dedupeSuppressed).toBe(1);

    expect(store.getDocument('invoice-1')).toEqual({ applied: 3, seen: [1, 2, 3] });

    const restartedDaemon = new ProjectionDaemon<{ applied: number; seen: number[] }>({
      projection,
      subscription: new ScriptedEventSubscription([
        {
          events: [
            event(2, 'invoice', 'invoice-1', 'created', {}),
            event(3, 'invoice', 'invoice-1', 'created', {})
          ],
          nextCursor: { sequence: 3, timestamp: '2026-04-09T00:00:03.000Z' }
        }
      ]),
      store,
      batchSize: 100
    });

    const replay = await restartedDaemon.processBatch();
    expect(replay.eventsProcessed).toBe(2);
    expect(replay.diagnostics.dedupeSuppressed).toBe(2);
    expect(store.getDocument('invoice-1')).toEqual({ applied: 3, seen: [1, 2, 3] });
  });

  test('recovers deterministically from injected cutover transition commit fault without double-apply', async () => {
    const projection = createProjection<{ applied: number }>('cutover-transition-recovery', () => ({ applied: 0 }))
      .from(invoiceAgg, {
        created: (state) => {
          state.applied += 1;
        }
      })
      .build();

    const store = new FailOnRuntimeModeCommitProjectionStore<{ applied: number }>();
    const catchUpEvents = [event(1, 'invoice', 'invoice-1', 'created', {})];
    const liveEvents = [
      event(1, 'invoice', 'invoice-1', 'created', {}),
      event(2, 'invoice', 'invoice-1', 'created', {})
    ];

    const daemon = new ProjectionDaemon<{ applied: number }>({
      projection,
      subscriptions: {
        catchUp: new InMemoryEventSubscription(catchUpEvents),
        live: new InMemoryEventSubscription(liveEvents)
      },
      store,
      batchSize: 100
    });

    await daemon.processBatch();
    expect(store.getDocument('invoice-1')).toEqual({ applied: 1 });

    store.failNextRuntimeModeCommit('ready_to_cutover');
    await expect(daemon.processBatch()).rejects.toThrow('injected runtime-mode commit failure: ready_to_cutover');

    expect(store.getDocument('__checkpoint__cutover-transition-recovery__runtime_mode')).toBeNull();
    expect(store.getCursor('__cursor__cutover-transition-recovery')).toEqual({
      sequence: 1,
      timestamp: '2026-04-09T00:00:01.000Z'
    });

    const restartedDaemon = new ProjectionDaemon<{ applied: number }>({
      projection,
      subscriptions: {
        catchUp: new InMemoryEventSubscription(catchUpEvents),
        live: new InMemoryEventSubscription(liveEvents)
      },
      store,
      batchSize: 100
    });

    await restartedDaemon.processBatch(); // catching_up -> ready_to_cutover
    await restartedDaemon.processBatch(); // ready_to_cutover -> live
    const recoveredLive = await restartedDaemon.processBatch();

    expect(recoveredLive.eventsProcessed).toBe(1);
    expect(recoveredLive.diagnostics.dedupeSuppressed).toBe(0);
    expect(store.getDocument('invoice-1')).toEqual({ applied: 2 });
    expect(store.getCursor('__cursor__cutover-transition-recovery')).toEqual({
      sequence: 2,
      timestamp: '2026-04-09T00:00:02.000Z'
    });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:1')).toEqual({
      sequence: 1,
      timestamp: '2026-04-09T00:00:01.000Z'
    });
    expect(await store.getDedupeCheckpoint('invoice:invoice-1:2')).toEqual({
      sequence: 2,
      timestamp: '2026-04-09T00:00:02.000Z'
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
