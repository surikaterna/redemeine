import { describe, expect, test } from '@jest/globals';
import type { Checkpoint, EventBatch, ProjectionEvent } from '../../src/projections/types';

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
    const batch: EventBatch<{ id: string; value: number }> = {
      events: [{ id: 'e1', value: 1 }, { id: 'e2', value: 2 }],
      nextCursor: { sequence: 50 },
      hasMore: true
    };

    expect(batch.events).toHaveLength(2);
    expect(batch.nextCursor.sequence).toBe(50);
    expect(batch.hasMore).toBe(true);
  });

  test('accepts empty batch', () => {
    const batch: EventBatch<string> = {
      events: [],
      nextCursor: { sequence: 0 },
      hasMore: false
    };

    expect(batch.events).toHaveLength(0);
    expect(batch.hasMore).toBe(false);
  });

  test('supports generic event types', () => {
    type CustomEvent = { type: string; data: unknown };
    const batch: EventBatch<CustomEvent> = {
      events: [{ type: 'test', data: { foo: 'bar' } }],
      nextCursor: { sequence: 1 },
      hasMore: false
    };

    expect(batch.events[0].type).toBe('test');
  });
});

describe('ProjectionEvent', () => {
  test('accepts valid projection event', () => {
    const event: ProjectionEvent<{ amount: number; currency: string }, 'invoice.created.event'> = {
      id: 'evt-123',
      aggregateType: 'invoice',
      aggregateId: 'inv-456',
      type: 'invoice.created.event',
      payload: { amount: 100, currency: 'USD' },
      sequence: 1,
      timestamp: '2024-01-15T10:30:00.000Z'
    };

    expect(event.id).toBe('evt-123');
    expect(event.aggregateType).toBe('invoice');
    expect(event.aggregateId).toBe('inv-456');
    expect(event.type).toBe('invoice.created.event');
    expect(event.payload.amount).toBe(100);
    expect(event.sequence).toBe(1);
  });

  test('accepts projection event with optional metadata', () => {
    const event: ProjectionEvent<void, 'order.placed.event'> = {
      id: 'evt-789',
      aggregateType: 'order',
      aggregateId: 'ord-001',
      type: 'order.placed.event',
      payload: undefined,
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
    const event: ProjectionEvent<{ status: string }> = {
      id: 'evt-abc',
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
