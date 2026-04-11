import { describe, expect, it, beforeEach } from 'bun:test';

import type {
  CommandOnlyEnvelope,
  CommandWithEventsEnvelope,
  AggregateRuntimeOptions,
  IIdempotencyStore,
  IOrderingStore,
  IAuditSink,
  IDepot,
  AuditSignal,
  AggregateRegistration,
  AggregateInstance,
  AuditRecord,
  BatchResult,
} from '../src/index';

import {
  createAggregateRuntimeProcessor,
  createAuditRecord,
  createBatchReport,
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

function createFakeDepot(): IDepot & { saved: Array<{ aggregateType: string; aggregateId: string; events: ReadonlyArray<unknown> }> } {
  const store = new Map<string, AggregateInstance>();
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
// createAuditRecord
// ---------------------------------------------------------------------------

describe('createAuditRecord', () => {
  it('includes occurredAt from context', () => {
    const signal: AuditSignal = {
      type: 'accepted',
      envelopeId: 'env-1',
      aggregateType: 'Order',
      aggregateId: 'order-1',
    };

    const record = createAuditRecord(signal, {
      occurredAt: '2026-01-01T00:00:00Z',
      ingestedAt: '2026-01-01T00:00:01Z',
      aggregateType: 'Order',
      aggregateId: 'order-1',
      startTime: Date.now() - 5,
    });

    expect(record.occurredAt).toBe('2026-01-01T00:00:00Z');
  });

  it('includes ingestedAt from context', () => {
    const signal: AuditSignal = {
      type: 'accepted',
      envelopeId: 'env-1',
      aggregateType: 'Order',
      aggregateId: 'order-1',
    };

    const record = createAuditRecord(signal, {
      occurredAt: '2026-01-01T00:00:00Z',
      ingestedAt: '2026-01-01T00:00:01Z',
      aggregateType: 'Order',
      aggregateId: 'order-1',
      startTime: Date.now() - 10,
    });

    expect(record.ingestedAt).toBe('2026-01-01T00:00:01Z');
  });

  it('includes aggregateType and aggregateId from context', () => {
    const signal: AuditSignal = {
      type: 'duplicate',
      envelopeId: 'env-2',
      aggregateType: 'Invoice',
      aggregateId: 'inv-42',
    };

    const record = createAuditRecord(signal, {
      occurredAt: '2026-01-01T00:00:00Z',
      ingestedAt: '2026-01-01T00:00:01Z',
      aggregateType: 'Invoice',
      aggregateId: 'inv-42',
      startTime: Date.now() - 3,
    });

    expect(record.aggregateType).toBe('Invoice');
    expect(record.aggregateId).toBe('inv-42');
  });

  it('includes durationMs as a non-negative number', () => {
    const signal: AuditSignal = {
      type: 'accepted',
      envelopeId: 'env-1',
      aggregateType: 'Order',
      aggregateId: 'order-1',
    };

    const record = createAuditRecord(signal, {
      occurredAt: '2026-01-01T00:00:00Z',
      ingestedAt: '2026-01-01T00:00:01Z',
      aggregateType: 'Order',
      aggregateId: 'order-1',
      startTime: Date.now() - 15,
    });

    expect(typeof record.durationMs).toBe('number');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('preserves the original signal properties', () => {
    const signal: AuditSignal = {
      type: 'rejected',
      envelopeId: 'env-bad',
      reason: 'invalid payload',
    };

    const record = createAuditRecord(signal, {
      occurredAt: '2026-01-01T00:00:00Z',
      ingestedAt: '2026-01-01T00:00:01Z',
      aggregateType: 'Order',
      aggregateId: 'order-1',
      startTime: Date.now(),
    });

    expect(record.type).toBe('rejected');
    expect(record.envelopeId).toBe('env-bad');
  });
});

// ---------------------------------------------------------------------------
// Processor emits enriched audit records
// ---------------------------------------------------------------------------

describe('processor audit records', () => {
  let auditSink: IAuditSink & { signals: AuditSignal[] };

  beforeEach(() => {
    auditSink = createFakeAuditSink();
  });

  it('accepted signal includes occurredAt and ingestedAt', async () => {
    const options = makeOptions({ auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    await processor.processBatch([makeCommandOnlyEnvelope()]);

    const accepted = auditSink.signals.find((s) => s.type === 'accepted');
    expect(accepted).toBeDefined();
    const record = accepted as AuditRecord;
    expect(record.occurredAt).toBe('2026-01-01T00:00:00Z');
    expect(record.ingestedAt).toBeDefined();
    expect(new Date(record.ingestedAt).toISOString()).toBe(record.ingestedAt);
  });

  it('accepted signal includes aggregateType and aggregateId', async () => {
    const options = makeOptions({ auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    await processor.processBatch([makeCommandOnlyEnvelope()]);

    const accepted = auditSink.signals.find((s) => s.type === 'accepted');
    const record = accepted as AuditRecord;
    expect(record.aggregateType).toBe('Order');
    expect(record.aggregateId).toBe('order-1');
  });

  it('accepted signal includes durationMs', async () => {
    const options = makeOptions({ auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    await processor.processBatch([makeCommandOnlyEnvelope()]);

    const accepted = auditSink.signals.find((s) => s.type === 'accepted');
    const record = accepted as AuditRecord;
    expect(typeof record.durationMs).toBe('number');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('conflict signal includes enriched audit context', async () => {
    const conflictReg: AggregateRegistration = {
      aggregateType: 'Order',
      commandHandlers: {
        PlaceOrder: (_state: unknown, payload: unknown) => {
          return [{ type: 'OrderPlaced', payload }];
        },
      },
      conflictResolver: (_ctx) => ({
        decision: 'accept' as const,
      }),
    };

    const options = makeOptions({ auditSink, registrations: [conflictReg] });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope: CommandWithEventsEnvelope = {
      type: 'command_with_events',
      envelopeId: 'env-cwe',
      commandId: 'cmd-cwe',
      aggregateType: 'Order',
      aggregateId: 'order-1',
      commandType: 'PlaceOrder',
      payload: { item: 'widget' },
      events: [{ type: 'OrderPlaced', payload: { item: 'different' } }],
      occurredAt: '2026-02-01T00:00:00Z',
    };

    await processor.processBatch([envelope]);

    const conflictSignal = auditSink.signals.find((s) => s.type === 'conflict');
    expect(conflictSignal).toBeDefined();
    const record = conflictSignal as AuditRecord;
    expect(record.occurredAt).toBe('2026-02-01T00:00:00Z');
    expect(record.ingestedAt).toBeDefined();
    expect(record.aggregateType).toBe('Order');
    expect(record.aggregateId).toBe('order-1');
    expect(typeof record.durationMs).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// createBatchReport
// ---------------------------------------------------------------------------

describe('createBatchReport', () => {
  it('correctly counts accepted envelopes', () => {
    const result: BatchResult = {
      status: 'completed',
      processed: 3,
      total: 3,
      results: [
        { status: 'accepted', envelopeId: 'env-1' },
        { status: 'accepted', envelopeId: 'env-2' },
        { status: 'accepted', envelopeId: 'env-3' },
      ],
      ingestedAt: '2026-01-01T00:00:00Z',
    };

    const report = createBatchReport(result, '2026-01-01T00:00:00Z', 42);

    expect(report.accepted).toBe(3);
    expect(report.duplicates).toBe(0);
    expect(report.rejected).toBe(0);
    expect(report.conflicts).toBe(0);
  });

  it('correctly counts mixed outcome types', () => {
    const result: BatchResult = {
      status: 'failed',
      processed: 2,
      total: 4,
      failedAtIndex: 3,
      results: [
        { status: 'accepted', envelopeId: 'env-1' },
        { status: 'duplicate', envelopeId: 'env-2' },
        { status: 'conflict_resolved', envelopeId: 'env-3', decision: { decision: 'accept' } },
        { status: 'rejected', envelopeId: 'env-4', reason: 'bad' },
      ],
      ingestedAt: '2026-01-01T00:00:00Z',
    };

    const report = createBatchReport(result, '2026-01-01T00:00:00Z', 100);

    expect(report.accepted).toBe(1);
    expect(report.duplicates).toBe(1);
    expect(report.conflicts).toBe(1);
    expect(report.rejected).toBe(1);
    expect(report.total).toBe(4);
  });

  it('reports failed status correctly', () => {
    const result: BatchResult = {
      status: 'failed',
      processed: 1,
      total: 3,
      failedAtIndex: 1,
      results: [
        { status: 'accepted', envelopeId: 'env-1' },
        { status: 'rejected', envelopeId: 'env-2', reason: 'bad' },
      ],
      ingestedAt: '2026-01-01T00:00:00Z',
    };

    const report = createBatchReport(result, '2026-01-01T00:00:00Z', 50);

    expect(report.failed).toBe(true);
    expect(report.failedAtIndex).toBe(1);
  });

  it('reports completed status correctly', () => {
    const result: BatchResult = {
      status: 'completed',
      processed: 2,
      total: 2,
      results: [
        { status: 'accepted', envelopeId: 'env-1' },
        { status: 'duplicate', envelopeId: 'env-2' },
      ],
      ingestedAt: '2026-01-01T00:00:00Z',
    };

    const report = createBatchReport(result, '2026-01-01T00:00:00Z', 25);

    expect(report.failed).toBe(false);
    expect(report.failedAtIndex).toBeUndefined();
  });

  it('includes timing information', () => {
    const result: BatchResult = {
      status: 'completed',
      processed: 1,
      total: 1,
      results: [
        { status: 'accepted', envelopeId: 'env-1' },
      ],
      ingestedAt: '2026-01-01T00:00:00Z',
    };

    const report = createBatchReport(result, '2026-01-01T00:00:00Z', 77);

    expect(report.durationMs).toBe(77);
    expect(report.startedAt).toBe('2026-01-01T00:00:00Z');
    expect(report.completedAt).toBeDefined();
    expect(new Date(report.completedAt).toISOString()).toBe(report.completedAt);
  });

  it('uses ingestedAt as batchId for traceability', () => {
    const result: BatchResult = {
      status: 'completed',
      processed: 0,
      total: 0,
      results: [],
      ingestedAt: '2026-03-15T12:00:00.000Z',
    };

    const report = createBatchReport(result, '2026-03-15T12:00:00.000Z', 0);

    expect(report.batchId).toBe('2026-03-15T12:00:00.000Z');
  });
});
