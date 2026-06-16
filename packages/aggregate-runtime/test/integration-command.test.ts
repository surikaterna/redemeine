/**
 * Integration tests: command processing, sequencing, idempotency, and routing.
 * Each test constructs a full processor with all adapters and processes complete batches.
 */

import { describe, expect, it } from 'bun:test';
import type { SyncEnvelope } from '../src/index';
import { createAggregateRuntimeProcessor } from '../src/index';

import {
  createInMemoryIdempotencyStore,
  createInMemoryOrderingStore,
  createInMemoryDepot,
  createCollectingAuditSink,
  counterRegistration,
  ledgerRegistration,
  ticketRegistration,
  makeCommandEnvelope,
  makeOptions,
} from './integration-helpers';

// ---------------------------------------------------------------------------
// Full command-only batch
// ---------------------------------------------------------------------------

describe('integration: full command-only batch processes all envelopes', () => {
  it('accepts 3 command envelopes for different aggregates', async () => {
    const depot = createInMemoryDepot();
    const orderingStore = createInMemoryOrderingStore();
    const auditSink = createCollectingAuditSink();
    const options = makeOptions({
      registrations: [counterRegistration(), ledgerRegistration(), ticketRegistration()],
      depot,
      orderingStore,
      auditSink,
    });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeCommandEnvelope({ envelopeId: 'e1', commandId: 'c1', aggregateId: 'counter-1' }),
      makeCommandEnvelope({
        envelopeId: 'e2', commandId: 'c2',
        aggregateType: 'Ledger', aggregateId: 'ledger-1',
        commandType: 'PostEntry', payload: { amount: 100 },
      }),
      makeCommandEnvelope({
        envelopeId: 'e3', commandId: 'c3',
        aggregateType: 'Ticket', aggregateId: 'ticket-1',
        commandType: 'Open', payload: { title: 'fix' },
      }),
    ]);

    expect(result.status).toBe('completed');
    expect(result.total).toBe(3);
    expect(result.processed).toBe(3);
    expect(result.results.every((r) => r.status === 'accepted')).toBe(true);
    expect(depot.saved).toHaveLength(3);
    expect(auditSink.signals.filter((s) => s.type === 'accepted')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Mixed batch with duplicate
// ---------------------------------------------------------------------------

describe('integration: mixed batch with duplicate skips idempotent envelope', () => {
  it('1st accepted, 2nd skipped as duplicate, 3rd accepted', async () => {
    const idempotencyStore = createInMemoryIdempotencyStore();
    idempotencyStore.reserved.add('e2'); // pre-mark as processed
    const depot = createInMemoryDepot();
    const auditSink = createCollectingAuditSink();
    const options = makeOptions({ idempotencyStore, depot, auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeCommandEnvelope({ envelopeId: 'e1', commandId: 'c1', aggregateId: 'a1' }),
      makeCommandEnvelope({ envelopeId: 'e2', commandId: 'c2', aggregateId: 'a2' }),
      makeCommandEnvelope({ envelopeId: 'e3', commandId: 'c3', aggregateId: 'a3' }),
    ]);

    expect(result.status).toBe('completed');
    expect(result.processed).toBe(3);
    expect(result.results[0].status).toBe('accepted');
    expect(result.results[1].status).toBe('duplicate');
    expect(result.results[2].status).toBe('accepted');
    // Only 2 envelopes should have saved events (duplicate skipped)
    expect(depot.saved).toHaveLength(2);
    expect(auditSink.signals.filter((s) => s.type === 'duplicate')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Sequence enforcement across batch
// ---------------------------------------------------------------------------

describe('integration: sequence enforcement accepts sequential envelopes', () => {
  it('accepts sequences 1, 2, 3 for same aggregate in one batch', async () => {
    const orderingStore = createInMemoryOrderingStore();
    const depot = createInMemoryDepot();
    const options = makeOptions({ orderingStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeCommandEnvelope({ envelopeId: 'e1', commandId: 'c1', sequence: 1 }),
      makeCommandEnvelope({ envelopeId: 'e2', commandId: 'c2', sequence: 2 }),
      makeCommandEnvelope({ envelopeId: 'e3', commandId: 'c3', sequence: 3 }),
    ]);

    expect(result.status).toBe('completed');
    expect(result.processed).toBe(3);
    expect(result.results.every((r) => r.status === 'accepted')).toBe(true);
    expect(orderingStore.sequences.get('Counter:counter-1')).toBe(3);
    expect(depot.saved).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Sequence gap halts batch
// ---------------------------------------------------------------------------

describe('integration: sequence gap halts batch at gap envelope', () => {
  it('sequences 1, 3, 4 — 1st accepted, 2nd fails with gap, 3rd not processed', async () => {
    const orderingStore = createInMemoryOrderingStore();
    const depot = createInMemoryDepot();
    const auditSink = createCollectingAuditSink();
    const options = makeOptions({ orderingStore, depot, auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeCommandEnvelope({ envelopeId: 'e1', commandId: 'c1', sequence: 1 }),
      makeCommandEnvelope({ envelopeId: 'e2', commandId: 'c2', sequence: 3 }),
      makeCommandEnvelope({ envelopeId: 'e3', commandId: 'c3', sequence: 4 }),
    ]);

    expect(result.status).toBe('failed');
    expect(result.failedAtIndex).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.total).toBe(3);
    // Only 2 results: 1st accepted, 2nd rejected; 3rd never processed
    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe('accepted');
    expect(result.results[1].status).toBe('rejected');
    if (result.results[1].status === 'rejected') {
      expect(result.results[1].reason).toContain('SEQUENCE_GAP');
    }
    // Only 1st envelope saved events
    expect(depot.saved).toHaveLength(1);
    // Sequence should remain at 1 (gap at 2nd)
    expect(orderingStore.sequences.get('Counter:counter-1')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Events-only rejection
// ---------------------------------------------------------------------------

describe('integration: events_only envelope causes batch failure', () => {
  it('rejects events_only envelope with EVENTS_ONLY_NOT_SUPPORTED', async () => {
    const auditSink = createCollectingAuditSink();
    const options = makeOptions({ auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope: SyncEnvelope = {
      type: 'events_only',
      envelopeId: 'eo-1',
      aggregateType: 'Counter',
      aggregateId: 'counter-1',
      events: [{ type: 'Incremented', payload: { amount: 1 } }],
      occurredAt: '2026-01-01T00:00:00Z',
    };

    const result = await processor.processBatch([envelope]);

    expect(result.status).toBe('failed');
    expect(result.failedAtIndex).toBe(0);
    expect(result.results[0].status).toBe('rejected');
    if (result.results[0].status === 'rejected') {
      expect(result.results[0].reason).toContain('EVENTS_ONLY_NOT_SUPPORTED');
    }
    expect(auditSink.signals.filter((s) => s.type === 'rejected')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unknown aggregate halts batch
// ---------------------------------------------------------------------------

describe('integration: unknown aggregate halts batch', () => {
  it('batch fails when envelope targets unregistered aggregate type', async () => {
    const depot = createInMemoryDepot();
    const auditSink = createCollectingAuditSink();
    const options = makeOptions({ depot, auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeCommandEnvelope({
        envelopeId: 'e1', commandId: 'c1',
        aggregateType: 'NonExistent', aggregateId: 'x-1',
        commandType: 'DoSomething',
      }),
    ]);

    expect(result.status).toBe('failed');
    expect(result.failedAtIndex).toBe(0);
    expect(result.results[0].status).toBe('rejected');
    if (result.results[0].status === 'rejected') {
      expect(result.results[0].reason).toContain('UNKNOWN_AGGREGATE');
    }
    expect(depot.saved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lazy hydration
// ---------------------------------------------------------------------------

describe('integration: lazy hydration creates aggregate from empty state', () => {
  it('command for non-existent aggregate succeeds with undefined state', async () => {
    let capturedState: unknown = 'NOT_SET';
    const reg = {
      aggregateType: 'Counter',
      commandHandlers: {
        Increment: (state: unknown, payload: unknown) => {
          capturedState = state;
          return [{ type: 'Incremented', payload }];
        },
      },
    };
    const depot = createInMemoryDepot();
    const options = makeOptions({ registrations: [reg], depot });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([makeCommandEnvelope()]);

    expect(result.status).toBe('completed');
    expect(result.results[0].status).toBe('accepted');
    expect(capturedState).toBeUndefined();
    expect(depot.saved).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Multiple aggregates in one batch
// ---------------------------------------------------------------------------

describe('integration: multiple aggregate types in one batch', () => {
  it('processes 3 different aggregate types independently', async () => {
    const depot = createInMemoryDepot();
    const options = makeOptions({
      registrations: [counterRegistration(), ledgerRegistration(), ticketRegistration()],
      depot,
    });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeCommandEnvelope({
        envelopeId: 'e1', commandId: 'c1',
        aggregateType: 'Counter', aggregateId: 'c-1',
        commandType: 'Increment', payload: { amount: 5 },
      }),
      makeCommandEnvelope({
        envelopeId: 'e2', commandId: 'c2',
        aggregateType: 'Ledger', aggregateId: 'l-1',
        commandType: 'PostEntry', payload: { amount: 200 },
      }),
      makeCommandEnvelope({
        envelopeId: 'e3', commandId: 'c3',
        aggregateType: 'Ticket', aggregateId: 't-1',
        commandType: 'Open', payload: { title: 'new' },
      }),
    ]);

    expect(result.status).toBe('completed');
    expect(result.processed).toBe(3);

    // Verify each aggregate produced its own events
    const savedTypes = depot.saved.map((s) => s.aggregateType);
    expect(savedTypes).toEqual(['Counter', 'Ledger', 'Ticket']);

    const eventTypes = depot.saved.map(
      (s) => (s.events[0] as { type: string }).type,
    );
    expect(eventTypes).toEqual(['Incremented', 'EntryPosted', 'Opened']);
  });
});

// ---------------------------------------------------------------------------
// Idempotency across batches
// ---------------------------------------------------------------------------

describe('integration: idempotency across separate batch calls', () => {
  it('same envelope accepted first time, duplicate second time', async () => {
    const idempotencyStore = createInMemoryIdempotencyStore();
    const depot = createInMemoryDepot();
    const options = makeOptions({ idempotencyStore, depot });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandEnvelope({ envelopeId: 'idem-1', commandId: 'c1' });

    // First batch
    const first = await processor.processBatch([envelope]);
    expect(first.status).toBe('completed');
    expect(first.results[0].status).toBe('accepted');

    // Second batch with same envelope
    const second = await processor.processBatch([envelope]);
    expect(second.status).toBe('completed');
    expect(second.results[0].status).toBe('duplicate');

    // Events saved only once
    expect(depot.saved).toHaveLength(1);
    expect(idempotencyStore.reserved.has('idem-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

describe('integration: results maintain deterministic input order', () => {
  it('results appear in exact envelope input order', async () => {
    const idempotencyStore = createInMemoryIdempotencyStore();
    idempotencyStore.reserved.add('e3'); // middle one is duplicate
    const options = makeOptions({ idempotencyStore });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeCommandEnvelope({ envelopeId: 'e1', commandId: 'c1', aggregateId: 'a1' }),
      makeCommandEnvelope({ envelopeId: 'e2', commandId: 'c2', aggregateId: 'a2' }),
      makeCommandEnvelope({ envelopeId: 'e3', commandId: 'c3', aggregateId: 'a3' }),
      makeCommandEnvelope({ envelopeId: 'e4', commandId: 'c4', aggregateId: 'a4' }),
    ]);

    expect(result.status).toBe('completed');
    const envelopeIds = result.results.map((r) => r.envelopeId);
    expect(envelopeIds).toEqual(['e1', 'e2', 'e3', 'e4']);

    expect(result.results[0].status).toBe('accepted');
    expect(result.results[1].status).toBe('accepted');
    expect(result.results[2].status).toBe('duplicate');
    expect(result.results[3].status).toBe('accepted');
  });
});
