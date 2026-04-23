import { describe, expect, it, beforeEach } from 'bun:test';

import type {
  CommandOnlyEnvelope,
  AggregateRuntimeOptions,
  IIdempotencyStore,
  IOrderingStore,
  IAuditSink,
  IDepot,
  AuditSignal,
  AggregateRegistration,
  AggregateInstance,
  SequenceCheckResult,
} from '../src/index';

import {
  createSequenceEnforcer,
  createAggregateRuntimeProcessor,
} from '../src/index';

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

function createFakeOrderingStore(): IOrderingStore & {
  sequences: Map<string, number>;
} {
  const sequences = new Map<string, number>();
  return {
    sequences,
    async getLastSequence(
      aggregateType: string,
      aggregateId: string,
    ): Promise<number | undefined> {
      return sequences.get(`${aggregateType}:${aggregateId}`);
    },
    async saveSequence(
      aggregateType: string,
      aggregateId: string,
      sequence: number,
    ): Promise<void> {
      sequences.set(`${aggregateType}:${aggregateId}`, sequence);
    },
  };
}

function createFakeIdempotencyStore(): IIdempotencyStore & {
  processed: Set<string>;
} {
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

function createFakeAuditSink(): IAuditSink & { signals: AuditSignal[] } {
  const signals: AuditSignal[] = [];
  return {
    signals,
    emit(signal: AuditSignal): void {
      signals.push(signal);
    },
  };
}

function createFakeDepot(): IDepot & {
  saved: Array<{
    aggregateType: string;
    aggregateId: string;
    events: ReadonlyArray<unknown>;
  }>;
} {
  const saved: Array<{
    aggregateType: string;
    aggregateId: string;
    events: ReadonlyArray<unknown>;
  }> = [];
  return {
    saved,
    async get(): Promise<AggregateInstance | undefined> {
      return undefined;
    },
    async save(
      aggregateType: string,
      aggregateId: string,
      events: ReadonlyArray<unknown>,
    ): Promise<void> {
      saved.push({ aggregateType, aggregateId, events });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEnvelope(
  overrides?: Partial<CommandOnlyEnvelope>,
): CommandOnlyEnvelope {
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

function makeInvoiceRegistration(): AggregateRegistration {
  return {
    aggregateType: 'Invoice',
    commandHandlers: {
      CreateInvoice: (_state: unknown, payload: unknown) => {
        return [{ type: 'InvoiceCreated', payload }];
      },
    },
  };
}

function makeOptions(
  overrides?: Partial<AggregateRuntimeOptions>,
): AggregateRuntimeOptions {
  return {
    registrations: [makeOrderRegistration(), makeInvoiceRegistration()],
    idempotencyStore: createFakeIdempotencyStore(),
    orderingStore: createFakeOrderingStore(),
    auditSink: createFakeAuditSink(),
    depot: createFakeDepot(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createSequenceEnforcer — unit tests
// ---------------------------------------------------------------------------

describe('createSequenceEnforcer', () => {
  let orderingStore: IOrderingStore & { sequences: Map<string, number> };

  beforeEach(() => {
    orderingStore = createFakeOrderingStore();
  });

  it('returns ok when sequence is undefined (no enforcement)', async () => {
    const enforcer = createSequenceEnforcer(orderingStore);

    const result = await enforcer.enforce('Order', 'order-1', undefined);

    expect(result).toEqual({ status: 'ok' });
    // Should not touch the store
    expect(orderingStore.sequences.size).toBe(0);
  });

  it('accepts any sequence for first envelope in a stream', async () => {
    const enforcer = createSequenceEnforcer(orderingStore);

    const result = await enforcer.enforce('Order', 'order-1', 5);

    expect(result).toEqual({ status: 'ok' });
    expect(orderingStore.sequences.get('Order:order-1')).toBe(5);
  });

  it('accepts valid next sequence (lastSequence + 1)', async () => {
    orderingStore.sequences.set('Order:order-1', 3);
    const enforcer = createSequenceEnforcer(orderingStore);

    const result = await enforcer.enforce('Order', 'order-1', 4);

    expect(result).toEqual({ status: 'ok' });
    expect(orderingStore.sequences.get('Order:order-1')).toBe(4);
  });

  it('detects gap when sequence is ahead of expected', async () => {
    orderingStore.sequences.set('Order:order-1', 3);
    const enforcer = createSequenceEnforcer(orderingStore);

    const result = await enforcer.enforce('Order', 'order-1', 6);

    expect(result).toEqual({
      status: 'gap',
      expected: 4,
      received: 6,
    });
    // Should NOT update the store
    expect(orderingStore.sequences.get('Order:order-1')).toBe(3);
  });

  it('detects out-of-order when sequence is behind last processed', async () => {
    orderingStore.sequences.set('Order:order-1', 5);
    const enforcer = createSequenceEnforcer(orderingStore);

    const result = await enforcer.enforce('Order', 'order-1', 2);

    expect(result).toEqual({
      status: 'out_of_order',
      expected: 6,
      received: 2,
    });
    // Should NOT update the store
    expect(orderingStore.sequences.get('Order:order-1')).toBe(5);
  });

  it('detects duplicate_sequence when sequence equals last processed', async () => {
    orderingStore.sequences.set('Order:order-1', 3);
    const enforcer = createSequenceEnforcer(orderingStore);

    const result = await enforcer.enforce('Order', 'order-1', 3);

    expect(result).toEqual({
      status: 'duplicate_sequence',
      sequence: 3,
    });
    // Should NOT update the store
    expect(orderingStore.sequences.get('Order:order-1')).toBe(3);
  });

  it('independent streams do not interfere with each other', async () => {
    const enforcer = createSequenceEnforcer(orderingStore);

    // Stream 1: Order:order-1
    const r1 = await enforcer.enforce('Order', 'order-1', 1);
    expect(r1).toEqual({ status: 'ok' });

    // Stream 2: Order:order-2 — starts at 1 independently
    const r2 = await enforcer.enforce('Order', 'order-2', 1);
    expect(r2).toEqual({ status: 'ok' });

    // Stream 1 continues to 2
    const r3 = await enforcer.enforce('Order', 'order-1', 2);
    expect(r3).toEqual({ status: 'ok' });

    // Stream 2 continues to 2 independently
    const r4 = await enforcer.enforce('Order', 'order-2', 2);
    expect(r4).toEqual({ status: 'ok' });

    expect(orderingStore.sequences.get('Order:order-1')).toBe(2);
    expect(orderingStore.sequences.get('Order:order-2')).toBe(2);
  });

  it('different aggregate types have independent streams', async () => {
    const enforcer = createSequenceEnforcer(orderingStore);

    const r1 = await enforcer.enforce('Order', 'id-1', 1);
    expect(r1).toEqual({ status: 'ok' });

    // Same aggregateId, different type — independent stream
    const r2 = await enforcer.enforce('Invoice', 'id-1', 1);
    expect(r2).toEqual({ status: 'ok' });

    expect(orderingStore.sequences.get('Order:id-1')).toBe(1);
    expect(orderingStore.sequences.get('Invoice:id-1')).toBe(1);
  });

  it('SequenceCheckResult discriminated union narrows correctly', async () => {
    const enforcer = createSequenceEnforcer(orderingStore);

    const results: SequenceCheckResult[] = [];

    // ok
    results.push(await enforcer.enforce('A', 'a1', undefined));
    // ok (first in stream)
    results.push(await enforcer.enforce('A', 'a1', 1));
    // duplicate_sequence
    results.push(await enforcer.enforce('A', 'a1', 1));
    // ok (next)
    results.push(await enforcer.enforce('A', 'a1', 2));
    // gap
    results.push(await enforcer.enforce('A', 'a1', 5));
    // out_of_order
    results.push(await enforcer.enforce('A', 'a1', 1));

    const statuses = results.map((r) => {
      switch (r.status) {
        case 'ok':
          return 'ok';
        case 'gap':
          return `gap:${r.expected}->${r.received}`;
        case 'duplicate_sequence':
          return `dup:${r.sequence}`;
        case 'out_of_order':
          return `ooo:${r.expected}->${r.received}`;
      }
    });

    expect(statuses).toEqual([
      'ok',
      'ok',
      'dup:1',
      'ok',
      'gap:3->5',
      'ooo:3->1',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Processor integration — sequence enforcement
// ---------------------------------------------------------------------------

describe('processor sequence enforcement', () => {
  let auditSink: IAuditSink & { signals: AuditSignal[] };
  let orderingStore: IOrderingStore & { sequences: Map<string, number> };
  let depot: ReturnType<typeof createFakeDepot>;

  beforeEach(() => {
    auditSink = createFakeAuditSink();
    orderingStore = createFakeOrderingStore();
    depot = createFakeDepot();
  });

  it('accepts envelopes without sequence (no enforcement)', async () => {
    const options = makeOptions({ auditSink, orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([makeEnvelope()]);

    expect(result.status).toBe('completed');
    expect(result.results[0].status).toBe('accepted');
  });

  it('accepts first sequenced envelope for a stream', async () => {
    const options = makeOptions({ auditSink, orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeEnvelope({ sequence: 1 }),
    ]);

    expect(result.status).toBe('completed');
    expect(result.results[0].status).toBe('accepted');
    expect(orderingStore.sequences.get('Order:order-1')).toBe(1);
  });

  it('accepts valid sequential envelopes', async () => {
    const options = makeOptions({ auditSink, orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    const env1 = makeEnvelope({
      envelopeId: 'env-1',
      commandId: 'cmd-1',
      sequence: 1,
    });
    const env2 = makeEnvelope({
      envelopeId: 'env-2',
      commandId: 'cmd-2',
      sequence: 2,
    });

    const result = await processor.processBatch([env1, env2]);

    expect(result.status).toBe('completed');
    expect(result.results[0].status).toBe('accepted');
    expect(result.results[1].status).toBe('accepted');
    expect(orderingStore.sequences.get('Order:order-1')).toBe(2);
  });

  it('fails batch on sequence gap with SEQUENCE_GAP error', async () => {
    orderingStore.sequences.set('Order:order-1', 3);
    const options = makeOptions({ auditSink, orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeEnvelope({ sequence: 6 }),
    ]);

    expect(result.status).toBe('failed');
    expect(result.failedAtIndex).toBe(0);
    expect(result.results[0].status).toBe('rejected');
    if (result.results[0].status === 'rejected') {
      expect(result.results[0].reason).toContain('SEQUENCE_GAP');
      expect(result.results[0].reason).toContain('expected sequence 4');
      expect(result.results[0].reason).toContain('received 6');
    }
  });

  it('fails batch on out-of-order with SEQUENCE_GAP error', async () => {
    orderingStore.sequences.set('Order:order-1', 5);
    const options = makeOptions({ auditSink, orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeEnvelope({ sequence: 2 }),
    ]);

    expect(result.status).toBe('failed');
    expect(result.failedAtIndex).toBe(0);
    if (result.results[0].status === 'rejected') {
      expect(result.results[0].reason).toContain('SEQUENCE_GAP');
    }
  });

  it('skips duplicate sequence as duplicate (not rejected)', async () => {
    orderingStore.sequences.set('Order:order-1', 3);
    const options = makeOptions({ auditSink, orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeEnvelope({ sequence: 3 }),
    ]);

    // Duplicate sequence → treated as duplicate, batch completes
    expect(result.status).toBe('completed');
    expect(result.results[0].status).toBe('duplicate');
  });

  it('emits rejected audit signal on sequence gap', async () => {
    orderingStore.sequences.set('Order:order-1', 3);
    const options = makeOptions({ auditSink, orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    await processor.processBatch([makeEnvelope({ sequence: 10 })]);

    const rejected = auditSink.signals.filter((s) => s.type === 'rejected');
    expect(rejected).toHaveLength(1);
    if (rejected[0].type === 'rejected') {
      expect(rejected[0].reason).toContain('SEQUENCE_GAP');
    }
  });

  it('emits duplicate audit signal on duplicate sequence', async () => {
    orderingStore.sequences.set('Order:order-1', 3);
    const options = makeOptions({ auditSink, orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    await processor.processBatch([makeEnvelope({ sequence: 3 })]);

    const duplicates = auditSink.signals.filter((s) => s.type === 'duplicate');
    expect(duplicates).toHaveLength(1);
  });

  it('saves sequence after successful processing', async () => {
    const options = makeOptions({ auditSink, orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    await processor.processBatch([
      makeEnvelope({ sequence: 1 }),
    ]);

    expect(orderingStore.sequences.get('Order:order-1')).toBe(1);
    expect(depot.saved).toHaveLength(1);
  });

  it('does not save events on sequence gap', async () => {
    orderingStore.sequences.set('Order:order-1', 3);
    const options = makeOptions({ auditSink, orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    await processor.processBatch([makeEnvelope({ sequence: 6 })]);

    expect(depot.saved).toHaveLength(0);
  });

  it('independent aggregate streams do not interfere via processor', async () => {
    const options = makeOptions({ auditSink, orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    const env1 = makeEnvelope({
      envelopeId: 'env-1',
      commandId: 'cmd-1',
      aggregateId: 'order-1',
      sequence: 1,
    });
    const env2 = makeEnvelope({
      envelopeId: 'env-2',
      commandId: 'cmd-2',
      aggregateId: 'order-2',
      sequence: 1,
    });

    const result = await processor.processBatch([env1, env2]);

    // Both should succeed — independent streams
    expect(result.status).toBe('completed');
    expect(result.results[0].status).toBe('accepted');
    expect(result.results[1].status).toBe('accepted');
    expect(orderingStore.sequences.get('Order:order-1')).toBe(1);
    expect(orderingStore.sequences.get('Order:order-2')).toBe(1);
  });

  it('sequence enforcement runs after idempotency check', async () => {
    // Pre-mark as processed (idempotent duplicate)
    const idempotencyStore = createFakeIdempotencyStore();
    idempotencyStore.processed.add('env-1');

    const options = makeOptions({
      auditSink,
      orderingStore,
      depot,
      idempotencyStore,
    });
    const processor = createAggregateRuntimeProcessor(options);

    // Would be a gap if sequence check ran, but idempotency catches it first
    const result = await processor.processBatch([
      makeEnvelope({ sequence: 99 }),
    ]);

    expect(result.status).toBe('completed');
    expect(result.results[0].status).toBe('duplicate');
    // Sequence should NOT have been updated
    expect(orderingStore.sequences.has('Order:order-1')).toBe(false);
  });
});
