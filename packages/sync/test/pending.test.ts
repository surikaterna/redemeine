import { describe, test, expect, beforeEach } from 'bun:test';
import type {
  StoredEvent,
  NewEvent,
  EventStatus,
  SaveEventOptions,
  SaveEventResult,
  ConfirmResult,
  SupersedeResult,
  ReadStreamOptions,
  ISyncEventStore,
  AggregateSnapshot,
} from '../src/store';
import {
  ReconciliationDispatcher,
  defaultEventMatcher,
  createPendingEvents,
  rebuildFromConfirmed,
} from '../src/pending';
import type {
  ReconciliationResult,
  AuthoritativeEvent,
  ProducedEvent,
} from '../src/pending';

// ---------------------------------------------------------------------------
// In-memory mock store
// ---------------------------------------------------------------------------

function createMockStore(): ISyncEventStore & { events: StoredEvent[] } {
  const events: StoredEvent[] = [];
  let nextId = 1;

  return {
    events,

    async saveEvents(
      streamId: string,
      newEvents: ReadonlyArray<NewEvent>,
      options: SaveEventOptions,
    ): Promise<SaveEventResult> {
      let version = events.filter((e) => e.streamId === streamId).length;
      const eventIds: string[] = [];

      for (const event of newEvents) {
        version += 1;
        const id = `evt-${nextId++}`;
        eventIds.push(id);
        events.push({
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
      let confirmedCount = 0;
      for (const event of events) {
        if (event.commandId === commandId && event.status === 'pending') {
          (event as { status: EventStatus }).status = 'confirmed';
          confirmedCount++;
        }
      }
      return { confirmedCount };
    },

    async supersedeEvents(
      commandId: string,
      replacements: ReadonlyArray<NewEvent>,
    ): Promise<SupersedeResult> {
      let supersededCount = 0;
      const replacementEventIds: string[] = [];

      // Find the streamId from existing pending events
      const pendingEvent = events.find(
        (e) => e.commandId === commandId && e.status === 'pending',
      );
      const streamId = pendingEvent?.streamId ?? 'unknown';

      for (const event of events) {
        if (event.commandId === commandId && event.status === 'pending') {
          (event as { status: EventStatus }).status = 'superseded';
          supersededCount++;
        }
      }

      let version = events.filter((e) => e.streamId === streamId).length;
      for (const r of replacements) {
        version += 1;
        const id = `evt-${nextId++}`;
        replacementEventIds.push(id);
        events.push({
          id,
          streamId,
          type: r.type,
          payload: r.payload,
          status: 'confirmed',
          commandId,
          version,
          occurredAt: r.occurredAt,
          ingestedAt: new Date().toISOString(),
        });
      }

      return { supersededCount, replacementEventIds };
    },

    async *readStream(
      streamId: string,
      options?: ReadStreamOptions,
    ): AsyncIterable<StoredEvent> {
      for (const event of events) {
        if (event.streamId !== streamId) continue;
        if (options?.confirmedOnly && event.status !== 'confirmed') continue;
        if (options?.fromVersion && event.version < options.fromVersion) continue;
        yield event;
      }
    },

    async loadSnapshot(_streamId: string): Promise<AggregateSnapshot | undefined> {
      return undefined;
    },

    async importSnapshot(_snapshot: AggregateSnapshot): Promise<void> {
      // no-op
    },
  };
}

// ---------------------------------------------------------------------------
// ReconciliationDispatcher tests
// ---------------------------------------------------------------------------

describe('ReconciliationDispatcher', () => {
  let store: ReturnType<typeof createMockStore>;
  let dispatcher: ReconciliationDispatcher;

  beforeEach(() => {
    store = createMockStore();
    dispatcher = new ReconciliationDispatcher(store);
  });

  test('outcome: new — no pending events, applies as confirmed', async () => {
    const authoritative: ReadonlyArray<AuthoritativeEvent> = [
      { type: 'item.added.event', payload: { sku: 'A1' } },
    ];

    const result = await dispatcher.reconcile('cmd-1', 'stream-1', authoritative);

    expect(result.outcome).toBe('new');
    expect(result.commandId).toBe('cmd-1');
    if (result.outcome === 'new') {
      expect(result.eventCount).toBe(1);
    }

    // Verify event was saved as confirmed
    const saved = store.events.filter((e) => e.commandId === 'cmd-1');
    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe('confirmed');
    expect(saved[0].type).toBe('item.added.event');
  });

  test('outcome: confirmed — pending events match authoritative exactly', async () => {
    // Pre-seed pending events
    await store.saveEvents(
      'stream-1',
      [
        { type: 'item.added.event', payload: { sku: 'A1' }, occurredAt: '2026-01-01T00:00:00Z' },
        { type: 'item.added.event', payload: { sku: 'B2' }, occurredAt: '2026-01-01T00:00:01Z' },
      ],
      { status: 'pending', commandId: 'cmd-1' },
    );

    const authoritative: ReadonlyArray<AuthoritativeEvent> = [
      { type: 'item.added.event', payload: { sku: 'A1' } },
      { type: 'item.added.event', payload: { sku: 'B2' } },
    ];

    const result = await dispatcher.reconcile('cmd-1', 'stream-1', authoritative);

    expect(result.outcome).toBe('confirmed');
    expect(result.commandId).toBe('cmd-1');
    if (result.outcome === 'confirmed') {
      expect(result.eventCount).toBe(2);
    }

    // Verify events were confirmed in store
    const confirmed = store.events.filter(
      (e) => e.commandId === 'cmd-1' && e.status === 'confirmed',
    );
    expect(confirmed).toHaveLength(2);
  });

  test('outcome: superseded — pending events differ from authoritative', async () => {
    // Pre-seed pending events
    await store.saveEvents(
      'stream-1',
      [{ type: 'item.added.event', payload: { sku: 'A1' }, occurredAt: '2026-01-01T00:00:00Z' }],
      { status: 'pending', commandId: 'cmd-1' },
    );

    // Authoritative has different payload (upstream enriched)
    const authoritative: ReadonlyArray<AuthoritativeEvent> = [
      { type: 'item.added.event', payload: { sku: 'A1', price: 9.99 } },
    ];

    const result = await dispatcher.reconcile('cmd-1', 'stream-1', authoritative);

    expect(result.outcome).toBe('superseded');
    expect(result.commandId).toBe('cmd-1');
    if (result.outcome === 'superseded') {
      expect(result.pendingEventCount).toBe(1);
      expect(result.authoritativeEventCount).toBe(1);
    }

    // Verify original event superseded, replacement inserted
    const superseded = store.events.filter((e) => e.status === 'superseded');
    expect(superseded).toHaveLength(1);

    const replacements = store.events.filter(
      (e) => e.commandId === 'cmd-1' && e.status === 'confirmed',
    );
    expect(replacements).toHaveLength(1);
    expect(replacements[0].payload).toEqual({ sku: 'A1', price: 9.99 });
  });

  test('outcome: superseded — different event count triggers supersession', async () => {
    // Pending: 1 event
    await store.saveEvents(
      'stream-1',
      [{ type: 'item.added.event', payload: { sku: 'A1' }, occurredAt: '2026-01-01T00:00:00Z' }],
      { status: 'pending', commandId: 'cmd-1' },
    );

    // Authoritative: 2 events (upstream split the event)
    const authoritative: ReadonlyArray<AuthoritativeEvent> = [
      { type: 'item.added.event', payload: { sku: 'A1' } },
      { type: 'stock.reserved.event', payload: { sku: 'A1', qty: 1 } },
    ];

    const result = await dispatcher.reconcile('cmd-1', 'stream-1', authoritative);

    expect(result.outcome).toBe('superseded');
    if (result.outcome === 'superseded') {
      expect(result.pendingEventCount).toBe(1);
      expect(result.authoritativeEventCount).toBe(2);
    }
  });

  test('outcome: already_confirmed — idempotent reconciliation', async () => {
    // Pre-seed confirmed events
    await store.saveEvents(
      'stream-1',
      [{ type: 'item.added.event', payload: { sku: 'A1' }, occurredAt: '2026-01-01T00:00:00Z' }],
      { status: 'confirmed', commandId: 'cmd-1' },
    );

    const authoritative: ReadonlyArray<AuthoritativeEvent> = [
      { type: 'item.added.event', payload: { sku: 'A1' } },
    ];

    const result = await dispatcher.reconcile('cmd-1', 'stream-1', authoritative);

    expect(result.outcome).toBe('already_confirmed');
    expect(result.commandId).toBe('cmd-1');
  });

  test('outcome: error — store failure produces error result', async () => {
    // Create a store that throws
    const failingStore: ISyncEventStore = {
      async saveEvents(): Promise<SaveEventResult> {
        throw new Error('store unavailable');
      },
      async confirmEvents(): Promise<ConfirmResult> {
        throw new Error('store unavailable');
      },
      async supersedeEvents(): Promise<SupersedeResult> {
        throw new Error('store unavailable');
      },
      async *readStream(): AsyncIterable<StoredEvent> {
        throw new Error('store unavailable');
      },
      async loadSnapshot(): Promise<AggregateSnapshot | undefined> {
        return undefined;
      },
      async importSnapshot(): Promise<void> {
        // no-op
      },
    };

    const failingDispatcher = new ReconciliationDispatcher(failingStore);
    const result = await failingDispatcher.reconcile('cmd-1', 'stream-1', [
      { type: 'item.added.event', payload: {} },
    ]);

    expect(result.outcome).toBe('error');
    expect(result.commandId).toBe('cmd-1');
    if (result.outcome === 'error') {
      expect(result.reason).toContain('store unavailable');
    }
  });

  test('custom matcher can override matching strategy', async () => {
    // Pre-seed pending events
    await store.saveEvents(
      'stream-1',
      [{ type: 'item.added.event', payload: { sku: 'A1' }, occurredAt: '2026-01-01T00:00:00Z' }],
      { status: 'pending', commandId: 'cmd-1' },
    );

    // Custom matcher that only compares type (ignores payload)
    const typeOnlyMatcher = {
      match(pending: StoredEvent, authoritative: AuthoritativeEvent): boolean {
        return pending.type === authoritative.type;
      },
    };

    const customDispatcher = new ReconciliationDispatcher(store, typeOnlyMatcher);

    // Authoritative has different payload but same type
    const authoritative: ReadonlyArray<AuthoritativeEvent> = [
      { type: 'item.added.event', payload: { sku: 'A1', enriched: true } },
    ];

    const result = await customDispatcher.reconcile('cmd-1', 'stream-1', authoritative);

    // With type-only matcher, this should be confirmed (not superseded)
    expect(result.outcome).toBe('confirmed');
  });
});

// ---------------------------------------------------------------------------
// defaultEventMatcher tests
// ---------------------------------------------------------------------------

describe('defaultEventMatcher', () => {
  const matcher = defaultEventMatcher();

  const makePendingEvent = (type: string, payload: unknown): StoredEvent => ({
    id: 'evt-1',
    streamId: 'stream-1',
    type,
    payload,
    status: 'pending',
    commandId: 'cmd-1',
    version: 1,
    occurredAt: '2026-01-01T00:00:00Z',
    ingestedAt: '2026-01-01T00:00:01Z',
  });

  test('matches identical type and payload', () => {
    const pending = makePendingEvent('item.added.event', { sku: 'A1', qty: 1 });
    const authoritative: AuthoritativeEvent = { type: 'item.added.event', payload: { sku: 'A1', qty: 1 } };

    expect(matcher.match(pending, authoritative)).toBe(true);
  });

  test('rejects different type', () => {
    const pending = makePendingEvent('item.added.event', { sku: 'A1' });
    const authoritative: AuthoritativeEvent = { type: 'item.removed.event', payload: { sku: 'A1' } };

    expect(matcher.match(pending, authoritative)).toBe(false);
  });

  test('rejects different payload', () => {
    const pending = makePendingEvent('item.added.event', { sku: 'A1' });
    const authoritative: AuthoritativeEvent = { type: 'item.added.event', payload: { sku: 'B2' } };

    expect(matcher.match(pending, authoritative)).toBe(false);
  });

  test('matches deeply nested payload', () => {
    const payload = { items: [{ sku: 'A1', tags: ['hot', 'new'] }], meta: { version: 2 } };
    const pending = makePendingEvent('order.created.event', payload);
    const authoritative: AuthoritativeEvent = {
      type: 'order.created.event',
      payload: { items: [{ sku: 'A1', tags: ['hot', 'new'] }], meta: { version: 2 } },
    };

    expect(matcher.match(pending, authoritative)).toBe(true);
  });

  test('rejects when payload has extra keys', () => {
    const pending = makePendingEvent('item.added.event', { sku: 'A1' });
    const authoritative: AuthoritativeEvent = {
      type: 'item.added.event',
      payload: { sku: 'A1', extra: true },
    };

    expect(matcher.match(pending, authoritative)).toBe(false);
  });

  test('matches null payloads', () => {
    const pending = makePendingEvent('item.cleared.event', null);
    const authoritative: AuthoritativeEvent = { type: 'item.cleared.event', payload: null };

    expect(matcher.match(pending, authoritative)).toBe(true);
  });

  test('matches empty object payloads', () => {
    const pending = makePendingEvent('noop.event', {});
    const authoritative: AuthoritativeEvent = { type: 'noop.event', payload: {} };

    expect(matcher.match(pending, authoritative)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// rebuildFromConfirmed tests
// ---------------------------------------------------------------------------

describe('rebuildFromConfirmed', () => {
  test('folds confirmed events only into aggregate state', async () => {
    const store = createMockStore();

    // Add confirmed events
    await store.saveEvents(
      'stream-1',
      [
        { type: 'counter.incremented', payload: { amount: 5 }, occurredAt: '2026-01-01T00:00:00Z' },
        { type: 'counter.incremented', payload: { amount: 3 }, occurredAt: '2026-01-01T00:00:01Z' },
      ],
      { status: 'confirmed', commandId: 'cmd-1' },
    );

    // Add pending events (should be excluded from rebuild)
    await store.saveEvents(
      'stream-1',
      [{ type: 'counter.incremented', payload: { amount: 10 }, occurredAt: '2026-01-01T00:00:02Z' }],
      { status: 'pending', commandId: 'cmd-2' },
    );

    const result = await rebuildFromConfirmed(
      store,
      'stream-1',
      (state: unknown, event: StoredEvent) => {
        const current = (state as number) ?? 0;
        const { amount } = event.payload as { amount: number };
        return current + amount;
      },
      0,
    );

    expect(result.streamId).toBe('stream-1');
    expect(result.state).toBe(8); // 5 + 3
    expect(result.confirmedEventCount).toBe(2);
    expect(result.version).toBe(2);
  });

  test('counts superseded events separately', async () => {
    const store = createMockStore();

    // Add confirmed events
    await store.saveEvents(
      'stream-1',
      [{ type: 'counter.incremented', payload: { amount: 5 }, occurredAt: '2026-01-01T00:00:00Z' }],
      { status: 'confirmed', commandId: 'cmd-1' },
    );

    // Add a pending event, then supersede it
    await store.saveEvents(
      'stream-1',
      [{ type: 'counter.incremented', payload: { amount: 99 }, occurredAt: '2026-01-01T00:00:01Z' }],
      { status: 'pending', commandId: 'cmd-2' },
    );
    await store.supersedeEvents('cmd-2', [
      { type: 'counter.incremented', payload: { amount: 7 }, occurredAt: '2026-01-01T00:00:02Z' },
    ]);

    const result = await rebuildFromConfirmed(
      store,
      'stream-1',
      (state: unknown, event: StoredEvent) => {
        const current = (state as number) ?? 0;
        const { amount } = event.payload as { amount: number };
        return current + amount;
      },
      0,
    );

    // 5 (confirmed from cmd-1) + 7 (replacement confirmed from cmd-2)
    expect(result.state).toBe(12);
    expect(result.confirmedEventCount).toBe(2);
    expect(result.supersededEventCount).toBe(1);
  });

  test('returns zero state for empty stream', async () => {
    const store = createMockStore();

    const result = await rebuildFromConfirmed(
      store,
      'stream-empty',
      (state: unknown) => state,
      0,
    );

    expect(result.state).toBe(0);
    expect(result.confirmedEventCount).toBe(0);
    expect(result.supersededEventCount).toBe(0);
    expect(result.version).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createPendingEvents tests
// ---------------------------------------------------------------------------

describe('createPendingEvents', () => {
  test('creates NewEvent records from produced events', () => {
    const produced: ReadonlyArray<ProducedEvent> = [
      { type: 'item.added.event', payload: { sku: 'A1' } },
      { type: 'item.added.event', payload: { sku: 'B2' } },
    ];

    const timestamp = '2026-01-01T00:00:00Z';
    const result = createPendingEvents(produced, timestamp);

    expect(result).toHaveLength(2);
    expect(result[0].type).toBe('item.added.event');
    expect(result[0].payload).toEqual({ sku: 'A1' });
    expect(result[0].occurredAt).toBe(timestamp);
    expect(result[1].type).toBe('item.added.event');
    expect(result[1].payload).toEqual({ sku: 'B2' });
    expect(result[1].occurredAt).toBe(timestamp);
  });

  test('uses consistent timestamp across all events', () => {
    const produced: ReadonlyArray<ProducedEvent> = [
      { type: 'a.event', payload: null },
      { type: 'b.event', payload: null },
      { type: 'c.event', payload: null },
    ];

    const result = createPendingEvents(produced, '2026-06-15T12:00:00Z');

    const timestamps = result.map((e) => e.occurredAt);
    expect(new Set(timestamps).size).toBe(1);
    expect(timestamps[0]).toBe('2026-06-15T12:00:00Z');
  });

  test('returns empty array for empty input', () => {
    const result = createPendingEvents([]);
    expect(result).toHaveLength(0);
  });

  test('preserves complex payload structures', () => {
    const payload = { nested: { items: [1, 2, 3], meta: { flag: true } } };
    const result = createPendingEvents([{ type: 'complex.event', payload }], '2026-01-01T00:00:00Z');

    expect(result[0].payload).toEqual(payload);
  });

  test('generates timestamp when none provided', () => {
    const result = createPendingEvents([{ type: 'test.event', payload: {} }]);

    expect(result).toHaveLength(1);
    // Should be a valid ISO string
    expect(() => new Date(result[0].occurredAt)).not.toThrow();
    expect(new Date(result[0].occurredAt).toISOString()).toBe(result[0].occurredAt);
  });
});

// ---------------------------------------------------------------------------
// ReconciliationResult type discrimination tests
// ---------------------------------------------------------------------------

describe('ReconciliationResult discrimination', () => {
  test('exhaustive switch narrows all outcome types', () => {
    const results: ReadonlyArray<ReconciliationResult> = [
      { outcome: 'confirmed', commandId: 'cmd-1', eventCount: 1 },
      { outcome: 'superseded', commandId: 'cmd-2', pendingEventCount: 1, authoritativeEventCount: 2 },
      { outcome: 'new', commandId: 'cmd-3', eventCount: 1 },
      { outcome: 'already_confirmed', commandId: 'cmd-4' },
      { outcome: 'error', commandId: 'cmd-5', reason: 'failed' },
    ];

    const outcomes: string[] = [];

    for (const result of results) {
      switch (result.outcome) {
        case 'confirmed':
          outcomes.push(`confirmed:${result.eventCount}`);
          break;
        case 'superseded':
          outcomes.push(`superseded:${result.pendingEventCount}->${result.authoritativeEventCount}`);
          break;
        case 'new':
          outcomes.push(`new:${result.eventCount}`);
          break;
        case 'already_confirmed':
          outcomes.push('already_confirmed');
          break;
        case 'error':
          outcomes.push(`error:${result.reason}`);
          break;
      }
    }

    expect(outcomes).toEqual([
      'confirmed:1',
      'superseded:1->2',
      'new:1',
      'already_confirmed',
      'error:failed',
    ]);
  });
});
