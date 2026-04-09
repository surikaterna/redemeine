import { describe, expect, test } from 'bun:test';
import type {
  ProjectionIngress,
  ProjectionIngressDecision,
  ProjectionIngressEnvelope,
  ProjectionIngressPushManyResult,
  ProjectionIngressPushResult,
  ProjectionRouterFanoutEnvelope,
  ProjectionStoreAtomicManyResult
} from '../src';

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
            decision: { status: 'ack' }
          }
        };
      },
      async pushMany(envelopes: readonly ProjectionIngressEnvelope[]): Promise<ProjectionIngressPushManyResult> {
        return {
          items: envelopes.map((envelope) => ({
            messageId: envelope.metadata.messageId,
            decision: envelope.metadata.retryCount > 0
              ? { status: 'nack', retryable: true, reason: 'retry-once' }
              : { status: 'ack' }
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
      reason: 'retry-once'
    });
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
      highestWatermark: { sequence: 11, timestamp: '2026-04-09T18:00:01.000Z' },
      byLaneWatermark: {
        'invoice-summary:doc-1': { sequence: 11 }
      }
    };

    expect(fanout.routingKeySource).toBe('invoice-summary:doc-1');
    expect(atomic.highestWatermark.sequence).toBe(11);
    expect(atomic.byLaneWatermark?.['invoice-summary:doc-1']?.sequence).toBe(11);
  });
});
