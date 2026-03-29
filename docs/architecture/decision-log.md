---
title: "Architecture Decision Record: Mixins vs. Classes"
last_updated: 2026-03-22
status: stable
ai_priority: high
---

# Architecture Decision Record: Mixins vs. Classes

## Summary
This document outlines the architectural decision to transition from prototype-based class mutation (used in the legacy `demeine` framework) to a functional, package-based Mixin architecture in Redemeine. By leveraging `createAggregate` and composable Mixins, we achieve strict end-to-end TypeScript inference, eliminate prototype pollution, and allow complex aggregates (like `Shipment` extending `Order`) to be composed predictably without creating tightly coupled "God Objects."

## Context: The Limitations of `demeine`
The original `demeine` library favored a class-based, object-oriented approach where functionality was shared via prototype mutation (e.g., `Object.assign(Shipment.prototype, ...)` or relying on classic `extends`).

While familiar, this pattern introduced severe limitations in modern TypeScript environments:
1. **Type-Safety Blackholes:** Mutating prototypes at runtime defeats static verification. TypeScript struggles to accurately infer the shapes of classes built dynamically via `Object.assign`.
2. **"God Object" Anti-pattern:** Because functionality was coupled to class hierarchies, aggregates rapidly grew unwieldy, inheriting irrelevant methods or requiring mock-heavy unit tests.
3. **Hidden Mutations:** It was difficult to trace whether a method was purely reading state or causing a silent mutation, directly violating CQRS principles.

## The Redemeine Solution: Functional Builders & Mixins
To solve these issues, Redemeine was designed around a **functional builder pattern** coupled with isolated **Mixins** and **Entities**.

### 1. Robust Type-Safety via Fluid Chaining
Instead of dynamically manipulating classes, Redemeine uses `createAggregate`. Each chained call (`.mixins()`, `.entities()`, `.commands()`) progressively narrows and extends the statically inferred TypeScript types.

```typescript
// The compiler guarantees `TrackingMixin`'s commands and events are now part of Shipment
const ShipmentAggregate = createAggregate('Shipment', initial)
  .mixins(TrackingMixin)
  .build();
```

### 2. Predictable Composability
Mixins encapsulate logic (commands, events, and selectors) into truly reusable, isolated packages. If an aggregate needs audit logging, it includes an `AuditLogMixin`.

Furthermore, the new `.extends()` API allows for logical inheritance without traditional OOP baggage. You can compose a `Shipment` directly from an `Order` aggregate, gaining its foundational rules while injecting domain-specific extensions.

```typescript
const ShipmentBuilder = createAggregate('Shipment', initial)
  .extends(OrderAggregate) // Safely inherits Order rules without prototype linking
  .entities({ legs: LegEntity })
  .build();
```

### 3. Testability Without Mocks
Because Redemeine models state updates functionally (often transparently backed by Immer), you no longer need complex mock environments to unit test an aggregate. You can invoke a command handler directly with an initial state and immediately assert against the resulting returned domain events.

## Future ADR Placeholder: Transactional Outbox for Post-Commit Hooks

- **Status:** TODO / pending ADR
- **Motivation:** `onAfterCommit` currently runs inline after event persistence. This guarantees ordering but couples side-effects to request lifecycle and relies on retry orchestration outside the core runtime.
- **Planned direction:** formalize a full transactional outbox ADR that records post-commit intents atomically with event append, then executes/retries side-effects asynchronously via worker(s).
- **Short-term policy:** maintain current fail-closed-post-commit behavior with structured plugin hook errors while clearing pending in-memory results after successful append.
