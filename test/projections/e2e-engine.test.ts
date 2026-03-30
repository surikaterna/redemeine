import { describe, it, expect, beforeEach } from '@jest/globals';
import { createProjection } from '../../src/projections/createProjection';
import { InMemoryProjectionStore } from '../../src/projections/InMemoryProjectionStore';
import { ProjectionDaemon } from '../../src/projections/ProjectionDaemon';
import { ProjectionEvent, Checkpoint } from '../../src/projections/types';
import { IEventSubscription } from '../../src/projections/IEventSubscription';

// Define payload types
interface InvoiceCreatedPayload {
  invoiceId: string;
  customerId: string;
  amount: number;
}

interface InvoiceLineAddedPayload {
  invoiceId: string;
  lineId: string;
  description: string;
  amount: number;
}

interface InvoicePaidPayload {
  invoiceId: string;
  paidAt: string;
  amount: number;
}

// State for our invoice summary projection
interface InvoiceSummaryState {
  invoiceId: string;
  customerId: string;
  subtotal: number;
  lines: Array<{ lineId: string; description: string; amount: number }>;
  total: number;
  paid: boolean;
  paidAt: string | null;
  eventCount: number;
}

// Test aggregates - need proper aggregate definition
const invoiceAgg = { 
  __aggregateType: 'invoice' as const,
  initialState: {},
  pure: { eventProjectors: {} }
};

// Create mock subscription with specific events
function createMockSubscription(events: ProjectionEvent[]): IEventSubscription {
  return {
    poll: async (cursor: Checkpoint, batchSize: number) => {
      const batch = events
        .filter((event) => event.sequence > cursor.sequence)
        .slice(0, batchSize);
      const lastSeq = batch.length > 0 ? batch[batch.length - 1].sequence : cursor.sequence;
      return {
        events: batch,
        nextCursor: { sequence: lastSeq, timestamp: new Date().toISOString() },
        hasMore: events.some((event) => event.sequence > lastSeq)
      };
    }
  };
}

describe('End-to-End Engine Test', () => {
  let store: InMemoryProjectionStore<InvoiceSummaryState>;
  let projection: ReturnType<typeof createProjection<InvoiceSummaryState>>;
  
  beforeEach(() => {
    store = new InMemoryProjectionStore<InvoiceSummaryState>();
    
    // Create invoice summary projection using the new builder API
    projection = createProjection<InvoiceSummaryState>('invoice-summary', (id) => ({
      invoiceId: id,
      customerId: '',
      subtotal: 0,
      lines: [],
      total: 0,
      paid: false,
      paidAt: null,
      eventCount: 0
    }))
      .from(invoiceAgg, {
        'invoice.created.event': (state, event) => {
          state.invoiceId = event.payload.invoiceId as string;
          state.customerId = event.payload.customerId as string;
          state.subtotal = event.payload.amount as number;
          state.total = event.payload.amount as number;
          state.eventCount++;
        },
        'invoice.line.added.event': (state, event) => {
          state.lines.push({
            lineId: event.payload.lineId as string,
            description: event.payload.description as string,
            amount: event.payload.amount as number
          });
          state.subtotal += event.payload.amount as number;
          state.total = state.subtotal;
          state.eventCount++;
        },
        'invoice.paid.event': (state, event) => {
          state.paid = true;
          state.paidAt = event.payload.paidAt as string;
          state.eventCount++;
        }
      })
      .build();
  });

  it('should process 5 events and produce correct final state', async () => {
    // Define 5 events in sequence
    const events: ProjectionEvent[] = [
      {
        id: 'evt-1',
        aggregateType: 'invoice',
        aggregateId: 'invoice-001',
        type: 'invoice.created.event',
        payload: {
          invoiceId: 'invoice-001',
          customerId: 'cust-123',
          amount: 100
        } as InvoiceCreatedPayload,
        sequence: 1,
        timestamp: '2024-01-15T10:00:00Z'
      },
      {
        id: 'evt-2',
        aggregateType: 'invoice',
        aggregateId: 'invoice-001',
        type: 'invoice.line.added.event',
        payload: {
          invoiceId: 'invoice-001',
          lineId: 'line-1',
          description: 'Consulting hours',
          amount: 150
        } as InvoiceLineAddedPayload,
        sequence: 2,
        timestamp: '2024-01-15T10:30:00Z'
      },
      {
        id: 'evt-3',
        aggregateType: 'invoice',
        aggregateId: 'invoice-001',
        type: 'invoice.line.added.event',
        payload: {
          invoiceId: 'invoice-001',
          lineId: 'line-2',
          description: 'Travel expenses',
          amount: 50
        } as InvoiceLineAddedPayload,
        sequence: 3,
        timestamp: '2024-01-15T11:00:00Z'
      },
      {
        id: 'evt-4',
        aggregateType: 'invoice',
        aggregateId: 'invoice-001',
        type: 'invoice.line.added.event',
        payload: {
          invoiceId: 'invoice-001',
          lineId: 'line-3',
          description: 'Materials',
          amount: 75
        } as InvoiceLineAddedPayload,
        sequence: 4,
        timestamp: '2024-01-15T11:30:00Z'
      },
      {
        id: 'evt-5',
        aggregateType: 'invoice',
        aggregateId: 'invoice-001',
        type: 'invoice.paid.event',
        payload: {
          invoiceId: 'invoice-001',
          paidAt: '2024-01-16T09:00:00Z',
          amount: 375
        } as InvoicePaidPayload,
        sequence: 5,
        timestamp: '2024-01-16T09:00:00Z'
      }
    ];
    
    const subscription = createMockSubscription(events);
    const daemon = new ProjectionDaemon({ projection, subscription, store });
    
    // Process the batch
    const stats = await daemon.processBatch();
    
    // Verify batch stats
    expect(stats.eventsProcessed).toBe(5);
    expect(stats.documentsUpdated).toBe(1); // All events go to same document
    
    // Verify final state in store
    const finalState = await store.load('invoice-001');
    expect(finalState).not.toBeNull();
    expect(finalState!.invoiceId).toBe('invoice-001');
    expect(finalState!.customerId).toBe('cust-123');
    expect(finalState!.subtotal).toBe(375); // 100 + 150 + 50 + 75
    expect(finalState!.total).toBe(375);
    expect(finalState!.lines).toHaveLength(3);
    expect(finalState!.paid).toBe(true);
    expect(finalState!.paidAt).toBe('2024-01-16T09:00:00Z');
    expect(finalState!.eventCount).toBe(5);
    
    // Verify cursor was saved
    const cursor = await store.getCheckpoint!('__cursor__invoice-summary');
    expect(cursor).not.toBeNull();
    expect(cursor!.sequence).toBe(5); // Last processed event checkpoint
  });

  it('should handle multiple documents in single batch', async () => {
    const events: ProjectionEvent[] = [
      {
        id: 'evt-1',
        aggregateType: 'invoice',
        aggregateId: 'invoice-001',
        type: 'invoice.created.event',
        payload: { invoiceId: 'invoice-001', customerId: 'cust-A', amount: 100 } as InvoiceCreatedPayload,
        sequence: 1,
        timestamp: '2024-01-15T10:00:00Z'
      },
      {
        id: 'evt-2',
        aggregateType: 'invoice',
        aggregateId: 'invoice-002',
        type: 'invoice.created.event',
        payload: { invoiceId: 'invoice-002', customerId: 'cust-B', amount: 200 } as InvoiceCreatedPayload,
        sequence: 2,
        timestamp: '2024-01-15T10:05:00Z'
      },
      {
        id: 'evt-3',
        aggregateType: 'invoice',
        aggregateId: 'invoice-001',
        type: 'invoice.paid.event',
        payload: { invoiceId: 'invoice-001', paidAt: '2024-01-16T09:00:00Z', amount: 100 } as InvoicePaidPayload,
        sequence: 3,
        timestamp: '2024-01-16T09:00:00Z'
      }
    ];
    
    const subscription = createMockSubscription(events);
    const daemon = new ProjectionDaemon({ projection, subscription, store });
    
    await daemon.processBatch();
    
    // Verify both documents were created
    const doc1 = await store.load('invoice-001');
    const doc2 = await store.load('invoice-002');
    
    expect(doc1).not.toBeNull();
    expect(doc1!.customerId).toBe('cust-A');
    expect(doc1!.paid).toBe(true);
    expect(doc1!.eventCount).toBe(2);
    
    expect(doc2).not.toBeNull();
    expect(doc2!.customerId).toBe('cust-B');
    expect(doc2!.paid).toBe(false);
    expect(doc2!.eventCount).toBe(1);
  });

  it('should fold multiple events for same document before saving', async () => {
    // Create 100 events for the same document
    const events: ProjectionEvent[] = Array.from({ length: 100 }, (_, i) => ({
      id: `evt-${i + 1}`,
      aggregateType: 'invoice',
      aggregateId: 'invoice-001',
      type: 'invoice.line.added.event',
      payload: {
        invoiceId: 'invoice-001',
        lineId: `line-${i + 1}`,
        description: `Line item ${i + 1}`,
        amount: 10
      } as InvoiceLineAddedPayload,
      sequence: i + 1,
      timestamp: new Date().toISOString()
    }));
    
    const subscription = createMockSubscription(events);
    const daemon = new ProjectionDaemon({ projection, subscription, store });
    
    await daemon.processBatch();
    
    // Verify state was accumulated correctly (in-memory folding worked)
    const finalState = await store.load('invoice-001');
    expect(finalState!.lines).toHaveLength(100);
    expect(finalState!.subtotal).toBe(1000); // 100 * 10
    expect(finalState!.eventCount).toBe(100);
  });
});
