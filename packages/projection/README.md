# @redemeine/projection

Type-safe read-model projections for Redemeine event-sourced aggregates.

## Overview

`@redemeine/projection` defines how domain events are folded into read-model documents. A projection declares which aggregate streams it consumes, how each event type mutates document state, and how events map to document identities. The package produces a `ProjectionDefinition` — a pure data structure that a runtime daemon (not included here) feeds events into.

The builder infers event payload types from your aggregate's `pure.eventProjectors`, so handler signatures stay in sync with the write model without manual type declarations.

Three mechanisms reuse write-model projectors instead of duplicating folding logic:

- **`inherit`** token — delegates a single event key to the aggregate's `applyToDraft`.
- **`inherit.extend(fn)`** — delegates first, then runs additional logic on the same draft.
- **`.mirror()`** builder method — like `.from()`, but unlisted events default to `inherit` instead of skip.

## Installation

```bash
bun add @redemeine/projection
```

Peer dependencies: `@redemeine/aggregate`.

## Quick Start

```typescript
import { createAggregate } from '@redemeine/aggregate';
import { createProjection } from '@redemeine/projection';

interface InvoiceState {
  customerId: string; amount: number; status: 'draft' | 'sent' | 'paid';
}

const InvoiceAggregate = createAggregate<InvoiceState, 'invoice'>('invoice', {
  customerId: '', amount: 0, status: 'draft'
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
    create: (state, p: { customerId: string; amount: number }) => emit.created(p),
    send: (state) => emit.sent(undefined),
    pay:  (state) => emit.paid(undefined)
  }))
  .build();

interface InvoiceSummary {
  customerId: string; amount: number; status: string; paidAt: string | null;
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
    sent: (state) => { state.status = 'sent'; },
    paid: (state, event) => {
      state.status = 'paid';
      state.paidAt = event.timestamp;
    }
  })
  .build();
```

`event.payload` in each handler is fully typed from the aggregate's event projector for that key.

## Core Concepts

### Projection Definition

| Field | Purpose |
|-------|---------|
| `name` | Unique identifier for this projection |
| `fromStream` | Primary aggregate stream + event handlers |
| `joinStreams` | Additional correlated streams |
| `initialState` | Factory that produces a fresh document for a given ID |
| `identity` | Maps an event to one or more document IDs |
| `hooks` | Cross-cutting lifecycle hooks |

The definition is inert data. A runtime daemon reads this structure to wire up subscriptions and apply events.

### The Builder API

```typescript
createProjection<TState>(name, initialStateFn)
  .from(aggregate, handlers)               // primary stream (required)
  .join(aggregate, handlers)               // correlated stream (optional, repeatable)
  .identity(fn)                            // custom document routing (optional)
  .initialState(fn)                        // override initial state (optional)
  .hooks({ afterEach })                    // lifecycle hooks (optional)
  .build()                                 // -> ProjectionDefinition<TState>

// Or with .mirror():
createProjection(name)                     // no initialState needed
  .mirror(aggregate, handlers?)            // unlisted events default to inherit
  .build()
```

### `.from()` — Primary Stream

The aggregate argument determines valid handler keys. Invalid keys cause compile-time errors. Unhandled events are skipped at runtime.

```typescript
.from(InvoiceAggregate, {
  created: (state, event) => {
    state.customerId = event.payload.customerId; // fully typed
  },
  paid: (state) => { state.status = 'paid'; }
})
```

### `.join()` — Correlated Streams

Join additional aggregate streams. Each `.join()` adds a separate stream with the same type inference.

```typescript
createProjection<DashboardState>('dashboard', () => ({ invoiceTotal: 0, shipmentCount: 0 }))
  .from(InvoiceAggregate, {
    created: (state, event) => { state.invoiceTotal += event.payload.amount; }
  })
  .join(ShipmentAggregate, {
    dispatched: (state) => { state.shipmentCount += 1; }
  })
  .build();
```

### `event.type` Narrowing

Inside a handler, `event.type` is narrowed to the handler key or its canonical form (`'created' | 'invoice.created.event'`).

### Identity Resolution

Default: `event.aggregateId`. Override with `.identity()`:

```typescript
.identity((event) => event.payload.customerId)           // single document
.identity((event) => [                                    // fan-out
  `customer-${event.payload.customerId}`, 'global-summary'
])
```

### Initial State

Factory receives the document ID. Each document gets its own copy.

```typescript
createProjection<InvoiceView>('invoices', () => ({ id: '', amount: 0, status: 'draft' }))
// Override:
.initialState((documentId) => ({ id: documentId, amount: 0, status: 'draft' }))
```

When using `.mirror()`, initial state is auto-cloned from the aggregate via `structuredClone` if not provided.

### Hooks

`afterEach` runs after every handler inside the same Immer `produce` pass:

```typescript
.hooks({
  afterEach: (state, event) => { state.lastUpdated = event.timestamp; }
})
```

## Reusing Aggregate Projectors

When the read model's state shape matches the write model, duplicating folding logic is maintenance overhead and drift risk. All reuse mechanisms require the aggregate to expose `applyToDraft`. Aggregates from `createAggregate(...).build()` provide this automatically.

### `inherit` Token

Use `inherit` in a `.from()` handler map to delegate to `applyToDraft`:

```typescript
import { createProjection, inherit } from '@redemeine/projection';

.from(InvoiceAggregate, {
  created:   inherit,
  sent:      inherit,
  paid:      inherit.extend((state, event) => {
    state.paidAt = event.timestamp;
  }),
  cancelled: (state, event) => {
    state.status = 'cancelled';
  }
})
```

Each key accepts one of three values: `inherit` (full delegation), `inherit.extend(fn)` (delegate then augment), or a plain function (fully custom). Structurally exclusive — each key has exactly one treatment.

### `inherit.extend(fn)`

Calls `applyToDraft` for that event, then runs your function on the resulting draft. Same `(state, event, context)` signature, fully typed via contextual inference.

```typescript
paid: inherit.extend((state, event) => {
  // applyToDraft already set state.status = 'paid'
  state.paidAt = event.timestamp;
})
```

**Caveat**: extracting the extended handler to a variable loses contextual type inference. Either inline it or annotate the variable explicitly.

### `.mirror()` Builder Method

Like `.from()`, but unlisted events default to `inherit` instead of skip. Handlers arg is optional. Auto-clones aggregate `initialState` when not provided.

```typescript
// 1:1 clone — everything inherited
createProjection('invoice-mirror').mirror(InvoiceAggregate).build();

// Inherit all, extend one
createProjection('invoice-mirror')
  .mirror(InvoiceAggregate, {
    paid: inherit.extend((state, event) => { state.paidAt = event.timestamp; })
  })
  .build();

// Inherit all, fully override one
createProjection('invoice-mirror')
  .mirror(InvoiceAggregate, {
    cancelled: (state, event) => { state.status = 'cancelled'; }
  })
  .build();
```

### Manual `applyToDraft` Escape Hatch

For around-wrapping (logic before *and* after the aggregate projector):

```typescript
.from(InvoiceAggregate, {
  paid: (state, event) => {
    state.preProcessedAt = new Date().toISOString();
    InvoiceAggregate.applyToDraft(state, event);
    state.postProcessedAt = new Date().toISOString();
  }
})
```

### Choosing What to Use

| Scenario | Use |
|----------|-----|
| 1:1 clone of write model state | `.mirror(Agg)` |
| Mostly the same, a few tweaks | `.mirror(Agg, overrides)` |
| Cherry-pick delegation for specific events | `.from(Agg, { key: inherit })` |
| Custom state shape, selective reuse | `.from(Agg, { key: inherit, other: handler })` |
| Fully custom | `.from(Agg, { key: handler })` |

## Reverse Semantics Contracts

For projections that declare subscription-level add/remove operations based on lifecycle events:

```typescript
import { reverseSemanticsContract } from '@redemeine/projection';

const contract = reverseSemanticsContract(
  [{ aggregateType: 'order', aggregateId: 'order-1' }],   // adds
  [{ aggregateType: 'shipment', aggregateId: 'ship-1' }]  // removes
);
```

Produces `{ adds, removes }` arrays for runtime subscription management.

## API Reference

### `createProjection(name, initialStateFn?)`

| Overload | Returns |
|----------|---------|
| `createProjection<TState>(name, () => TState)` | `ProjectionBuilder<TState>` |
| `createProjection(name)` | `ProjectionBuilder<unknown>` (use with `.mirror()`) |

### `ProjectionBuilder<TState>`

| Method | Description |
|--------|-------------|
| `.from(aggregate, handlers)` | Set the primary event stream |
| `.mirror(aggregate, handlers?)` | Primary stream; unlisted events default to `inherit` |
| `.join(aggregate, handlers)` | Add a correlated stream |
| `.identity(fn)` | Override document routing |
| `.initialState(fn)` | Override initial state factory |
| `.hooks({ afterEach })` | Register lifecycle hooks |
| `.build()` | Produce the final `ProjectionDefinition` |

### `inherit` Token

```typescript
inherit                    // InheritToken — delegates to applyToDraft
inherit.extend(fn)         // InheritExtended — delegates, then runs fn
```

### `.mirror()` Signature

```typescript
.mirror<TAggregate extends MirrorableAggregateSource>(
  aggregate: TAggregate,
  handlers?: Partial<HandlerMap>
): ProjectionBuilder<AggregateStateOf<TAggregate>>
```

Auto-provides `() => structuredClone(aggregate.initialState)` when `initialState` is not set.

### `ProjectionDefinition<TState>`

Fields: `name`, `fromStream`, `joinStreams?`, `initialState`, `identity`, `subscriptions`, `hooks?`.

### `ProjectionContext`

Passed as third argument to handlers at runtime. Methods: `subscribeTo(aggregate, aggregateId)`, `unsubscribeFrom(aggregate, aggregateId)`.

### Type Utilities

`AggregateEventPayloadMap<T>`, `AggregateEventKeys<T>`, `AggregateEventPayloadByKey<T, K>`, `AggregateStateOf<T>`.

## Testing

Handlers are pure `(draft, event) => void` functions — no database, no subscriptions, no async.

### Testing a Handler Directly

```typescript
import { produce } from 'immer';

test('paid handler sets status and timestamp', () => {
  const next = produce(
    { customerId: '', amount: 0, status: 'draft', paidAt: null } as InvoiceSummary,
    (draft) => { draft.status = 'paid'; draft.paidAt = '2024-01-15T10:00:00Z'; }
  );
  expect(next.status).toBe('paid');
});
```

### Testing the Built Projection

```typescript
test('projection registers correct handlers', () => {
  const projection = createProjection<InvoiceSummary>(
    'invoices', () => ({ customerId: '', amount: 0, status: 'draft', paidAt: null })
  )
    .from(InvoiceAggregate, {
      created: (state, event) => { state.amount = event.payload.amount; },
      paid: (state) => { state.status = 'paid'; }
    })
    .build();

  expect(projection.name).toBe('invoices');
  expect(projection.fromStream.handlers).toHaveProperty('created');
  expect(projection.identity({ aggregateId: 'inv-1' } as any)).toBe('inv-1');
});
```

### Testing Mirror Projections

```typescript
test('mirror delegates to aggregate applyToDraft', () => {
  const projection = createProjection('mirror').mirror(InvoiceAggregate).build();
  const state = { customerId: '', amount: 0, status: 'draft' as const };
  const ctx = { subscribeTo: () => {}, unsubscribeFrom: () => {} };

  projection.fromStream.handlers.created(state, {
    type: 'invoice.created.event', payload: { customerId: 'cust-1', amount: 250 },
    aggregateType: 'invoice', aggregateId: 'inv-1', sequence: 1,
    timestamp: '2024-01-01T00:00:00Z'
  }, ctx);

  expect(state.customerId).toBe('cust-1');
});
```

## Design Decisions

### Why separate definition from runtime?

`ProjectionDefinition` is plain data — testable without a daemon, serializable, portable across runtime implementations.

### Why infer types from `pure.eventProjectors`?

The aggregate builder declares canonical event projector signatures with full payload types. Extracting from `eventProjectors` keeps handler signatures in sync — no second source of truth.

### Why `applyToDraft` instead of `apply`?

Projection handlers already run inside the daemon's Immer `produce` pass. The aggregate's `apply` also wraps in `produce`. Nesting creates a frozen intermediate that the outer pass tries to mutate. `applyToDraft` does the same routing on an already-mutable draft.

### Why `inherit` instead of `fallback`?

The previous `fallback` used a separate map alongside handlers, requiring mutual-exclusivity validation and `Exclude<>` gymnastics. `inherit` collapses both into a single map — each key has exactly one value. No ambiguity, no overlap checks.

### Why `.mirror()` as a builder method?

The previous `createProjection.mirror()` was a static factory bypassing the builder chain — no `.identity()`, `.hooks()`, or `.join()`. As a builder method, `.mirror()` composes with everything else.
