/**
 * Integration tests: conflict handling and audit signal completeness.
 * Each test constructs a full processor with all adapters and processes complete batches.
 */

import { describe, expect, it } from 'bun:test';
import { createAggregateRuntimeProcessor } from '../src/index';

import {
  createInMemoryIdempotencyStore,
  createInMemoryDepot,
  createCollectingAuditSink,
  counterRegistration,
  makeCommandEnvelope,
  makeCommandWithEventsEnvelope,
  makeOptions,
} from './integration-helpers';

// ---------------------------------------------------------------------------
// Command with events — no conflict
// ---------------------------------------------------------------------------

describe('integration: command_with_events accepted when events match', () => {
  it('matching upstream events result in accepted status', async () => {
    const depot = createInMemoryDepot();
    const auditSink = createCollectingAuditSink();
    const options = makeOptions({ depot, auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    // Upstream events match what the handler produces
    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'Incremented', payload: { amount: 1 } }],
    });

    const result = await processor.processBatch([envelope]);

    expect(result.status).toBe('completed');
    expect(result.results[0].status).toBe('accepted');
    expect(depot.saved).toHaveLength(1);
    expect((depot.saved[0].events[0] as { type: string }).type).toBe('Incremented');
    // No conflict signal should be emitted
    expect(auditSink.signals.filter((s) => s.type === 'conflict')).toHaveLength(0);
    expect(auditSink.signals.filter((s) => s.type === 'accepted')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Command with events — conflict resolved with accept
// ---------------------------------------------------------------------------

describe('integration: conflict resolved with accept saves upstream events', () => {
  it('resolver accepts divergent events, upstream events are saved', async () => {
    const depot = createInMemoryDepot();
    const auditSink = createCollectingAuditSink();
    const reg = counterRegistration(() => ({ decision: 'accept' }));
    const options = makeOptions({ registrations: [reg], depot, auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'Incremented', payload: { amount: 999 } }], // differs from handler
    });

    const result = await processor.processBatch([envelope]);

    expect(result.status).toBe('completed');
    expect(result.results[0].status).toBe('conflict_resolved');
    if (result.results[0].status === 'conflict_resolved') {
      expect(result.results[0].decision.decision).toBe('accept');
    }
    // Upstream events should be saved (not locally produced)
    expect(depot.saved).toHaveLength(1);
    const savedPayload = (depot.saved[0].events[0] as { payload: { amount: number } }).payload;
    expect(savedPayload.amount).toBe(999);
    // Audit: conflict signal with accept
    const conflicts = auditSink.signals.filter((s) => s.type === 'conflict');
    expect(conflicts).toHaveLength(1);
    if (conflicts[0].type === 'conflict') {
      expect(conflicts[0].decision).toBe('accept');
    }
  });
});

// ---------------------------------------------------------------------------
// Command with events — conflict triggers batch failure (reject)
// ---------------------------------------------------------------------------

describe('integration: conflict reject causes batch failure', () => {
  it('resolver rejects divergent events, batch fails', async () => {
    const depot = createInMemoryDepot();
    const auditSink = createCollectingAuditSink();
    const reg = counterRegistration(
      () => ({ decision: 'reject', reason: 'policy violation' }),
    );
    const options = makeOptions({ registrations: [reg], depot, auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'Incremented', payload: { amount: 999 } }],
    });

    const result = await processor.processBatch([envelope]);

    expect(result.status).toBe('failed');
    expect(result.failedAtIndex).toBe(0);
    expect(result.results[0].status).toBe('rejected');
    if (result.results[0].status === 'rejected') {
      expect(result.results[0].reason).toContain('conflict rejected');
    }
    expect(depot.saved).toHaveLength(0);
    // Audit: conflict signal with reject decision
    const conflicts = auditSink.signals.filter((s) => s.type === 'conflict');
    expect(conflicts).toHaveLength(1);
    if (conflicts[0].type === 'conflict') {
      expect(conflicts[0].decision).toBe('reject');
    }
  });

  it('conflict reject halts remaining envelopes in the batch', async () => {
    const depot = createInMemoryDepot();
    const reg = counterRegistration(
      () => ({ decision: 'reject', reason: 'not allowed' }),
    );
    const options = makeOptions({ registrations: [reg], depot });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeCommandEnvelope({ envelopeId: 'e1', commandId: 'c1', aggregateId: 'a1' }),
      makeCommandWithEventsEnvelope({
        envelopeId: 'e2', commandId: 'c2', aggregateId: 'a2',
        events: [{ type: 'Incremented', payload: { amount: 999 } }],
      }),
      makeCommandEnvelope({ envelopeId: 'e3', commandId: 'c3', aggregateId: 'a3' }),
    ]);

    expect(result.status).toBe('failed');
    expect(result.failedAtIndex).toBe(1);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].status).toBe('accepted');
    expect(result.results[1].status).toBe('rejected');
    // Only first envelope saved events
    expect(depot.saved).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Command with events — no resolver, events differ → unresolved
// ---------------------------------------------------------------------------

describe('integration: unresolved conflict fails batch when no resolver', () => {
  it('divergent events without resolver cause batch failure', async () => {
    const depot = createInMemoryDepot();
    const auditSink = createCollectingAuditSink();
    // No conflict resolver registered
    const options = makeOptions({ depot, auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    const envelope = makeCommandWithEventsEnvelope({
      events: [{ type: 'Incremented', payload: { amount: 999 } }],
    });

    const result = await processor.processBatch([envelope]);

    expect(result.status).toBe('failed');
    expect(result.results[0].status).toBe('rejected');
    if (result.results[0].status === 'rejected') {
      expect(result.results[0].reason).toContain('no conflict resolver registered');
    }
    expect(depot.saved).toHaveLength(0);
    const conflicts = auditSink.signals.filter((s) => s.type === 'conflict');
    expect(conflicts).toHaveLength(1);
    if (conflicts[0].type === 'conflict') {
      expect(conflicts[0].decision).toBe('unresolved');
    }
  });
});

// ---------------------------------------------------------------------------
// Audit signal completeness for mixed batch
// ---------------------------------------------------------------------------

describe('integration: audit signals are complete for a mixed batch', () => {
  it('emits correct signals for accepted, duplicate, and conflict_resolved', async () => {
    const idempotencyStore = createInMemoryIdempotencyStore();
    idempotencyStore.reserved.add('e2'); // pre-mark as duplicate
    const depot = createInMemoryDepot();
    const auditSink = createCollectingAuditSink();
    const reg = counterRegistration(() => ({ decision: 'accept' }));
    const options = makeOptions({
      registrations: [reg],
      idempotencyStore,
      depot,
      auditSink,
    });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      // 1. command_only → accepted
      makeCommandEnvelope({ envelopeId: 'e1', commandId: 'c1', aggregateId: 'a1' }),
      // 2. duplicate → skipped
      makeCommandEnvelope({ envelopeId: 'e2', commandId: 'c2', aggregateId: 'a2' }),
      // 3. command_with_events, divergent → conflict_resolved (accept)
      makeCommandWithEventsEnvelope({
        envelopeId: 'e3', commandId: 'c3', aggregateId: 'a3',
        events: [{ type: 'Incremented', payload: { amount: 999 } }],
      }),
    ]);

    expect(result.status).toBe('completed');
    expect(result.processed).toBe(3);

    // Verify result statuses
    expect(result.results[0].status).toBe('accepted');
    expect(result.results[1].status).toBe('duplicate');
    expect(result.results[2].status).toBe('conflict_resolved');

    // Verify audit signals
    const accepted = auditSink.signals.filter((s) => s.type === 'accepted');
    const duplicates = auditSink.signals.filter((s) => s.type === 'duplicate');
    const conflicts = auditSink.signals.filter((s) => s.type === 'conflict');

    expect(accepted).toHaveLength(1);
    expect(accepted[0].envelopeId).toBe('e1');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].envelopeId).toBe('e2');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].envelopeId).toBe('e3');

    // No rejected or batch_failed signals
    expect(auditSink.signals.filter((s) => s.type === 'rejected')).toHaveLength(0);
    expect(auditSink.signals.filter((s) => s.type === 'batch_failed')).toHaveLength(0);

    // Signal count matches total emitted signals
    expect(auditSink.signals).toHaveLength(3);
  });

  it('emits batch_failed signal when processing error occurs', async () => {
    const auditSink = createCollectingAuditSink();
    const throwingReg = {
      aggregateType: 'Counter',
      commandHandlers: {
        Increment: () => { throw new Error('handler crash'); },
      },
    };
    const options = makeOptions({ registrations: [throwingReg], auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeCommandEnvelope({ envelopeId: 'crash-1', commandId: 'c1' }),
    ]);

    expect(result.status).toBe('failed');
    const batchFailed = auditSink.signals.filter((s) => s.type === 'batch_failed');
    expect(batchFailed).toHaveLength(1);
    if (batchFailed[0].type === 'batch_failed') {
      expect(batchFailed[0].reason).toContain('handler crash');
    }
  });
});

// ---------------------------------------------------------------------------
// Mixed batch: command_with_events no conflict + command_only
// ---------------------------------------------------------------------------

describe('integration: mixed command_only and command_with_events batch', () => {
  it('processes both envelope types in single batch', async () => {
    const depot = createInMemoryDepot();
    const auditSink = createCollectingAuditSink();
    const options = makeOptions({ depot, auditSink });
    const processor = createAggregateRuntimeProcessor(options);

    const result = await processor.processBatch([
      makeCommandEnvelope({ envelopeId: 'e1', commandId: 'c1', aggregateId: 'a1' }),
      makeCommandWithEventsEnvelope({
        envelopeId: 'e2', commandId: 'c2', aggregateId: 'a2',
        // events match handler output → no conflict
        events: [{ type: 'Incremented', payload: { amount: 1 } }],
      }),
    ]);

    expect(result.status).toBe('completed');
    expect(result.processed).toBe(2);
    expect(result.results[0].status).toBe('accepted');
    expect(result.results[1].status).toBe('accepted');
    expect(depot.saved).toHaveLength(2);
    expect(auditSink.signals.filter((s) => s.type === 'accepted')).toHaveLength(2);
  });
});
