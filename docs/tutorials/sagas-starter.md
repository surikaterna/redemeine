# Redemeine Sagas Starter: Build a Retryable Billing Flow

This starter walks through the minimum moving parts for building a helper-first, event-sourced saga in Redemeine.

> ⚠️ **Breaking change:** this tutorial now focuses on the manifest-first saga definition API (`createSaga({ name, plugins? })`).

You will:

1. Define saga state.
2. Define plugins with `defineSagaPlugin(...)` helper actions.
3. Build a saga with `createSaga({ name, plugins? })`.
4. Use namespaced plugin actions (`ctx.actions.<plugin_key>.<action>(...)`).
5. Route request/response actions with optional `.withData(...)`, optional `.onRetry(...)`, then `.onResponse(token).onError(token)`.

## 1) Define saga state

```ts
type BillingSagaState = {
  attempts: number;
  settled: boolean;
};
```

`createSaga<BillingSagaState>(...)` keeps handler state usage fully inferred.

## 2) Define plugin manifests with helper APIs

```ts
import {
  defineSagaPlugin,
  defineOneWay,
  defineRequestResponse,
  defineCustomAction
} from '@redemeine/saga';

export const InfraPlugin = defineSagaPlugin({
  plugin_key: 'infra',
  actions: {
    scheduleCommand: defineOneWay((name: 'billing.retry', delayMs: number) => ({ name, delayMs }))
  }
});

export const HttpPlugin = defineSagaPlugin({
  plugin_key: 'http',
  actions: {
    get: defineRequestResponse((url: string, headers?: Record<string, string>) => ({ url, headers })),
    annotate: defineCustomAction((builderCtx, topic: string, details: Record<string, unknown>) => {
      return builderCtx.emitOneWay({ topic, details });
    })
  }
});
```

Backward compatibility note: legacy `action_kind` descriptors still work while migrating existing plugins.
`forCommands` ergonomics are explicitly deferred from this helper rollout.

## 3) Build the saga definition (canonical mixed-action example)

```ts
import { createSaga } from '@redemeine/saga';

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
  .onResponses({
    billingFetchSucceeded: (state, response, ctx) => {
      state.settled = true;
      state.attempts += Number(response.payload?.attempt ?? 0);
      ctx.actions.core.cancelSchedule('invoice-timeout');
    }
  })
  .onErrors({
    billingFetchFailed: (state, error, ctx) => {
      state.settled = false;
      state.attempts += 1;
      ctx.actions.core.schedule('invoice-timeout', 5_000);
      void error.error;
    }
  })
  .onRetries({
    billingFetchRetrying: state => {
      state.attempts += 1;
    }
  })
  .initialState(() => ({ attempts: 0, settled: false }))
  .correlate(BillingAggregate, event => event.payload.invoiceId)
  .on(BillingAggregate, {
    created: (state, event, ctx) => {
      state.attempts += 1;

      // one-way helper action
      ctx.actions.infra.scheduleCommand('billing.retry', 5_000);

      // custom helper action
      ctx.actions.http.annotate('billing.attempted', { invoiceId: event.payload.invoiceId });

      // request_response plugin action chain
      ctx.actions.http
        .get(`https://api.example.com/billing/${event.payload.invoiceId}`)
        // optional
        .withData({ invoiceId: event.payload.invoiceId, attempt: state.attempts })
        // optional
        .onRetry(ctx.onRetry.billingFetchRetrying)
        .onResponse(ctx.onResponse.billingFetchSucceeded)
        // onError is terminal after retries exhausted/non-retryable
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

For `defineRequestResponse(...)`, remember lifecycle semantics:

- `withData(...)` is optional.
- `onRetry(...)` is optional.
- `onError(...)` is terminal and runs only when retries are exhausted or the error is non-retryable.

Executable response/error/retry handlers are registered with `.onResponses(...)`, `.onErrors(...)`, and `.onRetries(...)`.
These registrations are also the token namespace source for `ctx.onResponse.*`, `ctx.onError.*`, and `ctx.onRetry.*`.

## Deterministic testing chain with invokeResponse / invokeError

Use the testing fixture to simulate worker outcomes in a deterministic FIFO chain:

```ts
import { testSaga } from '@redemeine/testing';

const fixture = testSaga(BillingSaga)
  .withState({ attempts: 0, settled: false })
  .receiveEvent({
    type: 'created',
    payload: { invoiceId: 'inv-1', amount: 250 }
  })
  .invokeError('billingFetchFailed', { message: 'timeout' })
  .invokeResponse('billingFetchSucceeded', { attempt: 2, status: 'ok' });

fixture
  .expectState({ attempts: 3, settled: true })
  .expectIntents([
    { type: 'schedule', id: 'invoice-timeout', delay: 5_000 },
    { type: 'cancel-schedule', id: 'invoice-timeout' }
  ]);
```

`invokeResponse(token, payload)` only accepts response-phase tokens and `invokeError(token, payload)` only accepts error-phase tokens.

Because pending plugin requests are queued per token, repeated `.invokeError(...)` / `.invokeResponse(...)` calls are deterministic (FIFO within each token queue).

## 4) Add retry policy helpers

```ts
import {
  createSaga,
  validateRetryPolicy
} from '@redemeine/saga';

const policy = validateRetryPolicy({
  maxAttempts: 5,
  initialBackoffMs: 500,
  backoffCoefficient: 2,
  maxBackoffMs: 30_000,
  jitterCoefficient: 0.2
});

const sagaWithScheduling = createSaga<BillingSagaState>('billing-saga')
  .initialState(() => ({ attempts: 0, settled: false }))
  .on(BillingAggregate, {
    created: (state, event, ctx) => {
      // application runtime can reuse this policy for retries
      ctx.actions.core.schedule(`retry-${event.payload.invoiceId}`, policy.initialBackoffMs);
    }
  })
  .build();
```

`validateRetryPolicy(...)` keeps retry parameters explicit and typed so scheduling/execution layers can apply them consistently.

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
