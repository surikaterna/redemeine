import { describe, test, expect, beforeEach } from 'bun:test';
import type {
  IReconciliationEventStoreAdapter,
  UpstreamSnapshot,
  SyncEvent,
} from '../src/reconciliation/event-store-adapter';
import type { IConflictArchive } from '../src/reconciliation/conflict-archive';
import type { ConflictRecord } from '../src/reconciliation/conflict-record';
import type { ReconciliationOutcome } from '../src/reconciliation/reconciliation-result';
import type { IReconciliationService, EventMatcher } from '../src/reconciliation/reconciliation-service';
import {
  createReconciliationService,
  defaultEventMatcher,
} from '../src/reconciliation/reconciliation-service';

// ---------------------------------------------------------------------------
// In-memory mock adapter
// ---------------------------------------------------------------------------

interface MockAdapterState {
  events: Map<string, SyncEvent[]>; // streamId → events
  snapshots: UpstreamSnapshot[];
}

function createMockAdapter(): IReconciliationEventStoreAdapter & { state: MockAdapterState } {
  const state: MockAdapterState = {
    events: new Map(),
    snapshots: [],
  };

  return {
    state,

    async findEventsByCommandId(
      streamId: string,
      commandId: string,
    ): Promise<ReadonlyArray<SyncEvent>> {
      const streamEvents = state.events.get(streamId) ?? [];
      return streamEvents.filter(
        (e) => e.metadata?.command?.id === commandId,
      );
    },

    async replaceEventsByCommandId(
      streamId: string,
      commandId: string,
      authoritativeEvents: ReadonlyArray<SyncEvent>,
    ): Promise<ReadonlyArray<SyncEvent>> {
      const streamEvents = state.events.get(streamId) ?? [];
      const displaced = streamEvents.filter(
        (e) => e.metadata?.command?.id === commandId,
      );
      const remaining = streamEvents.filter(
        (e) => e.metadata?.command?.id !== commandId,
      );
      remaining.push(...authoritativeEvents);
      state.events.set(streamId, remaining);
      return displaced;
    },

    async saveEvents(
      streamId: string,
      newEvents: ReadonlyArray<SyncEvent>,
    ): Promise<void> {
      const existing = state.events.get(streamId) ?? [];
      existing.push(...newEvents);
      state.events.set(streamId, existing);
    },

    async importSnapshot(snapshot: UpstreamSnapshot): Promise<void> {
      state.snapshots.push(snapshot);
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: create events with command metadata
// ---------------------------------------------------------------------------

function makeEvent(
  type: string,
  payload: unknown,
  commandId: string,
): SyncEvent {
  return {
    type,
    payload,
    metadata: { command: { id: commandId } },
  };
}

// ---------------------------------------------------------------------------
// ReconciliationService tests
// ---------------------------------------------------------------------------

describe('createReconciliationService', () => {
  let adapter: ReturnType<typeof createMockAdapter>;
  let service: IReconciliationService;

  beforeEach(() => {
    adapter = createMockAdapter();
    service = createReconciliationService({ eventStoreAdapter: adapter });
  });

  test('outcome: applied — no local events, authoritative saved as-is', async () => {
    const authoritative: ReadonlyArray<SyncEvent> = [
      makeEvent('item.added.event', { sku: 'A1' }, 'cmd-1'),
    ];

    const result = await service.reconcile('cmd-1', 'stream-1', authoritative);

    expect(result.outcome).toBe('applied');
    expect(result.commandId).toBe('cmd-1');
    if (result.outcome === 'applied') {
      expect(result.eventCount).toBe(1);
    }

    // Verify events were saved in adapter
    const saved = adapter.state.events.get('stream-1');
    expect(saved).toHaveLength(1);
    expect(saved![0].type).toBe('item.added.event');
  });

  test('outcome: matched — local events match authoritative exactly', async () => {
    // Pre-seed local events
    adapter.state.events.set('stream-1', [
      makeEvent('item.added.event', { sku: 'A1' }, 'cmd-1'),
      makeEvent('item.added.event', { sku: 'B2' }, 'cmd-1'),
    ]);

    const authoritative: ReadonlyArray<SyncEvent> = [
      makeEvent('item.added.event', { sku: 'A1' }, 'cmd-1'),
      makeEvent('item.added.event', { sku: 'B2' }, 'cmd-1'),
    ];

    const result = await service.reconcile('cmd-1', 'stream-1', authoritative);

    expect(result.outcome).toBe('matched');
    expect(result.commandId).toBe('cmd-1');
    if (result.outcome === 'matched') {
      expect(result.eventCount).toBe(2);
    }

    // Events should remain unchanged
    const events = adapter.state.events.get('stream-1');
    expect(events).toHaveLength(2);
  });

  test('outcome: conflict — local events differ from authoritative', async () => {
    // Pre-seed local events with different payload
    adapter.state.events.set('stream-1', [
      makeEvent('item.added.event', { sku: 'A1' }, 'cmd-1'),
    ]);

    // Authoritative has enriched payload
    const authoritative: ReadonlyArray<SyncEvent> = [
      makeEvent('item.added.event', { sku: 'A1', price: 9.99 }, 'cmd-1'),
    ];

    const result = await service.reconcile('cmd-1', 'stream-1', authoritative);

    expect(result.outcome).toBe('conflict');
    expect(result.commandId).toBe('cmd-1');
    if (result.outcome === 'conflict') {
      expect(result.conflictRecord.commandId).toBe('cmd-1');
      expect(result.conflictRecord.streamId).toBe('stream-1');
      expect(result.conflictRecord.displacedEvents).toHaveLength(1);
      expect(result.conflictRecord.authoritativeEvents).toHaveLength(1);
      expect(result.conflictRecord.detectedAt).toBeDefined();
    }

    // Verify local events were replaced
    const events = adapter.state.events.get('stream-1');
    expect(events).toHaveLength(1);
    expect(events![0].payload).toEqual({ sku: 'A1', price: 9.99 });
  });

  test('outcome: conflict — different event count triggers conflict', async () => {
    // Local: 1 event
    adapter.state.events.set('stream-1', [
      makeEvent('item.added.event', { sku: 'A1' }, 'cmd-1'),
    ]);

    // Authoritative: 2 events (upstream split)
    const authoritative: ReadonlyArray<SyncEvent> = [
      makeEvent('item.added.event', { sku: 'A1' }, 'cmd-1'),
      makeEvent('stock.reserved.event', { sku: 'A1', qty: 1 }, 'cmd-1'),
    ];

    const result = await service.reconcile('cmd-1', 'stream-1', authoritative);

    expect(result.outcome).toBe('conflict');
    if (result.outcome === 'conflict') {
      expect(result.conflictRecord.displacedEvents).toHaveLength(1);
      expect(result.conflictRecord.authoritativeEvents).toHaveLength(2);
    }
  });

  test('outcome: error — adapter failure produces error result', async () => {
    const failingAdapter: IReconciliationEventStoreAdapter = {
      async findEventsByCommandId(): Promise<ReadonlyArray<SyncEvent>> {
        throw new Error('adapter unavailable');
      },
      async replaceEventsByCommandId(): Promise<ReadonlyArray<SyncEvent>> {
        throw new Error('adapter unavailable');
      },
      async saveEvents(): Promise<void> {
        throw new Error('adapter unavailable');
      },
      async importSnapshot(): Promise<void> {
        throw new Error('adapter unavailable');
      },
    };

    const failingService = createReconciliationService({
      eventStoreAdapter: failingAdapter,
    });

    const result = await failingService.reconcile('cmd-1', 'stream-1', [
      makeEvent('item.added.event', {}, 'cmd-1'),
    ]);

    expect(result.outcome).toBe('error');
    expect(result.commandId).toBe('cmd-1');
    if (result.outcome === 'error') {
      expect(result.reason).toContain('adapter unavailable');
    }
  });
});

// ---------------------------------------------------------------------------
// EventMatcher tests
// ---------------------------------------------------------------------------

describe('defaultEventMatcher', () => {
  const matcher = defaultEventMatcher();

  test('matches identical type and payload', () => {
    const local: SyncEvent = { type: 'item.added.event', payload: { sku: 'A1', qty: 1 } };
    const authoritative: SyncEvent = { type: 'item.added.event', payload: { sku: 'A1', qty: 1 } };

    expect(matcher.match(local, authoritative)).toBe(true);
  });

  test('rejects different type', () => {
    const local: SyncEvent = { type: 'item.added.event', payload: { sku: 'A1' } };
    const authoritative: SyncEvent = { type: 'item.removed.event', payload: { sku: 'A1' } };

    expect(matcher.match(local, authoritative)).toBe(false);
  });

  test('rejects different payload', () => {
    const local: SyncEvent = { type: 'item.added.event', payload: { sku: 'A1' } };
    const authoritative: SyncEvent = { type: 'item.added.event', payload: { sku: 'B2' } };

    expect(matcher.match(local, authoritative)).toBe(false);
  });

  test('matches deeply nested payload', () => {
    const payload = { items: [{ sku: 'A1', tags: ['hot', 'new'] }], meta: { version: 2 } };
    const local: SyncEvent = { type: 'order.created.event', payload };
    const authoritative: SyncEvent = {
      type: 'order.created.event',
      payload: { items: [{ sku: 'A1', tags: ['hot', 'new'] }], meta: { version: 2 } },
    };

    expect(matcher.match(local, authoritative)).toBe(true);
  });

  test('rejects when payload has extra keys', () => {
    const local: SyncEvent = { type: 'item.added.event', payload: { sku: 'A1' } };
    const authoritative: SyncEvent = {
      type: 'item.added.event',
      payload: { sku: 'A1', extra: true },
    };

    expect(matcher.match(local, authoritative)).toBe(false);
  });

  test('matches null payloads', () => {
    const local: SyncEvent = { type: 'item.cleared.event', payload: null };
    const authoritative: SyncEvent = { type: 'item.cleared.event', payload: null };

    expect(matcher.match(local, authoritative)).toBe(true);
  });

  test('matches empty object payloads', () => {
    const local: SyncEvent = { type: 'noop.event', payload: {} };
    const authoritative: SyncEvent = { type: 'noop.event', payload: {} };

    expect(matcher.match(local, authoritative)).toBe(true);
  });

  test('ignores metadata differences', () => {
    const local: SyncEvent = {
      type: 'item.added.event',
      payload: { sku: 'A1' },
      metadata: { source: 'local' },
    };
    const authoritative: SyncEvent = {
      type: 'item.added.event',
      payload: { sku: 'A1' },
      metadata: { source: 'upstream', enriched: true },
    };

    expect(matcher.match(local, authoritative)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Custom EventMatcher
// ---------------------------------------------------------------------------

describe('custom EventMatcher', () => {
  test('type-only matcher ignores payload differences', async () => {
    const adapter = createMockAdapter();

    // Pre-seed local events
    adapter.state.events.set('stream-1', [
      makeEvent('item.added.event', { sku: 'A1' }, 'cmd-1'),
    ]);

    const typeOnlyMatcher: EventMatcher = {
      match(local: SyncEvent, authoritative: SyncEvent): boolean {
        return local.type === authoritative.type;
      },
    };

    const service = createReconciliationService({
      eventStoreAdapter: adapter,
      eventMatcher: typeOnlyMatcher,
    });

    // Authoritative has different payload but same type
    const authoritative: ReadonlyArray<SyncEvent> = [
      makeEvent('item.added.event', { sku: 'A1', enriched: true }, 'cmd-1'),
    ];

    const result = await service.reconcile('cmd-1', 'stream-1', authoritative);

    // With type-only matcher, this should be matched (not conflict)
    expect(result.outcome).toBe('matched');
  });
});

// ---------------------------------------------------------------------------
// ConflictArchive integration
// ---------------------------------------------------------------------------

describe('ConflictArchive integration', () => {
  test('conflict records are archived when archive is provided', async () => {
    const archived: ConflictRecord[] = [];
    const archive: IConflictArchive = {
      async archive(record: ConflictRecord): Promise<void> {
        archived.push(record);
      },
    };

    const adapter = createMockAdapter();
    adapter.state.events.set('stream-1', [
      makeEvent('item.added.event', { sku: 'A1' }, 'cmd-1'),
    ]);

    const service = createReconciliationService({
      eventStoreAdapter: adapter,
      conflictArchive: archive,
    });

    const authoritative: ReadonlyArray<SyncEvent> = [
      makeEvent('item.added.event', { sku: 'A1', price: 9.99 }, 'cmd-1'),
    ];

    await service.reconcile('cmd-1', 'stream-1', authoritative);

    expect(archived).toHaveLength(1);
    expect(archived[0].commandId).toBe('cmd-1');
    expect(archived[0].streamId).toBe('stream-1');
    expect(archived[0].displacedEvents).toHaveLength(1);
    expect(archived[0].authoritativeEvents).toHaveLength(1);
    expect(archived[0].detectedAt).toBeDefined();
  });

  test('conflict records are not archived when no archive provided', async () => {
    const adapter = createMockAdapter();
    adapter.state.events.set('stream-1', [
      makeEvent('item.added.event', { sku: 'A1' }, 'cmd-1'),
    ]);

    const service = createReconciliationService({
      eventStoreAdapter: adapter,
      // no conflictArchive
    });

    const authoritative: ReadonlyArray<SyncEvent> = [
      makeEvent('item.added.event', { sku: 'A1', price: 9.99 }, 'cmd-1'),
    ];

    const result = await service.reconcile('cmd-1', 'stream-1', authoritative);

    // Should still produce conflict outcome, just not archive
    expect(result.outcome).toBe('conflict');
  });
});

// ---------------------------------------------------------------------------
// ReconciliationOutcome type discrimination tests
// ---------------------------------------------------------------------------

describe('ReconciliationOutcome discrimination', () => {
  test('exhaustive switch narrows all outcome types', () => {
    const conflictRecord: ConflictRecord = {
      commandId: 'cmd-2',
      streamId: 'stream-1',
      displacedEvents: [],
      authoritativeEvents: [],
      detectedAt: '2026-01-01T00:00:00Z',
    };

    const results: ReadonlyArray<ReconciliationOutcome> = [
      { outcome: 'matched', commandId: 'cmd-1', eventCount: 1 },
      { outcome: 'conflict', commandId: 'cmd-2', conflictRecord },
      { outcome: 'applied', commandId: 'cmd-3', eventCount: 1 },
      { outcome: 'error', commandId: 'cmd-4', reason: 'failed' },
    ];

    const outcomes: string[] = [];

    for (const result of results) {
      switch (result.outcome) {
        case 'matched':
          outcomes.push(`matched:${result.eventCount}`);
          break;
        case 'conflict':
          outcomes.push(`conflict:${result.conflictRecord.commandId}`);
          break;
        case 'applied':
          outcomes.push(`applied:${result.eventCount}`);
          break;
        case 'error':
          outcomes.push(`error:${result.reason}`);
          break;
      }
    }

    expect(outcomes).toEqual([
      'matched:1',
      'conflict:cmd-2',
      'applied:1',
      'error:failed',
    ]);
  });
});
