import { describe, expect, test } from 'bun:test';
import type {
  ProjectionIngress,
  ProjectionIngressAckDecision,
  ProjectionIngressDecision,
  ProjectionIngressEnvelope,
  ProjectionIngressNackDecision,
  ProjectionIngressPushManyResult,
  ProjectionIngressPushResult,
  ProjectionStoreAtomicManyContract,
  ProjectionStoreAtomicManyResult,
  ProjectionStoreCommitAtomicManyRequest,
  ProjectionStoreContract,
  ProjectionStoreDocumentWrite,
  ProjectionStoreDurableDedupeContract,
  ProjectionRouterFanoutEnvelope,
  ProjectionStoreWriteWatermark
} from '../src';

function createAckDecision(): ProjectionIngressAckDecision {
  return {
    status: 'ack',
    lifecycle: [
      { stage: 'received' },
      { stage: 'published_durable' },
      { stage: 'ackable' }
    ]
  };
}

function createNackDecision(
  cause: ProjectionIngressNackDecision['cause'],
  retryable: boolean,
  reason: string
): ProjectionIngressNackDecision {
  return {
    status: 'nack',
    retryable,
    reason,
    cause,
    lifecycle: [
      { stage: 'received' },
      { stage: 'published_durable' },
      { stage: 'nack', cause }
    ]
  };
}

function isAck(decision: ProjectionIngressDecision): boolean {
  return decision.status === 'ack';
}

describe('projection-runtime-core contract types', () => {
  test('push and pushMany contracts return per-item decisions', async () => {
    const ingress: ProjectionIngress = {
      async push(envelope: ProjectionIngressEnvelope): Promise<ProjectionIngressPushResult> {
        return {
          item: {
            messageId: envelope.metadata.messageId,
            decision: createAckDecision()
          }
        };
      },
      async pushMany(envelopes: readonly ProjectionIngressEnvelope[]): Promise<ProjectionIngressPushManyResult> {
        return {
          items: envelopes.map((envelope) => ({
            messageId: envelope.metadata.messageId,
            decision: envelope.metadata.retryCount > 0
              ? createNackDecision('failure', true, 'retry-once')
              : createAckDecision()
          }))
        };
      }
    };

    const envelope: ProjectionIngressEnvelope = {
      event: {
        aggregateType: 'invoice',
        aggregateId: 'invoice-1',
        type: 'created',
        payload: { amount: 42 },
        sequence: 10,
        timestamp: '2026-04-09T18:00:00.000Z'
      },
      metadata: {
        messageId: 'msg-1',
        priority: 'high',
        retryCount: 0,
        resume: { token: 'r-1' }
      }
    };

    const single = await ingress.push(envelope);
    expect(single.item.messageId).toBe('msg-1');
    expect(isAck(single.item.decision)).toBe(true);

    const many = await ingress.pushMany([
      envelope,
      {
        ...envelope,
        metadata: {
          ...envelope.metadata,
          messageId: 'msg-2',
          retryCount: 1
        }
      }
    ]);

    expect(many.items).toHaveLength(2);
    expect(many.items[0].decision.status).toBe('ack');
    expect(many.items[1].decision).toEqual({
      status: 'nack',
      retryable: true,
      reason: 'retry-once',
      cause: 'failure',
      lifecycle: [
        { stage: 'received' },
        { stage: 'published_durable' },
        { stage: 'nack', cause: 'failure' }
      ]
    });

    if (many.items[0].decision.status === 'ack') {
      expect(many.items[0].decision.lifecycle).toEqual([
        { stage: 'received' },
        { stage: 'published_durable' },
        { stage: 'ackable' }
      ]);
    }
  });

  test('router fanout and atomicMany contracts include locked fields', () => {
    const fanout: ProjectionRouterFanoutEnvelope = {
      routingKey: {
        projectionName: 'invoice-summary',
        targetDocId: 'doc-1'
      },
      routingKeySource: 'invoice-summary:doc-1',
      envelope: {
        event: {
          aggregateType: 'invoice',
          aggregateId: 'invoice-1',
          type: 'created',
          payload: {},
          sequence: 11,
          timestamp: '2026-04-09T18:00:01.000Z'
        },
        metadata: {
          messageId: 'msg-3',
          priority: 'normal',
          retryCount: 0
        }
      }
    };

    const atomic: ProjectionStoreAtomicManyResult = {
      status: 'committed',
      highestWatermark: { sequence: 11, timestamp: '2026-04-09T18:00:01.000Z' },
      byLaneWatermark: {
        'invoice-summary:doc-1': { sequence: 11 }
      },
      committedCount: 1
    };

    const writeWatermark: ProjectionStoreWriteWatermark = {
      checkpoint: { sequence: 11 }
    };

    expect(fanout.routingKeySource).toBe('invoice-summary:doc-1');
    expect(atomic.status).toBe('committed');
    expect(atomic.highestWatermark.sequence).toBe(11);
    expect(atomic.byLaneWatermark?.['invoice-summary:doc-1']?.sequence).toBe(11);
    expect(writeWatermark.checkpoint.sequence).toBe(11);
  });

  test('store document write contract discriminates full and patch writes', () => {
    const fullWrite: ProjectionStoreDocumentWrite<{ total: number }> = {
      documentId: 'doc-1',
      mode: 'full',
      fullDocument: { total: 11 },
      checkpoint: { sequence: 11 }
    };

    const patchWrite: ProjectionStoreDocumentWrite = {
      documentId: 'doc-1',
      mode: 'patch',
      patch: { total: 12 },
      checkpoint: { sequence: 12 }
    };

    expect(fullWrite.mode).toBe('full');
    if (fullWrite.mode === 'full') {
      expect(fullWrite.fullDocument.total).toBe(11);
    }

    expect(patchWrite.mode).toBe('patch');
    if (patchWrite.mode === 'patch') {
      expect(patchWrite.patch.total).toBe(12);
    }
  });

  test('store atomicMany contract exposes highest watermark and durable dedupe semantics', async () => {
    const dedupeStore: ProjectionStoreDurableDedupeContract = {
      async getDedupeCheckpoint(key) {
        return key === 'invoice:1:created:11' ? { sequence: 11 } : null;
      }
    };

    const atomicManyOnly: ProjectionStoreAtomicManyContract = {
      async commitAtomicMany(request: ProjectionStoreCommitAtomicManyRequest): Promise<ProjectionStoreAtomicManyResult> {
        if (request.writes.length === 0) {
          return {
            status: 'rejected',
            highestWatermark: null,
            failedAtIndex: 0,
            reason: 'no writes',
            committedCount: 0
          };
        }

        return {
          status: 'committed',
          highestWatermark: { sequence: 21 },
          byLaneWatermark: {
            [request.writes[0]?.routingKeySource ?? 'unknown:unknown']: { sequence: 21 }
          },
          committedCount: request.writes.length
        };
      }
    };

    const store: ProjectionStoreContract = {
      ...atomicManyOnly,
      ...dedupeStore
    };

    const rejected = await store.commitAtomicMany({ mode: 'atomic-all', writes: [] });
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') {
      expect(rejected.highestWatermark).toBeNull();
      expect(rejected.committedCount).toBe(0);
      expect(rejected.failedAtIndex).toBe(0);
    }

    const committed = await store.commitAtomicMany({
      mode: 'atomic-all',
      writes: [
        {
          routingKeySource: 'invoice-summary:doc-1',
          documents: [
            {
              documentId: 'doc-1',
              mode: 'patch',
              patch: { total: 21 },
              checkpoint: { sequence: 21 }
            }
          ],
          dedupe: {
            upserts: [{ key: 'invoice:1:created:21', checkpoint: { sequence: 21 } }]
          }
        }
      ]
    });

    expect(committed.status).toBe('committed');
    if (committed.status === 'committed') {
      expect(committed.highestWatermark.sequence).toBe(21);
      expect(committed.committedCount).toBe(1);
      expect(committed.byLaneWatermark?.['invoice-summary:doc-1']?.sequence).toBe(21);
    }

    const dedupeCheckpoint = await store.getDedupeCheckpoint('invoice:1:created:11');
    expect(dedupeCheckpoint?.sequence).toBe(11);
  });
});
