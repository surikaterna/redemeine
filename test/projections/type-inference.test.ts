import { describe, it, expect } from '@jest/globals';
import { createProjection, AggregateDefinition } from '../../src/projections/createProjection';
import { createAggregate } from '../../src/createAggregate';

// ============================================================================
// Test payload types - distinct types to verify type isolation
// ============================================================================

interface InvoiceCreatedPayload {
  invoiceId: string;
  amount: number;
}

interface InvoicePaidPayload {
  invoiceId: string;
  paidAt: string;
  amount: number;
}

interface OrderShippedPayload {
  orderId: string;
  trackingNumber: string;
  shippedAt: string;
}

interface OrderDeliveredPayload {
  orderId: string;
  deliveredAt: string;
}

// ============================================================================
// Test aggregates with explicit event payload types
// ============================================================================

const invoiceAgg: AggregateDefinition<
  { total: number; paid: boolean },
  { created: InvoiceCreatedPayload; paid: InvoicePaidPayload }
> = {
  __aggregateType: 'invoice',
  initialState: { total: 0, paid: false },
  pure: {
    eventProjectors: {}
  }
} as any;

const orderAgg: AggregateDefinition<
  { items: string[]; status: string },
  { shipped: OrderShippedPayload; delivered: OrderDeliveredPayload }
> = {
  __aggregateType: 'order',
  initialState: { items: [], status: 'pending' },
  pure: {
    eventProjectors: {}
  }
} as any;

const invoiceRealAgg = createAggregate('invoice', { total: 0, paid: false as boolean })
  .events({
    created: (state, event: { payload: InvoiceCreatedPayload }) => {
      state.total = event.payload.amount;
    },
    paid: (state, event: { payload: InvoicePaidPayload }) => {
      state.paid = true;
    }
  })
  .build();

// ============================================================================
// Tests: Type Inference for Projections
// ============================================================================

describe('Type Inference for Projections', () => {
  it('should infer event.payload types from .from() aggregate', () => {
    const projection = createProjection('test', () => ({ total: 0, paid: false }))
      .from(invoiceAgg, {
        // TypeScript should infer: event.payload is InvoiceCreatedPayload
        created: (state, event) => {
          // If types are correct, we can access:
          const _invoiceId: string = event.payload.invoiceId;
          const _amount: number = event.payload.amount;
        },
        // TypeScript should infer: event.payload is InvoicePaidPayload
        paid: (state, event) => {
          const _paidAt: string = event.payload.paidAt;
          const _amount: number = event.payload.amount;
        }
      })
      .build();

    expect(projection.name).toBe('test');
  });

  it('should infer .from() payloads from real createAggregate() output and reject invalid handler keys', () => {
    createProjection('from-real-aggregate', () => ({ total: 0, paidAt: '' }))
      .from(invoiceRealAgg, {
        created: (state, event) => {
          const _invoiceId: string = event.payload.invoiceId;
          state.total += event.payload.amount;
        },
        paid: (state, event) => {
          state.paidAt = event.payload.paidAt;
        },
        // @ts-expect-error real aggregate should constrain .from() handler keys
        shipped: (state, event) => {
          state.total += 1;
        }
      })
      .build();
  });

  it('should infer event.payload types from .join() aggregate', () => {
    const projection = createProjection('test', () => ({ total: 0 }))
      .from(invoiceAgg, { created: (state, event) => {} })
      .join(orderAgg, {
        // TypeScript should infer: event.payload is OrderShippedPayload
        shipped: (state, event) => {
          const _trackingNumber: string = event.payload.trackingNumber;
        },
        // TypeScript should infer: event.payload is OrderDeliveredPayload
        delivered: (state, event) => {
          const _deliveredAt: string = event.payload.deliveredAt;
        }
      })
      .build();

    expect(projection.name).toBe('test');
  });

  it('should NOT confuse types between .from() and .join() aggregates', () => {
    // This test verifies type isolation
    const projection = createProjection('test', () => ({ total: 0 }))
      .from(invoiceAgg, {
        created: (state, event) => {
          // Should ONLY have InvoiceCreatedPayload properties
          // TypeScript should error if we try to access order properties
          const _invoiceId: string = event.payload.invoiceId;
        }
      })
      .join(orderAgg, {
        shipped: (state, event) => {
          // Should ONLY have OrderShippedPayload properties
          // TypeScript should error if we try to access invoice properties
          const _trackingNumber: string = event.payload.trackingNumber;
        }
      })
      .build();

    expect(projection.name).toBe('test');
  });

  it('should infer state type correctly in handlers', () => {
    interface MyState {
      total: number;
      items: string[];
    }

    const projection = createProjection<MyState>('test', () => ({ total: 0, items: [] }))
      .from(invoiceAgg, {
        created: (state, event) => {
          // state should be MyState - we can mutate it
          state.total += event.payload.amount;
          state.items.push(event.payload.invoiceId);
        }
      })
      .build();

    expect(projection.name).toBe('test');
  });

  it('should support multiple handlers with different payload types in .from()', () => {
    const projection = createProjection('multi-handler-test', () => ({ total: 0 }))
      .from(invoiceAgg, {
        created: (state, event) => {
          // First handler: InvoiceCreatedPayload
          const _invoiceId: string = event.payload.invoiceId;
          const _amount: number = event.payload.amount;
        },
        paid: (state, event) => {
          // Second handler: InvoicePaidPayload (different type!)
          const _paidAt: string = event.payload.paidAt;
          const _invoiceId: string = event.payload.invoiceId;
        }
      })
      .build();

    expect(projection.name).toBe('multi-handler-test');
  });

  it('should support multiple handlers with different payload types in .join()', () => {
    const projection = createProjection('multi-join-test', () => ({ total: 0 }))
      .from(invoiceAgg, { created: (state, event) => {} })
      .join(orderAgg, {
        shipped: (state, event) => {
          // First handler: OrderShippedPayload
          const _trackingNumber: string = event.payload.trackingNumber;
          const _orderId: string = event.payload.orderId;
        },
        delivered: (state, event) => {
          // Second handler: OrderDeliveredPayload (different type!)
          const _deliveredAt: string = event.payload.deliveredAt;
          const _orderId: string = event.payload.orderId;
        }
      })
      .build();

    expect(projection.name).toBe('multi-join-test');
  });

  it('should preserve type inference when chaining multiple .join() calls', () => {
    // Create a second order aggregate with different types
    const shipmentAgg: AggregateDefinition<
      { status: string },
      { dispatched: { dispatchId: string }; received: { receivedAt: string } }
    > = {
      __aggregateType: 'shipment',
      initialState: { status: 'pending' },
      pure: { eventProjectors: {} }
    } as any;

    const projection = createProjection('chained-joins', () => ({ total: 0 }))
      .from(invoiceAgg, {
        created: (state, event) => {
          const _invoiceId: string = event.payload.invoiceId;
        }
      })
      .join(orderAgg, {
        shipped: (state, event) => {
          // Should have OrderShippedPayload, NOT OrderDeliveredPayload or others
          const _trackingNumber: string = event.payload.trackingNumber;
        }
      })
      .join(shipmentAgg, {
        dispatched: (state, event) => {
          // Should have { dispatchId: string }, NOT anything from orderAgg
          const _dispatchId: string = event.payload.dispatchId;
        }
      })
      .build();

    expect(projection.name).toBe('chained-joins');
  });

  it('should allow accessing state in both .from() and .join() handlers', () => {
    interface CombinedState {
      invoiceTotal: number;
      orderCount: number;
    }

    const projection = createProjection<CombinedState>('combined', () => ({
      invoiceTotal: 0,
      orderCount: 0
    }))
      .from(invoiceAgg, {
        created: (state, event) => {
          // Access and mutate from the state
          state.invoiceTotal += event.payload.amount;
        }
      })
      .join(orderAgg, {
        shipped: (state, event) => {
          // Access different part of the same state
          state.orderCount += 1;
        }
      })
      .build();

    expect(projection.name).toBe('combined');
  });

  it('should infer event types correctly for partial handlers', () => {
    // Only handling one event type - should still infer correctly
    const projection = createProjection('partial-handlers', () => ({ total: 0 }))
      .from(invoiceAgg, {
        created: (state, event) => {
          // Only handling 'created', should get InvoiceCreatedPayload
          const _invoiceId: string = event.payload.invoiceId;
        }
      })
      .build();

    expect(projection.name).toBe('partial-handlers');
  });

  it('should work with empty handlers object', () => {
    const projection = createProjection('empty-handlers', () => ({ total: 0 }))
      .from(invoiceAgg, {})
      .build();

    expect(projection.name).toBe('empty-handlers');
  });
});

// ============================================================================
// Tests: Compile-time type verification (no runtime impact)
// ============================================================================

describe('Compile-time Type Verification', () => {
  // These tests verify TypeScript will error on incorrect types
  // They use expect statements that would fail at compile time if types were wrong

  it('verifies that event.payload has correct properties in .from() handlers', () => {
    createProjection('verify-types', () => ({ total: 0 }))
      .from(invoiceAgg, {
        created: (state, event) => {
          // Verify we can access all InvoiceCreatedPayload properties
          expect(event.payload.invoiceId).toBeDefined();
          expect(event.payload.amount).toBeDefined();
        }
      })
      .build();
  });

  it('verifies that event.payload has correct properties in .join() handlers', () => {
    createProjection('verify-join-types', () => ({ total: 0 }))
      .from(invoiceAgg, { created: (state, event) => {} })
      .join(orderAgg, {
        shipped: (state, event) => {
          // Verify we can access all OrderShippedPayload properties
          expect(event.payload.orderId).toBeDefined();
          expect(event.payload.trackingNumber).toBeDefined();
          expect(event.payload.shippedAt).toBeDefined();
        }
      })
      .build();
  });

  it('verifies state mutation works in handlers', () => {
    createProjection('verify-state', () => ({ total: 0 }))
      .from(invoiceAgg, {
        created: (state, event) => {
          // Mutate state - this should work with Immer's Draft
          state.total = event.payload.amount;
          state.total += event.payload.amount;
        }
      })
      .build();
  });

  it('narrows event.type to handler key or canonical key in .from() handlers', () => {
    createProjection('verify-from-event-type', () => ({ total: 0 }))
      .from(invoiceAgg, {
        created: (state, event) => {
          const _literal: 'created' | 'invoice.created.event' = event.type;
          expect(_literal).toBeDefined();
          // @ts-expect-error event.type should not narrow to unrelated literal
          const _invalid: 'paid' = event.type;
        }
      })
      .build();
  });

  it('narrows event.type to handler key or canonical key in .join() handlers', () => {
    createProjection('verify-join-event-type', () => ({ total: 0 }))
      .from(invoiceAgg, { created: () => {} })
      .join(orderAgg, {
        shipped: (state, event) => {
          const _literal: 'shipped' | 'order.shipped.event' = event.type;
          expect(_literal).toBeDefined();
          // @ts-expect-error event.type should not narrow to unrelated literal
          const _invalid: 'delivered' = event.type;
        }
      })
      .build();
  });
});
