# Redemeine Sagas Starter: Build a Retryable Billing Flow

This starter walks through the minimum moving parts for building an event-sourced saga in Redemeine.

> ⚠️ **Breaking change:** this tutorial now focuses on the stable public API (`createSaga`, retry helpers, registry, event taxonomy). Runtime execution/persistence modules are internal and no longer public imports.

You will:

1. Define a typed command map.
2. Build a saga with `createSaga`.
3. Attach retry policy where needed.
4. Register saga definitions for runtime discovery.

## 1) Define command contracts

```ts
type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
  'billing.notify': { invoiceId: string; channel: 'email' | 'sms' };
};
```

`createSaga<BillingCommandMap>()` uses this map to type-check every `ctx.dispatch(...)` call.

## 2) Build the saga definition

```ts
import { createSaga } from 'redemeine';

export const BillingSaga = createSaga<BillingCommandMap>()
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

const sagaWithActivity = createSaga<BillingCommandMap>()
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

## 4) Register sagas for runtime discovery

```ts
import {
  createSagaRegistry,
  registerSaga,
  getSagaRegistry
} from 'redemeine';

const registry = createSagaRegistry();

registerSaga({
  name: 'billing',
  definition: BillingSaga
}, registry);

const discovered = registry.get('billing');

// shared process-level registry is also available
registerSaga({
  name: 'billing-shared',
  definition: BillingSaga
});

const shared = getSagaRegistry().list();
```

## Runtime architecture (internal-only)

Redemeine persists and executes saga intents through an internal runtime aggregate/projection system. Those runtime modules now live under internal paths and are intentionally not part of the stable public API.

In practice:

- Keep consumer code on exported saga definition APIs.
- Avoid importing runtime execution/persistence helpers directly.
- Treat internal runtime placement as implementation detail.

## Optional public seams

- `createSagaRegistry`, `registerSaga`, `getSagaRegistry`: register and discover saga definitions.
- `validateRetryPolicy`, `computeNextAttemptAt`, `isRetryableError`, `classifyRetryableError`: retry behavior helpers.
- `SAGA_EVENT_NAMES`: canonical saga taxonomy constants.

For full API details, see `/docs/reference/sagas-reference` and `/docs/api/`.
