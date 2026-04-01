# Saga API Reference

This page is the quick reference for the **public** saga API exported from `redemeine`.

> ⚠️ **Breaking change (slim-core runtime):** runtime execution/persistence modules are now internal-only and are no longer part of the public package surface.

For generated API signatures, use `/docs/api/`.

## Public module overview

- `createSaga.ts`: typed saga definition builder and intent types.
- `RetryPolicy.ts`: retry validation, backoff scheduling, and classification helpers.
- `SagaRegistry.ts`: registration/discovery helper for saga definitions.
- `events.ts`: canonical saga taxonomy event names.

Public export barrel (`src/sagas/index.ts`):

- `createSaga`
- `SAGA_EVENT_NAMES`, `SagaEventName`
- `SagaRetryPolicy` + retry helpers
- `createSagaRegistry`, `registerSaga`, `getSagaRegistry`

Anything outside these documented exports is runtime implementation detail and may change without semver guarantees.

## Defining sagas

Use `createSaga<TCommandMap>()` to build a saga definition with compile-time command payload checks.

```ts
import { createSaga } from 'redemeine';

type InvoiceCommandMap = {
  'invoice.create': { invoiceId: string; amount: number };
};

const saga = createSaga<InvoiceCommandMap>()
  .initialState(() => ({ attempted: 0 }))
  .on('invoice', {
    created: ctx => {
      const dispatchIntent = ctx.dispatch('invoice.create', {
        invoiceId: 'inv-1',
        amount: 100
      });

      const scheduleIntent = ctx.schedule('invoice-reminder', 5_000);

      return {
        state: { ...ctx.state, attempted: ctx.state.attempted + 1 },
        intents: [dispatchIntent, scheduleIntent]
      };
    }
  })
  .build();
```

Core contracts:

- `SagaReducerOutput<TState, TCommandMap>`: required handler output shape.
- `SagaIntent<TCommandMap>`: union of `dispatch`, `schedule`, `cancel-schedule`, and `run-activity`.
- `SagaIntentMetadata`: `sagaId`, `correlationId`, `causationId` attached to all intents.

## Runtime architecture note (internal-only)

Redemeine still executes sagas using an internal runtime model, and those modules are intentionally hidden from the package API.

This means:

- You define sagas through `createSaga(...)`.
- The framework/runtime integration layer handles persistence, projections, dedupe, replay behavior, and worker orchestration.
- Consumer apps should not import runtime helpers directly from internal package paths.

## Retry policy helpers

Retry helpers in `RetryPolicy.ts`:

- `validateRetryPolicy(policy)`
- `computeNextAttemptAt(policy, attempt, now, jitter?)`
- `isRetryableError(error, options?)`
- `classifyRetryableError(error, options?)`

Policy shape: `SagaRetryPolicy` (`maxAttempts`, `initialBackoffMs`, `backoffCoefficient`, optional caps/jitter).

## Registry helpers

Use `SagaRegistry` helpers for runtime registration/discovery:

- `createSagaRegistry()`
- `registerSaga(...)`
- `getSagaRegistry()`

Registered shape: `RegisteredSagaDefinition<TState, TCommandMap>`.

## Canonical saga event names

`SAGA_EVENT_NAMES` exports the canonical taxonomy, and `SagaEventName` is its union type.

This taxonomy is aligned with the ADR entry in `docs/architecture/decision-log.md`.

## `commandsFor` note

- `ctx.commandsFor(Aggregate, aggregateId, metadataOverride?)` creates typed command factories from aggregate definitions while preserving saga intent metadata defaults.

## Migration summary (breaking)

If you used older/expanded saga docs, migrate as follows:

- **Keep using:** `createSaga`, saga event taxonomy, retry helpers, and saga registry helpers.
- **Stop using as public imports:** runtime persistence adapters, runtime projections, event buffers, replay/daemon execution helpers.
- **Assume internal runtime placement:** internal runtime modules are implementation detail, not stable API.
