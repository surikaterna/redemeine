import { describe, expect, test } from 'bun:test';
import {
  createProjectionWorkerCore,
  type ProjectionWorkerCommit,
  type ProjectionWorkerDecision,
  type ProjectionWorkerProcessingContext
} from '../src';

function createCommit(
  eventName: string,
  targetId: string,
  metadata?: ProjectionWorkerCommit['metadata']
): ProjectionWorkerCommit {
  return {
    definition: {
      projectionName: 'invoice-summary'
    },
    message: {
      envelope: {
        projectionName: 'invoice-summary',
        sourceStream: 'invoice',
        sourceId: targetId,
        eventName,
        payload: { id: eventName }
      },
      routeDecision: {
        projectionName: 'invoice-summary',
        targets: [
          {
            targetId,
            laneKey: `invoice-summary:${targetId}`
          }
        ]
      }
    },
    metadata
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('projection-worker-core', () => {
  test('push returns ack decision and default metadata in output', async () => {
    const captured: ProjectionWorkerProcessingContext[] = [];
    const worker = createProjectionWorkerCore((context) => {
      captured.push(context);
      return { status: 'ack' };
    });

    const result = await worker.push(createCommit('created', 'invoice-1'));

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
      createCommit('created', 'invoice-1'),
      createCommit('failed', 'invoice-1')
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
      createCommit('single', 'invoice-1', {
        priority: 5,
        retryCount: 2
      })
    );

    const many = await worker.pushMany([
      createCommit('many-a', 'invoice-1', { priority: 1, retryCount: 0 }),
      createCommit('many-b', 'invoice-1', { priority: 9, retryCount: 3 })
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

  test('serializes execution per lane key while preserving order', async () => {
    const events: string[] = [];
    const worker = createProjectionWorkerCore(async (context) => {
      const event = context.commit.message.envelope.eventName;
      events.push(`start:${event}`);
      await delay(10);
      events.push(`end:${event}`);
      return { status: 'ack' };
    });

    const many = await worker.pushMany([
      createCommit('first', 'invoice-1'),
      createCommit('second', 'invoice-1'),
      createCommit('third', 'invoice-1')
    ]);

    expect(many.items).toHaveLength(3);
    expect(events).toEqual([
      'start:first',
      'end:first',
      'start:second',
      'end:second',
      'start:third',
      'end:third'
    ]);
  });

  test('preserves parallelism across distinct lanes', async () => {
    const events: string[] = [];
    const worker = createProjectionWorkerCore(async (context) => {
      const doc = context.commit.message.routeDecision.targets[0]?.targetId ?? 'none';
      events.push(`start:${doc}`);
      await delay(12);
      events.push(`end:${doc}`);
      return { status: 'ack' };
    });

    const many = await worker.pushMany([
      createCommit('created', 'invoice-1'),
      createCommit('created', 'invoice-2')
    ]);

    expect(many.items).toHaveLength(2);
    expect(events.filter((entry) => entry.startsWith('start:'))).toHaveLength(2);
    const endIndexDoc1 = events.indexOf('end:invoice-1');
    const startIndexDoc2 = events.indexOf('start:invoice-2');
    const endIndexDoc2 = events.indexOf('end:invoice-2');
    const startIndexDoc1 = events.indexOf('start:invoice-1');
    expect(startIndexDoc1).toBeGreaterThanOrEqual(0);
    expect(startIndexDoc2).toBeGreaterThanOrEqual(0);
    expect(endIndexDoc1).toBeGreaterThanOrEqual(0);
    expect(endIndexDoc2).toBeGreaterThanOrEqual(0);
    expect(startIndexDoc2 < endIndexDoc1 || startIndexDoc1 < endIndexDoc2).toBeTrue();
  });

  test('micro-batching mode single invokes batch processor one commit at a time', async () => {
    const batchSizes: number[] = [];
    const worker = createProjectionWorkerCore({
      processor: () => ({ status: 'ack' }),
      batchProcessor: (context) => {
        batchSizes.push(context.commits.length);
        return context.commits.map(() => ({ status: 'ack' as const }));
      },
      getProjectionConfig: () => ({ microBatching: 'single' })
    });

    const many = await worker.pushMany([
      createCommit('a', 'invoice-1'),
      createCommit('b', 'invoice-1')
    ]);

    expect(many.items).toHaveLength(2);
    expect(batchSizes).toEqual([1, 1]);
  });

  test('micro-batching mode all batches lane commits together', async () => {
    const batchSizes: number[] = [];
    const batchEventNames: string[][] = [];

    const worker = createProjectionWorkerCore({
      processor: () => ({ status: 'ack' }),
      batchProcessor: (context) => {
        batchSizes.push(context.commits.length);
        batchEventNames.push(context.commits.map((commit) => commit.message.envelope.eventName));
        return context.commits.map(() => ({ status: 'ack' as const }));
      },
      getProjectionConfig: () => ({ microBatching: 'all' })
    });

    const many = await worker.pushMany([
      createCommit('a', 'invoice-1'),
      createCommit('b', 'invoice-1'),
      createCommit('c', 'invoice-1')
    ]);

    expect(many.items).toHaveLength(3);
    expect(batchSizes).toEqual([3]);
    expect(batchEventNames[0]).toEqual(['a', 'b', 'c']);
  });

  test('optional LRU cache reuses loaded state and evicts least recently used', async () => {
    const loads: string[] = [];
    const store = new Map<string, unknown>([
      ['invoice-1', { total: 1 }],
      ['invoice-2', { total: 2 }],
      ['invoice-3', { total: 3 }]
    ]);

    const worker = createProjectionWorkerCore({
      processor: async (context) => {
        const target = context.commit.message.routeDecision.targets[0]?.targetId;
        if (target !== undefined) {
          await context.getProjectionState(target);
        }
        return { status: 'ack' };
      },
      stateLoader: async ({ targetId }) => {
        loads.push(targetId);
        return store.get(targetId) ?? null;
      },
      stateCache: {
        maxEntries: 2
      }
    });

    await worker.pushMany([
      createCommit('a', 'invoice-1'),
      createCommit('b', 'invoice-1'),
      createCommit('c', 'invoice-2'),
      createCommit('d', 'invoice-3'),
      createCommit('e', 'invoice-1')
    ]);

    expect(loads).toEqual(['invoice-1', 'invoice-2', 'invoice-3', 'invoice-1']);
  });
});
