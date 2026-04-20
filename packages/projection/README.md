# @redemeine/projection

Type-safe read-model projections for Redemeine event-sourced aggregates.

## Overview

`@redemeine/projection` defines how domain events are folded into read-model documents. A projection declares which aggregate streams it consumes, how each event type mutates document state, and how events map to document identities. The package produces a `ProjectionDefinition` — a pure data structure that a runtime daemon (not included here) feeds events into.

The projection builder infers event payload types directly from your aggregate's `pure.eventProjectors`, so handler signatures stay in sync with the write model without manual type declarations.

Two mechanisms allow read models to reuse the write model's event projectors instead of duplicating the folding logic:

- **`createProjection.mirror()`** clones an entire aggregate's projectors into a projection, with optional per-event overrides.
- **`fallback`** in `.from()` selectively delegates individual event types back to the aggregate while keeping explicit handlers for the rest.

## Installation

```bash
bun add @redemeine/projection
```

Peer dependencies: `@redemeine/aggregate`.

## Quick Start

```typescript
import { createAggregate } from '@redemeine/aggregate';
import { createProjection } from '@redemeine/projection';

// --- Write model ---

interface InvoiceState {
  customerId: string;
  amount: number;
  status: 'draft' | 'sent' | 'paid';
}

const InvoiceAggregate = createAggregate<InvoiceState, 'invoice'>('invoice', {
  customerId: '',
  amount: 0,
  status: 'draft'
})
  .events({
    created: (state, event) => {
      state.customerId = event.payload.customerId;
      state.amount = event.payload.amount;
    },
    sent: (state) => { state.status = 'sent'; },
    paid: (state) => { state.status = 'paid'; }
  })
  .commands((emit) => ({
    create: (state, p: { customerId: string; amount: number }) =>
      emit.created(p),
    send: (state) => emit.sent(undefined),
    pay:  (state) => emit.paid(undefined)
  }))
  .build();

// --- Read model ---

interface InvoiceSummary {
  customerId: string;
  amount: number;
  status: string;
  paidAt: string | null;
}

const invoiceSummary = createProjection<InvoiceSummary>(
  'invoice-summary',
  () => ({ customerId: '', amount: 0, status: 'draft', paidAt: null })
)
  .from(InvoiceAggregate, {
    created: (state, event) => {
      state.customerId = event.payload.customerId;
      state.amount = event.payload.amount;
    },
    sent: (state) => {
      state.status = 'sent';
    },
    paid: (state, event) => {
      state.status = 'paid';
      state.paidAt = event.timestamp;
    }
  })
  .build();
```

The `event` parameter in each handler is fully typed — `event.payload` carries the exact payload shape declared on the aggregate's event projector for that key.

## Core Concepts

### Projection Definition

A projection definition is a plain object that describes:

| Field | Purpose |
|-------|---------|
| `name` | Unique identifier for this projection |
| `fromStream` | Primary aggregate stream + event handlers |
| `joinStreams` | Additional correlated streams |
| `initialState` | Factory that produces a fresh document for a given ID |
| `identity` | Maps an event to one or more document IDs |
| `hooks` | Cross-cutting lifecycle hooks |

The definition is inert data. It does not process events on its own — a runtime daemon reads this structure to wire up subscriptions and apply events.

### The Builder API

Projections are built using a fluent chain:

```typescript
createProjection<TState>(name, initialStateFn)
  .from(aggregate, handlers, options?)   // primary stream (required)
  .join(aggregate, handlers)             // correlated stream (optional, repeatable)
  .identity(fn)                          // custom document routing (optional)
  .initialState(fn)                      // override initial state (optional)
  .hooks({ afterEach })                  // lifecycle hooks (optional)
  .build()                               // -> ProjectionDefinition<TState>
```

### `.from()` — Primary Stream

Every projection has exactly one primary stream. The aggregate argument determines which event types are valid handler keys.

```typescript
.from(InvoiceAggregate, {
  created: (state, event) => {
    // event.payload: { customerId: string; amount: number }
    state.customerId = event.payload.customerId;
    state.amount = event.payload.amount;
  },
  paid: (state, event) => {
    // event.payload: { paymentMethod: string; reference: string }
    state.status = 'paid';
  }
})
```

Handler keys that do not match an event projector name on the aggregate cause a compile-time error. You can handle a subset of the aggregate's events — unhandled events are silently skipped at runtime.

### `.join()` — Correlated Streams

Join additional aggregate streams to enrich the projection with cross-aggregate data. Each `.join()` call adds a separate stream.

```typescript
const orderDashboard = createProjection<DashboardState>(
  'order-dashboard',
  () => ({ invoiceTotal: 0, shipmentCount: 0 })
)
  .from(InvoiceAggregate, {
    created: (state, event) => {
      state.invoiceTotal += event.payload.amount;
    }
  })
  .join(ShipmentAggregate, {
    dispatched: (state, event) => {
      state.shipmentCount += 1;
    }
  })
  .join(PaymentAggregate, {
    received: (state, event) => {
      // correlate payment with order
    }
  })
  .build();
```

Type inference works the same way in `.join()` as in `.from()` — each handler's `event.payload` is inferred from the joined aggregate's event projectors. Invalid handler keys are rejected at compile time.

### `event.type` Narrowing

Inside a handler, `event.type` is narrowed to the handler key or its canonical form. For example, inside a `created` handler on an `invoice` aggregate, `event.type` is typed as `'created' | 'invoice.created.event'`. This lets you discriminate events without string manipulation if you need to.

### Identity Resolution

By default, a projection routes events to documents using `event.aggregateId`. Override this with `.identity()`:

```typescript
// Route by a custom field
.identity((event) => event.payload.customerId)

// Fan-out: one event updates multiple documents
.identity((event) => [
  `customer-${event.payload.customerId}`,
  'global-summary'
])
```

The identity function can return a single string or an array of strings. When it returns an array, the event is applied to every listed document.

### Initial State

The initial state factory receives the document ID and returns a fresh state object. Each document gets its own copy — mutations in one document never leak to another.

```typescript
// Default: provided in createProjection()
createProjection<InvoiceView>('invoices', () => ({
  id: '',
  amount: 0,
  status: 'draft'
}))

// Override after construction
.initialState((documentId) => ({
  id: documentId,
  amount: 0,
  status: 'draft'
}))
```

### Hooks

The `afterEach` hook runs after every event handler, regardless of event type. Use it for cross-cutting concerns like metadata tracking.

```typescript
createProjection<OrderView>('orders', () => ({ /* ... */ lastUpdated: '' }))
  .from(OrderAggregate, { /* handlers */ })
  .hooks({
    afterEach: (state, event) => {
      state.lastUpdated = event.timestamp;
    }
  })
  .build();
```

The hook receives the mutable state draft and the raw event. It runs inside the same Immer `produce` pass as the handler, so mutations are safe.

## Reusing Aggregate Projectors

When the read model's state shape matches the write model, duplicating event-folding logic across both is maintenance overhead and a source of drift. The projection package provides two mechanisms to share projectors.

Both require the aggregate to expose `applyToDraft` — a function that applies an event to a mutable state draft without wrapping in Immer's `produce` (since the projection runtime already does that). Aggregates built with `createAggregate(...).build()` expose this automatically.

### `createProjection.mirror()`

Mirror creates a projection that defaults all handlers from the aggregate. The read model gets the exact same state shape and folding logic as the write model.

```typescript
const invoiceMirror = createProjection.mirror(
  InvoiceAggregate,
  'invoice-mirror'
);
```

This is equivalent to writing a `createProjection` that manually delegates every event to the aggregate — but without the boilerplate.

Mirror also clones the aggregate's `initialState` (via `structuredClone`), so each document starts from the same defaults.

#### Overriding Specific Handlers

Sometimes the read model needs slightly different behavior for certain events. Pass an `overrides` map to replace individual handlers while keeping the rest from the aggregate:

```typescript
const invoiceMirror = createProjection.mirror(
  InvoiceAggregate,
  'invoice-mirror',
  {
    overrides: {
      paid: (state, event) => {
        // Custom read-model logic for the paid event
        state.status = 'paid';
        state.paidAt = event.timestamp;
      }
    }
  }
);
```

Only `paid` uses custom logic. All other events (`created`, `sent`, etc.) still delegate to `InvoiceAggregate.applyToDraft`.

### `fallback` in `.from()`

Fallback is the inverse of mirror: the projection starts with *no* aggregate handlers, and you explicitly opt individual event types into delegation.

```typescript
const invoiceView = createProjection<InvoiceView>(
  'invoice-view',
  () => ({ customerId: '', amount: 0, status: 'draft', paidAt: null })
)
  .from(InvoiceAggregate, {
    // Custom handler for paid — read model adds paidAt timestamp
    paid: (state, event) => {
      state.status = 'paid';
      state.paidAt = event.timestamp;
    }
  }, {
    // Delegate created and sent to the aggregate's projectors
    fallback: { created: true, sent: true }
  })
  .build();
```

#### Mutual Exclusivity

An event type cannot appear in both the explicit handlers and the fallback map. This is enforced at two levels:

1. **Type-level**: The `fallback` map's keys are typed as `Exclude<AggregateEventKeys, keyof Handlers>`. If you add `created` to both places, TypeScript reports an error.
2. **Runtime**: If you bypass the type system (e.g., via `as any`), the builder throws:

```
Projection 'invoice-view': event 'created' cannot appear in both
handlers and fallback. Declare it in one place only.
```

The builder also validates that fallback keys actually exist on the aggregate and that the aggregate provides `applyToDraft`.

### Choosing Between Mirror and Fallback

| Scenario | Use |
|----------|-----|
| Read model is a 1:1 clone of write model state | `mirror()` |
| Read model is mostly the same, a few events need custom logic | `mirror()` with `overrides` |
| Read model has a different state shape, but a few events use identical folding | `fallback` in `.from()` |
| Read model is fully custom | Plain `createProjection` without mirror or fallback |

## Reverse Semantics Contracts

For projections that need to declare subscription-level add/remove operations (e.g., when a joined stream should be added or removed based on lifecycle events), use `reverseSemanticsContract`:

```typescript
import { reverseSemanticsContract } from '@redemeine/projection';

const contract = reverseSemanticsContract(
  [{ aggregateType: 'order', aggregateId: 'order-1' }],   // adds
  [{ aggregateType: 'shipment', aggregateId: 'ship-1' }]  // removes
);
```

This produces a `ReverseSemanticsContract` with `adds` and `removes` arrays, each containing `{ aggregateType, aggregateId }` pairs. The runtime uses these to manage cross-stream subscriptions.

## API Reference

### `createProjection<TState>(name, initialStateFn)`

Creates a projection builder.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Unique projection name |
| `initialStateFn` | `(id: string) => TState` | Factory for initial document state |

Returns `ProjectionBuilder<TState>`.

### `ProjectionBuilder<TState>`

| Method | Description |
|--------|-------------|
| `.from(aggregate, handlers, options?)` | Set the primary event stream |
| `.join(aggregate, handlers)` | Add a correlated stream |
| `.identity(fn)` | Override document routing |
| `.initialState(fn)` | Override initial state factory |
| `.hooks({ afterEach })` | Register lifecycle hooks |
| `.build()` | Produce the final `ProjectionDefinition` |

### `.from()` Options

```typescript
.from(aggregate, handlers, {
  fallback?: { [eventKey]: true }
})
```

The `fallback` map is only available when the aggregate implements `MirrorableAggregateSource` (i.e., has `applyToDraft` and `initialState`).

### `createProjection.mirror(aggregate, name, options?)`

Creates a `ProjectionDefinition` directly (no builder chain needed).

| Parameter | Type | Description |
|-----------|------|-------------|
| `aggregate` | `MirrorableAggregateSource` | Built aggregate with `applyToDraft` |
| `name` | `string` | Unique projection name |
| `options.overrides` | Handler map | Per-event handler replacements |

Returns `ProjectionDefinition<AggregateStateOf<TAggregate>>`.

### `ProjectionDefinition<TState>`

The build output. All fields are populated:

```typescript
interface ProjectionDefinition<TState> {
  name: string;
  fromStream: ProjectionStreamDefinition<TState>;
  joinStreams?: JoinStreamDefinition<TState>[];
  initialState: (documentId: string) => TState;
  identity: (event: ProjectionEvent) => string | readonly string[];
  subscriptions: Array<{ aggregate: { aggregateType: string }; aggregateId: string }>;
  hooks?: ProjectionHooks<TState>;
}
```

### `ProjectionContext`

Passed as the third argument to every handler at runtime:

```typescript
interface ProjectionContext {
  subscribeTo(aggregate: { aggregateType: string }, aggregateId: string): void;
  unsubscribeFrom(aggregate: { aggregateType: string }, aggregateId: string): void;
}
```

Use `subscribeTo` in a `.from()` handler to dynamically subscribe the projection to events from a related aggregate instance. Use `unsubscribeFrom` to remove a prior subscription.

### Type Utilities

```typescript
// Extract the event payload map from an aggregate
type AggregateEventPayloadMap<TAggregate>

// Event key names (union of handler keys)
type AggregateEventKeys<TAggregate>

// Payload type for a specific event key
type AggregateEventPayloadByKey<TAggregate, TEventKey>

// State type from an aggregate's initialState
type AggregateStateOf<TAggregate>
```

These are useful when building generic projection utilities or testing helpers.

## Testing

Projection handlers are pure functions — they take state and an event and mutate the state. No database, no subscriptions, no async. This makes them straightforward to test in isolation.

### Testing a Handler Directly

```typescript
import { produce } from 'immer';

// Your handler (extracted or inline)
const orderCreatedHandler = (
  state: OrderSummary,
  event: { payload: { orderId: string; items: Array<{ qty: number; price: number }> } }
) => {
  state.orderId = event.payload.orderId;
  state.totalAmount = event.payload.items.reduce(
    (sum, item) => sum + item.qty * item.price, 0
  );
};

test('orderCreated computes total from line items', () => {
  const initial: OrderSummary = {
    orderId: '',
    totalAmount: 0,
    status: 'pending'
  };

  const next = produce(initial, (draft) => {
    orderCreatedHandler(draft, {
      payload: {
        orderId: 'order-1',
        items: [
          { qty: 2, price: 25 },
          { qty: 1, price: 50 }
        ]
      }
    });
  });

  expect(next.totalAmount).toBe(100);
  expect(next.orderId).toBe('order-1');
  expect(initial.totalAmount).toBe(0); // original unchanged
});
```

### Testing the Built Projection

You can also test against the built `ProjectionDefinition` by calling its handlers directly:

```typescript
test('projection has correct handlers registered', () => {
  const projection = createProjection<InvoiceView>('invoices', () => ({
    id: '', amount: 0, status: 'draft'
  }))
    .from(InvoiceAggregate, {
      created: (state, event) => {
        state.amount = event.payload.amount;
      },
      paid: (state) => {
        state.status = 'paid';
      }
    })
    .build();

  expect(projection.name).toBe('invoices');
  expect(projection.fromStream.handlers).toHaveProperty('created');
  expect(projection.fromStream.handlers).toHaveProperty('paid');

  // Test identity resolution
  const event = {
    aggregateType: 'invoice',
    aggregateId: 'inv-1',
    type: 'invoice.created.event',
    payload: {},
    sequence: 1,
    timestamp: '2024-01-01T00:00:00Z'
  };
  expect(projection.identity(event)).toBe('inv-1');
});
```

### Testing Mirror Projections

```typescript
test('mirror delegates to aggregate applyToDraft', () => {
  const projection = createProjection.mirror(InvoiceAggregate, 'mirror');

  const state = { customerId: '', amount: 0, status: 'draft' };
  const mockContext = { subscribeTo: () => {}, unsubscribeFrom: () => {} };

  projection.fromStream.handlers.created(state, {
    type: 'invoice.created.event',
    payload: { customerId: 'cust-1', amount: 250 },
    aggregateType: 'invoice',
    aggregateId: 'inv-1',
    sequence: 1,
    timestamp: '2024-01-01T00:00:00Z'
  }, mockContext);

  expect(state.customerId).toBe('cust-1');
  expect(state.amount).toBe(250);
});
```

## Design Decisions

### Why separate definition from runtime?

The `ProjectionDefinition` is a plain object — it carries no runtime behavior beyond handler functions. This separation means projections are testable without spinning up a daemon, serializable for inspection, and portable across different runtime implementations (in-memory, MongoDB-backed, etc.).

### Why infer types from `pure.eventProjectors`?

The aggregate builder already declares the canonical event projector signatures with full payload types. Re-declaring those types in the projection would create a second source of truth that drifts over time. By extracting payload types directly from `eventProjectors`, the projection's handler signatures are always in sync with the write model.

### Why `applyToDraft` instead of reusing `apply`?

The aggregate's `apply` function wraps event processing in Immer's `produce` — it takes immutable state in and returns immutable state out. But projection handlers already run inside the daemon's `produce` pass. Calling `apply` from inside a handler would nest `produce` calls, which is both inefficient and semantically wrong (the inner `produce` would create an intermediate frozen object that the outer `produce` then tries to mutate).

`applyToDraft` does the same event routing and projector dispatch, but operates on an already-mutable draft. This makes it safe to call from inside the projection runtime's `produce` without double-wrapping.

### Why mutual exclusivity for fallback?

Allowing the same event in both a custom handler and the fallback map creates ambiguity: which one wins? Rather than defining precedence rules that are easy to get wrong, the builder rejects the configuration entirely. You pick one place for each event — explicit handler or fallback delegation — and the intent is always clear.

The type system enforces this with `Exclude<AggregateEventKeys, keyof Handlers>`, so the IDE removes fallback suggestions for events that already have handlers. The runtime check is a safety net for `as any` escapes.
