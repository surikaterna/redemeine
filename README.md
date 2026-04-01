# 📦 Redemeine

> **Sane defaults CQRS/ES aggregates library for TypeScript**

![Build Status](https://img.shields.io/badge/build-passing-brightgreen?style=flat-square)
![Type Coverage](https://img.shields.io/badge/type_coverage-100%25-blue?style=flat-square)
![AI-Ready](https://img.shields.io/badge/AI--Ready-llms.txt-blueviolet?style=flat-square)

---

> Mirage command dispatch is synchronous by default, and becomes async only when awaited plugin interceptors are configured.

## ⚡ Visual Hook

```typescript
import { createAggregate, createMirage } from 'redemeine';

// Compose your aggregate builder with typed commands, events, and entities
const OrderAggregate = createAggregate('Order', initialOrderState)
  .entities({ orderLines: OrderLineEntity }) // Encapsulated logic & selectors
  .events({
    placed: (state, event: { payload: { customerId: string } }) => { state.status = 'placed'; }
  })
  .commands(emit => ({
    place: (state, customerId: string) => emit.placed({ customerId }),
  }))
  .build();

// Instantiate and interact with a live aggregate
const order123 = createMirage(OrderAggregate, 'order-123');

// Type-safe dispatching triggers Immer-powered state transitions natively
order123.place('cust-99');

// Entities act as Immutable Hybrid Collections! 
// 1. You can iterate over them natively as a safe, read-only array:
const totalLines = order123.orderLines.length;

// 2. You can invoke them as command factories mapped perfectly by ID:
order123.orderLines('line-1').cancel(); // Automatically maps to 'order.order_line.cancel.command'
```

## 🚀 The Elevator Pitch

*   **Immutable Hybrid Entity Collections**: Entities wrapped securely via proxies. Treat them seamlessly as safe Read-Only Arrays for UI iteration, and invoke them as targeted Command dispatcher functions bridging ID-mapped execution instantly.
*   **Path-Aware Convention**: Navigate and organize your commands and events effortlessly. Automatic routing driven by intuitive naming conventions reduces boilerplate.
*   **Encapsulated Logic**: Stop polluting your root aggregate. Entities (like `OrderLines`) keep their own private selectors and logic, exposed only where they matter.
*   **Type-Safe Contracts**: Strong compile-time safety from TypeScript, with optional runtime command/event validation when a Contract is provided (for example with Zod-backed schemas).
*   **Immutable State Transitions**: Leverage Immer under the hood for clean, predictable, and fully typed event applications to your aggregate state.

## 🎒 Cohesive Command Packing

Stop passing ugly generic objects around just to satisfy standard payload requirements!
The "Unified Pack" pattern allows you to define a beautifully tailored public API for your command, while bridging those arguments strictly into your internal, serializable Event Store payload object—all within a single cohesive definition.

```typescript
.commands((emit, ctx) => ({
  dispatchShipment: {
    // 1. You define the public API signature of your command here
    pack: (destination: string, priority: 'standard' | 'express' = 'standard') => ({
      dest: destination,
      speed: priority,
      timestamp: Date.now()
    }),
    // 2. The handler cleanly receives the formatted result of `pack`
    handler: (state, payload) => {
      if (!ctx.selectors.isReady(state)) throw new Error("Not ready");
      return emit('dispatched', payload);
    }
  }
}))
```

When invoking this aggregate dynamically via our Mirage Proxy, TypeScript correctly maps your UI execution directly to the `Parameters<typeof pack>`:

```typescript
// Natively accepts (destination: string, priority?: 'standard' | 'express')
mirage.dispatchShipment('123 Main St', 'express');
```

## 🧩 Aggregate Composition

Redemeine treats aggregates as composable building blocks:
*   **Inheritance**: Use `.extends(Parent)` to inherit all business rules, selectors, and events. For example, a `Shipment` can `.extends(Order)` to inherit its foundational logic while adding shipment-specific behaviors (like `Legs`).
*   **Mixins**: Use `.mixins(Contactable, Identifiable)` to stack reusable behavior across unrelated aggregates. Internally, Redemeine flattens mixin command and projector maps using the shared `Merge` utility from `src/utils/types/Merge.ts`, so command signatures stay cohesive while avoiding duplicate wiring.

## 🔌 Plugin Interceptors

Mirage/Depot infrastructure supports plugin hooks for command dispatch, append, hydration, and post-commit:

- `onBeforeCommand(ctx)`
- `onHydrateEvent(ctx)`
- `onBeforeAppend(ctx)`
- `onAfterCommit(ctx)`

Every plugin must provide a stable `key`:

```ts
const auditPlugin = {
  key: 'audit',
  onAfterCommit: async (ctx) => {
    // ctx.pluginKey === 'audit'
  }
};
```

Command handlers that return plugin intents must use the namespaced envelope shape:

```ts
return {
  events: [emit.incremented({ amount })],
  intents: {
    audit: { traceId: 'trace-123' }
  }
};
```

Flat root-level plugin keys are not accepted.

### Hook failure policy matrix

- `onBeforeCommand`: **fail_closed** (command is blocked, no events applied)
- `onHydrateEvent`: **fail_closed** (hydrate is blocked)
- `onBeforeAppend`: **fail_closed** (append/save is blocked)
- `onAfterCommit`: **fail_closed_post_commit** (events already persisted; pending results are cleared and a structured `RedemeinePluginHookError` is thrown with `pluginKey` + `hook`)

## 🔁 Sagas / Process Managers

Redemeine includes an event-sourced saga toolkit for long-running, cross-aggregate workflows.

- Define saga behavior with `createSaga<TState>(nameOrOptions?)`, aggregate-typed `.on(Aggregate, handlers)`, and `commandsFor` / `dispatchTo` helpers.
- Use saga runtime support through the documented saga API surface and events.
- Runtime internals are implementation details and are not part of Redemeine's public API.

Start with the docs tutorial at `docs/tutorials/sagas-starter.md` and the reference at `docs/reference/sagas-reference.md`.

## 🧭 Quick Navigation

*   📖 [**`/docs`**](./docs) - Deep dives into Commands, Events, Aggregates, and Mixins.
*   🧪 [**`/examples`**](./examples) - Executable, real-world CQRS applications.
*   🤖 [**`/llms.txt`**](./llms.txt) - Contextual overview specifically optimized for AI coding assistants.

## 🛠️ Scaffold Your Project

Get up to speed in seconds by leveraging the CLI to generate your domain skeleton:

```bash
# Initialize a new Redemeine workspace with standard conventions
npx redemeine init <name>

# Generate a new aggregate with its standard command and event files
# (This automatically scaffolds a "Given/When/Then" test suite!)
npx redemeine generate aggregate Shipment
```

## 🏗️ Core Concepts

*   **Commands**: Requests indicating an intent to change the State of an Aggregate.
*   **Events**: The result of a Command, representing that a State change has occurred.
*   **Selectors**: Pure functions for reading and deriving state, injectable into command handlers.
*   **Command Processors**: Handlers that execute business logic, validate intent, and emit domain events.
*   **Event Applyers**: Functions that compute the new aggregate state by consuming the emitted events.
*   **Path-Aware Naming**: Naming follows the `aggregate.entity.action` convention by default, automatically routing nested commands and events.

---
*Inspired by [demeine](http://github.com/surikaterna/demeine) and [Redux Toolkit](https://github.com/reduxjs/redux-toolkit).*
Redemeine is the **Type-Safe, Composition-focused evolution** of `demeine` for modern TypeScript projects.

# Future Work
1. Domain Services (The "Logic that fits nowhere")
Sometimes logic requires multiple Aggregates or external state (like a Currency Converter or an Inventory Checker).

The Gap: Currently, redemeine handlers are "Pure" (State + Payload).

The Solution: We don't necessarily need a builder for this, but we need a pattern for Command Middleware or Service Injection so a handler can "ask" for a Domain Service without losing its purity or testability.

2. Invariants (Cross-Entity Validation)
You have Zod for "Shape" validation, but what about "Business" validation? (e.g., "The sum of all Allocation percentages in the Party must equal 100%").

The Gap: If you have 5 different commands that can affect allocation, you don't want to copy-paste the "Sum to 100" logic in every handler.

The Solution: Support a .invariants() or .ensure() block in the builder. These are rules that run after any command handler but before the events are committed. If an invariant fails, the whole transaction rolls back.

3. Specification Pattern (Complex Query Logic)
In party_domain.txt, you might want to ask: party.isEligibleForDiscount().

The Gap: If this logic is complex, you don't want it sitting in a UI component or a Service. You want it on the Aggregate.

The Solution: Support .queries() (or .computed()) in the builder. These are pure functions that take the State and return a value. The Mirage would expose these as read-only properties or methods.
