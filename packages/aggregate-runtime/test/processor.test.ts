import { describe, expect, it, beforeEach } from 'bun:test';

import type {
  SyncEnvelope,
  CommandOnlyEnvelope,
  AggregateRuntimeOptions,
  IIdempotencyStore,
  IOrderingStore,
  IAuditSink,
  IDepot,
  AuditSignal,
  AggregateRegistration,
  AggregateInstance,
} from '../src/index';

import {
  createAggregateRuntimeProcessor,
  validateEnvelope,
  createRegistrationResolver,
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

function makeCommandOnlyEnvelope(overrides?: Partial<CommandOnlyEnvelope>): CommandOnlyEnvelope {
  return {
    type: 'command_only',
    envelopeId: 'env-1',
    commandId: 'cmd-1',
    aggregateType: 'Order',
    aggregateId: 'order-1',
    commandType: 'PlaceOrder',
    payload: { item: 'widget' },
    occurredAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOrderRegistration(): AggregateRegistration {
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
// validateEnvelope
// ---------------------------------------------------------------------------

describe('validateEnvelope', () => {
  it('accepts a valid command_only envelope', () => {
    const result = validateEnvelope(makeCommandOnlyEnvelope());
    expect(result).toEqual({ valid: true });
  });

  it('rejects envelope with empty envelopeId', () => {
    const result = validateEnvelope(makeCommandOnlyEnvelope({ envelopeId: '' }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('MALFORMED_ENVELOPE');
      expect(result.reason).toContain('envelopeId');
    }
  });

  it('rejects envelope with empty aggregateType', () => {
    const result = validateEnvelope(makeCommandOnlyEnvelope({ aggregateType: '' }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('MALFORMED_ENVELOPE');
    }
  });

  it('rejects envelope with empty aggregateId', () => {
    const result = validateEnvelope(makeCommandOnlyEnvelope({ aggregateId: '' }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('MALFORMED_ENVELOPE');
    }
  });

  it('rejects command envelope with empty commandId', () => {
    const result = validateEnvelope(makeCommandOnlyEnvelope({ commandId: '' }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('MALFORMED_ENVELOPE');
      expect(result.reason).toContain('commandId');
    }
  });

  it('rejects command envelope with empty commandType', () => {
    const result = validateEnvelope(makeCommandOnlyEnvelope({ commandType: '' }));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe('MALFORMED_ENVELOPE');
      expect(result.reason).toContain('commandType');
    }
  });
});

// ---------------------------------------------------------------------------
// createRegistrationResolver
// ---------------------------------------------------------------------------

describe('createRegistrationResolver', () => {
  it('resolves a registered aggregate type', () => {
    const resolver = createRegistrationResolver([makeOrderRegistration()]);
    const result = resolver.resolve('Order');
    expect(result).toBeDefined();
    expect(result?.aggregateType).toBe('Order');
  });

  it('returns undefined for unregistered aggregate type', () => {
    const resolver = createRegistrationResolver([makeOrderRegistration()]);
    expect(resolver.resolve('Unknown')).toBeUndefined();
  });

  it('handles empty registrations', () => {
    const resolver = createRegistrationResolver([]);
    expect(resolver.resolve('Order')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createAggregateRuntimeProcessor
// ---------------------------------------------------------------------------

describe('createAggregateRuntimeProcessor', () => {
  let auditSink: IAuditSink & { signals: AuditSignal[] };
  let depot: IDepot & { saved: Array<{ aggregateType: string; aggregateId: string; events: ReadonlyArray<unknown> }> };
  let idempotencyStore: IIdempotencyStore & { processed: Set<string> };

  beforeEach(() => {
    auditSink = createFakeAuditSink();
    depot = createFakeDepot();
    idempotencyStore = createFakeIdempotencyStore();
  });

  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  describe('happy path', () => {
    it('processes a valid command_only envelope and returns accepted', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);
      const envelope = makeCommandOnlyEnvelope();

      const result = await processor.processBatch([envelope]);

      expect(result.status).toBe('completed');
      expect(result.processed).toBe(1);
      expect(result.total).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('accepted');
      expect(result.results[0].envelopeId).toBe('env-1');
      expect(result.ingestedAt).toBeDefined();
      expect(result.failedAtIndex).toBeUndefined();
    });

    it('saves events through depot', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      await processor.processBatch([makeCommandOnlyEnvelope()]);

      expect(depot.saved).toHaveLength(1);
      expect(depot.saved[0].aggregateType).toBe('Order');
      expect(depot.saved[0].aggregateId).toBe('order-1');
      expect(depot.saved[0].events).toHaveLength(1);
      expect((depot.saved[0].events[0] as { type: string }).type).toBe('OrderPlaced');
    });

    it('processes multiple envelopes in order', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      const env1 = makeCommandOnlyEnvelope({ envelopeId: 'env-1', commandId: 'cmd-1' });
      const env2 = makeCommandOnlyEnvelope({
        envelopeId: 'env-2',
        commandId: 'cmd-2',
        commandType: 'CancelOrder',
        aggregateId: 'order-2',
      });

      const result = await processor.processBatch([env1, env2]);

      expect(result.status).toBe('completed');
      expect(result.processed).toBe(2);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].status).toBe('accepted');
      expect(result.results[1].status).toBe('accepted');
    });

    it('processes an empty batch', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      const result = await processor.processBatch([]);

      expect(result.status).toBe('completed');
      expect(result.processed).toBe(0);
      expect(result.total).toBe(0);
      expect(result.results).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Unknown aggregate
  // -----------------------------------------------------------------------

  describe('unknown aggregate', () => {
    it('fails with UNKNOWN_AGGREGATE for unregistered type', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);
      const envelope = makeCommandOnlyEnvelope({ aggregateType: 'Widget' });

      const result = await processor.processBatch([envelope]);

      expect(result.status).toBe('failed');
      expect(result.failedAtIndex).toBe(0);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('rejected');
      if (result.results[0].status === 'rejected') {
        expect(result.results[0].reason).toContain('UNKNOWN_AGGREGATE');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Malformed envelope
  // -----------------------------------------------------------------------

  describe('malformed envelope', () => {
    it('fails with MALFORMED_ENVELOPE for missing envelopeId', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);
      const envelope = makeCommandOnlyEnvelope({ envelopeId: '' });

      const result = await processor.processBatch([envelope]);

      expect(result.status).toBe('failed');
      expect(result.failedAtIndex).toBe(0);
      if (result.results[0].status === 'rejected') {
        expect(result.results[0].reason).toContain('MALFORMED_ENVELOPE');
      }
    });

    it('fails with MALFORMED_ENVELOPE for missing commandType', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);
      const envelope = makeCommandOnlyEnvelope({ commandType: '' });

      const result = await processor.processBatch([envelope]);

      expect(result.status).toBe('failed');
      if (result.results[0].status === 'rejected') {
        expect(result.results[0].reason).toContain('MALFORMED_ENVELOPE');
      }
    });
  });

  // -----------------------------------------------------------------------
  // Events-only rejection
  // -----------------------------------------------------------------------

  describe('events_only rejection', () => {
    it('rejects events_only envelope with EVENTS_ONLY_NOT_SUPPORTED', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
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

  // -----------------------------------------------------------------------
  // Duplicate handling
  // -----------------------------------------------------------------------

  describe('duplicate handling', () => {
    it('skips duplicate envelopes with duplicate result', async () => {
      idempotencyStore.processed.add('env-1');
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);
      const envelope = makeCommandOnlyEnvelope();

      const result = await processor.processBatch([envelope]);

      expect(result.status).toBe('completed');
      expect(result.processed).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('duplicate');
      expect(result.results[0].envelopeId).toBe('env-1');
    });

    it('does not save events for duplicate envelopes', async () => {
      idempotencyStore.processed.add('env-1');
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      await processor.processBatch([makeCommandOnlyEnvelope()]);

      expect(depot.saved).toHaveLength(0);
    });

    it('emits duplicate audit signal', async () => {
      idempotencyStore.processed.add('env-1');
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      await processor.processBatch([makeCommandOnlyEnvelope()]);

      const dupSignals = auditSink.signals.filter((s) => s.type === 'duplicate');
      expect(dupSignals).toHaveLength(1);
      expect(dupSignals[0].envelopeId).toBe('env-1');
    });
  });

  // -----------------------------------------------------------------------
  // Stop on first failure
  // -----------------------------------------------------------------------

  describe('stop on first failure', () => {
    it('halts batch at failing envelope and preserves prior results', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      const env1 = makeCommandOnlyEnvelope({ envelopeId: 'env-1', commandId: 'cmd-1' });
      const envBad = makeCommandOnlyEnvelope({
        envelopeId: 'env-2',
        commandId: 'cmd-2',
        aggregateType: 'Unknown',
      });
      const env3 = makeCommandOnlyEnvelope({ envelopeId: 'env-3', commandId: 'cmd-3' });

      const result = await processor.processBatch([env1, envBad, env3]);

      expect(result.status).toBe('failed');
      expect(result.failedAtIndex).toBe(1);
      expect(result.total).toBe(3);
      expect(result.processed).toBe(1);
      expect(result.results).toHaveLength(2);
      expect(result.results[0].status).toBe('accepted');
      expect(result.results[1].status).toBe('rejected');
    });

    it('does not process envelopes after the failure', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      const env1 = makeCommandOnlyEnvelope({ envelopeId: 'env-1', commandId: 'cmd-1' });
      const envBad = makeCommandOnlyEnvelope({
        envelopeId: 'env-2',
        commandId: 'cmd-2',
        aggregateType: 'Unknown',
      });
      const env3 = makeCommandOnlyEnvelope({
        envelopeId: 'env-3',
        commandId: 'cmd-3',
        aggregateId: 'order-3',
      });

      await processor.processBatch([env1, envBad, env3]);

      // Only env-1 should have been saved
      expect(depot.saved).toHaveLength(1);
      expect(depot.saved[0].aggregateId).toBe('order-1');
    });
  });

  // -----------------------------------------------------------------------
  // Lazy hydration
  // -----------------------------------------------------------------------

  describe('lazy hydration', () => {
    it('creates new instance with version 0 for missing aggregate', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      const result = await processor.processBatch([makeCommandOnlyEnvelope()]);

      // Should succeed — the aggregate is lazily created
      expect(result.status).toBe('completed');
      expect(result.results[0].status).toBe('accepted');
      // Events should have been saved via depot
      expect(depot.saved).toHaveLength(1);
    });

    it('uses existing state when aggregate is already hydrated', async () => {
      const existingDepot = createFakeDepot({
        'Order:order-1': { state: { items: ['existing'] }, version: 3 },
      });

      let capturedState: unknown;
      const reg: AggregateRegistration = {
        aggregateType: 'Order',
        commandHandlers: {
          PlaceOrder: (state: unknown, payload: unknown) => {
            capturedState = state;
            return [{ type: 'OrderPlaced', payload }];
          },
        },
      };

      const options = makeOptions({
        auditSink,
        depot: existingDepot,
        idempotencyStore,
        registrations: [reg],
      });
      const processor = createAggregateRuntimeProcessor(options);

      await processor.processBatch([makeCommandOnlyEnvelope()]);

      expect(capturedState).toEqual({ items: ['existing'] });
    });
  });

  // -----------------------------------------------------------------------
  // Audit signals
  // -----------------------------------------------------------------------

  describe('audit signals', () => {
    it('emits accepted signal for successful processing', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      await processor.processBatch([makeCommandOnlyEnvelope()]);

      const accepted = auditSink.signals.filter((s) => s.type === 'accepted');
      expect(accepted).toHaveLength(1);
      if (accepted[0].type === 'accepted') {
        expect(accepted[0].envelopeId).toBe('env-1');
        expect(accepted[0].aggregateType).toBe('Order');
        expect(accepted[0].aggregateId).toBe('order-1');
      }
    });

    it('emits rejected signal for unknown aggregate', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      await processor.processBatch([
        makeCommandOnlyEnvelope({ aggregateType: 'Widget' }),
      ]);

      const rejected = auditSink.signals.filter((s) => s.type === 'rejected');
      expect(rejected).toHaveLength(1);
      if (rejected[0].type === 'rejected') {
        expect(rejected[0].envelopeId).toBe('env-1');
        expect(rejected[0].reason).toContain('Widget');
      }
    });

    it('emits rejected signal for events_only envelope', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      const envelope: SyncEnvelope = {
        type: 'events_only',
        envelopeId: 'env-eo',
        aggregateType: 'Order',
        aggregateId: 'order-1',
        events: [],
        occurredAt: '2026-01-01T00:00:00Z',
      };

      await processor.processBatch([envelope]);

      const rejected = auditSink.signals.filter((s) => s.type === 'rejected');
      expect(rejected).toHaveLength(1);
    });

    it('emits batch_failed signal when command handler throws', async () => {
      const throwingReg: AggregateRegistration = {
        aggregateType: 'Order',
        commandHandlers: {
          PlaceOrder: () => {
            throw new Error('handler exploded');
          },
        },
      };

      const options = makeOptions({
        auditSink,
        depot,
        idempotencyStore,
        registrations: [throwingReg],
      });
      const processor = createAggregateRuntimeProcessor(options);

      const result = await processor.processBatch([makeCommandOnlyEnvelope()]);

      expect(result.status).toBe('failed');
      const batchFailed = auditSink.signals.filter((s) => s.type === 'batch_failed');
      expect(batchFailed).toHaveLength(1);
      if (batchFailed[0].type === 'batch_failed') {
        expect(batchFailed[0].reason).toContain('handler exploded');
      }
    });

    it('emits rejected signal for malformed envelope', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      await processor.processBatch([
        makeCommandOnlyEnvelope({ envelopeId: '' }),
      ]);

      const rejected = auditSink.signals.filter((s) => s.type === 'rejected');
      expect(rejected).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // ingestedAt
  // -----------------------------------------------------------------------

  describe('ingestedAt', () => {
    it('includes a valid ISO timestamp', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      const result = await processor.processBatch([makeCommandOnlyEnvelope()]);

      expect(result.ingestedAt).toBeDefined();
      const parsed = new Date(result.ingestedAt);
      expect(parsed.toISOString()).toBe(result.ingestedAt);
    });
  });

  // -----------------------------------------------------------------------
  // Command handler errors
  // -----------------------------------------------------------------------

  describe('command handler errors', () => {
    it('catches handler exceptions and returns failed batch', async () => {
      const throwingReg: AggregateRegistration = {
        aggregateType: 'Order',
        commandHandlers: {
          PlaceOrder: () => {
            throw new Error('boom');
          },
        },
      };

      const options = makeOptions({
        auditSink,
        depot,
        idempotencyStore,
        registrations: [throwingReg],
      });
      const processor = createAggregateRuntimeProcessor(options);

      const result = await processor.processBatch([makeCommandOnlyEnvelope()]);

      expect(result.status).toBe('failed');
      expect(result.failedAtIndex).toBe(0);
      if (result.results[0].status === 'rejected') {
        expect(result.results[0].reason).toContain('PROCESSING_ERROR');
        expect(result.results[0].reason).toContain('boom');
      }
    });

    it('fails when command type has no registered handler', async () => {
      const options = makeOptions({ auditSink, depot, idempotencyStore });
      const processor = createAggregateRuntimeProcessor(options);

      const envelope = makeCommandOnlyEnvelope({ commandType: 'UnknownCommand' });
      const result = await processor.processBatch([envelope]);

      expect(result.status).toBe('failed');
      expect(result.failedAtIndex).toBe(0);
      if (result.results[0].status === 'rejected') {
        expect(result.results[0].reason).toContain('PROCESSING_ERROR');
        expect(result.results[0].reason).toContain('UnknownCommand');
      }
    });
  });
});
