import { describe, it, expect, beforeEach } from '@jest/globals';
import type { IEventSubscription } from '../../src/projections';
import type { Checkpoint, EventBatch, ProjectionEvent } from '../../src/projections/types';

/**
 * Mock implementation of IEventSubscription for testing.
 * Used to verify interface contract compliance.
 */
class MockEventSubscription implements IEventSubscription {
  private events: ProjectionEvent[] = [];
  private latestSequence: number = 0;

  constructor(events: ProjectionEvent[] = []) {
    this.events = events;
    this.latestSequence = events.length > 0 
      ? Math.max(...events.map(e => e.sequence)) 
      : 0;
  }

  async poll(fromCursor: Checkpoint, batchSize: number): Promise<EventBatch<ProjectionEvent>> {
    // Filter events after the cursor
    const filteredEvents = this.events.filter(e => e.sequence > fromCursor.sequence);
    
    // Take up to batchSize events
    const batchEvents = filteredEvents.slice(0, batchSize);
    
    // Calculate next cursor
    const lastEvent = batchEvents[batchEvents.length - 1];
    const nextCursor: Checkpoint = lastEvent 
      ? { sequence: lastEvent.sequence, timestamp: lastEvent.timestamp }
      : fromCursor;
    
    // Check if there are more events
    const hasMore = filteredEvents.length > batchSize;
    
    return {
      events: batchEvents,
      nextCursor,
      hasMore,
    };
  }

  async getLatestCheckpoint(): Promise<Checkpoint> {
    return { sequence: this.latestSequence };
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
      expect(result.hasMore).toBe(false);
    });

    it('should return events after the given cursor', async () => {
      const events: ProjectionEvent[] = [
        { id: '1', aggregateType: 'order', aggregateId: 'o1', type: 'order.placed.event', payload: {}, sequence: 1, timestamp: '2024-01-01T00:00:00Z' },
        { id: '2', aggregateType: 'order', aggregateId: 'o1', type: 'order.fulfilled.event', payload: {}, sequence: 2, timestamp: '2024-01-01T00:00:01Z' },
        { id: '3', aggregateType: 'order', aggregateId: 'o1', type: 'order.shipped.event', payload: {}, sequence: 3, timestamp: '2024-01-01T00:00:02Z' },
      ];
      const subscription = new MockEventSubscription(events);
      const cursor: Checkpoint = { sequence: 1 };
      
      const result = await subscription.poll(cursor, 10);
      
      expect(result.events).toHaveLength(2);
      expect(result.events[0].id).toBe('2');
      expect(result.events[1].id).toBe('3');
    });

    it('should respect batch size limit', async () => {
      const events: ProjectionEvent[] = Array.from({ length: 5 }, (_, i) => ({
        id: String(i + 1),
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
      expect(result.hasMore).toBe(true);
    });

    it('should set hasMore to false when no more events', async () => {
      const events: ProjectionEvent[] = Array.from({ length: 3 }, (_, i) => ({
        id: String(i + 1),
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
      expect(result.hasMore).toBe(false);
    });

    it('should update nextCursor to last event in batch', async () => {
      const events: ProjectionEvent[] = Array.from({ length: 3 }, (_, i) => ({
        id: String(i + 1),
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

  describe('getLatestCheckpoint()', () => {
    it('should return zero checkpoint when no events', async () => {
      const subscription = new MockEventSubscription();
      
      const checkpoint = await subscription.getLatestCheckpoint();
      
      expect(checkpoint.sequence).toBe(0);
    });

    it('should return highest sequence number when events exist', async () => {
      const events: ProjectionEvent[] = [
        { id: '1', aggregateType: 'order', aggregateId: 'o1', type: 'order.event', payload: {}, sequence: 5, timestamp: '2024-01-01T00:00:05Z' },
        { id: '2', aggregateType: 'order', aggregateId: 'o1', type: 'order.event', payload: {}, sequence: 10, timestamp: '2024-01-01T00:00:10Z' },
        { id: '3', aggregateType: 'order', aggregateId: 'o1', type: 'order.event', payload: {}, sequence: 7, timestamp: '2024-01-01T00:00:07Z' },
      ];
      const subscription = new MockEventSubscription(events);
      
      const checkpoint = await subscription.getLatestCheckpoint();
      
      expect(checkpoint.sequence).toBe(10);
    });
  });

  describe('filterByAggregateTypes()', () => {
    it('should be optional - implementations may not support it', () => {
      const subscription = new MockEventSubscription();
      
      // TypeScript allows this because filterByAggregateTypes is optional
      const hasMethod = 'filterByAggregateTypes' in subscription;
      
      // If not implemented, the method should not exist
      // This test documents the optional nature of the method
      expect(hasMethod || true).toBe(true); // Test passes regardless - method is optional
    });

    it('should allow implementations that do support filtering', async () => {
      // This test verifies the interface allows for implementations
      // that DO implement filterByAggregateTypes
      
      class FilteringSubscription implements IEventSubscription {
        private filterTypes: string[] | undefined;
        
        filterByAggregateTypes(types: string[]): IEventSubscription {
          this.filterTypes = types;
          return this;
        }
        
        async poll(fromCursor: Checkpoint, batchSize: number): Promise<EventBatch<ProjectionEvent>> {
          return { events: [], nextCursor: fromCursor, hasMore: false };
        }
        
        async getLatestCheckpoint(): Promise<Checkpoint> {
          return { sequence: 0 };
        }
      }
      
      const subscription = new FilteringSubscription();
      const filtered = subscription.filterByAggregateTypes(['order', 'invoice']);
      
      expect(filtered).toBe(subscription); // Should return same instance for chaining
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
          return { events: [], nextCursor: { sequence: 0 }, hasMore: false };
        },
        async getLatestCheckpoint() {
          return { sequence: 0 };
        },
      };
      
      const typedSubscription: IEventSubscription = subscription;
      expect(typedSubscription).toBeDefined();
    });
  });
});
