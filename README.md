# 📦 Redemeine

> **Sane defaults CQRS/ES aggregates library for TypeScript**

![Build Status](https://img.shields.io/badge/build-passing-brightgreen?style=flat-square)
![Type Coverage](https://img.shields.io/badge/type_coverage-100%25-blue?style=flat-square)
![AI-Ready](https://img.shields.io/badge/AI--Ready-llms.txt-blueviolet?style=flat-square)

---

> Mirage command dispatch is synchronous by default, and becomes async only when awaited plugin interceptors are configured.

## ⚡ Visual Hook

```typescript
import { createAggregate } from '@redemeine/aggregate';
import { createMirage } from '@redemeine/mirage';

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

## 🧱 Monorepo Package Architecture

Redemeine now ships as a Bun+Turbo workspace with explicit package entry points:

- `@redemeine/kernel` - shared contracts and cross-package utilities
- `@redemeine/aggregate` - aggregate/entity/mixin builders
- `@redemeine/mirage` - live aggregate runtime helpers
- `@redemeine/projection` - projection builders + daemon/store helpers
- `@redemeine/saga` - saga definition DSL + retry utilities
- `@redemeine/saga-runtime` - runtime-facing saga orchestration seams

Legacy root imports from `redemeine` are deprecated for internal and new consumer code. Prefer direct `@redemeine/*` imports.

## 🛠️ Scaffold Your Project

Get up to speed in seconds by leveraging the CLI to generate your domain skeleton:

```bash
# Initialize a new Redemeine workspace with standard conventions
bunx redemeine init <name>

# Generate a new aggregate with its standard command and event files
# (This automatically scaffolds a "Given/When/Then" test suite!)
bunx redemeine generate aggregate Shipment
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

## support 
spawn sub sagas
startOn(starTrigger(...));
Resume:
1. Repairing a Failed Request (Payload Rewrite)
2. The "Fork and Resume" (Manual Rewind)
Instead of rewinding the existing Saga, you Fork it into a new instance:

Abandon V1: You send a command to the broken Saga: AbandonWorkflow(reason: 'Bug in reducer'). The framework marks it as terminal.

Create V2 (The Fork): The framework creates a brand new Saga stream (e.g., Order-123-v2).

Copy History: The framework copies all events from V1 up to the explicit "fork point" you specified, and appends them to V2.

Resume: V2 hydrates its state from those copied events. Because your new, bug-free code is now running, when it evaluates the last event, it makes the correct state transition and generates the correct intents.

Crucial Guardrail: When building the Fork feature, your framework must carry over the original intentIds for any side-effects that were already executed prior to the fork point. This ensures that the Outbox's idempotency checks prevent V2 from double-charging a credit card that V1 already charged.
3. The "Force Transition" (The Ultimate Escape Hatch)
Sometimes, the external world just breaks, and neither a code fix nor a payload repair will save you. (e.g., A partner company goes bankrupt and their webhook will never fire).

You need the ability to manually shove the Saga into its next state.

The Solution: Synthetic Events
Your operations team should be able to inject a "Synthetic Event" into the Saga's stream as if it came from the real world.

e.g., InjectEvent(type: 'PartnerApproved', payload: { manualOverrideBy: 'admin@company.com' })
The Saga's pure reducer receives this event, wakes up, and continues the workflow normally.

## Versioning:
Here is the complete Epic for Saga Versioning & Lifecycle Management.

This finalizes the operational robustness of the redemeine framework, ensuring that long-running workflows can safely evolve over months or years without corrupting in-flight state or violating the immutable Event Store.

Epic: Saga Versioning & Lifecycle Management
📖 Context & Background
In distributed systems, versioning long-running business processes (Sagas) is exceptionally dangerous. If a workflow spans 30 days, deploying a new required step on Day 15 can corrupt the state machine of in-flight instances. Because Event Sourcing relies on an immutable historical ledger, we cannot "migrate" database tables or rewrite historical events to match new code.

To solve this, the redemeine framework will natively support three professional versioning strategies: Side-by-Side Execution (running multiple versions simultaneously), the Tolerant Reader (safe in-place upgrades for backward-compatible changes), and Process Handoffs (forced migrations from V1 to V2). The framework routing engine will use explicit metadata to ensure events are always routed to the correct version of the workflow logic.

🎯 User Stories
As a Domain Developer, I want to write backward-compatible additions to my pure reducers (e.g., adding an optional welcome email) without crashing in-flight Sagas that were started before this feature existed.

As an Infrastructure Engineer, I want to deploy a structurally different V2 of a workflow alongside V1, so that new orders use the new logic while existing orders safely complete on the legacy code.

As a DevOps/Operations Engineer, I want telemetry indicating exactly how many instances of a specific Saga version are still active, so I know when it is safe to permanently delete legacy code from the repository.

As a Business Stakeholder, I want the ability to force an active V1 workflow to immediately upgrade to V2 mid-flight if a legacy external vendor shuts down unexpectedly.

🏗️ Architectural Requirements
1. The Versioned Definition API
The framework must treat version as a first-class routing citizen in the DSL.

The createSaga definition must explicitly require (or strongly default to) a version: number parameter.

The generated SagaDefinition manifest must expose this version to the runtime.

Developers must be able to register multiple versions of the same Saga name simultaneously (e.g., createSaga({ name: 'fulfillment', version: 1 }) and createSaga({ name: 'fulfillment', version: 2 })).

2. The Version-Aware Event Router (Side-by-Side Execution)
The framework's worker daemon must route incoming events to the exact code version that owns the state.

Instance Creation: When an event triggers a new Saga instance (e.g., orderPlaced), the framework must route it to the highest registered version of that Saga (e.g., V2) and tag the resulting state document with _version: 2.

State Resumption: When a subsequent event arrives for an active Saga, the framework must read the _version from the database and route the event to the matching code version (e.g., V1), entirely ignoring the existence of V2.

3. The Tolerant Reader Guarantee (In-Place Upgrades)
The framework must not crash when hydrating state that is older than the current reducer code.

The Immer draft passed into the .on() reducer must naturally support undefined coalescing for newly added fields.

The pure reducer's type definitions must allow developers to explicitly check for missing historical state and assign safe defaults.

4. Process Handoffs & Spawning (Forced Migrations)
The framework must provide a safe escape hatch for a V1 Saga to terminate itself and spawn a V2 Saga.

Ensure the Unified Plugin Architecture exposes a spawnChild (or spawnSibling) action via a lifecycle plugin (e.g., ctx.plugins.lifecycle.spawn('fulfillment', 2, mappedState)).

The framework must guarantee transactional atomicity: appending the V1.Completed event and the V2.Started event must succeed or fail together, preventing a workflow from being lost in the void during handoff.

✅ Acceptance Criteria (Definition of Done)
Side-by-Side Test: A developer registers fulfillmentSagaV1 and fulfillmentSagaV2. An event for an existing V1 workflow correctly routes to the V1 code. A trigger event for a brand new workflow correctly creates a V2 instance.

Tolerant Reader Test: A developer adds a new state property isPriority: boolean to an existing Saga. Hydrating an old event stream that does not contain this property successfully yields an Immer draft where isPriority safely evaluates to undefined or a developer-provided default.

Handoff Migration Test: A V1 Saga explicitly calls ctx.plugins.lifecycle.spawn('fulfillment_v2', state) and ctx.complete(). The framework correctly terminates V1, initializes V2 with the passed state, and subsequent events are routed exclusively to the new V2 stream.

Telemetry Visibility: The framework's diagnostic logs or metrics adapter accurately reports the count of active, suspended, and completed instances grouped by SagaName and Version.

##
Native OpenTelemetry: The framework execution wrappers automatically track the "Holy Trinity" of distributed tracing (MessageId, CorrelationId, CausationId). This stitches together asynchronous API calls, events, and side-effects into a perfect Directed Acyclic Graph (DAG) without the developer writing a single line of logging code. It also tracks critical system health metrics like Projection_Lag_Count.


## Testing:
Epic: Framework Testing Utilities (@redemeine/testing)
📖 Context & Background
In traditional microservice architectures, testing business logic requires heavy infrastructure: spinning up mongodb-memory-server, stubbing Kafka brokers, mocking HTTP libraries (nock, jest.spyOn), and manipulating global clocks for timeouts (jest.useFakeTimers). This makes test suites slow, flaky, and hard to maintain.

Because redemeine isolates all side-effects and database I/O to the framework edges, 99% of the application's business logic exists as mathematically pure functions. The @redemeine/testing package must provide a suite of developer-friendly, fluent testing wrappers that execute these pure functions instantly. Developers should be able to assert complex long-running workflows and strict database invariants entirely in memory, with zero infrastructure dependencies.

🎯 User Stories
As a Domain Developer, I want to test my Aggregate's business rules using a BDD (Given/When/Then) syntax, so I can prove that a specific history of events correctly accepts or rejects a new command.

As a Workflow Developer, I want to test a 30-day Saga workflow (including HTTP retries and timeouts) synchronously in milliseconds, without having to manipulate system clocks or mock network libraries.

As a Read-Model Developer, I want to verify that a Projection correctly mutates state and generates the exact MongoDB JSON Patches I expect, without needing a real MongoDB connection.

As a System Architect, I want an in-memory version of the entire framework engine so I can write fast end-to-end integration tests that verify my Aggregates, Sagas, and Projections are wired together correctly.

🏗️ Architectural Requirements
1. The Aggregate Tester (testAggregate)
Provide a fluent, BDD-style fixture for validating pure command execution and state hydration.

API: testAggregate(aggregateDef)

.given(events): Hydrates the aggregate's Immer state by folding the historical events through its .reduce() handlers.

.when(command, payload): Executes the pure .commands() handler against the hydrated state.

Assertions: * .expectEvents(events): Deep-equals the array of typed events returned by the command.

.expectError(ErrorClass, message?): Asserts that the command handler threw the expected Domain Error (Invariant Violation).

2. The Saga Tester (testSaga)
Provide a fluent fixture that executes a Saga's .on() or .responseDefinitions() and captures the resulting infrastructure Intents.

API: testSaga(sagaDef)

State Management: .withState(state) allows the developer to arrange the starting point. State mutations must carry forward automatically when chaining methods.

Event Injection: .receiveEvent(event) triggers the main reducer.

Response/Error Injection: .invokeResponse(token, payload) and .invokeError(token, payload) allow the developer to simulate the framework routing an external worker's response back to the Saga, including the serialized passThroughContext.

Token bindings come from `responseDefinitions(...)` (persisted as `response_handlers`), while executable callbacks registered through `.onResponses(...)` / `.onErrors(...)` are runtime-only maps (`executable_response_handlers` / `executable_error_handlers`).

Determinism: invoke calls dequeue pending requests in FIFO order per token, so chained `.invokeError(...)` / `.invokeResponse(...)` sequences are stable and repeatable.

Assertions: * .expectState(expected): Deep-equals the mutated Immer draft.

.expectIntents(intents): Deep-equals the exact array of Plugin Intents yielded to the Outbox (e.g., verifying a schedule or https intent was generated with the correct routing metadata).

3. The Projection Tester (testProjection)
Provide a simple fixture to validate Read-Model mutations and database patch generation.

API: testProjection(projectionDef)

Execution: .withState(state).applyEvent(event)

Assertions: Must expose both the final .state and the generated .patches (the JSON Patch array) for developer assertions.

4. The In-Memory Integration Engine (createTestDepot)
Provide an infrastructure-free version of the complete framework runtime for integration testing.

API: createTestDepot({ aggregates, sagas, projections })

Behavior: Instantiates the real Event Router, Command Bus, and Projection Daemon, but replaces the EventStore, ProjectionStore, and PluginWorkers with synchronous, in-memory Maps and Arrays.

Execution: Developers can depot.dispatch(...) at the entry point, await depot.waitForIdle() to let the internal queues drain, and then query depot.projections.get(...) to verify end-to-end success.

✅ Acceptance Criteria (Definition of Done)
Aggregate Validation: An aggregate test successfully fails if a when command violates an invariant based on the given history, and successfully passes when asserting the correct emitted events.

Saga Time-Travel Chain: A Saga test successfully chains .receiveEvent() -> .invokeError() -> .invokeResponse() in a single fluent block, proving that state carries forward, retries increment correctly, and time-based schedule intents are asserted identically to HTTP intents.

Phase safety: `invokeResponse` accepts response-phase tokens only, and `invokeError` accepts error-phase tokens only.

Strict Purity: The entire @redemeine/testing suite can be executed on a machine with no internet connection, no Docker daemon, and no mocked external libraries (like nock), completing 1,000 assertions in under 2 seconds.

Depot End-to-End: An integration test successfully dispatches a Command, which emits an Event, which updates an in-memory Projection, all within a single createTestDepot instance.

## Plugins for opentelemetry in runtimes
