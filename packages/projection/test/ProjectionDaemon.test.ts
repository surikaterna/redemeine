import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ProjectionDaemon, ProjectionDaemonOptions, BatchStats } from '../src/ProjectionDaemon';
import { IProjectionStore } from '../src/IProjectionStore';
import { IEventSubscription } from '../src/IEventSubscription';
import { ProjectionDefinition, createProjection } from '../src/createProjection';
import { Checkpoint, EventBatch, ProjectionEvent } from '../src/types';

// Test types
interface TestState {
  count: number;
  name: string;
  events: string[];
}

// Mock event subscription factory
function createMockSubscription(events: ProjectionEvent[]): IEventSubscription {
  return {
    async poll(cursor: Checkpoint, batchSize: number): Promise<EventBatch> {
      const startSeq = cursor.sequence;
      const batchEvents = events
        .filter(e => e.sequence > startSeq)
        .slice(0, batchSize);
      
      const nextSeq = batchEvents.length > 0 
        ? batchEvents[batchEvents.length - 1].sequence 
        : startSeq;
      
      return {
        events: batchEvents,
        nextCursor: { sequence: nextSeq, timestamp: new Date().toISOString() }
      };
    }
  };
}

// Mock projection store factory
function createMockStore(): IProjectionStore<TestState> & {
  states: Map<string, TestState>;
  checkpoints: Map<string, Checkpoint>;
} {
  const states = new Map<string, TestState>();
  const checkpoints = new Map<string, Checkpoint>();
  const links = new Map<string, string>();
  
  return {
    states,
    checkpoints,
    
    async load(documentId: string): Promise<TestState | null> {
      return states.get(documentId) ?? null;
    },
    
    async save(documentId: string, state: TestState, checkpoint: Checkpoint): Promise<void> {
      states.set(documentId, state);
      checkpoints.set(documentId, checkpoint);
    },

    async commitAtomic(write): Promise<void> {
      for (const document of write.documents) {
        states.set(document.documentId, document.state);
        checkpoints.set(document.documentId, document.checkpoint);
      }

      for (const link of write.links) {
        links.set(`${link.aggregateType}:${link.aggregateId}`, link.targetDocId);
      }

      checkpoints.set(write.cursorKey, write.cursor);
      states.set(write.cursorKey, {} as TestState);
    },

    async resolveTarget(aggregateType: string, aggregateId: string): Promise<string | null> {
      return links.get(`${aggregateType}:${aggregateId}`) ?? null;
    },
    
    async getCheckpoint(key: string): Promise<Checkpoint | null> {
      return checkpoints.get(key) ?? null;
    },
    
    async delete(documentId: string): Promise<void> {
      states.delete(documentId);
      checkpoints.delete(documentId);
    }
  };
}

// Simple projection for testing - using new builder API
function createTestProjection(): ProjectionDefinition<TestState> {
  const orderAgg = {
    __aggregateType: 'order',
    initialState: {},
    pure: { eventProjectors: {} }
  };
  
  return createProjection<TestState>('testProjection', (docId) => ({
    count: 0,
    name: '',
    events: []
  }))
    .from(orderAgg, {
      'order.created': (state, event: any) => {
        state.name = event.payload.name || 'unknown';
        state.count = 1;
        state.events.push(event.type);
      },
      'order.updated': (state, event: any) => {
        state.count += event.payload.amount || 1;
        state.events.push(event.type);
      }
    })
    .build();
}

// Create events for testing
function createTestEvents(): ProjectionEvent[] {
  return [
    {
      aggregateType: 'order',
      aggregateId: 'order-1',
      type: 'order.created',
      payload: { name: 'Test Order' },
      sequence: 1,
      timestamp: '2024-01-01T00:00:00Z'
    },
    {
      aggregateType: 'order',
      aggregateId: 'order-1',
      type: 'order.updated',
      payload: { amount: 5 },
      sequence: 2,
      timestamp: '2024-01-01T00:01:00Z'
    },
    {
      aggregateType: 'order',
      aggregateId: 'order-1',
      type: 'order.updated',
      payload: { amount: 3 },
      sequence: 3,
      timestamp: '2024-01-01T00:02:00Z'
    },
    {
      aggregateType: 'order',
      aggregateId: 'order-2',
      type: 'order.created',
      payload: { name: 'Second Order' },
      sequence: 4,
      timestamp: '2024-01-01T00:03:00Z'
    }
  ];
}

describe('ProjectionDaemon', () => {
  let mockSubscription: IEventSubscription;
  let mockStore: ReturnType<typeof createMockStore>;
  let projection: ProjectionDefinition<TestState>;
  let options: ProjectionDaemonOptions<TestState>;
  
  beforeEach(() => {
    mockSubscription = createMockSubscription(createTestEvents());
    mockStore = createMockStore();
    projection = createTestProjection();
    options = {
      projection,
      subscription: mockSubscription,
      store: mockStore,
      batchSize: 100,
      pollInterval: 0 // Don't actually wait in tests
    };
  });
  
  describe('Basic polling loop', () => {
    it('should process a batch of events', async () => {
      const daemon = new ProjectionDaemon(options);
      
      const stats = await daemon.processBatch();
      
      expect(stats.eventsProcessed).toBe(4);
      expect(stats.documentsUpdated).toBe(2); // order-1 and order-2
      expect(stats.duration).toBeGreaterThanOrEqual(0);
    });
    
    it('should persist state to store', async () => {
      const daemon = new ProjectionDaemon(options);
      
      await daemon.processBatch();
      
      const state1 = await mockStore.load('order-1');
      expect(state1).not.toBeNull();
      expect(state1!.count).toBe(9); // 1 (created) + 5 + 3
      expect(state1!.name).toBe('Test Order');
      expect(state1!.events).toContain('order.created');
      expect(state1!.events).toContain('order.updated');
      
      const state2 = await mockStore.load('order-2');
      expect(state2).not.toBeNull();
      expect(state2!.name).toBe('Second Order');
    });
    
    it('should save checkpoint after processing', async () => {
      const daemon = new ProjectionDaemon(options);
      
      await daemon.processBatch();
      
      const checkpoint = await mockStore.getCheckpoint!('__cursor__testProjection');
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.sequence).toBe(4);
    });
    
    it('should not reprocess events when cursor is set', async () => {
      const daemon = new ProjectionDaemon(options);
      
      // First batch
      await daemon.processBatch();
      
      // Reset state but keep cursor
      await mockStore.save('order-1', { count: 0, name: '', events: [] }, { sequence: 0 });
      
      // Second batch should not reprocess since cursor is at 4
      const stats = await daemon.processBatch();
      
      // No events processed because cursor is at the end
      expect(stats.eventsProcessed).toBe(0);
    });
  });
  
  describe('Event routing (from vs join)', () => {
    it('should use aggregateId as document ID for .from stream events', async () => {
      const daemon = new ProjectionDaemon(options);
      
      await daemon.processBatch();
      
      // Events from 'order' aggregate should use aggregateId as docId
      const state = await mockStore.load('order-1');
      expect(state).not.toBeNull();
      expect(state!.name).toBe('Test Order');
    });

    it('should route .from events using custom identity based on aggregateId', async () => {
      const orderAgg = {
        __aggregateType: 'order',
        initialState: {},
        pure: { eventProjectors: {} }
      };

      const projectionWithCustomIdentity = createProjection<TestState>('customIdentityByAggregate', (docId) => ({
        count: 0,
        name: '',
        events: []
      }))
        .identity((event) => `doc-${event.aggregateId}`)
        .from(orderAgg, {
          'order.created': (state, event: any) => {
            state.name = event.payload.name;
            state.events.push(event.type);
          }
        })
        .build();

      const events: ProjectionEvent[] = [
        {
          aggregateType: 'order',
          aggregateId: 'order-1',
          type: 'order.created',
          payload: { name: 'Order 1' },
          sequence: 1,
          timestamp: '2024-01-01T00:00:00Z'
        }
      ];

      const daemon = new ProjectionDaemon({
        ...options,
        projection: projectionWithCustomIdentity,
        subscription: createMockSubscription(events)
      });

      await daemon.processBatch();

      expect(await mockStore.load('order-1')).toBeNull();
      const state = await mockStore.load('doc-order-1');
      expect(state).not.toBeNull();
      expect(state!.name).toBe('Order 1');
    });

    it('should route .from events using custom identity based on payload', async () => {
      const orderAgg = {
        __aggregateType: 'order',
        initialState: {},
        pure: { eventProjectors: {} }
      };

      const projectionWithPayloadIdentity = createProjection<TestState>('customIdentityByPayload', (docId) => ({
        count: 0,
        name: '',
        events: []
      }))
        .identity((event) => (event.payload as any).documentId)
        .from(orderAgg, {
          'order.created': (state, event: any) => {
            state.name = event.payload.name;
            state.events.push(event.type);
          }
        })
        .build();

      const events: ProjectionEvent[] = [
        {
          aggregateType: 'order',
          aggregateId: 'order-2',
          type: 'order.created',
          payload: { name: 'Order 2', documentId: 'payload-doc-2' },
          sequence: 1,
          timestamp: '2024-01-01T00:00:00Z'
        }
      ];

      const daemon = new ProjectionDaemon({
        ...options,
        projection: projectionWithPayloadIdentity,
        subscription: createMockSubscription(events)
      });

      await daemon.processBatch();

      expect(await mockStore.load('order-2')).toBeNull();
      const state = await mockStore.load('payload-doc-2');
      expect(state).not.toBeNull();
      expect(state!.name).toBe('Order 2');
    });

    it('should fan out a single .from event to multiple unique identities', async () => {
      const orderAgg = {
        __aggregateType: 'order',
        initialState: {},
        pure: { eventProjectors: {} }
      };

      const fanOutProjection = createProjection<TestState>('fanOutIdentity', () => ({
        count: 0,
        name: '',
        events: []
      }))
        .identity((event) => ['doc-a', 'doc-b', 'doc-a'] as const)
        .from(orderAgg, {
          'order.created': (state, event: any) => {
            state.name = event.payload.name;
            state.count += 1;
            state.events.push(event.type);
          }
        })
        .build();

      const daemon = new ProjectionDaemon({
        ...options,
        projection: fanOutProjection,
        subscription: createMockSubscription([
          {
            aggregateType: 'order',
            aggregateId: 'order-1',
            type: 'order.created',
            payload: { name: 'Fan Out' },
            sequence: 1,
            timestamp: '2024-01-01T00:00:00Z'
          }
        ])
      });

      const stats = await daemon.processBatch();

      expect(stats.eventsProcessed).toBe(1);
      expect(stats.documentsUpdated).toBe(2);

      const stateA = await mockStore.load('doc-a');
      const stateB = await mockStore.load('doc-b');
      expect(stateA).not.toBeNull();
      expect(stateB).not.toBeNull();
      expect(stateA!.name).toBe('Fan Out');
      expect(stateB!.name).toBe('Fan Out');
      expect(stateA!.count).toBe(1);
      expect(stateB!.count).toBe(1);
    });
    
    it('should handle events from multiple aggregates with different document IDs', async () => {
      const events: ProjectionEvent[] = [
        {
          aggregateType: 'order',
          aggregateId: 'order-A',
          type: 'order.created',
          payload: { name: 'Order A' },
          sequence: 1,
          timestamp: '2024-01-01T00:00:00Z'
        },
        {
          aggregateType: 'order',
          aggregateId: 'order-B',
          type: 'order.created',
          payload: { name: 'Order B' },
          sequence: 2,
          timestamp: '2024-01-01T00:01:00Z'
        }
      ];
      
      const subscription = createMockSubscription(events);
      const daemon = new ProjectionDaemon({ ...options, subscription });
      
      await daemon.processBatch();
      
      const stateA = await mockStore.load('order-A');
      const stateB = await mockStore.load('order-B');
      
      expect(stateA!.name).toBe('Order A');
      expect(stateB!.name).toBe('Order B');
    });
  });
  
  describe('Ghost document prevention', () => {
    it('should ignore .join stream events without subscription', async () => {
      // Create projection with join stream - new builder API
      const orderAgg = {
        __aggregateType: 'order',
        initialState: {},
        pure: { eventProjectors: {} }
      };
      const customerAgg = {
        __aggregateType: 'customer',
        initialState: {},
        pure: { eventProjectors: {} }
      };
      
      const projectionWithJoin = createProjection<TestState>('joinTest', (docId) => ({
        count: 0,
        name: '',
        events: []
      }))
        .from(orderAgg, {
          'order.created': (state, event: any) => {
            state.name = event.payload.name || 'unknown';
          }
        })
        .join(customerAgg, {
          'customer.attached': (state, event: any) => {
            state.name = event.payload.customerName || state.name;
          }
        })
        .build();
      
      // Events include both order and customer
      const events: ProjectionEvent[] = [
        {
          aggregateType: 'order',
          aggregateId: 'order-1',
          type: 'order.created',
          payload: { name: 'Order 1' },
          sequence: 1,
          timestamp: '2024-01-01T00:00:00Z'
        },
        {
          aggregateType: 'customer',
          aggregateId: 'customer-1',
          type: 'customer.attached',
          payload: { customerName: 'John' },
          sequence: 2,
          timestamp: '2024-01-01T00:01:00Z'
        }
      ];
      
      const subscription = createMockSubscription(events);
      const daemon = new ProjectionDaemon({ 
        ...options, 
        projection: projectionWithJoin,
        subscription 
      });
      
      await daemon.processBatch();
      
      // Customer event should be ignored because no subscription exists
      const state = await mockStore.load('order-1');
      expect(state!.name).toBe('Order 1'); // Should still be original name, not 'John'
    });
  });

  describe('Store link resolution seam', () => {
    it('should route join events via store.resolveTarget', async () => {
      const orderAgg = {
        __aggregateType: 'order',
        initialState: {},
        pure: { eventProjectors: {} }
      };
      const customerAgg = {
        __aggregateType: 'customer',
        initialState: {},
        pure: { eventProjectors: {} }
      };

      const projectionWithJoin = createProjection<TestState>('joinWithExternalLinks', () => ({
        count: 0,
        name: '',
        events: []
      }))
        .from(orderAgg, {
          'order.created': (state, event: any) => {
            state.name = event.payload.name || 'unknown';
          }
        })
        .join(customerAgg, {
          'customer.attached': (state, event: any) => {
            state.name = event.payload.customerName;
            state.events.push(event.type);
          }
        })
        .build();

      const resolveTargetSpy = jest.fn((aggregateType: string, aggregateId: string) => {
        return aggregateType === 'customer' && aggregateId === 'customer-1' ? 'invoice-1' : null;
      });

      const customStore = createMockStore();
      customStore.resolveTarget = async (aggregateType: string, aggregateId: string) => resolveTargetSpy(aggregateType, aggregateId);

      const subscription = createMockSubscription([
        {
          aggregateType: 'customer',
          aggregateId: 'customer-1',
          type: 'customer.attached',
          payload: { customerName: 'Jane' },
          sequence: 1,
          timestamp: '2024-01-01T00:00:00Z'
        }
      ]);

      const daemon = new ProjectionDaemon({
        ...options,
        store: customStore,
        projection: projectionWithJoin,
        subscription
      });

      const stats = await daemon.processBatch();

      expect(stats.eventsProcessed).toBe(1);
      expect(resolveTargetSpy).toHaveBeenCalledWith('customer', 'customer-1');

      const state = await customStore.load('invoice-1');
      expect(state).not.toBeNull();
      expect(state!.name).toBe('Jane');
      expect(state!.events).toEqual(['customer.attached']);
    });
  });
  
  describe('In-memory batching/folding', () => {
    it('should fold multiple events for same document in one batch', async () => {
      // All events are for order-1
      const events: ProjectionEvent[] = [
        {
          aggregateType: 'order',
          aggregateId: 'order-1',
          type: 'order.created',
          payload: { name: 'Initial' },
          sequence: 1,
          timestamp: '2024-01-01T00:00:00Z'
        },
        {
          aggregateType: 'order',
          aggregateId: 'order-1',
          type: 'order.updated',
          payload: { amount: 10 },
          sequence: 2,
          timestamp: '2024-01-01T00:01:00Z'
        },
        {
          aggregateType: 'order',
          aggregateId: 'order-1',
          type: 'order.updated',
          payload: { amount: 20 },
          sequence: 3,
          timestamp: '2024-01-01T00:02:00Z'
        }
      ];
      
      const subscription = createMockSubscription(events);
      const daemon = new ProjectionDaemon({ ...options, subscription });
      
      const stats = await daemon.processBatch();
      
      // Should process all 3 events but only 1 document
      expect(stats.eventsProcessed).toBe(3);
      expect(stats.documentsUpdated).toBe(1);
      
      // State should have all events applied in sequence
      const state = await mockStore.load('order-1');
      expect(state!.count).toBe(31); // 1 + 10 + 20
      expect(state!.events).toHaveLength(3);
    });
    
    it('should save document only once per batch even with multiple events', async () => {
      const commitAtomicSpy = jest.spyOn(mockStore as any, 'commitAtomic');
      
      const events: ProjectionEvent[] = [
        {
          aggregateType: 'order',
          aggregateId: 'order-1',
          type: 'order.created',
          payload: { name: 'Test' },
          sequence: 1,
          timestamp: '2024-01-01T00:00:00Z'
        },
        {
          aggregateType: 'order',
          aggregateId: 'order-1',
          type: 'order.updated',
          payload: { amount: 5 },
          sequence: 2,
          timestamp: '2024-01-01T00:01:00Z'
        }
      ];
      
      const subscription = createMockSubscription(events);
      const daemon = new ProjectionDaemon({ ...options, subscription });
      
      await daemon.processBatch();
      
      expect(commitAtomicSpy).toHaveBeenCalledTimes(1);
      const atomicWrite = commitAtomicSpy.mock.calls[0][0] as {
        documents: Array<{ documentId: string }>;
      };

      // Should only include one write for order-1 (batching)
      const order1Writes = atomicWrite.documents.filter((document) => document.documentId === 'order-1');
      expect(order1Writes).toHaveLength(1);
    });
  });
  
  describe('Cursor management', () => {
    it('should initialize cursor at 0 on first run', async () => {
      const daemon = new ProjectionDaemon(options);
      
      await daemon.processBatch();
      
      const cursor = await mockStore.getCheckpoint!('__cursor__testProjection');
      expect(cursor?.sequence).toBe(4); // Last processed event
    });
    
    it('should resume from saved cursor', async () => {
      const daemon = new ProjectionDaemon(options);
      
      // First batch
      await daemon.processBatch();
      
      // Create new daemon with same store (simulates restart)
      const daemon2 = new ProjectionDaemon({
        ...options,
        store: mockStore
      });
      
      const stats = await daemon2.processBatch();
      
      // Should process 0 events since cursor is at end
      expect(stats.eventsProcessed).toBe(0);
    });
    
    it('should handle empty batches correctly', async () => {
      // Subscription with no events
      const emptySubscription = createMockSubscription([]);
      const daemon = new ProjectionDaemon({ ...options, subscription: emptySubscription });
      
      const stats = await daemon.processBatch();
      
      expect(stats.eventsProcessed).toBe(0);
      expect(stats.documentsUpdated).toBe(0);
    });
  });
  
  describe('Daemon lifecycle', () => {
    it('should start and stop the polling loop', async () => {
      const events: ProjectionEvent[] = [
        {
          aggregateType: 'order',
          aggregateId: 'order-1',
          type: 'order.created',
          payload: { name: 'Test' },
          sequence: 1,
          timestamp: '2024-01-01T00:00:00Z'
        }
      ];
      
      const subscription = createMockSubscription(events);
      const daemon = new ProjectionDaemon({ 
        ...options, 
        subscription,
        pollInterval: 50 // Short interval for testing
      });
      
      // Start the daemon
      const startPromise = daemon.start();
      
      // Let it run for a bit
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Stop the daemon
      daemon.stop();
      
      await startPromise;
      
      // Daemon should have stopped
      expect(true).toBe(true); // If we got here without error, stop worked
    });
    
    it('should call onBatch callback after each batch', async () => {
      const onBatchMock = jest.fn();
      
      const daemon = new ProjectionDaemon({
        ...options,
        onBatch: onBatchMock
      });
      
      await daemon.processBatch();
      
      expect(onBatchMock).toHaveBeenCalledTimes(1);
      const stats = onBatchMock.mock.calls[0][0] as BatchStats;
      expect(stats.eventsProcessed).toBe(4);
    });
  });
  
  describe('Handler resolution', () => {
    it('should find handler by full event type', async () => {
      const daemon = new ProjectionDaemon(options);
      
      await daemon.processBatch();
      
      const state = await mockStore.load('order-1');
      expect(state!.events).toContain('order.created');
      expect(state!.events).toContain('order.updated');
    });

    it('should resolve .event style handlers using normalized key variants', async () => {
      const invoiceAgg = {
        __aggregateType: 'invoice',
        initialState: {},
        pure: { eventProjectors: {} }
      };

      const handlerKeys = [
        'invoice.line.added.event',
        'line.added.event',
        'invoice.line.added',
        'line.added'
      ];

      for (const handlerKey of handlerKeys) {
        const store = createMockStore();
        const projectionForKey = createProjection<TestState>(`handlerKeyVariant-${handlerKey}`, () => ({
          count: 0,
          name: '',
          events: []
        }))
          .from(invoiceAgg, {
            [handlerKey]: (state) => {
              state.events.push(handlerKey);
            }
          })
          .build();

        const daemon = new ProjectionDaemon({
          ...options,
          store,
          projection: projectionForKey,
          subscription: createMockSubscription([
            {
              aggregateType: 'invoice',
              aggregateId: 'inv-1',
              type: 'invoice.line.added.event',
              payload: {},
              sequence: 1,
              timestamp: '2024-01-01T00:00:00Z'
            }
          ])
        });

        await daemon.processBatch();

        const state = await store.load('inv-1');
        expect(state).not.toBeNull();
        expect(state!.events).toEqual([handlerKey]);
      }
    });

    it('should resolve non-.event handlers by exact and without aggregate prefix only', async () => {
      const orderAgg = {
        __aggregateType: 'order',
        initialState: {},
        pure: { eventProjectors: {} }
      };

      const acceptedKeys = ['order.created', 'created'];

      for (const handlerKey of acceptedKeys) {
        const store = createMockStore();
        const projectionForKey = createProjection<TestState>(`handlerKeyNoSuffix-${handlerKey}`, () => ({
          count: 0,
          name: '',
          events: []
        }))
          .from(orderAgg, {
            [handlerKey]: (state) => {
              state.events.push(handlerKey);
            }
          })
          .build();

        const daemon = new ProjectionDaemon({
          ...options,
          store,
          projection: projectionForKey,
          subscription: createMockSubscription([
            {
              aggregateType: 'order',
              aggregateId: 'order-1',
              type: 'order.created',
              payload: {},
              sequence: 1,
              timestamp: '2024-01-01T00:00:00Z'
            }
          ])
        });

        await daemon.processBatch();

        const state = await store.load('order-1');
        expect(state).not.toBeNull();
        expect(state!.events).toEqual([handlerKey]);
      }
    });

    it('should not match ambiguous last-segment-only handler keys', async () => {
      const invoiceAgg = {
        __aggregateType: 'invoice',
        initialState: {},
        pure: { eventProjectors: {} }
      };

      const projectionWithAmbiguousKey = createProjection<TestState>('handlerKeyAmbiguous', () => ({
        count: 0,
        name: '',
        events: []
      }))
        .from(invoiceAgg, {
          added: (state) => {
            state.events.push('added');
          }
        })
        .build();

      const store = createMockStore();
      const daemon = new ProjectionDaemon({
        ...options,
        store,
        projection: projectionWithAmbiguousKey,
        subscription: createMockSubscription([
          {
            aggregateType: 'invoice',
            aggregateId: 'inv-1',
            type: 'invoice.line.added.event',
            payload: {},
            sequence: 1,
            timestamp: '2024-01-01T00:00:00Z'
          }
        ])
      });

      await daemon.processBatch();

      const state = await store.load('inv-1');
      expect(state).not.toBeNull();
      expect(state!.events).toEqual([]);
    });
    
    it('should handle events with no matching handler gracefully', async () => {
      const events: ProjectionEvent[] = [
        {
          aggregateType: 'order',
          aggregateId: 'order-1',
          type: 'order.unknown', // No handler for this
          payload: {},
          sequence: 1,
          timestamp: '2024-01-01T00:00:00Z'
        },
        {
          aggregateType: 'order',
          aggregateId: 'order-1',
          type: 'order.created',
          payload: { name: 'Test' },
          sequence: 2,
          timestamp: '2024-01-01T00:01:00Z'
        }
      ];
      
      const subscription = createMockSubscription(events);
      const daemon = new ProjectionDaemon({ ...options, subscription });
      
      // Should not throw - just process what it can
      const result = await daemon.processBatch();
      expect(result.eventsProcessed).toBe(2); // Both events processed (unknown just skipped)
      
      const state = await mockStore.load('order-1');
      expect(state).not.toBeNull();
      expect(state!.name).toBe('Test');
    });
  });
});
