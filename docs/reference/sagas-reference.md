# Saga API Reference

This page is the quick reference for the **public** saga API exported from `redemeine`.

> ⚠️ **Breaking change:** the public saga surface is now intentionally minimal.

For generated API signatures, use `/docs/api/`.

## Public module overview

- `createSaga.ts`: typed saga definition builder and intent types.
- `RetryPolicy.ts`: retry validation, backoff scheduling, and classification helpers.
- `createSagaAggregate.ts`: public constructor/export for the structure-only `SagaAggregate` contract.

Public export barrel (`src/sagas/index.ts`):

- `createSaga`
- `SagaRetryPolicy` + retry helpers
- `createSagaAggregate`
- `startPolicy` typed helper API
- trigger start contracts (`SagaTriggerStartContract`)

Usage note:

- `createSagaAggregate(nameOrOptions?)` exposes the public, structure-only saga aggregate contract used for persisted saga records and wire-level shape typing.

Anything outside these documented exports is runtime implementation detail and may change without semver guarantees.

## Defining sagas

Use `createSaga<TState>(nameOrOptions?)` to build a saga definition.

- `TState` is your saga state shape.
- `nameOrOptions?` is optional and lets you provide a saga name/config.
- Handlers use mutation-style state updates (Immer draft semantics).

```ts
import { createSaga } from 'redemeine';

type InvoiceSagaState = {
  attempted: number;
  settled: boolean;
};

const InvoiceAggregate = {
  __aggregateType: 'invoice',
  pure: {
    eventProjectors: {
      created: (state: unknown, event: { payload: { invoiceId: string; amount: number } }) => state
    }
  },
  commandCreators: {
    create: (input: { invoiceId: string; amount: number }) => ({
      type: 'invoice.create',
      payload: input
    })
  }
} as const;

const saga = createSaga<InvoiceSagaState>('invoice-saga')
  .initialState(() => ({ attempted: 0, settled: false }))
  .correlate(InvoiceAggregate, event => event.payload.invoiceId)
  .on(InvoiceAggregate, {
    created: (state, event, ctx) => {
      state.attempted += 1;

      const commands = ctx.commandsFor(InvoiceAggregate, event.payload.invoiceId);
      commands.create({
        invoiceId: event.payload.invoiceId,
        amount: event.payload.amount
      });
      ctx.schedule('invoice-reminder', 5_000);
    }
  })
  .build();
```

Core contracts:

- Handler signature: `(state, event, ctx)` mutation-style state updates.
- Handlers emit intents via `ctx.commandsFor(...)`, `ctx.dispatchTo(...)`, `ctx.schedule(...)`, `ctx.cancelSchedule(...)`, and `ctx.runActivity(...)`.
- `SagaIntent`: union of `dispatch`, `schedule`, `cancel-schedule`, and `run-activity`.
- `SagaIntentMetadata`: `sagaId`, `correlationId`, `causationId` attached to all intents.

## Retry policy helpers

Retry helpers in `RetryPolicy.ts`:

- `validateRetryPolicy(policy)`
- `computeNextAttemptAt(policy, attempt, now, jitter?)`
- `isRetryableError(error, options?)`
- `classifyRetryableError(error, options?)`

Policy shape: `SagaRetryPolicy` (`maxAttempts`, `initialBackoffMs`, `backoffCoefficient`, optional caps/jitter).

## Typed aggregate dispatch

- `commandsFor(Aggregate, aggregateId, metadataOverride?)` returns typed command factories derived from aggregate command creators.
- `dispatchTo` is the common variable name for that typed command factory.
- Prefer aggregate command creators over string command names for dispatch typing.

## Start policy helpers (typed, no magic strings)

Use `startPolicy` helpers instead of raw string literals when defining trigger start behavior.

```ts
import { startPolicy, type SagaTriggerStartContract } from 'redemeine';

const triggerConfig: SagaTriggerStartContract = {
  startPolicy: startPolicy.ifIdle()
};

const joinConfig: SagaTriggerStartContract = {
  startPolicy: startPolicy.joinExisting()
};

const restartConfig: SagaTriggerStartContract = {
  startPolicy: startPolicy.restart({ mode: 'graceful', reason: 'manual replay' })
};
```

Accepted restart modes are `'graceful' | 'force'`.

## SagaAggregate structure-only model

`SagaAggregate` is a **persistence/contract shape** for saga state and emitted records.
It is intentionally structure-only and does **not** define runtime worker behavior.

### Naming and wire format conventions

- Saga state uses **camelCase** keys (for example `createdAt`, `updatedAt`, `transitionVersion`).
- Command and event `type` values on the wire use **snake_case** naming.
- Temporal fields are serialized as **ISO8601** timestamps.
- Recent transition/event/activity history is stored in **compact windows** (bounded arrays), with totals tracked separately.

Example structural shape:

```ts
type SagaAggregateState = {
  sagaId: string;
  createdAt: string; // ISO8601
  updatedAt: string; // ISO8601
  transitionVersion: number;
  recentTransitions: Array<{ type: string; at: string }>;
  recentEvents: Array<{ type: string; at: string }>;
  recentActivities: Array<{ name: string; at: string }>;
  totalTransitions: number;
  totalEvents: number;
  totalActivities: number;
};

type SagaWireRecord = {
  type: 'saga_transition_recorded' | 'saga_activity_scheduled' | 'saga_activity_completed';
  at: string; // ISO8601
  payload: Record<string, unknown>;
};
```

### Intent vs activity (explicit terminology)

- **Intent**: a deterministic instruction emitted by saga logic (for example: dispatch command, schedule timer, cancel timer, run activity).
- **Activity**: the side-effecting execution unit that happens at runtime when a `runActivity` intent is executed.

In other words, the saga definition emits intents; runtime infrastructure may later execute activities.

> Out of scope for this reference: runtime worker/executor implementation details (queueing, polling, retries in workers, etc.).

## Migration summary (breaking)

If you used older/expanded saga docs, migrate as follows:

- **Keep using:** `createSaga` and retry helpers.
- **Use new builder form:** `createSaga<TState>(nameOrOptions?)`.
- **Use aggregate-typed handlers:** `.on(Aggregate, handlers)`.
- **Use mutation-style handlers:** update saga state directly in handler scope (Immer semantics).
- **Use typed dispatch factories:** `commandsFor(...)` / `dispatchTo.<commandCreator>(...)`.
- **Stop using as public imports:** registry/event taxonomy modules and runtime persistence/execution internals.
- **Treat internals as unstable:** anything outside `src/sagas/index.ts` exports is implementation detail.
