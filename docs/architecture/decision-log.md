---
title: 'Architecture Decision Record: Mixins vs. Classes'
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
const ShipmentAggregate = createAggregate('Shipment', initial).mixins(TrackingMixin).build();
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

## ADR: Event-Sourced Process Managers (Sagas)

- **Status:** Accepted
- **Date:** 2026-03-30

### Decision

Redemeine will model process managers (sagas) as event-sourced modules that consume domain events and emit explicit, persisted saga intents. Saga progress, retries, failures, and completion are represented as first-class saga events so replay is deterministic and side-effect execution is never inferred from transient runtime state.

### Canonical Saga Event / Intent Taxonomy

The taxonomy below is canonical for S01 and should be referenced by runtime implementation work:

1. **Observed / Decision Inputs**
    - `saga.event-observed`
    - Meaning: A domain event relevant to a saga instance has been seen and correlated.

2. **Intent Lifecycle**
    - `saga.intent-recorded`
    - Meaning: A side-effect intent has been persisted (for example: dispatch command, publish message, invoke integration).
    - `saga.intent-dispatched`
    - Meaning: Execution of a recorded intent has started.
    - `saga.intent-succeeded`
    - Meaning: Intent execution completed successfully.
    - `saga.intent-failed`
    - Meaning: Intent execution failed with a classified error and retry metadata.
    - `saga.intent-retry-scheduled`
    - Meaning: A next attempt was scheduled using retry policy/backoff.
    - `saga.intent-dead-lettered`
    - Meaning: Intent exceeded retry policy and was moved to dead-letter handling.

3. **Saga Instance Lifecycle**
    - `saga.started`
    - Meaning: Saga instance created from first correlated event.
    - `saga.advanced`
    - Meaning: Saga state advanced to next logical step.
    - `saga.completed`
    - Meaning: Saga reached terminal success state.
    - `saga.compensating`
    - Meaning: Saga entered compensation flow after unrecoverable failure.
    - `saga.compensated`
    - Meaning: Compensation completed.
    - `saga.failed`
    - Meaning: Saga reached terminal failure state.

### Intent Categories

Saga intents are persisted as explicit execution requests and grouped by category:

- **Command Intent**: dispatch a typed command to an aggregate.
- **Integration Intent**: invoke external transport/integration boundary.
- **Timer Intent**: schedule delayed wake-up or timeout transition.
- **Compensation Intent**: execute compensating action for prior successful step.

### Module Placement and Structure (updated for slim-core)

Saga architecture is now split into:

1. **Public saga API** (stable imports for consumers)
2. **Internal runtime implementation** (non-public, runtime-only)

Public surface (exported from `src/sagas/index.ts`):

```text
src/
  sagas/
    index.ts
    createSaga.ts
    events.ts
    RetryPolicy.ts
    SagaRegistry.ts
```

Runtime implementation (internal-only):

```text
src/
  sagas/
    internal/
      runtime/
        SagaRuntimeAggregate.ts
        SagaRuntimePersistenceAdapter.ts
        RuntimeIntentProjection.ts
        SagaIntentExecutionAdapter.ts
        SagaIntentRouter.ts
        SagaRouterDaemon.ts
        IntentLease.ts
        replayExecution.ts
        execution/
          contracts.ts
          decision.ts
          execute.ts
          orchestration.ts
        aggregate/
          observationStartMixin.ts
          queueingMixin.ts
          executionTransitionsMixin.ts
          retryDeadLetterMixin.ts
          shared.ts
          types.ts
```

Notes:

- `events.ts` defines the canonical saga taxonomy exported via `SAGA_EVENT_NAMES`.
- `createSaga.ts` defines typed saga reducers and intent contracts.
- Runtime aggregate/projection/execution modules are intentionally internal and may change without semver guarantees.

### Breaking change notice (R20)

The following saga modules/helpers are no longer documented as public API and should be treated as internal runtime plumbing:

- runtime aggregate/persistence adapters
- runtime projections and event buffers
- dedupe/replay execution helpers
- router/worker runtime orchestration seams

Consumers should depend on the public saga definition surface only (`createSaga`, retry helpers, registry helpers, canonical event names).

As saga feature slices progress, these shared modules can be complemented by feature-first saga folders where appropriate.
