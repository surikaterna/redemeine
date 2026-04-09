import { describe, expect, test } from 'bun:test';
import type { Checkpoint, EventBatch, ProjectionEvent } from '@redemeine/projection-runtime-core';
import {
  createProjectionWorkerCore,
  createProjectionWorkerReplayPollingAdapter,
  type ProjectionWorkerCommit,
  type ProjectionWorkerDecision
} from '../src';

function createEvent(sequence: number, type = 'created'): ProjectionEvent {
  return {
    aggregateType: 'invoice',
    aggregateId: `invoice-${sequence}`,
    type,
    payload: { sequence },
    sequence,
    timestamp: `2026-04-09T18:00:${String(sequence).padStart(2, '0')}.000Z`
  };
}

function toCommit(event: ProjectionEvent): ProjectionWorkerCommit {
  return {
    definition: {
      projectionName: 'invoice-summary'
    },
    message: {
      envelope: {
        projectionName: 'invoice-summary',
        sourceStream: event.aggregateType,
        sourceId: event.aggregateId,
        eventName: event.type,
        payload: event.payload
      },
      routeDecision: {
        projectionName: 'invoice-summary',
        targets: [
          {
            targetId: event.aggregateId,
            laneKey: `invoice-summary:${event.aggregateId}`
          }
        ]
      }
    },
    metadata: {
      priority: 0,
      retryCount: 0
    }
  };
}

describe('projection-worker-core replay polling adapter', () => {
  test('resumes from checkpoint and advances cursor after successful pushMany', async () => {
    const polls: Checkpoint[] = [];
    const polling = {
      async poll(cursor: Checkpoint, batchSize: number): Promise<EventBatch> {
        polls.push(cursor);
        expect(batchSize).toBe(10);
        return {
          events: [createEvent(11), createEvent(12)],
          nextCursor: { sequence: 12, timestamp: '2026-04-09T18:00:12.000Z' }
        };
      }
    };

    const processedSequences: number[] = [];
    const worker = createProjectionWorkerCore((context) => {
      const sequence = Number((context.commit.message.envelope.payload as { sequence: number }).sequence);
      processedSequences.push(sequence);
      return { status: 'ack' };
    });

    const adapter = createProjectionWorkerReplayPollingAdapter({
      polling,
      worker,
      toCommit,
      initialCursor: { sequence: 10, timestamp: '2026-04-09T18:00:10.000Z' }
    });

    const result = await adapter.pollAndPush(10);

    expect(polls).toEqual([{ sequence: 10, timestamp: '2026-04-09T18:00:10.000Z' }]);
    expect(processedSequences).toEqual([11, 12]);
    expect(result).toMatchObject({
      cursorStart: { sequence: 10, timestamp: '2026-04-09T18:00:10.000Z' },
      cursorEnd: { sequence: 12, timestamp: '2026-04-09T18:00:12.000Z' },
      polledCount: 2,
      pushedCount: 2,
      dedupedCount: 0
    });
    expect(result.nack).toBeUndefined();
    expect(adapter.getCursor()).toEqual({ sequence: 12, timestamp: '2026-04-09T18:00:12.000Z' });
  });

  test('suppresses duplicates across replay overlap and still advances cursor', async () => {
    const events = [createEvent(31), createEvent(31), createEvent(32)];
    const polling = {
      async poll(): Promise<EventBatch> {
        return {
          events,
          nextCursor: { sequence: 32, timestamp: '2026-04-09T18:00:32.000Z' }
        };
      }
    };

    const processedSequences: number[] = [];
    const worker = createProjectionWorkerCore((context) => {
      const sequence = Number((context.commit.message.envelope.payload as { sequence: number }).sequence);
      processedSequences.push(sequence);
      return { status: 'ack' };
    });

    const adapter = createProjectionWorkerReplayPollingAdapter({
      polling,
      worker,
      toCommit
    });

    const result = await adapter.pollAndPush(100);

    expect(processedSequences).toEqual([31, 32]);
    expect(result.polledCount).toBe(3);
    expect(result.pushedCount).toBe(2);
    expect(result.dedupedCount).toBe(1);
    expect(result.nack).toBeUndefined();
    expect(adapter.getCursor()).toEqual({ sequence: 32, timestamp: '2026-04-09T18:00:32.000Z' });
  });

  test('does not advance cursor when worker returns nack', async () => {
    const polledEvents = [createEvent(41), createEvent(42, 'failed')];
    const polling = {
      async poll(): Promise<EventBatch> {
        return {
          events: polledEvents,
          nextCursor: { sequence: 42, timestamp: '2026-04-09T18:00:42.000Z' }
        };
      }
    };

    const decisionsByType: Record<string, ProjectionWorkerDecision> = {
      created: { status: 'ack' },
      failed: { status: 'nack', retryable: true, reason: 'transient-failure' }
    };

    const worker = createProjectionWorkerCore((context) => {
      return decisionsByType[context.commit.message.envelope.eventName];
    });

    const adapter = createProjectionWorkerReplayPollingAdapter({
      polling,
      worker,
      toCommit,
      initialCursor: { sequence: 40 }
    });

    const result = await adapter.pollAndPush(10);

    expect(result.cursorStart).toEqual({ sequence: 40 });
    expect(result.cursorEnd).toEqual({ sequence: 40 });
    expect(result.nack).toBeDefined();
    expect(result.nack?.event.sequence).toBe(42);
    expect(result.nack?.decision).toEqual({ status: 'nack', retryable: true, reason: 'transient-failure' });
    expect(adapter.getCursor()).toEqual({ sequence: 40 });
  });

  test('suppresses already-acked duplicates across nack retry window', async () => {
    const firstPassEvents = [createEvent(51), createEvent(52, 'failed')];
    const secondPassEvents = [createEvent(51), createEvent(52, 'failed')];
    let pollCount = 0;
    const polling = {
      async poll(): Promise<EventBatch> {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            events: firstPassEvents,
            nextCursor: { sequence: 52, timestamp: '2026-04-09T18:00:52.000Z' }
          };
        }

        return {
          events: secondPassEvents,
          nextCursor: { sequence: 52, timestamp: '2026-04-09T18:00:52.000Z' }
        };
      }
    };

    const pushedSequences: number[] = [];
    let failedAttempts = 0;
    const worker = createProjectionWorkerCore((context) => {
      const sequence = Number((context.commit.message.envelope.payload as { sequence: number }).sequence);
      pushedSequences.push(sequence);

      if (sequence === 52 && failedAttempts === 0) {
        failedAttempts += 1;
        return { status: 'nack', retryable: true, reason: 'transient-failure' };
      }

      return { status: 'ack' };
    });

    const adapter = createProjectionWorkerReplayPollingAdapter({
      polling,
      worker,
      toCommit,
      initialCursor: { sequence: 50 }
    });

    const firstResult = await adapter.pollAndPush(10);
    const secondResult = await adapter.pollAndPush(10);

    expect(firstResult.cursorStart).toEqual({ sequence: 50 });
    expect(firstResult.cursorEnd).toEqual({ sequence: 50 });
    expect(firstResult.pushedCount).toBe(2);
    expect(firstResult.dedupedCount).toBe(0);
    expect(firstResult.nack?.event.sequence).toBe(52);

    expect(secondResult.cursorStart).toEqual({ sequence: 50 });
    expect(secondResult.cursorEnd).toEqual({ sequence: 52, timestamp: '2026-04-09T18:00:52.000Z' });
    expect(secondResult.polledCount).toBe(2);
    expect(secondResult.pushedCount).toBe(1);
    expect(secondResult.dedupedCount).toBe(1);
    expect(secondResult.nack).toBeUndefined();

    expect(pushedSequences).toEqual([51, 52, 52]);
    expect(adapter.getCursor()).toEqual({ sequence: 52, timestamp: '2026-04-09T18:00:52.000Z' });
  });
});
