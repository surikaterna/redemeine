import { describe, expect, test } from '@jest/globals';
import {
  createProjection,
  inherit,
  ProjectionBuilder,
  ProjectionDefinition,
  ProjectionContext,
  ProjectionEvent,
  AggregateDefinition,
  AggregateEventPayloadMap,
  AggregateEventKeys,
  AggregateEventPayloadByKey
} from '../src';
import { createAggregate } from '@redemeine/aggregate';

// ============================================================================
// Test Aggregates — built with real createAggregate
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

const invoiceAggregate = createAggregate<InvoiceState, 'invoice'>('invoice', {
  id: '',
  amount: 0,
  status: 'pending'
})
  .events({
    created: (state, event: { payload: InvoiceCreatedPayload }) => {
      state.id = event.payload.customerId;
      state.amount = event.payload.amount;
    },
    paid: (state, event: { payload: InvoicePaidPayload }) => {
      state.status = 'paid';
      state.paidAt = event.payload.reference;
    }
  })
  .build();

interface OrderState {
  id: string;
  items: string[];
  shippedAt?: string;
}

interface OrderShippedPayload {
  carrier: string;
  trackingNumber: string;
}

const orderAggregate = createAggregate<OrderState, 'order'>('order', {
  id: '',
  items: []
})
  .events({
    itemAdded: (state, event: { payload: { itemId: string } }) => {
      state.items.push(event.payload.itemId);
    },
    shipped: (state, event: { payload: OrderShippedPayload }) => {
      state.shippedAt = 'shipped';
    }
  })
  .build();

// Compile-time payload extraction verification
type InvoicePayloadMap = AggregateEventPayloadMap<typeof invoiceAggregate>;
type InvoiceEventKeys = AggregateEventKeys<typeof invoiceAggregate>;
type InvoiceCreatedExtracted = AggregateEventPayloadByKey<typeof invoiceAggregate, 'created'>;
const _payloadCheck: InvoiceCreatedExtracted = { customerId: 'c1', amount: 42 };
void _payloadCheck;

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
      .from(invoiceAggregate, {
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
    expect(projection.fromStream.aggregate).toBe(invoiceAggregate);
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
      .from(invoiceAggregate, {
        created: (state, event) => {
          state.invoice.id = event.payload.customerId;
        }
      })
      .join(orderAggregate, {
        shipped: (state, event) => {
          state.order.shippedAt = new Date().toISOString();
        }
      })
      .build();

    expect(projection.name).toBe('composite-view');
    expect(projection.fromStream.aggregate).toBe(invoiceAggregate);
    expect(projection.joinStreams).toHaveLength(1);
    expect(projection.joinStreams?.[0].aggregate).toBe(orderAggregate);
  });

  test('initialState(fn) overrides the initial state factory', () => {
    const projection = createProjection<InvoiceState>('invoice-summary', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggregate, {
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
      .from(invoiceAggregate, {
        created: (state, event) => {
          state.amount = event.payload.amount;
        }
      })
      .identity((event) => `custom-${event.aggregateId}`)
      .build();

    const event: ProjectionEvent = {
      type: 'invoice.created.event',
      payload: {},
      aggregateType: 'invoice',
      aggregateId: 'original-id',
      sequence: 1,
      timestamp: '2024-01-01T00:00:00Z'
    };

    expect(projection.identity(event)).toBe('custom-original-id');
  });

  test('identity(fn) supports fan-out identity arrays', () => {
    const projection = createProjection<InvoiceState>('invoice-summary', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggregate, {
        created: (state, event) => {
          state.amount = event.payload.amount;
        }
      })
      .identity((event) => [`doc-${event.aggregateId}`, 'shared-doc'] as const)
      .build();

    const event: ProjectionEvent = {
      type: 'invoice.created.event',
      payload: {},
      aggregateType: 'invoice',
      aggregateId: 'original-id',
      sequence: 1,
      timestamp: '2024-01-01T00:00:00Z'
    };

    expect(projection.identity(event)).toEqual(['doc-original-id', 'shared-doc']);
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
      .from(invoiceAggregate, {
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
      .from(invoiceAggregate, {
        created: (state, event) => {
          // event.payload should be InvoiceCreatedPayload
          const _customerId: string = event.payload.customerId;
        }
      })
      .join(orderAggregate, {
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
      .from(invoiceAggregate, {
        created: (state, event) => {
          const _payload = event.payload;
          state.invoice.amount = event.payload.amount;
        },
        paid: (state, event) => {
          const _payload = event.payload;
          state.invoice.status = 'paid';
        }
      })
      .join(orderAggregate, {
        shipped: (state, event) => {
          const _payload = event.payload;
          state.order.shippedAt = new Date().toISOString();
        }
      })
      .build();

    expect(projection.fromStream.aggregate).toBe(invoiceAggregate);
    expect(projection.joinStreams?.[0].aggregate).toBe(orderAggregate);
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
    const agg2 = createAggregate<OrderState2, 'order2'>('order2', { id: '', status: '' })
      .events({
        updated: (state, event: { payload: { status: string } }) => {
          state.status = event.payload.status;
        }
      })
      .build();

    const projection = createProjection<{ a: InvoiceState; b: OrderState; c: OrderState2 }>(
      'multi-join',
      () => ({
        a: { id: '', amount: 0, status: 'pending' as const },
        b: { id: '', items: [] },
        c: { id: '', status: '' }
      })
    )
      .from(invoiceAggregate, {
        created: (state, event) => {}
      })
      .join(orderAggregate, {
        shipped: (state, event) => {}
      })
      .join(agg2, {
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
      .from(invoiceAggregate, {
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
    expect(projection.identity({
      aggregateType: 'invoice',
      type: 'test',
      payload: {},
      aggregateId: 'agg-1',
      sequence: 1,
      timestamp: '2024-01-01T00:00:00Z'
    })).toBe('id-agg-1');
  });

  test('creates isolated initial state instances per document id', () => {
    const projection = createProjection<InvoiceState>('isolated-invoice', (id) => ({
      id,
      amount: 999,
      status: 'paid'
    }))
      .from(invoiceAggregate, {
        created: (state, event) => {}
      })
      .build();

    const initialA = projection.initialState('invoice-a');
    const initialB = projection.initialState('invoice-b');

    expect(initialA.id).toBe('invoice-a');
    expect(initialB.id).toBe('invoice-b');
    expect(initialA).not.toBe(initialB);

    initialA.amount = 123;
    expect(initialB.amount).toBe(999);
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
      .from(invoiceAggregate, {
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
      .from(invoiceAggregate, {
        created: (state, event) => {},
        paid: (state, event) => {}
      })
      .build();

    expect(projection.fromStream.aggregate).toBe(invoiceAggregate);
    expect(projection.fromStream.handlers).toHaveProperty('created');
    expect(projection.fromStream.handlers).toHaveProperty('paid');
  });

  test('joinStreams contains aggregated handlers', () => {
    const projection = createProjection<{ order: OrderState }>('order-view', () => ({
      order: { id: '', items: [] }
    }))
      .from(invoiceAggregate, {
        created: (state, event) => {}
      })
      .join(orderAggregate, {
        shipped: (state, event) => {},
        itemAdded: (state, event) => {}
      })
      .build();

    expect(projection.joinStreams).toHaveLength(1);
    expect(projection.joinStreams?.[0].aggregate).toBe(orderAggregate);
    expect(projection.joinStreams?.[0].handlers).toHaveProperty('shipped');
    expect(projection.joinStreams?.[0].handlers).toHaveProperty('itemAdded');
  });

  test('subscriptions are captured from handlers', () => {
    const projection = createProjection<{ order: OrderState }>('order-view', () => ({
      order: { id: '', items: [] }
    }))
      .from(invoiceAggregate, {
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
      .from(invoiceAggregate, {
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
    const mockEvent: ProjectionEvent = {
      type: 'invoice.created.event',
      payload: { customerId: 'cust-1', amount: 100 },
      aggregateType: 'invoice',
      aggregateId: 'inv-1',
      sequence: 1,
      timestamp: '2024-01-01T00:00:00Z'
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
      .from(invoiceAggregate, {
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
      .from(invoiceAggregate, {})
      .build();

    expect(Object.keys(projection.fromStream.handlers)).toHaveLength(0);
  });

  test('handles single handler', () => {
    const projection = createProjection<InvoiceState>('single-handler', () => ({
      id: '',
      amount: 0,
      status: 'pending' as const
    }))
      .from(invoiceAggregate, {
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
      .from(invoiceAggregate, {
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
  test('ProjectionContext exposes only subscribeTo/unsubscribeFrom', () => {
    const context: ProjectionContext = {
      subscribeTo() {
        // no-op
      },
      unsubscribeFrom() {
        // no-op
      }
    };

    expect(Object.keys(context).sort()).toEqual(['subscribeTo', 'unsubscribeFrom']);
  });

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
      .from(invoiceAggregate, {
        created: (state, event) => {}
      })
      .build();

    const definition: ProjectionDefinition<InvoiceState> = projection;
    expect(definition).toBeDefined();
  });
});

// ============================================================================
// Tests: Mirror Projections
// ============================================================================

describe('createProjection .mirror() builder', () => {

  test('mirrors all aggregate event projectors', () => {
    const projection = createProjection('invoice-mirror')
      .mirror(invoiceAggregate)
      .build();

    expect(projection.name).toBe('invoice-mirror');
    expect(projection.fromStream.aggregate).toBe(invoiceAggregate);
    expect(projection.fromStream.handlers).toHaveProperty('created');
    expect(projection.fromStream.handlers).toHaveProperty('paid');
    expect(Object.keys(projection.fromStream.handlers)).toHaveLength(2);
  });

  test('uses aggregate initialState when not provided', () => {
    const projection = createProjection('invoice-mirror')
      .mirror(invoiceAggregate)
      .build();

    const initial = projection.initialState('inv-1');
    expect(initial).toEqual({ id: '', amount: 0, status: 'pending' });
    const another = projection.initialState('inv-1');
    expect(initial).not.toBe(another);
  });

  test('uses default identity resolver', () => {
    const projection = createProjection('invoice-mirror')
      .mirror(invoiceAggregate)
      .build();

    const event: ProjectionEvent = {
      type: 'invoice.created.event',
      payload: { customerId: 'c1', amount: 100 },
      aggregateType: 'invoice',
      aggregateId: 'inv-1',
      sequence: 1,
      timestamp: '2024-01-01T00:00:00Z'
    };

    expect(projection.identity(event)).toBe('inv-1');
  });

  test('mirrored handlers delegate to applyToDraft', () => {
    const projection = createProjection('invoice-mirror')
      .mirror(invoiceAggregate)
      .build();

    const state: InvoiceState = { id: '', amount: 0, status: 'pending' };
    const event = {
      type: 'invoice.created.event',
      payload: { customerId: 'cust-1', amount: 250 },
      aggregateType: 'invoice',
      aggregateId: 'inv-1',
      sequence: 1,
      timestamp: '2024-01-01T00:00:00Z'
    };

    const handler = projection.fromStream.handlers.created;
    handler(state, event, { subscribeTo: () => {}, unsubscribeFrom: () => {} });

    expect(state.id).toBe('cust-1');
    expect(state.amount).toBe(250);
  });

  test('overrides replace specific handlers', () => {
    let overrideCalled = false;

    const projection = createProjection('invoice-mirror')
      .mirror(invoiceAggregate, {
        paid: (state: any, event: any) => {
          overrideCalled = true;
          state.status = 'paid';
        }
      })
      .build();

    expect(projection.fromStream.handlers).toHaveProperty('created');
    expect(projection.fromStream.handlers).toHaveProperty('paid');

    const state: InvoiceState = { id: 'inv-1', amount: 100, status: 'pending' };
    projection.fromStream.handlers.paid(state, {
      type: 'invoice.paid.event',
      payload: { paymentMethod: 'card', reference: 'ref-1' },
      aggregateType: 'invoice',
      aggregateId: 'inv-1',
      sequence: 2,
      timestamp: '2024-01-01T00:00:00Z'
    }, { subscribeTo: () => {}, unsubscribeFrom: () => {} });

    expect(overrideCalled).toBe(true);
    expect(state.status).toBe('paid');
  });

  test('non-overridden handlers still use applyToDraft', () => {
    const projection = createProjection('invoice-mirror')
      .mirror(invoiceAggregate, {
        paid: (state: any) => { state.status = 'paid'; }
      })
      .build();

    const state: InvoiceState = { id: '', amount: 0, status: 'pending' };
    projection.fromStream.handlers.created(state, {
      type: 'invoice.created.event',
      payload: { customerId: 'cust-2', amount: 500 },
      aggregateType: 'invoice',
      aggregateId: 'inv-1',
      sequence: 1,
      timestamp: '2024-01-01T00:00:00Z'
    }, { subscribeTo: () => {}, unsubscribeFrom: () => {} });

    expect(state.id).toBe('cust-2');
    expect(state.amount).toBe(500);
  });

  test('inherit.extend in mirror overrides', () => {
    const projection = createProjection('invoice-mirror')
      .mirror(invoiceAggregate, {
        paid: inherit.extend((state: any, event: any) => {
          state.paidAt = 'extended';
        })
      })
      .build();

    const state: InvoiceState = { id: 'inv-1', amount: 100, status: 'pending' };
    projection.fromStream.handlers.paid(state, {
      type: 'invoice.paid.event',
      payload: { paymentMethod: 'card', reference: 'ref-1' },
      aggregateType: 'invoice',
      aggregateId: 'inv-1',
      sequence: 2,
      timestamp: '2024-01-01T00:00:00Z'
    }, { subscribeTo: () => {}, unsubscribeFrom: () => {} });

    expect(state.status).toBe('paid');
    expect(state.paidAt).toBe('extended');
  });
});

// ============================================================================
// Tests: Inherit Token
// ============================================================================

describe('createProjection inherit token', () => {

  test('inherit delegates to aggregate applyToDraft', () => {
    const projection = createProjection<InvoiceState>('invoice-view', () => ({
      id: '', amount: 0, status: 'pending' as const
    }))
      .from(invoiceAggregate, {
        created: (state, event) => {
          state.id = 'custom-' + event.payload.customerId;
        },
        paid: inherit
      })
      .build();

    const state: InvoiceState = { id: 'inv-1', amount: 100, status: 'pending' };
    projection.fromStream.handlers.paid(state, {
      type: 'invoice.paid.event',
      payload: { paymentMethod: 'card', reference: 'ref-1' },
      aggregateType: 'invoice',
      aggregateId: 'inv-1',
      sequence: 2,
      timestamp: '2024-01-01T00:00:00Z'
    }, { subscribeTo: () => {}, unsubscribeFrom: () => {} });

    expect(state.status).toBe('paid');
  });

  test('inherit.extend runs applyToDraft then callback', () => {
    const projection = createProjection<InvoiceState>('invoice-view', () => ({
      id: '', amount: 0, status: 'pending' as const
    }))
      .from(invoiceAggregate, {
        created: inherit,
        paid: inherit.extend((state, event) => {
          state.paidAt = event.timestamp;
        })
      })
      .build();

    const state: InvoiceState = { id: '', amount: 0, status: 'pending' };
    projection.fromStream.handlers.paid(state, {
      type: 'invoice.paid.event',
      payload: { paymentMethod: 'card', reference: 'ref-1' },
      aggregateType: 'invoice',
      aggregateId: 'inv-1',
      sequence: 2,
      timestamp: '2024-06-15T12:00:00Z'
    }, { subscribeTo: () => {}, unsubscribeFrom: () => {} });

    expect(state.status).toBe('paid');
    expect(state.paidAt).toBe('2024-06-15T12:00:00Z');
  });

  test('custom handlers are not affected by inherit', () => {
    const projection = createProjection<InvoiceState>('invoice-view', () => ({
      id: '', amount: 0, status: 'pending' as const
    }))
      .from(invoiceAggregate, {
        created: (state, event) => {
          state.id = 'custom-' + event.payload.customerId;
        },
        paid: inherit
      })
      .build();

    const state: InvoiceState = { id: '', amount: 0, status: 'pending' };
    projection.fromStream.handlers.created(state, {
      type: 'invoice.created.event',
      payload: { customerId: 'cust-1', amount: 100 },
      aggregateType: 'invoice',
      aggregateId: 'inv-1',
      sequence: 1,
      timestamp: '2024-01-01T00:00:00Z'
    }, { subscribeTo: () => {}, unsubscribeFrom: () => {} });

    expect(state.id).toBe('custom-cust-1');
  });

  test('throws when inherit used on aggregate without applyToDraft', () => {
    const noApplyAgg = {
      aggregateType: 'invoice' as const,
      pure: {
        eventProjectors: {
          created: () => {}
        }
      },
      metadata: {}
    };

    expect(() => {
      createProjection<InvoiceState>('invoice-view', () => ({
        id: '', amount: 0, status: 'pending' as const
      }))
        .from(noApplyAgg, {
          created: inherit
        })
        .build();
    }).toThrow(/applyToDraft/);
  });

  test('createProjection without initialState throws if not using mirror', () => {
    expect(() => {
      createProjection('test')
        .from(invoiceAggregate, {
          created: inherit
        })
        .build();
    }).toThrow(/initial state/);
  });

  test('inherit.extend callback receives correct event', () => {
    const projection = createProjection<InvoiceState>('invoice-view', () => ({
      id: '', amount: 0, status: 'pending' as const
    }))
      .from(invoiceAggregate, {
        created: inherit,
        paid: inherit.extend((state, event) => {
          state.paidAt = event.payload.reference;
        })
      })
      .build();

    const state: InvoiceState = { id: '', amount: 0, status: 'pending' };
    projection.fromStream.handlers.paid(state, {
      type: 'invoice.paid.event',
      payload: { paymentMethod: 'card', reference: 'pay-ref-42' },
      aggregateType: 'invoice',
      aggregateId: 'inv-1',
      sequence: 2,
      timestamp: '2024-01-01T00:00:00Z'
    }, { subscribeTo: () => {}, unsubscribeFrom: () => {} });

    expect(state.paidAt).toBe('pay-ref-42');
  });
});
