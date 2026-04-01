# Redemeine Sagas Starter: Build a Retryable Billing Flow

This starter walks through the minimum moving parts for building a manifest-first, event-sourced saga in Redemeine.

> ⚠️ **Breaking change:** this tutorial now focuses on the manifest-first saga definition API (`createSaga({ name, plugins? })`).

You will:

1. Define saga state.
2. Define plugins with `defineSagaPlugin(...)`.
3. Build a saga with `createSaga({ name, plugins? })`.
4. Use namespaced plugin actions (`ctx.actions.<plugin_key>.<action>(...)`).
5. Route `request_response` actions with `.withData(...).onResponse(token).onError(token)`.

## 1) Define saga state

```ts
type BillingSagaState = {
  attempts: number;
  settled: boolean;
};
```

`createSaga<BillingSagaState>(...)` keeps handler state usage fully inferred.

## 2) Define plugin manifests

```ts
import { defineSagaPlugin } from 'redemeine';

export const InfraPlugin = defineSagaPlugin({
  plugin_key: 'infra',
  actions: {
    scheduleCommand: {
      action_kind: 'void',
      build: (name: 'billing.retry', delayMs: number) => ({ name, delayMs })
    }
  }
});

export const HttpPlugin = defineSagaPlugin({
  plugin_key: 'http',
  actions: {
    get: {
      action_kind: 'request_response',
      build: (url: string, headers?: Record<string, string>) => ({ url, headers })
    }
  }
});
```

## 3) Build the saga definition (canonical mixed-action example)

```ts
import { createSaga } from 'redemeine';

const BillingAggregate = {
  __aggregateType: 'billing',
  pure: {
    eventProjectors: {
      created: (state: unknown, event: { payload: { invoiceId: string; amount: number } }) => state
    }
  },
  commandCreators: {
    charge: (input: { invoiceId: string; amount: number }) => ({
      type: 'billing.charge',
      payload: input
    }),
    notify: (input: { invoiceId: string; channel: 'email' | 'sms' }) => ({
      type: 'billing.notify',
      payload: input
    })
  }
} as const;

export const BillingSaga = createSaga<BillingSagaState>({
  name: 'billing-saga',
  plugins: [InfraPlugin, HttpPlugin] as const
})
  .responseHandlers({
    billingFetchSucceeded: {
      plugin_key: 'http',
      action_name: 'get',
      phase: 'response'
    },
    billingFetchFailed: {
      plugin_key: 'http',
      action_name: 'get',
      phase: 'error'
    }
  })
  .initialState(() => ({ attempts: 0, settled: false }))
  .correlate(BillingAggregate, event => event.payload.invoiceId)
  .on(BillingAggregate, {
    created: (state, event, ctx) => {
      state.attempts += 1;

      // void plugin action
      ctx.actions.infra.scheduleCommand('billing.retry', 5_000);

      // request_response plugin action chain
      ctx.actions.http
        .get(`https://api.example.com/billing/${event.payload.invoiceId}`)
        .withData({ invoiceId: event.payload.invoiceId, attempt: state.attempts })
        .onResponse(ctx.onResponse.billingFetchSucceeded)
        .onError(ctx.onError.billingFetchFailed);

      // core actions are available in the same namespace
      const commands = ctx.actions.core.dispatch(BillingAggregate, event.payload.invoiceId);
      commands.charge({ invoiceId: event.payload.invoiceId, amount: 250 });
      commands.notify({ invoiceId: event.payload.invoiceId, channel: 'email' });
      ctx.actions.core.schedule('invoice-timeout', 5_000);
    }
  })
  .build();
```

Handlers are mutation-style (Immer semantics): mutate `state`, then emit intents through `ctx` helpers.

Request routing is durable and restart-safe because only named handler tokens are persisted (`response_handler_key`, `error_handler_key`, `handler_data`). Inline callback persistence is not supported.

## 4) Add retry policy to activity intents

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

const sagaWithActivity = createSaga<BillingSagaState>('billing-saga')
  .initialState(() => ({ attempts: 0, settled: false }))
  .on(BillingAggregate, {
    created: (state, event, ctx) => {
      ctx.runActivity('charge-card', async () => {
        // external call
      }, policy);
    }
  })
  .build();
```

`ctx.runActivity(...)` keeps retries explicit and typed while the runtime handles scheduling/execution internally.

## 5) Keep integration boundaries explicit

Saga definitions are pure contracts: they describe state transitions and emitted intents.

Definition-only scope reminder: plugin runtime execution is intentionally out of scope for this API layer.

### SagaAggregate terminology (intent vs activity)

When persisting saga progress as a structure-only `SagaAggregate` model, keep these terms distinct:

- Code-level keys remain camelCase (`scheduleCommand`, `billingFetchSucceeded`, etc.).
- Persisted/wire metadata fields remain snake_case (`plugin_key`, `action_name`, `response_handler_key`, `error_handler_key`, `handler_data`).
- Event/command `type` values on the wire are snake_case.
- Timestamps are ISO8601 strings.
- Recent transitions/events/activities are compact bounded windows with separate totals.
- **Intent** means the declarative instruction produced by saga logic.
- **Activity** means the runtime side effect that executes from a prior intent.

Runtime worker/executor implementation is intentionally out of scope for this tutorial.

In practice:

- Keep consumer code on exported saga definition APIs.
- Prefer aggregate command creators for typed dispatch (`commandsFor` / `dispatchTo`).
- Avoid importing runtime execution/persistence helpers from internal paths.
- Treat runtime wiring as application-level integration detail.

## Optional public seams

- `validateRetryPolicy`, `computeNextAttemptAt`, `isRetryableError`, `classifyRetryableError`: retry behavior helpers.

For full API details, see `/docs/reference/sagas-reference` and `/docs/api/`.
