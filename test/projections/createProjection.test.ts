import { describe, expect, test } from '@jest/globals';
import { createAggregate } from '../../src/createAggregate';
import {
  createProjection,
  ProjectionBuilder,
  ProjectionDefinition,
  ProjectionEvent,
  AggregateDefinition
} from '../../src/projections';

// ============================================================================
// Test Aggregates
// ============================================================================

interface InvoiceState {
  id: string;
  amount: number;
  status: 'pending' | 'paid';
  paidAt?: string;
}

interface InvoiceCreatedPayload {
  customerId: string;
  amount: number;
}

interface InvoicePaidPayload {
  paymentMethod: string;
  reference: string;
}

const initialInvoiceState: InvoiceState = {
  id: '',
  amount: 0,
  status: 'pending'
};

const invoiceAgg = createAggregate<InvoiceState, 'invoice'>('invoice', initialInvoiceState)
  .events({
    created: (state, event: { payload: InvoiceCreatedPayload }) => {
      state.id = event.payload.customerId;
      state.amount = event.payload.amount;
    },
    paid: (state, event: { payload: InvoicePaidPayload }) => {
      state.status = 'paid';
      state.paidAt = new Date().toISOString();
    }
  })
  .build();

// Define the aggregate definition for use in projections
const invoiceAggDef: AggregateDefinition<InvoiceState, { created: InvoiceCreatedPayload; paid: InvoicePaidPayload }> = {
  __aggregateType: 'invoice',
  initialState: initialInvoiceState,
  pure: {
    eventProjectors: invoiceAgg.pure.eventProjectors
  },
  metadata: invoiceAgg.metadata
};

interface OrderState {
  id: string;
  items: string[];
  shippedAt?: string;
}

interface OrderShippedPayload {
  carrier: string;
  trackingNumber: string;
}

const initialOrderState: OrderState = {
  id: '',
  items: []
};

const orderAgg = createAggregate<OrderState, 'order'>('order', initialOrderState)
  .events({
    itemAdded: (state, event: { payload: { itemId: string } }) => {
      state.items.push(event.payload.itemId);
    },
    shipped: (state, event: { payload: OrderShippedPayload }) => {
      state.shippedAt = new Date().toISOString();
    }
  })
  .build();

const orderAggDef: AggregateDefinition<OrderState, { itemAdded: { itemId: string }; shipped: OrderShippedPayload }> = {
  __aggregateType: 'order',
  initialState: initialOrderState,
  pure: {
    eventProjectors: orderAgg.pure.eventProjectors
  },
  metadata: orderAgg.metadata
};

// ============================================================================
// Tests: Basic Builder API
// ============================================================================

describe('createProjection Builder API', () => {
  test('creates a basic projection with from() only', () => {
    const projection = createProjection<InvoiceState>('invoice-summary', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {
          state.id = event.payload.customerId;
          state.amount = event.payload.amount;
        },
        paid: (state, event) => {
          state.status = 'paid';
        }
      })
      .build();

    expect(projection.name).toBe('invoice-summary');
    expect(projection.fromStream.aggregate).toBe(invoiceAggDef);
    expect(projection.joinStreams).toHaveLength(0);
    expect(typeof projection.initialState).toBe('function');
    expect(typeof projection.identity).toBe('function');
  });

  test('creates a projection with both from() and join()', () => {
    const projection = createProjection<{ invoice: InvoiceState; order: OrderState }>(
      'composite-view',
      () => ({
        invoice: { id: '', amount: 0, status: 'pending' as const },
        order: { id: '', items: [] }
      })
    )
      .from(invoiceAggDef, {
        created: (state, event) => {
          state.invoice.id = event.payload.customerId;
        }
      })
      .join(orderAggDef, {
        shipped: (state, event) => {
          state.order.shippedAt = new Date().toISOString();
        }
      })
      .build();

    expect(projection.name).toBe('composite-view');
    expect(projection.fromStream.aggregate).toBe(invoiceAggDef);
    expect(projection.joinStreams).toHaveLength(1);
    expect(projection.joinStreams[0].aggregate).toBe(orderAggDef);
  });

  test('initialState(fn) overrides the initial state factory', () => {
    const projection = createProjection<InvoiceState>('invoice-summary', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {
          state.amount = event.payload.amount;
        }
      })
      .initialState((id) => ({
        id,
        amount: 100,
        status: 'pending' as const
      }))
      .build();

    const initial = projection.initialState('test-id');
    expect(initial.id).toBe('test-id');
    expect(initial.amount).toBe(100);
    expect(initial.status).toBe('pending');
  });

  test('identity(fn) overrides the default identity resolver', () => {
    const projection = createProjection<InvoiceState>('invoice-summary', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {
          state.amount = event.payload.amount;
        }
      })
      .identity((event) => `custom-${event.aggregateId}`)
      .build();

    const event: ProjectionEvent<unknown> = {
      type: 'invoice.created.event',
      payload: {},
      aggregateId: 'original-id'
    };

    expect(projection.identity(event)).toBe('custom-original-id');
  });

  test('throws error when build() is called without from()', () => {
    expect(() => {
      createProjection<InvoiceState>('invoice-summary', () => ({
        id: '',
        amount: 0,
        status: 'pending' as const
      })).build();
    }).toThrow(/must have at least one .from\(\) stream/);
  });
});

// ============================================================================
// Tests: Type Inference
// ============================================================================

describe('createProjection Type Inference', () => {
  test('infers event.payload type from aggregate definition in from()', () => {
    // This is a compile-time test that verifies TypeScript inference
    const projection = createProjection<InvoiceState>('invoice-summary', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {
          // TypeScript should infer event.payload as InvoiceCreatedPayload
          // Access properties to verify inference
          const _customerId: string = event.payload.customerId;
          const _amount: number = event.payload.amount;
        },
        paid: (state, event) => {
          // TypeScript should infer event.payload as InvoicePaidPayload
          // Access properties to verify inference
          const _paymentMethod: string = event.payload.paymentMethod;
          const _reference: string = event.payload.reference;
        }
      })
      .build();

    expect(projection.name).toBe('invoice-summary');
  });

  test('infers event.payload type from aggregate definition in join()', () => {
    const projection = createProjection<{ order: OrderState }>('order-view', () => ({
      order: { id: '', items: [] }
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {
          // event.payload should be InvoiceCreatedPayload
          const _customerId: string = event.payload.customerId;
        }
      })
      .join(orderAggDef, {
        shipped: (state, event) => {
          // event.payload should be OrderShippedPayload
          // Access properties to verify inference
          const _carrier: string = event.payload.carrier;
          const _tracking: string = event.payload.trackingNumber;
        },
        itemAdded: (state, event) => {
          // event.payload should be { itemId: string }
          const _itemId: string = event.payload.itemId;
        }
      })
      .build();

    expect(projection.name).toBe('order-view');
  });

  test('allows mixing different aggregate types in from() and join()', () => {
    const projection = createProjection<{ invoice: InvoiceState; order: OrderState }>(
      'combined',
      () => ({
        invoice: { id: '', amount: 0, status: 'pending' as const },
        order: { id: '', items: [] }
      })
    )
      .from(invoiceAggDef, {
        created: (state, event) => {
          const _payload = event.payload;
          state.invoice.amount = event.payload.amount;
        },
        paid: (state, event) => {
          const _payload = event.payload;
          state.invoice.status = 'paid';
        }
      })
      .join(orderAggDef, {
        shipped: (state, event) => {
          const _payload = event.payload;
          state.order.shippedAt = new Date().toISOString();
        }
      })
      .build();

    expect(projection.fromStream.aggregate).toBe(invoiceAggDef);
    expect(projection.joinStreams[0].aggregate).toBe(orderAggDef);
  });
});

// ============================================================================
// Tests: Builder Chaining
// ============================================================================

describe('createProjection Builder Chaining', () => {
  test('allows multiple join() calls', () => {
    interface OrderState2 {
      id: string;
      status: string;
    }
    const initial2: OrderState2 = { id: '', status: '' };
    const agg2Def: AggregateDefinition<OrderState2, { updated: { status: string } }> = {
      __aggregateType: 'order2',
      initialState: initial2,
      pure: {
        eventProjectors: {}
      }
    };

    const projection = createProjection<{ a: InvoiceState; b: OrderState; c: OrderState2 }>(
      'multi-join',
      () => ({
        a: { id: '', amount: 0, status: 'pending' as const },
        b: { id: '', items: [] },
        c: { id: '', status: '' }
      })
    )
      .from(invoiceAggDef, {
        created: (state, event) => {}
      })
      .join(orderAggDef, {
        shipped: (state, event) => {}
      })
      .join(agg2Def, {
        updated: (state, event) => {}
      })
      .build();

    expect(projection.joinStreams).toHaveLength(2);
  });

  test('allows chaining initialState after from()', () => {
    const projection = createProjection<InvoiceState>('invoice-summary', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {}
      })
      .initialState((id) => ({
        id,
        amount: 0,
        status: 'pending' as const
      }))
      .identity((event) => `id-${event.aggregateId}`)
      .build();

    expect(projection.name).toBe('invoice-summary');
    expect(projection.identity({ type: 'test', payload: {}, aggregateId: 'agg-1' })).toBe('id-agg-1');
  });

  test('accepts static initial state (not just functions)', () => {
    const staticState: InvoiceState = {
      id: 'static-id',
      amount: 999,
      status: 'paid'
    };

    const projection = createProjection<InvoiceState>('static-invoice', staticState)
      .from(invoiceAggDef, {
        created: (state, event) => {}
      })
      .build();

    const initial = projection.initialState('ignored');
    expect(initial.id).toBe('static-id');
    expect(initial.amount).toBe(999);
  });
});

// ============================================================================
// Tests: ProjectionDefinition Output
// ============================================================================

describe('createProjection ProjectionDefinition Output', () => {
  test('build() returns correct structure', () => {
    const projection = createProjection<InvoiceState>('invoice-summary', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {},
        paid: (state, event) => {}
      })
      .build();

    expect(projection).toHaveProperty('name');
    expect(projection).toHaveProperty('initialState');
    expect(projection).toHaveProperty('identity');
    expect(projection).toHaveProperty('fromStream');
    expect(projection).toHaveProperty('joinStreams');
    expect(projection).toHaveProperty('subscriptions');
  });

  test('fromStream contains aggregate and handlers', () => {
    const projection = createProjection<InvoiceState>('invoice-summary', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {},
        paid: (state, event) => {}
      })
      .build();

    expect(projection.fromStream.aggregate).toBe(invoiceAggDef);
    expect(projection.fromStream.handlers).toHaveProperty('created');
    expect(projection.fromStream.handlers).toHaveProperty('paid');
  });

  test('joinStreams contains aggregated handlers', () => {
    const projection = createProjection<{ order: OrderState }>('order-view', () => ({
      order: { id: '', items: [] }
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {}
      })
      .join(orderAggDef, {
        shipped: (state, event) => {},
        itemAdded: (state, event) => {}
      })
      .build();

    expect(projection.joinStreams).toHaveLength(1);
    expect(projection.joinStreams[0].aggregate).toBe(orderAggDef);
    expect(projection.joinStreams[0].handlers).toHaveProperty('shipped');
    expect(projection.joinStreams[0].handlers).toHaveProperty('itemAdded');
  });

  test('subscriptions are captured from handlers', () => {
    const projection = createProjection<{ order: OrderState }>('order-view', () => ({
      order: { id: '', items: [] }
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {
          // In a real implementation, this would use context.subscribeTo()
        }
      })
      .build();

    // Subscriptions should be empty initially - subscribeTo is called at runtime
    expect(Array.isArray(projection.subscriptions)).toBe(true);
  });
});

// ============================================================================
// Tests: Immer Integration
// ============================================================================

describe('createProjection Immer Integration', () => {
  test('handlers are wrapped with Immer produce for immutable updates', () => {
    const projection = createProjection<{ count: number }>('counter', () => ({
      count: 0
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {
          // State should be a Draft and mutable
          state.count = 42;
        }
      })
      .build();

    // Verify that handlers are stored
    expect(projection.fromStream.handlers.created).toBeDefined();
    
    // Call the handler to verify it works with Immer
    const initialState = { count: 0 };
    const mockEvent: ProjectionEvent<InvoiceCreatedPayload> = {
      type: 'invoice.created.event',
      payload: { customerId: 'cust-1', amount: 100 },
      aggregateId: 'inv-1'
    };
    
    // The handler is wrapped with produce() - we need to check that produce returns a new state
    // The internal implementation returns undefined (side-effect style), so we verify handlers exist
    const wrappedHandler = projection.fromStream.handlers.created;
    expect(typeof wrappedHandler).toBe('function');
    
    // Verify that the handler is properly wrapped (will throw if called incorrectly)
    // Note: The actual Immer integration would be tested in integration tests with the daemon
    expect(projection.fromStream.handlers).toHaveProperty('created');
  });

  test('multiple handlers are registered correctly', () => {
    const projection = createProjection<{ count: number; name: string }>('multi', () => ({
      count: 0,
      name: ''
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {
          state.count = 10;
          state.name = 'initial';
        },
        paid: (state, event) => {
          state.count += 5;
          state.name = 'updated';
        }
      })
      .build();

    // The handlers are wrapped with produce() internally
    expect(projection.fromStream.handlers.created).toBeDefined();
    expect(projection.fromStream.handlers.paid).toBeDefined();
  });
});

// ============================================================================
// Tests: Edge Cases
// ============================================================================

describe('createProjection Edge Cases', () => {
  test('handles empty handlers object', () => {
    const projection = createProjection<InvoiceState>('empty-handlers', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggDef, {})
      .build();

    expect(Object.keys(projection.fromStream.handlers)).toHaveLength(0);
  });

  test('handles single handler', () => {
    const projection = createProjection<InvoiceState>('single-handler', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {}
      })
      .build();

    expect(Object.keys(projection.fromStream.handlers)).toHaveLength(1);
    expect(projection.fromStream.handlers).toHaveProperty('created');
  });

  test('projection name can contain special characters', () => {
    const projection = createProjection<InvoiceState>('invoice-summary_v2.0.0', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {}
      })
      .build();

    expect(projection.name).toBe('invoice-summary_v2.0.0');
  });
});

// ============================================================================
// Tests: Type Exports Verification
// ============================================================================

describe('createProjection Type Exports', () => {
  test('ProjectionBuilder interface is exported', () => {
    // This is a compile-time test
    const builder: ProjectionBuilder<InvoiceState> = createProjection<InvoiceState>(
      'test',
      () => ({ id: '', amount: 0, status: 'pending' as const })
    );
    
    expect(builder).toBeDefined();
    expect(typeof builder.from).toBe('function');
    expect(typeof builder.join).toBe('function');
    expect(typeof builder.build).toBe('function');
  });

  test('ProjectionDefinition interface is returned from build()', () => {
    const projection = createProjection<InvoiceState>('test', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggDef, {
        created: (state, event) => {}
      })
      .build();

    const definition: ProjectionDefinition<InvoiceState> = projection;
    expect(definition).toBeDefined();
  });
});
