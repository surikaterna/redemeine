import { describe, test, expect, beforeEach } from 'bun:test';
import type {
  EventStreamEnvelope,
  DownstreamEvent,
} from '../src/downstream/event-stream-envelope';
import type { ProjectionEnvelope } from '../src/downstream/projection-envelope';
import type { ConfigEnvelope } from '../src/downstream/config-envelope';
import type {
  ICheckpointStore,
  Checkpoint,
  SyncLane,
} from '../src/store';
import type { EnvelopeProcessResult } from '../src/downstream/feed-consumer';
import type {
  IReconciliationEventStoreAdapter,
  UpstreamSnapshot,
  SyncEvent,
} from '../src/reconciliation/event-store-adapter';
import type { IReconciliationService } from '../src/reconciliation/reconciliation-service';
import type { ReconciliationOutcome } from '../src/reconciliation/reconciliation-result';
import { createReconciliationService } from '../src/reconciliation/reconciliation-service';
import { createEventStreamConsumer } from '../src/downstream/feed-consumer';

// ---------------------------------------------------------------------------
// In-memory mock stores
// ---------------------------------------------------------------------------

function createMockEventStoreAdapter(): IReconciliationEventStoreAdapter & {
  events: Map<string, SyncEvent[]>;
  snapshots: UpstreamSnapshot[];
} {
  const events = new Map<string, SyncEvent[]>();
  const snapshots: UpstreamSnapshot[] = [];

  return {
    events,
    snapshots,

    async findEventsByCommandId(
      streamId: string,
      commandId: string,
    ): Promise<ReadonlyArray<SyncEvent>> {
      const streamEvents = events.get(streamId) ?? [];
      return streamEvents.filter(
        (e) => e.metadata?.command?.id === commandId,
      );
    },

    async replaceEventsByCommandId(
      streamId: string,
      commandId: string,
      authoritativeEvents: ReadonlyArray<SyncEvent>,
    ): Promise<ReadonlyArray<SyncEvent>> {
      const streamEvents = events.get(streamId) ?? [];
      const displaced = streamEvents.filter(
        (e) => e.metadata?.command?.id === commandId,
      );
      const remaining = streamEvents.filter(
        (e) => e.metadata?.command?.id !== commandId,
      );
      remaining.push(...authoritativeEvents);
      events.set(streamId, remaining);
      return displaced;
    },

    async saveEvents(
      streamId: string,
      newEvents: ReadonlyArray<SyncEvent>,
    ): Promise<void> {
      const existing = events.get(streamId) ?? [];
      existing.push(...newEvents);
      events.set(streamId, existing);
    },

    async importSnapshot(snapshot: UpstreamSnapshot): Promise<void> {
      snapshots.push(snapshot);
    },
  };
}

function createMockCheckpointStore(): ICheckpointStore & {
  checkpoints: Map<SyncLane, Checkpoint>;
} {
  const checkpoints = new Map<SyncLane, Checkpoint>();

  return {
    checkpoints,

    async getCheckpoint(lane: SyncLane): Promise<Checkpoint | undefined> {
      return checkpoints.get(lane);
    },

    async saveCheckpoint(lane: SyncLane, checkpoint: Checkpoint): Promise<void> {
      checkpoints.set(lane, checkpoint);
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: async iterable from array
// ---------------------------------------------------------------------------

async function* fromArray<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}

// ---------------------------------------------------------------------------
// Envelope type narrowing tests
// ---------------------------------------------------------------------------

describe('EventStreamEnvelope discrimination', () => {
  test('narrows snapshot variant', () => {
    const envelope: EventStreamEnvelope = {
      type: 'snapshot',
      streamId: 'order-123',
      aggregateType: 'order',
      state: { items: [] },
      version: 5,
      snapshotAt: '2026-01-01T00:00:00Z',
    };

    if (envelope.type === 'snapshot') {
      expect(envelope.streamId).toBe('order-123');
      expect(envelope.aggregateType).toBe('order');
      expect(envelope.version).toBe(5);
      expect(envelope.state).toEqual({ items: [] });
    } else {
      throw new Error('Expected snapshot type');
    }
  });

  test('narrows events variant', () => {
    const event: DownstreamEvent = {
      eventId: 'evt-1',
      type: 'item.added',
      payload: { sku: 'A1' },
      commandId: 'cmd-1',
      version: 1,
      occurredAt: '2026-01-01T00:00:00Z',
    };

    const envelope: EventStreamEnvelope = {
      type: 'events',
      streamId: 'order-123',
      aggregateType: 'order',
      events: [event],
      fromVersion: 1,
      toVersion: 1,
    };

    if (envelope.type === 'events') {
      expect(envelope.events).toHaveLength(1);
      expect(envelope.events[0].eventId).toBe('evt-1');
      expect(envelope.fromVersion).toBe(1);
      expect(envelope.toVersion).toBe(1);
    } else {
      throw new Error('Expected events type');
    }
  });

  test('narrows stream_added variant', () => {
    const envelope: EventStreamEnvelope = {
      type: 'stream_added',
      streamId: 'order-456',
      aggregateType: 'order',
      addedAt: '2026-01-01T00:00:00Z',
    };

    if (envelope.type === 'stream_added') {
      expect(envelope.streamId).toBe('order-456');
      expect(envelope.addedAt).toBe('2026-01-01T00:00:00Z');
    } else {
      throw new Error('Expected stream_added type');
    }
  });

  test('narrows stream_removed variant', () => {
    const envelope: EventStreamEnvelope = {
      type: 'stream_removed',
      streamId: 'order-789',
      aggregateType: 'order',
      removedAt: '2026-06-01T00:00:00Z',
    };

    if (envelope.type === 'stream_removed') {
      expect(envelope.streamId).toBe('order-789');
      expect(envelope.removedAt).toBe('2026-06-01T00:00:00Z');
    } else {
      throw new Error('Expected stream_removed type');
    }
  });

  test('exhaustive switch covers all variants', () => {
    const envelopes: ReadonlyArray<EventStreamEnvelope> = [
      { type: 'snapshot', streamId: 's1', aggregateType: 'a', state: {}, version: 1, snapshotAt: '' },
      { type: 'events', streamId: 's2', aggregateType: 'a', events: [], fromVersion: 1, toVersion: 1 },
      { type: 'stream_added', streamId: 's3', aggregateType: 'a', addedAt: '' },
      { type: 'stream_removed', streamId: 's4', aggregateType: 'a', removedAt: '' },
    ];

    const types: string[] = [];
    for (const env of envelopes) {
      switch (env.type) {
        case 'snapshot': types.push('snapshot'); break;
        case 'events': types.push('events'); break;
        case 'stream_added': types.push('stream_added'); break;
        case 'stream_removed': types.push('stream_removed'); break;
      }
    }

    expect(types).toEqual(['snapshot', 'events', 'stream_added', 'stream_removed']);
  });
});

describe('ProjectionEnvelope discrimination', () => {
  test('narrows snapshot variant', () => {
    const envelope: ProjectionEnvelope = {
      type: 'snapshot',
      projectionName: 'order-summary',
      documentId: 'doc-1',
      state: { total: 42 },
      version: 3,
      snapshotAt: '2026-01-01T00:00:00Z',
    };

    if (envelope.type === 'snapshot') {
      expect(envelope.projectionName).toBe('order-summary');
      expect(envelope.documentId).toBe('doc-1');
      expect(envelope.version).toBe(3);
    } else {
      throw new Error('Expected snapshot type');
    }
  });

  test('narrows delta variant', () => {
    const envelope: ProjectionEnvelope = {
      type: 'delta',
      projectionName: 'order-summary',
      documentId: 'doc-1',
      patches: [{ op: 'replace', path: '/total', value: 50 }],
      fromVersion: 3,
      toVersion: 4,
    };

    if (envelope.type === 'delta') {
      expect(envelope.patches).toHaveLength(1);
      expect(envelope.fromVersion).toBe(3);
      expect(envelope.toVersion).toBe(4);
    } else {
      throw new Error('Expected delta type');
    }
  });

  test('narrows removed variant', () => {
    const envelope: ProjectionEnvelope = {
      type: 'removed',
      projectionName: 'order-summary',
      documentId: 'doc-1',
      removedAt: '2026-06-01T00:00:00Z',
    };

    if (envelope.type === 'removed') {
      expect(envelope.removedAt).toBe('2026-06-01T00:00:00Z');
    } else {
      throw new Error('Expected removed type');
    }
  });

  test('exhaustive switch covers all variants', () => {
    const envelopes: ReadonlyArray<ProjectionEnvelope> = [
      { type: 'snapshot', projectionName: 'p', documentId: 'd', state: {}, version: 1, snapshotAt: '' },
      { type: 'delta', projectionName: 'p', documentId: 'd', patches: [], fromVersion: 1, toVersion: 2 },
      { type: 'removed', projectionName: 'p', documentId: 'd', removedAt: '' },
    ];

    const types: string[] = [];
    for (const env of envelopes) {
      switch (env.type) {
        case 'snapshot': types.push('snapshot'); break;
        case 'delta': types.push('delta'); break;
        case 'removed': types.push('removed'); break;
      }
    }

    expect(types).toEqual(['snapshot', 'delta', 'removed']);
  });
});

describe('ConfigEnvelope discrimination', () => {
  test('narrows snapshot variant', () => {
    const envelope: ConfigEnvelope = {
      type: 'snapshot',
      namespace: 'feature-flags',
      config: { darkMode: true },
      version: 1,
      snapshotAt: '2026-01-01T00:00:00Z',
    };

    if (envelope.type === 'snapshot') {
      expect(envelope.namespace).toBe('feature-flags');
      expect(envelope.config).toEqual({ darkMode: true });
    } else {
      throw new Error('Expected snapshot type');
    }
  });

  test('narrows delta variant', () => {
    const envelope: ConfigEnvelope = {
      type: 'delta',
      namespace: 'feature-flags',
      patches: [{ op: 'add', path: '/newFlag', value: false }],
      fromVersion: 1,
      toVersion: 2,
    };

    if (envelope.type === 'delta') {
      expect(envelope.patches).toHaveLength(1);
      expect(envelope.fromVersion).toBe(1);
    } else {
      throw new Error('Expected delta type');
    }
  });

  test('exhaustive switch covers all variants', () => {
    const envelopes: ReadonlyArray<ConfigEnvelope> = [
      { type: 'snapshot', namespace: 'n', config: {}, version: 1, snapshotAt: '' },
      { type: 'delta', namespace: 'n', patches: [], fromVersion: 1, toVersion: 2 },
    ];

    const types: string[] = [];
    for (const env of envelopes) {
      switch (env.type) {
        case 'snapshot': types.push('snapshot'); break;
        case 'delta': types.push('delta'); break;
      }
    }

    expect(types).toEqual(['snapshot', 'delta']);
  });
});

// ---------------------------------------------------------------------------
// Feed consumer tests
// ---------------------------------------------------------------------------

describe('EventStreamConsumer', () => {
  let eventStoreAdapter: ReturnType<typeof createMockEventStoreAdapter>;
  let checkpointStore: ReturnType<typeof createMockCheckpointStore>;
  let reconciliationService: IReconciliationService;

  beforeEach(() => {
    eventStoreAdapter = createMockEventStoreAdapter();
    checkpointStore = createMockCheckpointStore();
    reconciliationService = createReconciliationService({
      eventStoreAdapter,
    });
  });

  test('snapshot import processed correctly', async () => {
    const consumer = createEventStreamConsumer({
      eventStoreAdapter,
      checkpointStore,
      reconciliationService,
      nodeId: 'node-1',
    });

    const feed = fromArray<EventStreamEnvelope>([
      {
        type: 'snapshot',
        streamId: 'order-123',
        aggregateType: 'order',
        state: { items: ['A1'] },
        version: 5,
        snapshotAt: '2026-01-01T00:00:00Z',
      },
    ]);

    const result = await consumer.consume(feed);

    expect(result.processed).toBe(1);
    expect(result.snapshots).toBe(1);
    expect(result.reconciled).toBe(0);
    expect(result.errors).toBe(0);

    // Verify snapshot was imported
    expect(eventStoreAdapter.snapshots).toHaveLength(1);
    expect(eventStoreAdapter.snapshots[0].streamId).toBe('order-123');
    expect(eventStoreAdapter.snapshots[0].version).toBe(5);
    expect(eventStoreAdapter.snapshots[0].state).toEqual({ items: ['A1'] });
  });

  test('events trigger reconciliation', async () => {
    // Pre-seed local events for cmd-1
    eventStoreAdapter.events.set('order-123', [
      {
        type: 'item.added',
        payload: { sku: 'A1' },
        metadata: { command: { id: 'cmd-1' } },
      },
    ]);

    const consumer = createEventStreamConsumer({
      eventStoreAdapter,
      checkpointStore,
      reconciliationService,
      nodeId: 'node-1',
    });

    const feed = fromArray<EventStreamEnvelope>([
      {
        type: 'events',
        streamId: 'order-123',
        aggregateType: 'order',
        events: [
          {
            eventId: 'upstream-evt-1',
            type: 'item.added',
            payload: { sku: 'A1' },
            commandId: 'cmd-1',
            version: 1,
            occurredAt: '2026-01-01T00:00:00Z',
          },
        ],
        fromVersion: 1,
        toVersion: 1,
      },
    ]);

    const result = await consumer.consume(feed);

    expect(result.processed).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(result.errors).toBe(0);
  });

  test('stream_added emits lifecycle signal via listener', async () => {
    const received: EventStreamEnvelope[] = [];

    const consumer = createEventStreamConsumer({
      eventStoreAdapter,
      checkpointStore,
      reconciliationService,
      nodeId: 'node-1',
      onEnvelope: (envelope) => {
        received.push(envelope);
      },
    });

    const feed = fromArray<EventStreamEnvelope>([
      {
        type: 'stream_added',
        streamId: 'order-456',
        aggregateType: 'order',
        addedAt: '2026-01-01T00:00:00Z',
      },
    ]);

    const result = await consumer.consume(feed);

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('stream_added');
    if (received[0].type === 'stream_added') {
      expect(received[0].streamId).toBe('order-456');
    }
  });

  test('stream_removed emits lifecycle signal via listener', async () => {
    const received: EventStreamEnvelope[] = [];

    const consumer = createEventStreamConsumer({
      eventStoreAdapter,
      checkpointStore,
      reconciliationService,
      nodeId: 'node-1',
      onEnvelope: (envelope) => {
        received.push(envelope);
      },
    });

    const feed = fromArray<EventStreamEnvelope>([
      {
        type: 'stream_removed',
        streamId: 'order-789',
        aggregateType: 'order',
        removedAt: '2026-06-01T00:00:00Z',
      },
    ]);

    const result = await consumer.consume(feed);

    expect(result.processed).toBe(1);
    expect(result.errors).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('stream_removed');
    if (received[0].type === 'stream_removed') {
      expect(received[0].streamId).toBe('order-789');
    }
  });

  test('checkpoint saved after each processed envelope', async () => {
    const consumer = createEventStreamConsumer({
      eventStoreAdapter,
      checkpointStore,
      reconciliationService,
      nodeId: 'node-1',
    });

    const feed = fromArray<EventStreamEnvelope>([
      {
        type: 'snapshot',
        streamId: 'order-1',
        aggregateType: 'order',
        state: {},
        version: 1,
        snapshotAt: '2026-01-01T00:00:00Z',
      },
      {
        type: 'stream_added',
        streamId: 'order-2',
        aggregateType: 'order',
        addedAt: '2026-01-01T00:00:01Z',
      },
      {
        type: 'snapshot',
        streamId: 'order-3',
        aggregateType: 'order',
        state: {},
        version: 1,
        snapshotAt: '2026-01-01T00:00:02Z',
      },
    ]);

    await consumer.consume(feed);

    // Checkpoint should exist and reflect the latest position
    const checkpoint = await consumer.getCheckpoint();
    expect(checkpoint).toBeDefined();
    expect(checkpoint).toBe('3'); // 3 envelopes processed

    // Verify checkpoint is persisted in the store
    const stored = checkpointStore.checkpoints.get('events');
    expect(stored).toBeDefined();
    expect(stored!.position).toBe('3');
    expect(stored!.lane).toBe('events');
  });

  test('handles errors gracefully without losing checkpoint', async () => {
    // Create an adapter that fails on importSnapshot on 2nd call
    const failingAdapter = createMockEventStoreAdapter();
    let callCount = 0;

    const originalImport = failingAdapter.importSnapshot.bind(failingAdapter);
    failingAdapter.importSnapshot = async (snapshot: UpstreamSnapshot): Promise<void> => {
      callCount++;
      if (callCount === 2) {
        throw new Error('storage full');
      }
      return originalImport(snapshot);
    };

    const failingService = createReconciliationService({
      eventStoreAdapter: failingAdapter,
    });

    const consumer = createEventStreamConsumer({
      eventStoreAdapter: failingAdapter,
      checkpointStore,
      reconciliationService: failingService,
      nodeId: 'node-1',
    });

    const feed = fromArray<EventStreamEnvelope>([
      // First snapshot — succeeds
      {
        type: 'snapshot',
        streamId: 'order-1',
        aggregateType: 'order',
        state: { v: 1 },
        version: 1,
        snapshotAt: '2026-01-01T00:00:00Z',
      },
      // Second snapshot — fails
      {
        type: 'snapshot',
        streamId: 'order-2',
        aggregateType: 'order',
        state: { v: 2 },
        version: 1,
        snapshotAt: '2026-01-01T00:00:01Z',
      },
      // Third envelope — succeeds (lifecycle signal)
      {
        type: 'stream_added',
        streamId: 'order-3',
        aggregateType: 'order',
        addedAt: '2026-01-01T00:00:02Z',
      },
    ]);

    const result = await consumer.consume(feed);

    expect(result.processed).toBe(2);  // 1st snapshot + stream_added
    expect(result.snapshots).toBe(1);   // only 1st succeeded
    expect(result.errors).toBe(1);      // 2nd snapshot failed

    // Checkpoint should reflect last successful position
    const checkpoint = await consumer.getCheckpoint();
    expect(checkpoint).toBeDefined();
    // 2 successful envelopes got checkpoints (positions 1 and 2)
    expect(checkpoint).toBe('2');

    // First snapshot was imported successfully
    expect(failingAdapter.snapshots).toHaveLength(1);
    expect(failingAdapter.snapshots[0].streamId).toBe('order-1');
  });

  test('listener receives both envelope and result for each processed item', async () => {
    const received: Array<{ envelope: EventStreamEnvelope; result: EnvelopeProcessResult }> = [];

    const consumer = createEventStreamConsumer({
      eventStoreAdapter,
      checkpointStore,
      reconciliationService,
      nodeId: 'node-1',
      onEnvelope: (envelope, result) => {
        received.push({ envelope, result });
      },
    });

    const feed = fromArray<EventStreamEnvelope>([
      {
        type: 'snapshot',
        streamId: 'order-1',
        aggregateType: 'order',
        state: {},
        version: 1,
        snapshotAt: '2026-01-01T00:00:00Z',
      },
      {
        type: 'events',
        streamId: 'order-2',
        aggregateType: 'order',
        events: [
          {
            eventId: 'e1',
            type: 'created',
            payload: {},
            commandId: 'cmd-new',
            version: 1,
            occurredAt: '2026-01-01T00:00:00Z',
          },
        ],
        fromVersion: 1,
        toVersion: 1,
      },
    ]);

    await consumer.consume(feed);

    expect(received).toHaveLength(2);
    expect(received[0].result.envelopeType).toBe('snapshot');
    expect(received[0].result.success).toBe(true);
    expect(received[1].result.envelopeType).toBe('events');
    expect(received[1].result.success).toBe(true);
  });

  test('getCheckpoint returns undefined when no checkpoint saved', async () => {
    const consumer = createEventStreamConsumer({
      eventStoreAdapter,
      checkpointStore,
      reconciliationService,
      nodeId: 'node-1',
    });

    const checkpoint = await consumer.getCheckpoint();
    expect(checkpoint).toBeUndefined();
  });

  test('consumes empty feed without error', async () => {
    const consumer = createEventStreamConsumer({
      eventStoreAdapter,
      checkpointStore,
      reconciliationService,
      nodeId: 'node-1',
    });

    const feed = fromArray<EventStreamEnvelope>([]);
    const result = await consumer.consume(feed);

    expect(result.processed).toBe(0);
    expect(result.snapshots).toBe(0);
    expect(result.reconciled).toBe(0);
    expect(result.errors).toBe(0);
  });

  test('events with multiple commands are each reconciled', async () => {
    const consumer = createEventStreamConsumer({
      eventStoreAdapter,
      checkpointStore,
      reconciliationService,
      nodeId: 'node-1',
    });

    const feed = fromArray<EventStreamEnvelope>([
      {
        type: 'events',
        streamId: 'order-1',
        aggregateType: 'order',
        events: [
          {
            eventId: 'e1',
            type: 'item.added',
            payload: { sku: 'A' },
            commandId: 'cmd-1',
            version: 1,
            occurredAt: '2026-01-01T00:00:00Z',
          },
          {
            eventId: 'e2',
            type: 'item.added',
            payload: { sku: 'B' },
            commandId: 'cmd-2',
            version: 2,
            occurredAt: '2026-01-01T00:00:01Z',
          },
        ],
        fromVersion: 1,
        toVersion: 2,
      },
    ]);

    const result = await consumer.consume(feed);

    expect(result.reconciled).toBe(1);  // 1 events envelope
    expect(result.processed).toBe(1);

    // Both command IDs should have events applied (no local events existed)
    const streamEvents = eventStoreAdapter.events.get('order-1') ?? [];
    const cmd1Events = streamEvents.filter(
      (e) => e.metadata?.command?.id === 'cmd-1',
    );
    const cmd2Events = streamEvents.filter(
      (e) => e.metadata?.command?.id === 'cmd-2',
    );
    expect(cmd1Events.length).toBeGreaterThan(0);
    expect(cmd2Events.length).toBeGreaterThan(0);
  });
});
