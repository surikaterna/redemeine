import { describe, expect, it, beforeEach } from 'bun:test';

import type {
  SyncEnvelope,
  CommandWithEventsEnvelope,
  AggregateRuntimeOptions,
  IIdempotencyStore,
  IOrderingStore,
  IAuditSink,
  IDepot,
  AuditSignal,
  AggregateRegistration,
  AggregateInstance,
  ConflictHandlerContext,
} from '../src/index';

import {
  createAggregateRuntimeProcessor,
  handleConflict,
  eventsMatch,
  SyncErrorCode,
} from '../src/index';

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

function createFakeIdempotencyStore(): IIdempotencyStore & { processed: Set<string> } {
  const processed = new Set<string>();
  return {
    processed,
    async reserve(envelopeId: string): Promise<boolean> {
      if (processed.has(envelopeId)) {
        return false;
      }
      processed.add(envelopeId);
      return true;
    },
    async isProcessed(envelopeId: string): Promise<boolean> {
      return processed.has(envelopeId);
    },
  };
}

function createFakeOrderingStore(): IOrderingStore {
  const sequences = new Map<string, number>();
  return {
    async getLastSequence(aggregateType: string, aggregateId: string): Promise<number | undefined> {
      return sequences.get(`${aggregateType}:${aggregateId}`);
    },
    async saveSequence(aggregateType: string, aggregateId: string, sequence: number): Promise<void> {
      sequences.set(`${aggregateType}:${aggregateId}`, sequence);
    },
  };
}

function createFakeAuditSink(): IAuditSink & { signals: AuditSignal[] } {
  const signals: AuditSignal[] = [];
  return {
    signals,
    emit(signal: AuditSignal): void {
      signals.push(signal);
    },
  };
}

function createFakeDepot(
  instances?: Record<string, AggregateInstance>,
): IDepot & { saved: Array<{ aggregateType: string; aggregateId: string; events: ReadonlyArray<unknown> }> } {
  const store = new Map<string, AggregateInstance>();
  if (instances) {
    for (const [key, value] of Object.entries(instances)) {
      store.set(key, value);
    }
  }
  const saved: Array<{ aggregateType: string; aggregateId: string; events: ReadonlyArray<unknown> }> = [];
  return {
    saved,
    async get(aggregateType: string, aggregateId: string): Promise<AggregateInstance | undefined> {
      return store.get(`${aggregateType}:${aggregateId}`);
    },
    async save(aggregateType: string, aggregateId: string, events: ReadonlyArray<unknown>): Promise<void> {
      saved.push({ aggregateType, aggregateId, events });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCommandWithEventsEnvelope(
  overrides?: Partial<CommandWithEventsEnvelope>,
): CommandWithEventsEnvelope {
  return {
    type: 'command_with_events',
    envelopeId: 'env-cwe-1',
    commandId: 'cmd-1',
    aggregateType: 'Order',
    aggregateId: 'order-1',
    commandType: 'PlaceOrder',
    payload: { item: 'widget' },
    events: [{ type: 'OrderPlaced', payload: { item: 'widget' } }],
    occurredAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOrderRegistration(overrides?: Partial<AggregateRegistration>): AggregateRegistration {
  return {
    aggregateType: 'Order',
    commandHandlers: {
      PlaceOrder: (_state: unknown, payload: unknown) => {
        return [{ type: 'OrderPlaced', payload }];
      },
      CancelOrder: (_state: unknown, _payload: unknown) => {
        return [{ type: 'OrderCancelled', payload: {} }];
      },
    },
    ...overrides,
  };
}

function makeOptions(overrides?: Partial<AggregateRuntimeOptions>): AggregateRuntimeOptions {
  return {
    registrations: [makeOrderRegistration()],
    idempotencyStore: createFakeIdempotencyStore(),
    orderingStore: createFakeOrderingStore(),
    auditSink: createFakeAuditSink(),
    depot: createFakeDepot(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// eventsMatch
// ---------------------------------------------------------------------------

describe('eventsMatch', () => {
  it('returns true for identical event arrays', () => {
    const events = [
      { type: 'OrderPlaced', payload: { item: 'widget' } },
      { type: 'OrderConfirmed', payload: { id: '123' } },
    ];
    expect(eventsMatch(events, events)).toBe(true);
  });

  it('returns true for structurally equal event arrays', () => {
    const a = [{ type: 'OrderPlaced', payload: { item: 'widget' } }];
    const b = [{ type: 'OrderPlaced', payload: { item: 'widget' } }];
    expect(eventsMatch(a, b)).toBe(true);
  });

  it('returns false for different lengths', () => {
    const a = [{ type: 'OrderPlaced', payload: {} }];
    const b = [
      { type: 'OrderPlaced', payload: {} },
      { type: 'OrderConfirmed', payload: {} },
    ];
    expect(eventsMatch(a, b)).toBe(false);
  });

  it('returns false for different event types', () => {
    const a = [{ type: 'OrderPlaced', payload: {} }];
    const b = [{ type: 'OrderCancelled', payload: {} }];
    expect(eventsMatch(a, b)).toBe(false);
  });

  it('returns false for different payloads', () => {
    const a = [{ type: 'OrderPlaced', payload: { item: 'widget' } }];
    const b = [{ type: 'OrderPlaced', payload: { item: 'gadget' } }];
    expect(eventsMatch(a, b)).toBe(false);
  });

  it('returns true for empty arrays', () => {
    expect(eventsMatch([], [])).toBe(true);
  });

  it('handles nested payloads', () => {
    const a = [{ type: 'X', payload: { a: { b: [1, 2, 3] } } }];
    const b = [{ type: 'X', payload: { a: { b: [1, 2, 3] } } }];
    expect(eventsMatch(a, b)).toBe(true);
  });

  it('detects nested payload differences', () => {
    const a = [{ type: 'X', payload: { a: { b: [1, 2, 3] } } }];
    const b = [{ type: 'X', payload: { a: { b: [1, 2, 4] } } }];
    expect(eventsMatch(a, b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleConflict
// ---------------------------------------------------------------------------

describe('handleConflict', () => {
  it('returns no_conflict when events match', () => {
    const context: ConflictHandlerContext = {
      producedEvents: [{ type: 'OrderPlaced', payload: { item: 'widget' } }],
      upstreamEvents: [{ type: 'OrderPlaced', payload: { item: 'widget' } }],
      resolver: undefined,
      aggregateType: 'Order',
      aggregateId: 'order-1',
      envelopeId: 'env-1',
    };

    const result = handleConflict(context);
    expect(result.outcome).toBe('no_conflict');
  });

  it('returns unresolved when events differ and no resolver', () => {
    const context: ConflictHandlerContext = {
      producedEvents: [{ type: 'OrderPlaced', payload: { item: 'widget' } }],
      upstreamEvents: [{ type: 'OrderPlaced', payload: { item: 'gadget' } }],
      resolver: undefined,
      aggregateType: 'Order',
      aggregateId: 'order-1',
      envelopeId: 'env-1',
    };

    const result = handleConflict(context);
    expect(result.outcome).toBe('unresolved');
    if (result.outcome === 'unresolved') {
      expect(result.reason).toContain('no conflict resolver registered');
    }
  });

  it('returns resolved with accept decision', () => {
    const context: ConflictHandlerContext = {
      producedEvents: [{ type: 'OrderPlaced', payload: { item: 'widget' } }],
      upstreamEvents: [{ type: 'OrderPlaced', payload: { item: 'gadget' } }],
      resolver: () => ({ decision: 'accept' }),
      aggregateType: 'Order',
      aggregateId: 'order-1',
      envelopeId: 'env-1',
    };

    const result = handleConflict(context);
    expect(result.outcome).toBe('resolved');
    if (result.outcome === 'resolved') {
      expect(result.decision.decision).toBe('accept');
      expect(result.events).toEqual(context.upstreamEvents);
    }
  });

  it('returns resolved with reject decision', () => {
    const context: ConflictHandlerContext = {
      producedEvents: [{ type: 'OrderPlaced', payload: { item: 'widget' } }],
      upstreamEvents: [{ type: 'OrderPlaced', payload: { item: 'gadget' } }],
      resolver: () => ({ decision: 'reject', reason: 'policy violation' }),
      aggregateType: 'Order',
      aggregateId: 'order-1',
      envelopeId: 'env-1',
    };

    const result = handleConflict(context);
    expect(result.outcome).toBe('resolved');
    if (result.outcome === 'resolved') {
      expect(result.decision.decision).toBe('reject');
    }
  });

  it('returns resolved with override decision and custom events', () => {
    const overrideEvents = [{ type: 'OrderMerged', payload: { merged: true } }];
    const context: ConflictHandlerContext = {
      producedEvents: [{ type: 'OrderPlaced', payload: { item: 'widget' } }],
      upstreamEvents: [{ type: 'OrderPlaced', payload: { item: 'gadget' } }],
      resolver: () => ({ decision: 'override', events: overrideEvents }),
      aggregateType: 'Order',
      aggregateId: 'order-1',
      envelopeId: 'env-1',
    };

    const result = handleConflict(context);
    expect(result.outcome).toBe('resolved');
    if (result.outcome === 'resolved') {
      expect(result.decision.decision).toBe('override');
      expect(result.events).toEqual(overrideEvents);
    }
  });
});

// ---------------------------------------------------------------------------
// Processor: command_with_events integration
// ---------------------------------------------------------------------------

describe('processor: command_with_events', () => {
  let auditSink: IAuditSink & { signals: AuditSignal[] };
  let depot: IDepot & { saved: Array<{ aggregateType: string; aggregateId: string; events: ReadonlyArray<unknown> }> };
  let idempotencyStore: IIdempotencyStore & { processed: Set<string> };

  beforeEach(() => {
    auditSink = createFakeAuditSink();
    depot = createFakeDepot();
    idempotencyStore = createFakeIdempotencyStore();
  });

  // -----------------------------------------------------------------------
  // No conflict — events match
  // -----------------------------------------------------------------------

  it('accepts when produced events match upstream events', async () => {
    const options = makeOptions({ auditSink, depot, idempotencyStore });
    const processor = createAggregateRuntimeProcessor(options);
    const envelope = makeCommandWithEventsEnvelope();

    const result = await processor.processBatch([envelope]);

    expect(result.status).toBe('completed');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('accepted');
    expect(result.results[0].envelopeId).toBe('env-cwe-1');
  });

  it('saves local events when no conflict', async () => {
    const options = makeOptions({ auditSink, depot, idempotencyStore });
    const processor = createAggregateRuntimeProcessor(options);
    const envelope = makeCommandWithEventsEnvelope();

    await processor.processBatch([envelope]);

    expect(depot.saved).toHaveLength(1);
    expect((depot.saved[0].events[0] as { type: string }).type).toBe('OrderPlaced');
  });

  // -----------------------------------------------------------------------
  // Conflict resolved — accept upstream
  // -----------------------------------------------------------------------

  it('resolves conflict with accept and returns conflict_resolved', async () => {
    const reg = makeOrderRegistration({
      conflictResolver: () => ({ decision: 'accept' }),
    });
    const options = makeOptions({
      auditSink,
      depot,
      idempotencyStore,
      registrations: [reg],
    });
    const processor = createAggregateRuntimeProcessor(options);

    // Upstream events differ from what the command handler produces
    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'OrderPlaced', payload: { item: 'different' } }],
    });

    const result = await processor.processBatch([envelope]);

    expect(result.status).toBe('completed');
    expect(result.results[0].status).toBe('conflict_resolved');
    if (result.results[0].status === 'conflict_resolved') {
      expect(result.results[0].decision.decision).toBe('accept');
    }
  });

  it('saves upstream events when resolver accepts', async () => {
    const reg = makeOrderRegistration({
      conflictResolver: () => ({ decision: 'accept' }),
    });
    const options = makeOptions({
      auditSink,
      depot,
      idempotencyStore,
      registrations: [reg],
    });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'OrderPlaced', payload: { item: 'upstream-value' } }],
    });

    await processor.processBatch([envelope]);

    expect(depot.saved).toHaveLength(1);
    expect((depot.saved[0].events[0] as { payload: { item: string } }).payload.item).toBe('upstream-value');
  });

  // -----------------------------------------------------------------------
  // Conflict resolved — reject
  // -----------------------------------------------------------------------

  it('fails batch when resolver rejects', async () => {
    const reg = makeOrderRegistration({
      conflictResolver: () => ({ decision: 'reject', reason: 'not allowed' }),
    });
    const options = makeOptions({
      auditSink,
      depot,
      idempotencyStore,
      registrations: [reg],
    });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'OrderPlaced', payload: { item: 'different' } }],
    });

    const result = await processor.processBatch([envelope]);

    expect(result.status).toBe('failed');
    expect(result.failedAtIndex).toBe(0);
    expect(result.results[0].status).toBe('rejected');
    if (result.results[0].status === 'rejected') {
      expect(result.results[0].reason).toContain('conflict rejected');
    }
  });

  it('does not save events when resolver rejects', async () => {
    const reg = makeOrderRegistration({
      conflictResolver: () => ({ decision: 'reject', reason: 'nope' }),
    });
    const options = makeOptions({
      auditSink,
      depot,
      idempotencyStore,
      registrations: [reg],
    });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'OrderPlaced', payload: { item: 'different' } }],
    });

    await processor.processBatch([envelope]);

    expect(depot.saved).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Conflict resolved — override with custom events
  // -----------------------------------------------------------------------

  it('resolves conflict with override and saves custom events', async () => {
    const overrideEvents = [{ type: 'OrderMerged', payload: { merged: true } }];
    const reg = makeOrderRegistration({
      conflictResolver: () => ({ decision: 'override', events: overrideEvents }),
    });
    const options = makeOptions({
      auditSink,
      depot,
      idempotencyStore,
      registrations: [reg],
    });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'OrderPlaced', payload: { item: 'different' } }],
    });

    const result = await processor.processBatch([envelope]);

    expect(result.status).toBe('completed');
    expect(result.results[0].status).toBe('conflict_resolved');
    if (result.results[0].status === 'conflict_resolved') {
      expect(result.results[0].decision.decision).toBe('override');
    }
    expect(depot.saved).toHaveLength(1);
    expect((depot.saved[0].events[0] as { type: string }).type).toBe('OrderMerged');
  });

  // -----------------------------------------------------------------------
  // No resolver registered — events differ → unresolved
  // -----------------------------------------------------------------------

  it('fails batch when no resolver and events differ', async () => {
    // Registration without a conflict resolver
    const reg = makeOrderRegistration();
    const options = makeOptions({
      auditSink,
      depot,
      idempotencyStore,
      registrations: [reg],
    });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'OrderPlaced', payload: { item: 'different' } }],
    });

    const result = await processor.processBatch([envelope]);

    expect(result.status).toBe('failed');
    expect(result.failedAtIndex).toBe(0);
    expect(result.results[0].status).toBe('rejected');
    if (result.results[0].status === 'rejected') {
      expect(result.results[0].reason).toContain('no conflict resolver registered');
    }
  });

  it('does not save events when unresolved', async () => {
    const reg = makeOrderRegistration();
    const options = makeOptions({
      auditSink,
      depot,
      idempotencyStore,
      registrations: [reg],
    });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'OrderPlaced', payload: { item: 'different' } }],
    });

    await processor.processBatch([envelope]);

    expect(depot.saved).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Audit signals
  // -----------------------------------------------------------------------

  it('emits conflict audit signal when resolver accepts', async () => {
    const reg = makeOrderRegistration({
      conflictResolver: () => ({ decision: 'accept' }),
    });
    const options = makeOptions({
      auditSink,
      depot,
      idempotencyStore,
      registrations: [reg],
    });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'OrderPlaced', payload: { item: 'different' } }],
    });

    await processor.processBatch([envelope]);

    const conflictSignals = auditSink.signals.filter((s) => s.type === 'conflict');
    expect(conflictSignals).toHaveLength(1);
    if (conflictSignals[0].type === 'conflict') {
      expect(conflictSignals[0].decision).toBe('accept');
      expect(conflictSignals[0].aggregateType).toBe('Order');
      expect(conflictSignals[0].aggregateId).toBe('order-1');
    }
  });

  it('emits conflict audit signal when resolver rejects', async () => {
    const reg = makeOrderRegistration({
      conflictResolver: () => ({ decision: 'reject', reason: 'nope' }),
    });
    const options = makeOptions({
      auditSink,
      depot,
      idempotencyStore,
      registrations: [reg],
    });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'OrderPlaced', payload: { item: 'different' } }],
    });

    await processor.processBatch([envelope]);

    const conflictSignals = auditSink.signals.filter((s) => s.type === 'conflict');
    expect(conflictSignals).toHaveLength(1);
    if (conflictSignals[0].type === 'conflict') {
      expect(conflictSignals[0].decision).toBe('reject');
    }
  });

  it('emits conflict audit signal for unresolved conflicts', async () => {
    const reg = makeOrderRegistration();
    const options = makeOptions({
      auditSink,
      depot,
      idempotencyStore,
      registrations: [reg],
    });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'OrderPlaced', payload: { item: 'different' } }],
    });

    await processor.processBatch([envelope]);

    const conflictSignals = auditSink.signals.filter((s) => s.type === 'conflict');
    expect(conflictSignals).toHaveLength(1);
    if (conflictSignals[0].type === 'conflict') {
      expect(conflictSignals[0].decision).toBe('unresolved');
    }
  });

  it('does not emit conflict signal when events match (no conflict)', async () => {
    const options = makeOptions({ auditSink, depot, idempotencyStore });
    const processor = createAggregateRuntimeProcessor(options);
    const envelope = makeCommandWithEventsEnvelope();

    await processor.processBatch([envelope]);

    const conflictSignals = auditSink.signals.filter((s) => s.type === 'conflict');
    expect(conflictSignals).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Processor: events_only still rejected
// ---------------------------------------------------------------------------

describe('processor: events_only still rejected', () => {
  it('rejects events_only envelope with EVENTS_ONLY_NOT_SUPPORTED', async () => {
    const auditSink = createFakeAuditSink();
    const options = makeOptions({ auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope: SyncEnvelope = {
      type: 'events_only',
      envelopeId: 'env-eo',
      aggregateType: 'Order',
      aggregateId: 'order-1',
      events: [{ type: 'OrderPlaced', payload: {} }],
      occurredAt: '2026-01-01T00:00:00Z',
    };

    const result = await processor.processBatch([envelope]);

    expect(result.status).toBe('failed');
    expect(result.failedAtIndex).toBe(0);
    if (result.results[0].status === 'rejected') {
      expect(result.results[0].reason).toContain('EVENTS_ONLY_NOT_SUPPORTED');
    }
  });
});
