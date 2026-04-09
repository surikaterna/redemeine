import { describe, expect, test } from 'bun:test';
import {
  PROJECTION_WORKER_LITE_GUARANTEE,
  createProjectionWorkerLite,
  type ProjectionWorkerLiteDecision,
  type ProjectionWorkerLiteMessage
} from '../src';

function createMessage(eventName: string): ProjectionWorkerLiteMessage {
  return {
    definition: {
      projectionName: 'invoice-summary'
    },
    envelope: {
      projectionName: 'invoice-summary',
      sourceStream: 'invoice',
      sourceId: 'invoice-1',
      eventName,
      payload: { id: eventName }
    }
  };
}

describe('projection-worker-lite', () => {
  test('push exposes explicit best-effort guarantee', async () => {
    const worker = createProjectionWorkerLite(() => ({ status: 'processed' }));

    const result = await worker.push(createMessage('created'));

    expect(result.guarantee).toBe(PROJECTION_WORKER_LITE_GUARANTEE);
    expect(result.decision).toEqual({ status: 'processed' });
  });

  test('pushMany returns per-item decisions in-order', async () => {
    const decisionsByEvent: Record<string, ProjectionWorkerLiteDecision> = {
      created: { status: 'processed' },
      failed: { status: 'dropped', reason: 'temporary-overload' }
    };

    const worker = createProjectionWorkerLite((message) => decisionsByEvent[message.envelope.eventName]);
    const many = await worker.pushMany([
      createMessage('created'),
      createMessage('failed')
    ]);

    expect(many.guarantee).toBe(PROJECTION_WORKER_LITE_GUARANTEE);
    expect(many.items).toHaveLength(2);
    expect(many.items[0].decision).toEqual({ status: 'processed' });
    expect(many.items[1].decision).toEqual({ status: 'dropped', reason: 'temporary-overload' });
  });
});
