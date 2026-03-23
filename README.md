# 📦 Redemeine

> **Sane defaults CQRS/ES aggregates library for TypeScript**

![Build Status](https://img.shields.io/badge/build-passing-brightgreen?style=flat-square)
![Type Coverage](https://img.shields.io/badge/type_coverage-100%25-blue?style=flat-square)
![AI-Ready](https://img.shields.io/badge/AI--Ready-llms.txt-blueviolet?style=flat-square)

---

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
await order123.place('cust-99');

// Entities act as Immutable Hybrid Collections! 
// 1. You can iterate over them natively as a safe, read-only array:
const totalLines = order123.orderLines.length;

// 2. You can invoke them as command factories mapped perfectly by ID:
await order123.orderLines('line-1').cancel(); // Automatically maps to 'order.order_line.cancel.command'
```

## 🚀 The Elevator Pitch

*   **Immutable Hybrid Entity Collections**: Entities wrapped securely via proxies. Treat them seamlessly as safe Read-Only Arrays for UI iteration, and invoke them as targeted Command dispatcher functions bridging ID-mapped execution instantly.
*   **Path-Aware Convention**: Navigate and organize your commands and events effortlessly. Automatic routing driven by intuitive naming conventions reduces boilerplate.
*   **Encapsulated Logic**: Stop polluting your root aggregate. Entities (like `OrderLines`) keep their own private selectors and logic, exposed only where they matter.
*   **Type-Safe Contracts**: End-to-end type safety derived directly from your Command and Event schemas (powered by Zod), catching mismatches at compile time rather than runtime.
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
await mirage.dispatchShipment('123 Main St', 'express');
```

## 🧩 Aggregate Composition

Redemeine treats aggregates as composable building blocks:
*   **Inheritance**: Use `.extends(Parent)` to inherit all business rules, selectors, and events. For example, a `Shipment` can `.extends(Order)` to inherit its foundational logic while adding shipment-specific behaviors (like `Legs`).

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
