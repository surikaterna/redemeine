# Redemeine Sagas Starter: Build a Retryable Billing Flow

This starter walks through the minimum moving parts for building an event-sourced saga in Redemeine.

> ⚠️ **Breaking change:** this tutorial now focuses on the minimal public API (`createSaga` + retry helpers).

You will:

1. Define typed command contracts.
2. Build a saga with `createSaga`.
3. Attach retry policy where needed.

## 1) Define command contracts

```ts
type SagaCommands = {
  'billing.charge': { invoiceId: string; amount: number };
  'billing.notify': { invoiceId: string; channel: 'email' | 'sms' };
};
```

`createSaga<SagaCommands>()` uses this command map to type-check every `ctx.dispatch(...)` call.

## 2) Build the saga definition

```ts
import { createSaga } from 'redemeine';

export const BillingSaga = createSaga<SagaCommands>()
  .initialState(() => ({ attempts: 0, settled: false }))
  .correlate('invoice', event => event)
  .on('invoice', {
    created: ctx => {
      const chargeIntent = ctx.dispatch('billing.charge', {
        invoiceId: 'inv-1',
        amount: 250
      });

      const notifyIntent = ctx.dispatch('billing.notify', {
        invoiceId: 'inv-1',
        channel: 'email'
      });

      const timeoutIntent = ctx.schedule('invoice-timeout', 5_000);

      return {
        state: {
          ...ctx.state,
          attempts: ctx.state.attempts + 1
        },
        intents: [chargeIntent, notifyIntent, timeoutIntent]
      };
    }
  })
  .build();
```

Every handler returns `{ state, intents }`, which keeps state transitions deterministic and side effects explicit.

## 3) Add retry policy to activity intents

```ts
import {
  createSaga,
  validateRetryPolicy
} from 'redemeine';

const policy = validateRetryPolicy({
  maxAttempts: 5,
  initialBackoffMs: 500,
  backoffCoefficient: 2,
  maxBackoffMs: 30_000,
  jitterCoefficient: 0.2
});

const sagaWithActivity = createSaga<SagaCommands>()
  .initialState(() => ({ attempts: 0, settled: false }))
  .on('invoice', {
    created: ctx => ({
      state: ctx.state,
      intents: [
        ctx.runActivity('charge-card', async () => {
          // external call
        }, policy)
      ]
    })
  })
  .build();
```

`ctx.runActivity(...)` keeps retries explicit and typed while the runtime handles scheduling/execution internally.

## 4) Keep integration boundaries explicit

Saga definitions are pure contracts: they describe state transitions and emitted intents.

In practice:

- Keep consumer code on exported saga definition APIs.
- Avoid importing runtime execution/persistence helpers from internal paths.
- Treat runtime wiring as application-level integration detail.

## Optional public seams

- `validateRetryPolicy`, `computeNextAttemptAt`, `isRetryableError`, `classifyRetryableError`: retry behavior helpers.

For full API details, see `/docs/reference/sagas-reference` and `/docs/api/`.
