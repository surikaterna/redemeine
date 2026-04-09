import { describe, expect, test } from 'bun:test';
import {
  createProjectionWorkerCore,
  type ProjectionWorkerCommit,
  type ProjectionWorkerDecision,
  type ProjectionWorkerProcessingContext
} from '../src';

function createCommit(eventName: string, metadata?: ProjectionWorkerCommit['metadata']): ProjectionWorkerCommit {
  return {
    definition: {
      projectionName: 'invoice-summary'
    },
    message: {
      envelope: {
        projectionName: 'invoice-summary',
        sourceStream: 'invoice',
        sourceId: 'invoice-1',
        eventName,
        payload: { id: eventName }
      },
      routeDecision: {
        projectionName: 'invoice-summary',
        targets: [
          {
            targetId: 'invoice-1',
            laneKey: 'invoice-summary:invoice-1'
          }
        ]
      }
    },
    metadata
  };
}

describe('projection-worker-core', () => {
  test('push returns ack decision and default metadata in output', async () => {
    const captured: ProjectionWorkerProcessingContext[] = [];
    const worker = createProjectionWorkerCore((context) => {
      captured.push(context);
      return { status: 'ack' };
    });

    const result = await worker.push(createCommit('created'));

    expect(result.item.decision).toEqual({ status: 'ack' });
    expect(result.item.metadata).toEqual({ priority: 0, retryCount: 0 });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.metadata).toEqual({ priority: 0, retryCount: 0 });
  });

  test('pushMany returns per-item mixed ack/nack decisions in-order', async () => {
    const decisionsByEvent: Record<string, ProjectionWorkerDecision> = {
      created: { status: 'ack' },
      failed: { status: 'nack', retryable: true, reason: 'transient-store-failure' }
    };

    const worker = createProjectionWorkerCore((context) =>
      decisionsByEvent[context.commit.message.envelope.eventName]
    );

    const many = await worker.pushMany([
      createCommit('created'),
      createCommit('failed')
    ]);

    expect(many.items).toHaveLength(2);
    expect(many.items[0]?.decision).toEqual({ status: 'ack' });
    expect(many.items[1]?.decision).toEqual({
      status: 'nack',
      retryable: true,
      reason: 'transient-store-failure'
    });
  });

  test('push and pushMany pass transport metadata into context and output', async () => {
    const seenMetadata: Array<{ priority: number; retryCount: number }> = [];
    const worker = createProjectionWorkerCore((context) => {
      seenMetadata.push(context.metadata);
      return { status: 'ack' };
    });

    const single = await worker.push(
      createCommit('single', {
        priority: 5,
        retryCount: 2
      })
    );

    const many = await worker.pushMany([
      createCommit('many-a', { priority: 1, retryCount: 0 }),
      createCommit('many-b', { priority: 9, retryCount: 3 })
    ]);

    expect(single.item.metadata).toEqual({ priority: 5, retryCount: 2 });
    expect(many.items[0]?.metadata).toEqual({ priority: 1, retryCount: 0 });
    expect(many.items[1]?.metadata).toEqual({ priority: 9, retryCount: 3 });
    expect(seenMetadata).toEqual([
      { priority: 5, retryCount: 2 },
      { priority: 1, retryCount: 0 },
      { priority: 9, retryCount: 3 }
    ]);
  });
});
