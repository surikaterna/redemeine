# Saga API Reference

This page is the quick reference for the **public** saga API exported from `redemeine`.

> ⚠️ **Breaking change:** the public saga surface is now intentionally minimal.

For generated API signatures, use `/docs/api/`.

## Public module overview

- `createSaga.ts`: typed saga definition builder and intent types.
- `RetryPolicy.ts`: retry validation, backoff scheduling, and classification helpers.

Public export barrel (`src/sagas/index.ts`):

- `createSaga`
- `SagaRetryPolicy` + retry helpers

Anything outside these documented exports is runtime implementation detail and may change without semver guarantees.

## Defining sagas

Use `createSaga<TCommands>()` to build a saga definition with compile-time command payload checks.

```ts
import { createSaga } from 'redemeine';

type InvoiceCommands = {
  'invoice.create': { invoiceId: string; amount: number };
};

const saga = createSaga<InvoiceCommands>()
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

- `SagaReducerOutput<TState, TCommands>`: required handler output shape.
- `SagaIntent<TCommands>`: union of `dispatch`, `schedule`, `cancel-schedule`, and `run-activity`.
- `SagaIntentMetadata`: `sagaId`, `correlationId`, `causationId` attached to all intents.

## Retry policy helpers

Retry helpers in `RetryPolicy.ts`:

- `validateRetryPolicy(policy)`
- `computeNextAttemptAt(policy, attempt, now, jitter?)`
- `isRetryableError(error, options?)`
- `classifyRetryableError(error, options?)`

Policy shape: `SagaRetryPolicy` (`maxAttempts`, `initialBackoffMs`, `backoffCoefficient`, optional caps/jitter).

## `commandsFor` note

- `ctx.commandsFor(Aggregate, aggregateId, metadataOverride?)` creates typed command factories from aggregate definitions while preserving saga intent metadata defaults.

## Migration summary (breaking)

If you used older/expanded saga docs, migrate as follows:

- **Keep using:** `createSaga` and retry helpers.
- **Stop using as public imports:** registry/event taxonomy modules and runtime persistence/execution internals.
- **Treat internals as unstable:** anything outside `src/sagas/index.ts` exports is implementation detail.
