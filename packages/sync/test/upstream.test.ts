import { describe, test, expect, beforeEach } from 'bun:test';
import type {
  ICommandQueue,
  QueuedCommand,
  CommandMetadata,
} from '../src/store';
import type {
  UpstreamBatchRequest,
  UpstreamBatchResult,
  UpstreamSyncService,
  IConnectionMonitor,
  ConnectionState,
  ConnectionStateListener,
  Unsubscribe,
  DrainResult,
} from '../src/upstream';
import { createQueueDrain } from '../src/upstream';

// ---------------------------------------------------------------------------
// In-memory mock: ICommandQueue
// ---------------------------------------------------------------------------

function createMockQueue(): ICommandQueue & { items: QueuedCommand[] } {
  const items: QueuedCommand[] = [];

  return {
    items,

    async enqueue(command: QueuedCommand): Promise<void> {
      items.push(command);
    },

    async peekBatch(size: number): Promise<ReadonlyArray<QueuedCommand>> {
      return items.slice(0, size);
    },

    async ackBatch(commandIds: ReadonlyArray<string>): Promise<void> {
      const idSet = new Set(commandIds);
      for (let i = items.length - 1; i >= 0; i--) {
        if (idSet.has(items[i].commandId)) {
          items.splice(i, 1);
        }
      }
    },

    async depth(): Promise<number> {
      return items.length;
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory mock: IConnectionMonitor
// ---------------------------------------------------------------------------

function createMockConnectionMonitor(
  initial: ConnectionState = 'online',
): IConnectionMonitor & { setState(s: ConnectionState): void } {
  let state: ConnectionState = initial;
  const listeners: Set<ConnectionStateListener> = new Set();

  return {
    getState: () => state,

    onStateChange(listener: ConnectionStateListener): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setState(s: ConnectionState): void {
      state = s;
      for (const listener of listeners) {
        listener(s);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory mock: UpstreamSyncService
// ---------------------------------------------------------------------------

function createMockSyncService(
  handler?: (req: UpstreamBatchRequest) => UpstreamBatchResult,
): UpstreamSyncService & { calls: UpstreamBatchRequest[] } {
  const calls: UpstreamBatchRequest[] = [];

  return {
    calls,

    async submitCommands(request: UpstreamBatchRequest): Promise<UpstreamBatchResult> {
      calls.push(request);

      if (handler) {
        return handler(request);
      }

      // Default: accept all commands
      return {
        batchId: request.batchId,
        receivedAt: new Date().toISOString(),
        results: request.commands.map((cmd) => ({
          status: 'accepted' as const,
          commandId: cmd.commandId,
        })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const makeCommand = (id: string, overrides?: Partial<QueuedCommand>): QueuedCommand => {
  const metadata: CommandMetadata = {
    nodeId: 'node-1',
    tenant: 'tenant-a',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides?.metadata,
  };

  return {
    commandId: id,
    aggregateType: 'test-aggregate',
    aggregateId: 'agg-1',
    commandType: 'test.command',
    payload: { value: id },
    metadata,
    enqueuedAt: '2026-01-01T00:00:00Z',
    ...overrides,
    // Re-apply metadata after spread to ensure merge
    metadata: { ...metadata, ...overrides?.metadata },
  };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueueDrain', () => {
  let queue: ReturnType<typeof createMockQueue>;
  let monitor: ReturnType<typeof createMockConnectionMonitor>;
  let syncService: ReturnType<typeof createMockSyncService>;

  beforeEach(() => {
    queue = createMockQueue();
    monitor = createMockConnectionMonitor('online');
    syncService = createMockSyncService();
  });

  // -------------------------------------------------------------------------
  // drainOnce: happy path
  // -------------------------------------------------------------------------

  test('drainOnce: batch submitted, accepted commands acked', async () => {
    await queue.enqueue(makeCommand('cmd-1'));
    await queue.enqueue(makeCommand('cmd-2'));
    await queue.enqueue(makeCommand('cmd-3'));

    const drain = createQueueDrain({
      queue,
      syncService,
      connectionMonitor: monitor,
      nodeId: 'node-1',
    });

    const result = await drain.drainOnce();

    expect(result.drained).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(queue.items).toHaveLength(0);

    // Verify the service was called with correct envelope structure
    expect(syncService.calls).toHaveLength(1);
    const req = syncService.calls[0];
    expect(req.nodeId).toBe('node-1');
    expect(req.commands).toHaveLength(3);
    expect(req.commands[0].commandId).toBe('cmd-1');
    expect(req.commands[0].metadata.nodeId).toBe('node-1');
    expect(req.commands[0].metadata.tenant).toBe('tenant-a');
  });

  // -------------------------------------------------------------------------
  // drainOnce: offline
  // -------------------------------------------------------------------------

  test('drainOnce: offline returns immediately with remaining count', async () => {
    await queue.enqueue(makeCommand('cmd-1'));
    await queue.enqueue(makeCommand('cmd-2'));

    monitor.setState('offline');

    const drain = createQueueDrain({
      queue,
      syncService,
      connectionMonitor: monitor,
      nodeId: 'node-1',
    });

    const result = await drain.drainOnce();

    expect(result.drained).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(2);
    expect(syncService.calls).toHaveLength(0);
    expect(queue.items).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // drainOnce: mixed results
  // -------------------------------------------------------------------------

  test('drainOnce: mixed results — accepted acked, rejected reported', async () => {
    await queue.enqueue(makeCommand('cmd-1'));
    await queue.enqueue(makeCommand('cmd-2'));
    await queue.enqueue(makeCommand('cmd-3'));

    const drainResults: DrainResult[] = [];

    const service = createMockSyncService((req) => ({
      batchId: req.batchId,
      receivedAt: new Date().toISOString(),
      results: [
        { status: 'accepted' as const, commandId: 'cmd-1' },
        { status: 'rejected' as const, commandId: 'cmd-2', reason: 'invalid payload' },
        { status: 'accepted' as const, commandId: 'cmd-3' },
      ],
    }));

    const drain = createQueueDrain({
      queue,
      syncService: service,
      connectionMonitor: monitor,
      nodeId: 'node-1',
      onDrainResult: (r) => drainResults.push(r),
    });

    const result = await drain.drainOnce();

    expect(result.drained).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.remaining).toBe(0);

    // All commands (including rejected) are acked out of the queue
    expect(queue.items).toHaveLength(0);

    // Callback was invoked
    expect(drainResults).toHaveLength(1);
    expect(drainResults[0].failed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // drainOnce: duplicate handling
  // -------------------------------------------------------------------------

  test('drainOnce: duplicates are acked', async () => {
    await queue.enqueue(makeCommand('cmd-1'));
    await queue.enqueue(makeCommand('cmd-2'));

    const service = createMockSyncService((req) => ({
      batchId: req.batchId,
      receivedAt: new Date().toISOString(),
      results: [
        { status: 'duplicate' as const, commandId: 'cmd-1' },
        { status: 'accepted' as const, commandId: 'cmd-2' },
      ],
    }));

    const drain = createQueueDrain({
      queue,
      syncService: service,
      connectionMonitor: monitor,
      nodeId: 'node-1',
    });

    const result = await drain.drainOnce();

    expect(result.drained).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);
    expect(queue.items).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // drainOnce: empty queue
  // -------------------------------------------------------------------------

  test('drainOnce: empty queue returns zero drained', async () => {
    const drain = createQueueDrain({
      queue,
      syncService,
      connectionMonitor: monitor,
      nodeId: 'node-1',
    });

    const result = await drain.drainOnce();

    expect(result.drained).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.remaining).toBe(0);

    // Service should not be called for empty batch
    expect(syncService.calls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Connection state change triggers drain
  // -------------------------------------------------------------------------

  test('connection state change to online triggers drain', async () => {
    await queue.enqueue(makeCommand('cmd-1'));

    monitor.setState('offline');

    const drain = createQueueDrain({
      queue,
      syncService,
      connectionMonitor: monitor,
      nodeId: 'node-1',
    });

    drain.start();
    expect(drain.isRunning()).toBe(true);

    // Transition to online should trigger drain
    monitor.setState('online');

    // Wait for the async drain to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(syncService.calls).toHaveLength(1);
    expect(queue.items).toHaveLength(0);

    drain.stop();
    expect(drain.isRunning()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Connection state: reconnecting does not trigger drain
  // -------------------------------------------------------------------------

  test('connection state change to reconnecting does not trigger drain', async () => {
    await queue.enqueue(makeCommand('cmd-1'));

    monitor.setState('offline');

    const drain = createQueueDrain({
      queue,
      syncService,
      connectionMonitor: monitor,
      nodeId: 'node-1',
    });

    drain.start();

    // Transition to reconnecting should NOT trigger drain
    monitor.setState('reconnecting');

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(syncService.calls).toHaveLength(0);
    expect(queue.items).toHaveLength(1);

    drain.stop();
  });

  // -------------------------------------------------------------------------
  // start/stop lifecycle
  // -------------------------------------------------------------------------

  test('stop unsubscribes from connection state changes', async () => {
    await queue.enqueue(makeCommand('cmd-1'));

    monitor.setState('offline');

    const drain = createQueueDrain({
      queue,
      syncService,
      connectionMonitor: monitor,
      nodeId: 'node-1',
    });

    drain.start();
    drain.stop();

    // After stop, going online should NOT trigger drain
    monitor.setState('online');

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(syncService.calls).toHaveLength(0);
    expect(queue.items).toHaveLength(1);
  });

  test('start is idempotent', () => {
    const drain = createQueueDrain({
      queue,
      syncService,
      connectionMonitor: monitor,
      nodeId: 'node-1',
    });

    drain.start();
    drain.start(); // Should not throw or double-subscribe

    expect(drain.isRunning()).toBe(true);

    drain.stop();
    expect(drain.isRunning()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Batch size limiting
  // -------------------------------------------------------------------------

  test('drainOnce respects batchSize option', async () => {
    for (let i = 1; i <= 10; i++) {
      await queue.enqueue(makeCommand(`cmd-${i}`));
    }

    const drain = createQueueDrain({
      queue,
      syncService,
      connectionMonitor: monitor,
      nodeId: 'node-1',
      batchSize: 3,
    });

    const result = await drain.drainOnce();

    // Only 3 should be submitted in a single drain cycle
    expect(syncService.calls).toHaveLength(1);
    expect(syncService.calls[0].commands).toHaveLength(3);
    expect(result.drained).toBe(3);
    expect(result.remaining).toBe(7);
  });

  // -------------------------------------------------------------------------
  // Envelope mapping fidelity
  // -------------------------------------------------------------------------

  test('maps QueuedCommand to UpstreamCommandEnvelope correctly', async () => {
    const metadata: CommandMetadata = {
      nodeId: 'node-42',
      tenant: 'tenant-x',
      timestamp: '2026-06-15T12:00:00Z',
      correlationId: 'corr-1',
      causationId: 'cause-1',
    };

    await queue.enqueue(
      makeCommand('cmd-special', {
        aggregateType: 'order',
        aggregateId: 'order-99',
        commandType: 'order.place',
        payload: { items: [1, 2, 3] },
        metadata,
      }),
    );

    const drain = createQueueDrain({
      queue,
      syncService,
      connectionMonitor: monitor,
      nodeId: 'node-42',
    });

    await drain.drainOnce();

    const envelope = syncService.calls[0].commands[0];
    expect(envelope.commandId).toBe('cmd-special');
    expect(envelope.aggregateType).toBe('order');
    expect(envelope.aggregateId).toBe('order-99');
    expect(envelope.commandType).toBe('order.place');
    expect(envelope.payload).toEqual({ items: [1, 2, 3] });
    expect(envelope.metadata.nodeId).toBe('node-42');
    expect(envelope.metadata.tenant).toBe('tenant-x');
    expect(envelope.metadata.timestamp).toBe('2026-06-15T12:00:00Z');
    expect(envelope.metadata.correlationId).toBe('corr-1');
    expect(envelope.metadata.causationId).toBe('cause-1');
  });
});
