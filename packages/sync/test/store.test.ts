import { describe, test, expect } from 'bun:test';
import type {
  CommandMetadata,
  QueuedCommand,
  ICommandQueue,
  Checkpoint,
  ICheckpointStore,
} from '../src/store';
import type { SyncLane } from '../src/store';

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
