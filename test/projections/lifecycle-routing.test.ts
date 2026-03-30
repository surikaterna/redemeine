import { describe, it, expect, beforeEach } from '@jest/globals';
import { createProjection, ProjectionDefinition, ProjectionEvent, AggregateDefinition, InMemoryProjectionStore } from '../../src/projections';
import { ProjectionDaemon } from '../../src/projections/ProjectionDaemon';
import { IProjectionStore } from '../../src/projections/IProjectionStore';
import { IEventSubscription } from '../../src/projections/IEventSubscription';
import { Checkpoint, EventBatch } from '../../src/projections/types';

// Test aggregates - simplified definitions
const invoiceAgg: AggregateDefinition = {
  __aggregateType: 'invoice',
  initialState: { total: 0 },
} as any;

const orderAgg: AggregateDefinition = {
  __aggregateType: 'order',
  initialState: { status: 'pending' },
} as any;

// Mock event subscription that yields specific events
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
        nextCursor: { sequence: nextSeq, timestamp: new Date().toISOString() },
        hasMore: false
      };
    }
  };
}

// Test state types
interface InvoiceState {
  total: number;
  orders?: string[];
}

interface OrderState {
  status: string;
}

describe('Lifecycle Routing', () => {
  let store: InMemoryProjectionStore<InvoiceState>;
  
  beforeEach(() => {
    store = new InMemoryProjectionStore<InvoiceState>();
  });

  it('should create document when .from() event is processed', async () => {
    const projection = createProjection<InvoiceState>('invoice-test', {
      from: {
        aggregate: invoiceAgg,
        handlers: {
          'invoice.created': (state: any, event: ProjectionEvent<{ amount: number }>) => {
            state.total = event.payload.amount;
          }
        }
      },
      initialState: (docId: string) => ({ total: 0 })
    });
    
    const subscription = createMockSubscription([
      {
        aggregateType: 'invoice',
        aggregateId: 'invoice-123',
        type: 'invoice.created',
        payload: { amount: 100 },
        sequence: 1,
        timestamp: new Date().toISOString()
      }
    ]);
    
    const daemon = new ProjectionDaemon({ 
      projection: projection as ProjectionDefinition<InvoiceState>, 
      subscription, 
      store 
    });
    
    await daemon.processBatch();
    
    // Document should be created
    const doc = await store.load('invoice-123');
    expect(doc).not.toBeNull();
    expect(doc?.total).toBe(100);
  });

  it('should IGNORE .join() event WITHOUT subscribeTo - NO ghost document', async () => {
    const projection = createProjection<InvoiceState>('invoice-test', {
      from: {
        aggregate: invoiceAgg,
        handlers: {
          'invoice.created': (state: any, event: ProjectionEvent) => {
            // No subscribeTo call here
          }
        }
      },
      join: [
        {
          aggregate: orderAgg,
          handlers: {
            'order.shipped': (state: any, event: ProjectionEvent<{ amount: number }>) => {
              state.total = event.payload.amount;
            }
          }
        }
      ],
      initialState: (docId: string) => ({ total: 0 })
    });
    
    // Order event WITHOUT corresponding invoice event or subscribeTo
    const subscription = createMockSubscription([
      {
        aggregateType: 'order',
        aggregateId: 'order-456',
        type: 'order.shipped',
        payload: { amount: 200 },
        sequence: 1,
        timestamp: new Date().toISOString()
      }
    ]);
    
    const daemon = new ProjectionDaemon({ 
      projection: projection as ProjectionDefinition<InvoiceState>, 
      subscription, 
      store 
    });
    
    await daemon.processBatch();
    
    // NO document should be created (ghost prevention)
    const doc = await store.load('order-456');
    expect(doc).toBeNull();
    
    // Verify that the order-456 key is not in the store (excluding cursor)
    const allDocs = store.getAll();
    const dataDocCount = Array.from(allDocs.keys()).filter(k => !k.startsWith('__cursor__')).length;
    expect(dataDocCount).toBe(0);
  });

  it('should PROCESS .join() event WITH subscribeTo', async () => {
    const projection = createProjection<InvoiceState & { orders: string[] }>('invoice-test', {
      from: {
        aggregate: invoiceAgg,
        handlers: {
          'invoice.created': (state: any, event: ProjectionEvent<{ amount: number; orderId: string }>, ctx) => {
            // Subscribe to order events for this invoice
            ctx.subscribeTo(orderAgg, event.payload.orderId);
            state.total = event.payload.amount;
          }
        }
      },
      join: [
        {
          aggregate: orderAgg,
          handlers: {
            'order.shipped': (state: any, event: ProjectionEvent<{ amount: number }>) => {
              state.total += event.payload.amount;
              state.orders.push(event.aggregateId);
            }
          }
        }
      ],
      initialState: (docId: string) => ({ total: 0, orders: [] })
    });
    
    const subscription = createMockSubscription([
      {
        aggregateType: 'invoice',
        aggregateId: 'invoice-123',
        type: 'invoice.created',
        payload: { amount: 100, orderId: 'order-456' },
        sequence: 1,
        timestamp: new Date().toISOString()
      },
      {
        aggregateType: 'order',
        aggregateId: 'order-456',
        type: 'order.shipped',
        payload: { amount: 200 },
        sequence: 1,
        timestamp: new Date().toISOString()
      }
    ]);
    
    const daemon = new ProjectionDaemon({ 
      projection: projection as ProjectionDefinition<InvoiceState & { orders: string[] }>, 
      subscription, 
      store 
    });
    
    await daemon.processBatch();
    
    // Document should be created and include order data
    const doc = await store.load('invoice-123');
    expect(doc).not.toBeNull();
    expect(doc?.total).toBe(300); // 100 + 200
    expect(doc?.orders).toContain('order-456');
  });

  it('should use aggregateId as document ID for .from() events', async () => {
    const projection = createProjection<InvoiceState>('invoice-test', {
      from: {
        aggregate: invoiceAgg,
        handlers: {
          'invoice.created': (state: any, event: ProjectionEvent<{ amount: number }>) => {
            state.total = event.payload.amount;
          }
        }
      },
      initialState: (docId: string) => ({ total: 0 })
    });
    
    const subscription = createMockSubscription([
      {
        aggregateType: 'invoice',
        aggregateId: 'custom-invoice-id',
        type: 'invoice.created',
        payload: { amount: 500 },
        sequence: 1,
        timestamp: new Date().toISOString()
      }
    ]);
    
    const daemon = new ProjectionDaemon({ 
      projection: projection as ProjectionDefinition<InvoiceState>, 
      subscription, 
      store 
    });
    
    await daemon.processBatch();
    
    // Document should be created with aggregateId as document ID
    const doc = await store.load('custom-invoice-id');
    expect(doc).not.toBeNull();
    expect(doc?.total).toBe(500);
  });

  it('should route .join() events to the subscribed document', async () => {
    let subscribeContext: any = null;
    
    const projection = createProjection<InvoiceState & { orders: string[] }>('invoice-test', {
      from: {
        aggregate: invoiceAgg,
        handlers: {
          'invoice.created': (state: any, event: ProjectionEvent<{ amount: number; orderId: string }>, ctx) => {
            // Subscribe to order
            ctx.subscribeTo(orderAgg, event.payload.orderId);
            subscribeContext = ctx;
            state.total = event.payload.amount;
          }
        }
      },
      join: [
        {
          aggregate: orderAgg,
          handlers: {
            'order.shipped': (state: any, event: ProjectionEvent<{ amount: number }>) => {
              state.orders.push(event.aggregateId);
            }
          }
        }
      ],
      initialState: (docId: string) => ({ total: 0, orders: [] })
    });
    
    // First event: invoice created (subscribes to order-456)
    // Second event: order-456 shipped (should be processed because subscribed)
    // Third event: order-999 shipped (should be IGNORED because not subscribed)
    const subscription = createMockSubscription([
      {
        aggregateType: 'invoice',
        aggregateId: 'invoice-123',
        type: 'invoice.created',
        payload: { amount: 100, orderId: 'order-456' },
        sequence: 1,
        timestamp: new Date().toISOString()
      },
      {
        aggregateType: 'order',
        aggregateId: 'order-456',
        type: 'order.shipped',
        payload: { amount: 50 },
        sequence: 2,
        timestamp: new Date().toISOString()
      },
      {
        aggregateType: 'order',
        aggregateId: 'order-999',
        type: 'order.shipped',
        payload: { amount: 50 },
        sequence: 3,
        timestamp: new Date().toISOString()
      }
    ]);
    
    const daemon = new ProjectionDaemon({ 
      projection: projection as ProjectionDefinition<InvoiceState & { orders: string[] }>, 
      subscription, 
      store 
    });
    
    await daemon.processBatch();
    
    // Only order-456 should be processed (not order-999)
    const doc = await store.load('invoice-123');
    expect(doc).not.toBeNull();
    expect(doc?.orders).toEqual(['order-456']); // Only the subscribed order
    
    // order-999 should NOT have created any document
    const ghostDoc = await store.load('order-999');
    expect(ghostDoc).toBeNull();
  });
});
