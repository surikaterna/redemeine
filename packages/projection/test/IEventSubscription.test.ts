import { describe, it, expect } from '@jest/globals';
import type { IEventSubscription } from '../src';
import type { Checkpoint, EventBatch, ProjectionEvent } from '../src/types';

/**
 * Mock implementation of IEventSubscription for testing.
 * Used to verify interface contract compliance.
 */
class MockEventSubscription implements IEventSubscription {
  private events: ProjectionEvent[] = [];
  constructor(events: ProjectionEvent[] = []) {
    this.events = events;
  }

  async poll(fromCursor: Checkpoint, batchSize: number): Promise<EventBatch> {
    // Filter events after the cursor
    const filteredEvents = this.events.filter(e => e.sequence > fromCursor.sequence);
    
    // Take up to batchSize events
    const batchEvents = filteredEvents.slice(0, batchSize);
    
    // Calculate next cursor
    const lastEvent = batchEvents[batchEvents.length - 1];
    const nextCursor: Checkpoint = lastEvent 
      ? { sequence: lastEvent.sequence, timestamp: lastEvent.timestamp }
      : fromCursor;
    
    return {
      events: batchEvents,
      nextCursor
    };
  }

}

/**
 * Tests that verify IEventSubscription interface contract.
 * These tests ensure any implementation adheres to the expected behavior.
 */
describe('IEventSubscription interface contract', () => {
  describe('poll()', () => {
    it('should return empty batch when no events exist', async () => {
      const subscription = new MockEventSubscription();
      const cursor: Checkpoint = { sequence: 0 };
      
      const result = await subscription.poll(cursor, 10);
      
      expect(result.events).toHaveLength(0);
      expect(result.nextCursor).toEqual(cursor);
    });

    it('should return events after the given cursor', async () => {
      const events: ProjectionEvent[] = [
        { aggregateType: 'order', aggregateId: 'o1', type: 'order.placed.event', payload: {}, sequence: 1, timestamp: '2024-01-01T00:00:00Z' },
        { aggregateType: 'order', aggregateId: 'o1', type: 'order.fulfilled.event', payload: {}, sequence: 2, timestamp: '2024-01-01T00:00:01Z' },
        { aggregateType: 'order', aggregateId: 'o1', type: 'order.shipped.event', payload: {}, sequence: 3, timestamp: '2024-01-01T00:00:02Z' },
      ];
      const subscription = new MockEventSubscription(events);
      const cursor: Checkpoint = { sequence: 1 };
      
      const result = await subscription.poll(cursor, 10);
      
      expect(result.events).toHaveLength(2);
      expect(result.events[0].sequence).toBe(2);
      expect(result.events[1].sequence).toBe(3);
    });

    it('should respect batch size limit', async () => {
      const events: ProjectionEvent[] = Array.from({ length: 5 }, (_, i) => ({
        aggregateType: 'order',
        aggregateId: 'o1',
        type: 'order.event',
        payload: {},
        sequence: i + 1,
        timestamp: new Date(i * 1000).toISOString(),
      }));
      const subscription = new MockEventSubscription(events);
      const cursor: Checkpoint = { sequence: 0 };
      
      const result = await subscription.poll(cursor, 2);
      
      expect(result.events).toHaveLength(2);
    });

    it('should return all remaining events when batch size is large', async () => {
      const events: ProjectionEvent[] = Array.from({ length: 3 }, (_, i) => ({
        aggregateType: 'order',
        aggregateId: 'o1',
        type: 'order.event',
        payload: {},
        sequence: i + 1,
        timestamp: new Date(i * 1000).toISOString(),
      }));
      const subscription = new MockEventSubscription(events);
      const cursor: Checkpoint = { sequence: 0 };
      
      const result = await subscription.poll(cursor, 10);
      
      expect(result.events).toHaveLength(3);
    });

    it('should update nextCursor to last event in batch', async () => {
      const events: ProjectionEvent[] = Array.from({ length: 3 }, (_, i) => ({
        aggregateType: 'order',
        aggregateId: 'o1',
        type: 'order.event',
        payload: {},
        sequence: i + 1,
        timestamp: new Date(i * 1000).toISOString(),
      }));
      const subscription = new MockEventSubscription(events);
      const cursor: Checkpoint = { sequence: 0 };
      
      const result = await subscription.poll(cursor, 2);
      
      expect(result.nextCursor.sequence).toBe(2);
      expect(result.nextCursor.timestamp).toBeDefined();
    });
  });

  describe('interface typing', () => {
    it('should accept valid implementation', () => {
      // This test verifies TypeScript accepts a valid implementation
      const validImplementation: IEventSubscription = new MockEventSubscription();
      expect(validImplementation).toBeDefined();
    });

    it('should require poll method', () => {
      // TypeScript would error if poll was not implemented
      const subscription = {
        async poll(_fromCursor: Checkpoint, _batchSize: number) {
          return { events: [], nextCursor: { sequence: 0 } };
        },
      };
      
      const typedSubscription: IEventSubscription = subscription;
      expect(typedSubscription).toBeDefined();
    });
  });
});
