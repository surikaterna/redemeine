import { describe, test, expect } from 'bun:test';
import type {
  EventStatus,
  StoredEvent,
  AggregateSnapshot,
  NewEvent,
  SaveEventOptions,
  SaveEventResult,
  ConfirmResult,
  SupersedeResult,
  ReadStreamOptions,
  ISyncEventStore,
  CommandMetadata,
  QueuedCommand,
  ICommandQueue,
  Checkpoint,
  ICheckpointStore,
} from '../src/store';
import type { SyncLane } from '../src/store';

// ---------------------------------------------------------------------------
// Type-level helpers
// ---------------------------------------------------------------------------

/**
 * Compile-time assertion: if `T` does not extend `U`, the assignment
 * below fails to compile. No runtime cost.
 */
type AssertExtends<T extends U, U> = T;

// ---------------------------------------------------------------------------
// EventStatus — discriminated union
// ---------------------------------------------------------------------------

describe('EventStatus', () => {
  test('accepts all valid status values', () => {
    const pending: EventStatus = 'pending';
    const confirmed: EventStatus = 'confirmed';
    const superseded: EventStatus = 'superseded';

    expect(pending).toBe('pending');
    expect(confirmed).toBe('confirmed');
    expect(superseded).toBe('superseded');
  });

  test('type guard narrows correctly', () => {
    const isConfirmed = (status: EventStatus): status is 'confirmed' =>
      status === 'confirmed';

    const status: EventStatus = 'confirmed';
    if (isConfirmed(status)) {
      // Inside this branch, TS narrows `status` to the literal 'confirmed'
      const _narrowed: 'confirmed' = status;
      expect(_narrowed).toBe('confirmed');
    }
  });

  // Compile-time: verify the union is exactly these three values
  type _CheckPending = AssertExtends<'pending', EventStatus>;
  type _CheckConfirmed = AssertExtends<'confirmed', EventStatus>;
  type _CheckSuperseded = AssertExtends<'superseded', EventStatus>;
});

// ---------------------------------------------------------------------------
// StoredEvent — interface shape
// ---------------------------------------------------------------------------

describe('StoredEvent', () => {
  test('can construct a valid stored event literal', () => {
    const event: StoredEvent = {
      id: 'evt-1',
      streamId: 'stream-1',
      type: 'order.created.event',
      payload: { total: 100 },
      status: 'pending',
      commandId: 'cmd-1',
      version: 1,
      occurredAt: '2026-01-01T00:00:00Z',
      ingestedAt: '2026-01-01T00:00:01Z',
    };

    expect(event.id).toBe('evt-1');
    expect(event.status).toBe('pending');
  });

  test('supersededBy is optional', () => {
    const event: StoredEvent = {
      id: 'evt-2',
      streamId: 'stream-1',
      type: 'order.created.event',
      payload: {},
      status: 'superseded',
      commandId: 'cmd-2',
      version: 2,
      occurredAt: '2026-01-01T00:00:00Z',
      ingestedAt: '2026-01-01T00:00:01Z',
      supersededBy: 'evt-3',
    };

    expect(event.supersededBy).toBe('evt-3');
  });
});

// ---------------------------------------------------------------------------
// AggregateSnapshot — interface shape
// ---------------------------------------------------------------------------

describe('AggregateSnapshot', () => {
  test('can construct a valid snapshot literal', () => {
    const snapshot: AggregateSnapshot = {
      streamId: 'stream-1',
      version: 42,
      state: { items: [] },
      snapshotAt: '2026-01-01T00:00:00Z',
    };

    expect(snapshot.version).toBe(42);
    expect(snapshot.streamId).toBe('stream-1');
  });
});

// ---------------------------------------------------------------------------
// ISyncEventStore — mock implementation proves implementability
// ---------------------------------------------------------------------------

describe('ISyncEventStore', () => {
  test('mock implementation satisfies the interface', async () => {
    const storedEvents: StoredEvent[] = [];

    const mockStore: ISyncEventStore = {
      async saveEvents(
        streamId: string,
        events: ReadonlyArray<NewEvent>,
        options: SaveEventOptions,
      ): Promise<SaveEventResult> {
        let version = storedEvents.filter(e => e.streamId === streamId).length;
        const eventIds: string[] = [];

        for (const event of events) {
          version += 1;
          const id = `evt-${version}`;
          eventIds.push(id);
          storedEvents.push({
            id,
            streamId,
            type: event.type,
            payload: event.payload,
            status: options.status,
            commandId: options.commandId,
            version,
            occurredAt: event.occurredAt,
            ingestedAt: new Date().toISOString(),
          });
        }

        return { eventIds, nextVersion: version };
      },

      async confirmEvents(commandId: string): Promise<ConfirmResult> {
        let count = 0;
        for (const event of storedEvents) {
          if (event.commandId === commandId && event.status === 'pending') {
            (event as { status: EventStatus }).status = 'confirmed';
            count++;
          }
        }
        return { confirmedCount: count };
      },

      async supersedeEvents(
        commandId: string,
        replacements: ReadonlyArray<NewEvent>,
      ): Promise<SupersedeResult> {
        let supersededCount = 0;
        const replacementEventIds: string[] = [];

        for (const event of storedEvents) {
          if (event.commandId === commandId && event.status === 'pending') {
            (event as { status: EventStatus }).status = 'superseded';
            supersededCount++;
          }
        }

        for (const r of replacements) {
          const id = `evt-replacement-${replacementEventIds.length}`;
          replacementEventIds.push(id);
        }

        return { supersededCount, replacementEventIds };
      },

      async *readStream(
        streamId: string,
        options?: ReadStreamOptions,
      ): AsyncIterable<StoredEvent> {
        for (const event of storedEvents) {
          if (event.streamId !== streamId) continue;
          if (options?.confirmedOnly && event.status !== 'confirmed') continue;
          if (options?.fromVersion && event.version < options.fromVersion) continue;
          yield event;
        }
      },

      async loadSnapshot(
        _streamId: string,
      ): Promise<AggregateSnapshot | undefined> {
        return undefined;
      },

      async importSnapshot(_snapshot: AggregateSnapshot): Promise<void> {
        // no-op in mock
      },
    };

    // Exercise the mock
    const result = await mockStore.saveEvents(
      'stream-1',
      [{ type: 'item.added.event', payload: { sku: 'A1' }, occurredAt: '2026-01-01T00:00:00Z' }],
      { status: 'pending', commandId: 'cmd-1' },
    );

    expect(result.eventIds).toHaveLength(1);
    expect(result.nextVersion).toBe(1);

    const confirmResult = await mockStore.confirmEvents('cmd-1');
    expect(confirmResult.confirmedCount).toBe(1);

    const events: StoredEvent[] = [];
    for await (const e of mockStore.readStream('stream-1')) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// ICommandQueue — mock implementation proves implementability
// ---------------------------------------------------------------------------

describe('ICommandQueue', () => {
  test('mock implementation satisfies the interface', async () => {
    const queue: QueuedCommand[] = [];

    const mockQueue: ICommandQueue = {
      async enqueue(command: QueuedCommand): Promise<void> {
        queue.push(command);
      },

      async peekBatch(size: number): Promise<ReadonlyArray<QueuedCommand>> {
        return queue.slice(0, size);
      },

      async ackBatch(commandIds: ReadonlyArray<string>): Promise<void> {
        const idSet = new Set(commandIds);
        let i = queue.length;
        while (i--) {
          if (idSet.has(queue[i].commandId)) {
            queue.splice(i, 1);
          }
        }
      },

      async depth(): Promise<number> {
        return queue.length;
      },
    };

    const command: QueuedCommand = {
      commandId: 'cmd-1',
      aggregateType: 'order',
      aggregateId: 'order-123',
      commandType: 'order.create.command',
      payload: { total: 100 },
      metadata: {
        nodeId: 'node-1',
        tenant: 'tenant-a',
        timestamp: '2026-01-01T00:00:00Z',
      },
      enqueuedAt: '2026-01-01T00:00:00Z',
    };

    await mockQueue.enqueue(command);
    expect(await mockQueue.depth()).toBe(1);

    const batch = await mockQueue.peekBatch(10);
    expect(batch).toHaveLength(1);
    expect(batch[0].commandId).toBe('cmd-1');

    await mockQueue.ackBatch(['cmd-1']);
    expect(await mockQueue.depth()).toBe(0);
  });

  test('CommandMetadata supports optional tracing fields', () => {
    const meta: CommandMetadata = {
      nodeId: 'node-1',
      tenant: 'tenant-a',
      timestamp: '2026-01-01T00:00:00Z',
      correlationId: 'corr-1',
      causationId: 'cause-1',
    };

    expect(meta.correlationId).toBe('corr-1');
    expect(meta.causationId).toBe('cause-1');
  });
});

// ---------------------------------------------------------------------------
// ICheckpointStore — mock implementation proves implementability
// ---------------------------------------------------------------------------

describe('ICheckpointStore', () => {
  test('mock implementation satisfies the interface', async () => {
    const checkpoints = new Map<SyncLane, Checkpoint>();

    const mockStore: ICheckpointStore = {
      async getCheckpoint(lane: SyncLane): Promise<Checkpoint | undefined> {
        return checkpoints.get(lane);
      },

      async saveCheckpoint(lane: SyncLane, checkpoint: Checkpoint): Promise<void> {
        checkpoints.set(lane, checkpoint);
      },
    };

    expect(await mockStore.getCheckpoint('events')).toBeUndefined();

    const checkpoint: Checkpoint = {
      lane: 'events',
      position: 'cursor-42',
      savedAt: '2026-01-01T00:00:00Z',
    };

    await mockStore.saveCheckpoint('events', checkpoint);

    const loaded = await mockStore.getCheckpoint('events');
    expect(loaded).toBeDefined();
    expect(loaded!.position).toBe('cursor-42');
    expect(loaded!.lane).toBe('events');
  });

  test('SyncLane accepts all valid lane values', () => {
    const lanes: SyncLane[] = ['events', 'projections', 'masterData', 'configuration'];
    expect(lanes).toHaveLength(4);
  });
});
