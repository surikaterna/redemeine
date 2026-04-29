# @redemeine/mirage

Runtime proxy layer that turns a built Redemeine aggregate into a live, interactive object.

## Overview

Mirage wraps a `BuiltAggregate` (the output of `createAggregate(...).build()`) into a Proxy where state properties, commands, selectors, and entity sub-aggregates all live on a single object. The root namespace belongs entirely to your domain — there are no framework-reserved properties like `.dispatch()` or `.getState()` cluttering the type.

Infrastructure operations (reading raw state, accessing uncommitted events, subscribing to changes) are handled through standalone functions that accept a mirage as their first argument. This keeps the proxy surface clean and avoids naming collisions with your domain model.

Mirage sits between the aggregate builder (`@redemeine/aggregate`) and your application layer. The builder defines *what* your aggregate does; mirage makes it *usable*.

## Installation

```bash
bun add @redemeine/mirage
```

Peer dependencies: `@redemeine/aggregate`, `@redemeine/kernel`.

## Quick Start

```typescript
import { createAggregate } from '@redemeine/aggregate';
import { createMirage, extractUncommittedEvents } from '@redemeine/mirage';

interface OrderState {
  status: 'draft' | 'placed' | 'cancelled';
  total: number;
  lines: { id: string; product: string; qty: number; price: number }[];
}

const OrderAggregate = createAggregate<OrderState, 'order'>('order', {
  status: 'draft',
  total: 0,
  lines: []
})
  .events({
    placed: (state) => { state.status = 'placed'; },
    lineAdded: (state, event) => {
      state.lines.push(event.payload);
      state.total += event.payload.qty * event.payload.price;
    }
  })
  .commands((emit) => ({
    place: (state) => emit.placed(undefined),
    addLine: (state, line: { id: string; product: string; qty: number; price: number }) =>
      emit.lineAdded(line)
  }))
  .selectors({
    hasLine: (state, productId: string) => state.lines.some(l => l.product === productId),
    lineCount: (state) => state.lines.length
  })
  .build();

// Create a live mirage
const order = createMirage(OrderAggregate, 'order-1');

// Commands are methods
order.addLine({ id: 'l1', product: 'widget', qty: 2, price: 10 });
order.place();

// State is properties
console.log(order.status);  // 'placed'
console.log(order.total);   // 20

// Selectors are callable on the root
console.log(order.hasLine('widget'));  // true
console.log(order.lineCount());       // 1

// Infrastructure via standalone functions
const events = extractUncommittedEvents(order);
// [{ type: 'order.lineAdded.event', ... }, { type: 'order.placed.event', ... }]
```

## Core Concepts

### The Mirage Proxy

A mirage is a `Proxy` object. Property access resolves against the current aggregate state. Method calls route to command handlers. The proxy is deeply immutable on the read side — attempting to assign a property throws.

The type signature reflects this:

```typescript
type Mirage<TState, M, Registry, Sel> =
  MirageCommandMap<TState, M>          // commands as methods
  & ReadonlyDeep<TState>               // state as properties
  & MountedMirageProps<TState, Registry> // entity sub-mirages
  & RootMirageSelectorMap<...>          // selectors
```

### Commands as Methods

Every command defined in your aggregate builder becomes a callable method on the mirage. The method dispatches the command through the full lifecycle (hooks, validation, event projection) and returns the updated state.

```typescript
order.place();                    // void command
order.addLine({ id: 'l1', ... }); // payload command
```

If plugins with `onBeforeCommand` hooks are registered, command dispatch becomes async and returns a `Promise`.

### State as Properties

State properties are readable directly. They reflect the current aggregate state after all applied events.

```typescript
order.status  // 'placed'
order.total   // 20
order.lines   // readonly array
```

All state access returns deeply readonly values. You cannot mutate state through the proxy.

### Selectors

Selectors are query functions defined on the aggregate that get projected onto the mirage root. They receive the current readonly state and any additional arguments.

```typescript
// Definition
.selectors({
  hasLine: (state, productId: string) => state.lines.some(l => l.product === productId),
  lineCount: (state) => state.lines.length
})

// Usage
order.hasLine('widget')  // true
order.lineCount()        // 1
```

Selectors that collide with command names are shadowed by the command. Selectors that collide with state property names are shadowed by the state property. Design your names accordingly.

Selectors can also return context-bound entities using `bindContext`, enabling scoped sub-mirages from query results. See [Entity Collections](#entity-collections) for details.

### Entity Sub-Mirages

Entities registered via `.entityList()`, `.entityMap()`, etc. become scoped sub-mirages. A list entity is both an array (for reading) and a function (for targeting by primary key).

```typescript
// Read as array
order.lines.length        // number of lines
order.lines[0].qty        // first line's quantity

// Target by primary key
order.lines('line-1').updateQty(5);
```

The targeted sub-mirage exposes only that entity's commands and state. Command payloads are automatically enriched with the entity's identity fields.

## API Reference

### `createMirage(builder, id, options?)`

Creates a live mirage instance from a built aggregate.

| Parameter | Type | Description |
|-----------|------|-------------|
| `builder` | `BuiltAggregate` | Output of `createAggregate(...).build()` |
| `id` | `string` | Aggregate instance identifier |
| `options` | `MirageOptions & { snapshot?, events? }` | Optional configuration |

**Options:**

| Field | Type | Description |
|-------|------|-------------|
| `snapshot` | `TState` | Initial state to use instead of the builder's default |
| `events` | `Iterable<Event> \| AsyncIterable<Event>` | Events to replay for hydration |
| `contract` | `Contract` | Schema validation contract |
| `strict` | `boolean` | Throw on missing schemas (default: warn) |
| `plugins` | `RedemeinePlugin[]` | Plugins to attach |

**Return type:** Returns `Mirage<...>` synchronously when no `events` are provided. Returns `Promise<Mirage<...>>` when `events` are provided (hydration is async).

```typescript
// Synchronous — no hydration
const order = createMirage(OrderAggregate, 'order-1');

// Synchronous — from snapshot
const order = createMirage(OrderAggregate, 'order-1', {
  snapshot: { status: 'placed', total: 10, lines: [] }
});

// Async — hydrate from events
const order = await createMirage(OrderAggregate, 'order-1', {
  events: storedEvents
});

// Async — snapshot + catch-up events
const order = await createMirage(OrderAggregate, 'order-1', {
  snapshot: cachedState,
  events: newEvents
});
```

### Standalone Utility Functions

These functions access mirage internals without polluting the proxy namespace.

#### `extractState(mirage)`

Returns a readonly deep proxy of the current aggregate state.

```typescript
import { extractState } from '@redemeine/mirage';

const snapshot = extractState(order);
// snapshot.status, snapshot.total, etc. — all deeply readonly
```

#### `extractUncommittedEvents(mirage)`

Returns a copy of all events produced since the last clear/save.

```typescript
import { extractUncommittedEvents } from '@redemeine/mirage';

order.place();
const events = extractUncommittedEvents(order);
// [{ type: 'order.placed.event', payload: undefined }]
```

#### `clearUncommittedEvents(mirage)`

Clears the uncommitted event buffer. Typically called after persisting events.

```typescript
import { clearUncommittedEvents } from '@redemeine/mirage';

clearUncommittedEvents(order);
```

#### `subscribe(mirage, listener)`

Subscribes to state changes. The listener fires after each command dispatch. Returns an unsubscribe function.

```typescript
import { subscribe } from '@redemeine/mirage';

const unsub = subscribe(order, (state) => {
  console.log('State changed:', state.status);
});

order.place();  // logs: "State changed: placed"
unsub();
```

#### `dispatch(mirage, command)`

Low-level raw command dispatch. Prefer using the typed methods on the mirage directly.

```typescript
import { dispatch } from '@redemeine/mirage';

dispatch(order, { type: 'order.place', payload: undefined });
```

### `createDepot(builder, store, options?)`

Creates a Depot — the persistence bridge between an event store and mirage instances.

```typescript
import { createDepot } from '@redemeine/mirage';

const depot = createDepot(OrderAggregate, store, { plugins: [auditPlugin] });
```

The depot provides two methods:

#### `depot.get(id, options?)`

Hydrates a mirage from the event store. Optionally accepts a snapshot for faster hydration.

```typescript
const order = await depot.get('order-1');

// With snapshot (replays only events after snapshot version)
const order = await depot.get('order-1', {
  snapshot: { state: cachedState, version: 42 }
});
```

#### `depot.save(mirage)`

Persists uncommitted events to the store and clears the buffer. Runs `onBeforeAppend` and `onAfterCommit` plugin hooks.

```typescript
order.addLine({ id: 'l2', product: 'gadget', qty: 1, price: 50 });
await depot.save(order);
```

### `EventStore` Interface

Implement this to connect mirage to your storage backend.

```typescript
interface EventStore {
  readStream(id: string, options?: { fromVersion?: number }): AsyncIterable<Event>;
  saveEvents(id: string, events: Event[], expectedVersion?: number): Promise<void>;
}
```

`readStream` returns an async iterable of events for a given aggregate ID. `saveEvents` persists events, optionally with optimistic concurrency via `expectedVersion`.

## Hydration

Hydration reconstructs aggregate state from stored events. Mirage supports three hydration modes:

1. **From events only** — replays all events from the beginning
2. **From snapshot** — starts from a known state, no event replay
3. **From snapshot + events** — starts from a snapshot, replays only subsequent events

During hydration, events are replayed through the aggregate's `apply` function in order. To avoid blocking the event loop on large aggregates, mirage yields back to Node.js every 250 events (`HYDRATION_REPLAY_YIELD_THRESHOLD`).

Plugin `onHydrateEvent` hooks run during replay, allowing payload transformation (e.g., decryption) before projection.

## Entity Collections

Mirage supports three entity mount types, each registered on the aggregate builder.

### Lists

Registered via `.entityList(name, entity)`. The mount is both a readable array and a targeting function.

```typescript
// Array access (readonly)
order.lines.length
order.lines[0].qty
order.lines.filter(l => l.qty > 1)

// Target by primary key
order.lines('line-1').updateQty(5);
order.lines('line-1').qty  // read targeted entity state
```

Composite primary keys use an object argument:

```typescript
order.assignments({ orderId: 'o1', assignmentId: 'a1' }).reassign('new-owner');
```

### Maps

Registered via `.entityMap(name, entity)`. Accessed by string key.

```typescript
order.settings.billing.update({ address: '...' });
order.settings.billing.address  // read state
```

### Value Objects

Registered via `.valueObject()`, `.valueObjectList()`, or `.valueObjectMap()`. These are read-only — no commands, no sub-mirage. They return deeply frozen state.

## Selectors

### Definition

Selectors are defined in the aggregate builder's `.selectors()` call. They receive readonly state as the first argument.

```typescript
.selectors({
  // Simple query
  lineCount: (state) => state.lines.length,

  // Parameterized query
  hasLine: (state, productId: string) => state.lines.some(l => l.product === productId),

  // With utils (bindContext for entity-scoped results)
  activeLines: (state, utils) =>
    utils.bindContext(
      state.lines.filter(l => l.active),
      LineEntity
    )
})
```

### Collision Rules

The type system prevents selector names from overlapping with state properties or commands — TypeScript will not show them in autocomplete, and colliding selectors are excluded from the `Mirage` type.

At the type level, the priority order is:

1. **Commands** — always present, shadow selectors of the same name
2. **State properties** — always present, shadow selectors of the same name
3. **Entity mounts** — always present
4. **Selectors** — only appear if the name is unique

Avoid collisions by using distinct naming conventions for selectors (e.g., prefix with `has`, `is`, `get`, `find`, `compute`).

### Context-Bound Selectors

Selectors can return entity-scoped mirages using `bindContext`. The returned items are full sub-mirages with commands and state access, not plain data objects.

```typescript
const active = order.activeLines();
active[0].updateQty(10);  // command on the scoped entity
active.length;             // array length
active.first();            // first entity mirage
active.at(2);              // entity mirage at index
```

## Plugins

Plugins hook into the mirage lifecycle at four points. Each plugin must have a unique `key` string.

```typescript
import { RedemeinePlugin } from '@redemeine/kernel';

const myPlugin: RedemeinePlugin = {
  key: 'my-plugin',
  onBeforeCommand: async (ctx) => { /* ... */ },
  onHydrateEvent: async (ctx) => { /* ... */ },
  onBeforeAppend: async (ctx) => { /* ... */ },
  onAfterCommit: async (ctx) => { /* ... */ }
};
```

### Hook Lifecycle

| Hook | When | Where | Can modify | Can block |
|------|------|-------|------------|-----------|
| `onBeforeCommand` | Before command processing | `createMirage` dispatch | No | Yes (throw) |
| `onHydrateEvent` | During event replay | `createMirage` hydration | Event payload | No |
| `onBeforeAppend` | Before persisting events | `depot.save()` | Event payload | Yes (throw) |
| `onAfterCommit` | After successful persist | `depot.save()` | No | No |

Plugins are registered either on the aggregate builder (`.plugins([...])`) or passed via options to `createMirage` / `createDepot`. Both sources are merged.

When any plugin has an `onBeforeCommand` hook, all command dispatch becomes async (returns `Promise<S>` instead of `S`).

### Error Handling

Plugin hook failures are wrapped in `RedemeinePluginHookError` with the plugin key, hook name, aggregate ID, and original cause. This makes it straightforward to identify which plugin failed and why.

## Testing

### Unit Testing Commands and Events

For isolated unit tests, use `createMirage` directly without a depot or event store.

```typescript
import { createMirage, extractUncommittedEvents, extractState } from '@redemeine/mirage';

test('placing an order sets status to placed', () => {
  const order = createMirage(OrderAggregate, 'test-1');
  order.place();

  expect(order.status).toBe('placed');

  const events = extractUncommittedEvents(order);
  expect(events).toHaveLength(1);
  expect(events[0].type).toBe('order.placed.event');
});
```

### Testing with Hydration

```typescript
test('hydrates from stored events', async () => {
  const events = [
    { type: 'order.lineAdded.event', payload: { id: 'l1', product: 'x', qty: 1, price: 10 } },
    { type: 'order.placed.event', payload: undefined }
  ];

  const order = await createMirage(OrderAggregate, 'test-1', { events });
  expect(order.status).toBe('placed');
  expect(order.total).toBe(10);
});
```

### Pure Function Testing

The `BuiltAggregate` exposes `.pure.commandProcessors` and `.pure.eventProjectors` for testing domain logic without the proxy layer. These bypass all lifecycle hooks — use them only for isolated unit tests.

## Design Decisions

### Why no reserved keys on the root?

Most aggregate/entity frameworks reserve names like `dispatch`, `getState`, `subscribe` on the instance. This creates naming collisions with your domain. An `Order` aggregate might legitimately have a `dispatch` command (for dispatching shipments). By keeping the root namespace clean, mirage avoids this entire class of problems.

### Why standalone functions?

The alternative was a wrapper object (e.g., `mirage.meta.extractState()`). Standalone functions are tree-shakeable, have simpler types, and don't require a reserved namespace on the proxy. They also compose naturally with functional patterns.

### Why does hydration make createMirage async?

Event replay may involve async iterables (streaming from a database) and plugin hooks that are inherently async. Rather than forcing all mirages to be async, `createMirage` returns synchronously when no events are provided and only becomes async when hydration is needed. The overload signatures make this explicit at the type level.

### Why MirageCoreSymbol?

The internal `MirageCore` (which tracks state, version, uncommitted events, and listeners) is accessed via a Symbol property on the proxy. This keeps it invisible to normal property enumeration and avoids any possible collision with domain names. The standalone utility functions use this symbol internally.
