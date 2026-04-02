import { describe, expect, test } from '@jest/globals';
import type { Checkpoint, EventBatch, ProjectionEvent } from '../src/types';

/**
 * Type-level tests verify TypeScript compiles correctly.
 * Runtime tests ensure structure expectations match implementation.
 */
describe('Checkpoint', () => {
  test('accepts valid checkpoint with sequence only', () => {
    const checkpoint: Checkpoint = { sequence: 42 };
    expect(checkpoint.sequence).toBe(42);
    expect(checkpoint.timestamp).toBeUndefined();
  });

  test('accepts valid checkpoint with sequence and timestamp', () => {
    const checkpoint: Checkpoint = {
      sequence: 100,
      timestamp: '2024-01-15T10:30:00.000Z'
    };
    expect(checkpoint.sequence).toBe(100);
    expect(checkpoint.timestamp).toBe('2024-01-15T10:30:00.000Z');
  });
});

describe('EventBatch', () => {
  test('accepts batch with events and cursor', () => {
    const batch: EventBatch = {
      events: [{ aggregateType: 'a', aggregateId: '1', type: 't', payload: {}, sequence: 1, timestamp: '2024-01-01T00:00:00Z' }],
      nextCursor: { sequence: 50 }
    };

    expect(batch.events).toHaveLength(1);
    expect(batch.nextCursor.sequence).toBe(50);
  });

  test('accepts empty batch', () => {
    const batch: EventBatch = {
      events: [],
      nextCursor: { sequence: 0 }
    };

    expect(batch.events).toHaveLength(0);
  });

  test('supports generic event types', () => {
    const batch: EventBatch = {
      events: [{ aggregateType: 'task', aggregateId: 'task-1', type: 'test', payload: { foo: 'bar' }, sequence: 1, timestamp: '2024-01-01T00:00:00Z' }],
      nextCursor: { sequence: 1 }
    };

    expect(batch.events[0].type).toBe('test');
  });
});

describe('ProjectionEvent', () => {
  test('accepts valid projection event', () => {
    const event: ProjectionEvent = {
      aggregateType: 'invoice',
      aggregateId: 'inv-456',
      type: 'invoice.created.event',
      payload: { amount: 100, currency: 'USD' },
      sequence: 1,
      timestamp: '2024-01-15T10:30:00.000Z'
    };

    expect(event.aggregateType).toBe('invoice');
    expect(event.aggregateId).toBe('inv-456');
    expect(event.type).toBe('invoice.created.event');
    expect(event.payload.amount).toBe(100);
    expect(event.sequence).toBe(1);
  });

  test('accepts projection event with optional metadata', () => {
    const event: ProjectionEvent = {
      aggregateType: 'order',
      aggregateId: 'ord-001',
      type: 'order.placed.event',
      payload: {},
      sequence: 5,
      timestamp: '2024-01-16T14:00:00.000Z',
      metadata: {
        correlationId: 'corr-123',
        causationId: 'cmd-456'
      }
    };

    expect(event.metadata?.correlationId).toBe('corr-123');
    expect(event.metadata?.causationId).toBe('cmd-456');
  });

  test('supports flexible type parameter for event naming', () => {
    const event: ProjectionEvent = {
      aggregateType: 'task',
      aggregateId: 'task-1',
      type: 'task.completed', // custom type without .event suffix
      payload: { status: 'completed' },
      sequence: 10,
      timestamp: '2024-01-17T08:00:00.000Z'
    };

    expect(event.type).toBe('task.completed');
  });
});
