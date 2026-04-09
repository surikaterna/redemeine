import { describe, expect, test } from '@jest/globals';
import {
  createProjection,
  EventStoreCatchUpSubscription,
  type Checkpoint,
  type IProjectionStore,
  type ProjectionAtomicWrite,
  type ProjectionEvent,
  ProjectionDaemon
} from '../../projection-runtime-core/src';

type ProjectionState = {
  seen: number[];
};

class RecordingProjectionStore<TState> implements IProjectionStore<TState> {
  readonly atomicWrites: ProjectionAtomicWrite<TState>[] = [];
  private readonly documents = new Map<string, { state: TState; checkpoint: Checkpoint }>();
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

    for (const dedupeEntry of write.dedupe.upserts) {
      this.dedupe.set(dedupeEntry.key, dedupeEntry.checkpoint);
    }

    this.documents.set(write.cursorKey, {
      state: {} as TState,
      checkpoint: write.cursor
    });
  }

  async resolveTarget(_aggregateType: string, _aggregateId: string): Promise<string | null> {
    return null;
  }

  async getCheckpoint(key: string): Promise<Checkpoint | null> {
    return this.documents.get(key)?.checkpoint ?? null;
  }

  async getDedupeCheckpoint(key: string): Promise<Checkpoint | null> {
    return this.dedupe.get(key) ?? null;
  }

  setCheckpoint(key: string, checkpoint: Checkpoint): void {
    this.documents.set(key, { state: {} as TState, checkpoint });
  }

  getDocument(documentId: string): TState | null {
    return this.documents.get(documentId)?.state ?? null;
  }
}

class RecordingEventStoreReader {
  readonly calls: Array<{ sequence: number; limit: number }> = [];

  constructor(private readonly batches: readonly ProjectionEvent[][]) {}

  async readAfter(sequence: number, limit: number): Promise<readonly ProjectionEvent[]> {
    this.calls.push({ sequence, limit });
    return this.batches[this.calls.length - 1] ?? [];
  }
}

const invoiceAgg = {
  __aggregateType: 'invoice',
  initialState: {},
  pure: { eventProjectors: {} }
};

function event(sequence: number): ProjectionEvent {
  return {
    sequence,
    aggregateType: 'invoice',
    aggregateId: 'invoice-1',
    type: 'created',
    payload: {},
    timestamp: `2026-04-09T00:00:${String(sequence).padStart(2, '0')}.000Z`
  };
}

describe('runtime-core E5.1 EventStore catch-up subscription', () => {
  test('replays in order from non-zero persisted checkpoint', async () => {
    const projection = createProjection<ProjectionState>('eventstore-catchup-ordered', () => ({ seen: [] }))
      .from(invoiceAgg, {
        created: (state, evt) => {
          state.seen.push(evt.sequence);
        }
      })
      .build();

    const store = new RecordingProjectionStore<ProjectionState>();
    store.setCheckpoint('__cursor__eventstore-catchup-ordered', { sequence: 2 });

    const reader = new RecordingEventStoreReader([
      [event(4), event(3), event(2)]
    ]);

    const daemon = new ProjectionDaemon<ProjectionState>({
      projection,
      subscription: new EventStoreCatchUpSubscription(reader),
      store,
      batchSize: 100
    });

    const stats = await daemon.processBatch();

    expect(reader.calls).toEqual([{ sequence: 2, limit: 100 }]);
    expect(stats.eventsProcessed).toBe(2);
    expect(store.getDocument('invoice-1')).toEqual({ seen: [3, 4] });
    expect(store.atomicWrites).toHaveLength(1);
    expect(store.atomicWrites[0]?.cursor).toEqual({
      sequence: 4,
      timestamp: '2026-04-09T00:00:04.000Z'
    });
  });

  test('continues safely after restart without reprocessing last checkpoint event', async () => {
    const projection = createProjection<ProjectionState>('eventstore-catchup-restart', () => ({ seen: [] }))
      .from(invoiceAgg, {
        created: (state, evt) => {
          state.seen.push(evt.sequence);
        }
      })
      .build();

    const store = new RecordingProjectionStore<ProjectionState>();
    const reader = new RecordingEventStoreReader([
      [event(1), event(2)],
      [event(2), event(3)]
    ]);

    const firstDaemon = new ProjectionDaemon<ProjectionState>({
      projection,
      subscription: new EventStoreCatchUpSubscription(reader),
      store,
      batchSize: 100
    });

    const firstStats = await firstDaemon.processBatch();
    expect(firstStats.eventsProcessed).toBe(2);
    expect(store.getDocument('invoice-1')).toEqual({ seen: [1, 2] });

    const restartedDaemon = new ProjectionDaemon<ProjectionState>({
      projection,
      subscription: new EventStoreCatchUpSubscription(reader),
      store,
      batchSize: 100
    });

    const restartStats = await restartedDaemon.processBatch();
    expect(reader.calls).toEqual([
      { sequence: 0, limit: 100 },
      { sequence: 2, limit: 100 }
    ]);
    expect(restartStats.eventsProcessed).toBe(1);
    expect(store.getDocument('invoice-1')).toEqual({ seen: [1, 2, 3] });
    expect(store.atomicWrites).toHaveLength(2);
    expect(store.atomicWrites[1]?.dedupe.upserts.map((entry) => entry.key)).toEqual([
      'invoice:invoice-1:3'
    ]);
  });

  test('keeps cursor stable on empty batch', async () => {
    const projection = createProjection<ProjectionState>('eventstore-catchup-empty', () => ({ seen: [] }))
      .from(invoiceAgg, {
        created: (state, evt) => {
          state.seen.push(evt.sequence);
        }
      })
      .build();

    const store = new RecordingProjectionStore<ProjectionState>();
    store.setCheckpoint('__cursor__eventstore-catchup-empty', {
      sequence: 5,
      timestamp: '2026-04-09T00:00:05.000Z'
    });

    const reader = new RecordingEventStoreReader([[]]);

    const daemon = new ProjectionDaemon<ProjectionState>({
      projection,
      subscription: new EventStoreCatchUpSubscription(reader),
      store,
      batchSize: 100
    });

    const stats = await daemon.processBatch();

    expect(reader.calls).toEqual([{ sequence: 5, limit: 100 }]);
    expect(stats).toEqual({
      eventsProcessed: 0,
      documentsUpdated: 0,
      duration: expect.any(Number)
    });
    expect(store.atomicWrites).toHaveLength(0);
    expect(await store.getCheckpoint('__cursor__eventstore-catchup-empty')).toEqual({
      sequence: 5,
      timestamp: '2026-04-09T00:00:05.000Z'
    });
  });
});
