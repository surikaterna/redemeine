# Saga API Reference

This page is the quick reference for the **public** saga API exported from `@redemeine/saga`.

> ⚠️ **Breaking change:** the public saga surface is now intentionally minimal.

For generated API signatures, use `/docs/api/`.

## Public module overview

From `@redemeine/saga`:

- `createSaga`: typed saga definition builder and intent types.
- `RetryPolicy` exports: retry validation, backoff scheduling, and classification helpers.
- `triggers` exports: definition-only trigger builders (`event`, `parent`, `direct`, `recovery`, `schedule.*`) with typed `toStartInput` and `when` chaining.
- `startPolicy`: typed start policy helper constructors for trigger contracts.

Public export barrel (`packages/saga/src/index.ts`):

- `createSaga`
- `SagaRetryPolicy` + retry helpers
- `createSagaTriggerBuilder`
- `startPolicy`

Usage note:

- `createSagaAggregate(nameOrOptions?)` is owned by `@redemeine/saga-runtime` (re-exported from `packages/saga-runtime/src/index.ts`) and exposes the public, structure-only saga aggregate contract used for persisted saga records and wire-level shape typing.
- Trigger builders and start-policy helpers are **definition-layer only** and do not change runtime execution behavior.

Anything outside these documented exports is runtime implementation detail and may change without semver guarantees.

## Saga identity contract (canonical)

Saga identity is strict and has one canonical source of truth in `@redemeine/saga`.

- Canonical identity derives from structured fields via `normalizeSagaIdentity`.
- URN helpers are intentionally minimal: `deriveSagaUrn`, `deriveSagaInstanceUrn`, `parseSagaUrn`.
- Legacy adapter/compat identity entrypoints were removed as a release-breaking cleanup.

### Structured source fields (required)

- `namespace: string`
- `name: string`
- `version: number` (**integer**)

These three fields are authoritative. Persisted or transmitted identity strings must be derived from these values after normalization.

### Validation regex

- `namespace`: `^[a-z0-9]+(?:\.[a-z0-9]+)*$`
  - Lowercase alphanumeric segments separated by `.`
  - Segment characters allowed: `[a-z0-9]`
- `name`: `^[a-z0-9]+(?:[._-][a-z0-9]+)*$`
  - Lowercase alphanumeric tokens
  - Optional separators between tokens: `.`, `_`, `-`
- `version`: must satisfy `Number.isSafeInteger(version) && version >= 1`

### Normalization rules

Apply normalization before validation and derivation:

1. Trim leading/trailing whitespace from `namespace` and `name`.
2. Lowercase `namespace` and `name`.
3. Do not rewrite or infer separators beyond trimming/lowercasing; invalid separator or whitespace usage fails validation.
4. `version` must be an integer (`Number.isSafeInteger(version)`) and `version >= 1`.

### Derived identity fields

From normalized structured fields:

- `sagaKey = <namespace>/<name>`
- `sagaType = <namespace>/<name>@v<version>`
- `sagaUrn = urn:redemeine:saga:<namespace>:<name>:v<version>`
- `instanceUrn` is optional and, when used, extends `sagaUrn`:
  - `instanceUrn = <sagaUrn>:instance:<instanceId>`

Notes:

- `sagaType` and `sagaUrn` are **derived**, not independently authored.
- `instanceUrn` is optional because not all definition-only surfaces carry an instance identifier.

### Type contract

The public `sagas` module exposes lightweight declaration types:

- `CanonicalSagaIdentityInput` (required structured source)
- `NormalizedSagaIdentity` (canonical normalized + derived identity)

## Defining sagas (manifest-first)

Use `createSaga({ identity, plugins? })` to build saga definitions with typed plugin actions.

- `identity` is required and must include `namespace`, `name`, and integer `version`.
- `plugins?` is an optional tuple of `defineSagaPlugin(...)` manifests.
- Handlers use mutation-style state updates (Immer draft semantics).
- Scope is **definition-only**: this API defines typed intent contracts and persisted routing metadata; it does **not** execute plugin runtimes.

### Typed plugin helper API contracts (planned)

The following helper APIs are part of the typed saga plugin roadmap and are
documented here as **contract-first** behavior for upcoming implementation:

- `defineOneWay(...)`
- `defineRequestResponse(...)`
- `defineCustomAction(...)`

Contract details:

- `defineOneWay(...)`
  - Builds a one-way plugin action contract.
  - Emits intent immediately from the handler turn and returns that intent.
- `defineRequestResponse(...)`
  - Builds a request-response contract with durable routing.
  - `.withData(...)` is optional.
  - `.onResponse(...)` is required.
  - `.onError(...)` is required.
  - `.onRetry(...)` is optional.
  - `onError` is terminal after retries are exhausted, or when an error is
    classified as non-retryable.
- `defineCustomAction(...)`
  - Builds a custom action contract using constrained builder primitives.
  - Plugin authors may define custom completeness semantics while still using
    deterministic intent-state mutation primitives.

Planned `builderCtx` primitive surface:

- `createPending(...)`
- `patch(...)` / `set(...)`
- `snapshot(...)`
- `finalize(...)` / `emit(...)`
- `complete(...)` / `isComplete(...)`

Intent emission timing semantics:

- One-way: emit immediately.
- Request-response: emit after request routing is fully bound (`onResponse` +
  `onError`, with optional `withData` / `onRetry`).
- Custom: emission/finalization is explicit and controlled through `builderCtx`.

Out of scope/deferred:

- Plugin `forCommands` ergonomics are explicitly deferred and are not part of
  this contract pass.

### Canonical plugin + saga example (helper-based plugin actions)

```ts
import {
  createSaga,
  defineSagaPlugin,
  defineOneWay,
  defineRequestResponse,
  defineCustomAction
} from '@redemeine/saga';

type InvoiceSagaState = { attempted: number; settled: boolean };

const InfraPlugin = defineSagaPlugin({
  plugin_key: 'infra',
  actions: {
    scheduleCommand: defineOneWay((name: 'invoice.retry', delayMs: number) => ({ name, delayMs }))
  }
});

const HttpPlugin = defineSagaPlugin({
  plugin_key: 'http',
  actions: {
    get: defineRequestResponse((url: string, headers?: Record<string, string>) => ({ url, headers })),
    // Custom builders can choose their own completion semantics.
    annotate: defineCustomAction((builderCtx, topic: string, details: Record<string, unknown>) => {
      return builderCtx.emitOneWay({ topic, details });
    })
  }
});

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

const saga = createSaga<InvoiceSagaState>({
  identity: {
    namespace: 'billing',
    name: 'invoice_saga',
    version: 1
  },
  plugins: [InfraPlugin, HttpPlugin] as const
})
  .onResponses({
    invoiceFetchSucceeded: (state, response, ctx) => {
      state.settled = true;
      ctx.actions.core.cancelSchedule('invoice-reminder');
      state.attempted += Number(response.payload?.attempt ?? 0);
    }
  })
  .onErrors({
    invoiceFetchFailed: (state, error, ctx) => {
      state.settled = false;
      state.attempted += 1;
      ctx.actions.core.schedule('invoice-retry', 5_000);
      void error.error;
    }
  })
  .onRetries({
    invoiceFetchRetrying: state => {
      state.attempted += 1;
    }
  })
  .initialState(() => ({ attempted: 0, settled: false }))
  .correlate(InvoiceAggregate, event => event.payload.invoiceId)
  .on(InvoiceAggregate, {
    created: (state, event, ctx) => {
      state.attempted += 1;

      // one-way helper action
      ctx.actions.infra.scheduleCommand('invoice.retry', 5_000);

      // custom helper action
      ctx.actions.http.annotate('billing.attempted', { invoiceId: event.payload.invoiceId });

      // request_response action chain
      ctx.actions.http
        .get(`https://api.example.com/invoices/${event.payload.invoiceId}`)
        // optional
        .withData({ invoiceId: event.payload.invoiceId, attempt: state.attempted })
        // optional
        .onRetry(ctx.onRetry.invoiceFetchRetrying)
        .onResponse(ctx.onResponse.invoiceFetchSucceeded)
        // terminal after retries exhausted/non-retryable
        .onError(ctx.onError.invoiceFetchFailed);

      // built-in actions are also available under ctx.actions.core
      const commands = ctx.actions.core.dispatch(InvoiceAggregate, event.payload.invoiceId);
      commands.create({ invoiceId: event.payload.invoiceId, amount: event.payload.amount });
      ctx.actions.core.schedule('invoice-reminder', 5_000);
    }
  })
  .build();
```

Core contracts:

- Handler signature: `(state, event, ctx)` mutation-style state updates.
- Plugin calls are namespaced as `ctx.actions.<plugin_key>.<action>(...)`.
- Helper APIs provide ergonomic plugin action builders:
  - `defineOneWay(build)`
  - `defineRequestResponse(build)`
  - `defineCustomAction((builderCtx, ...args) => ...)`
- Request/response actions use durable routing chain:
  - `.withData(handlerData)` (optional)
  - `.onRetry(retryToken)` (optional)
  - `.onResponse(responseToken)`
  - `.onError(errorToken)` (terminal after retries exhausted/non-retryable)
- `onResponses(...)`, `onErrors(...)`, and `onRetries(...)` register executable handlers and define token namespaces with phase-safe typing.
- Routing is persisted with named tokens only (`response_handler_key`, `error_handler_key`, `handler_data`) for restart safety; inline callback persistence is not supported.
- Existing `action_kind`-descriptor manifests remain supported for backward compatibility.
- `forCommands` helper ergonomics are intentionally deferred and out of scope for this change.
- Built-ins remain available via `ctx.actions.core.*` (and legacy base helpers like `ctx.schedule(...)`).
- `SagaIntent`: union of `dispatch`, `schedule`, `cancel-schedule`, `plugin-one-way`, and `plugin-request`.
- `SagaIntentMetadata`: `sagaId`, `correlationId`, `causationId` attached to all intents.

### Handler registration and runtime maps

- `saga.responseHandlers`, `saga.errorHandlers`, and `saga.retryHandlers` are the registered executable function maps.
- Token namespaces (`ctx.onResponse.*`, `ctx.onError.*`, `ctx.onRetry.*`) are derived from these registrations and are phase-branded.
- Runtime helpers (`runSagaResponseHandler` / `runSagaErrorHandler`) resolve and execute against those maps.

## Deterministic `testSaga` invoke chain

For testing, use `testSaga(...)` to execute the same token routing deterministically without plugin runtime workers:

```ts
import { testSaga } from '@redemeine/testing';

const fixture = testSaga(saga)
  .withState({ attempted: 0, settled: false })
  .receiveEvent({
    type: 'created',
    payload: { invoiceId: 'inv-1', amount: 250 }
  })
  .invokeError('invoiceFetchFailed', { message: 'timeout' })
  .invokeResponse('invoiceFetchSucceeded', { attempt: 2, status: 'ok' });

fixture.expectState({ attempted: 3, settled: true });
```

- `invokeResponse(token, payload)` is token-phase-safe and accepts response-phase tokens only.
- `invokeError(token, payload)` is token-phase-safe and accepts error-phase tokens only.
- Invocation order is deterministic for queued plugin requests (FIFO per token).

## Retry policy helpers

Retry helpers in `RetryPolicy.ts`:

- `validateRetryPolicy(policy)`
- `computeNextAttemptAt(policy, attempt, now, jitter?)`
- `isRetryableError(error, options?)`
- `classifyRetryableError(error, options?)`

Policy shape: `SagaRetryPolicy` (`maxAttempts`, `initialBackoffMs`, `backoffCoefficient`, optional caps/jitter).

## Trigger builders and start policies (definition-only)

Use `createSagaTriggerBuilder<TStartInput>()` when you want typed trigger definitions that map source payloads to saga `StartInput` without introducing runtime execution concerns in this package.

- Trigger families: `event`, `parent`, `direct`, `recovery`, and `schedule` (`interval`, `isoInterval`, `cron`, `rrule`).
- Each trigger requires `toStartInput(source) => startInput`.
- Optional `.when((source, startInput) => boolean)` chaining preserves strong inference across chained predicates.
- Schedule definitions carry semantics metadata (`elapsed-time` vs `wall-clock`) and default DST policy at the definition layer.

Use `startPolicy` for typed policy literals:

- `startPolicy.ifIdle()`
- `startPolicy.joinExisting()`
- `startPolicy.restart({ mode?: 'graceful' | 'force', reason?: string })`

Attach policies to trigger-adjacent contracts through `SagaTriggerStartContract`.

## Typed aggregate dispatch

- `commandsFor(Aggregate, aggregateId, metadataOverride?)` returns typed command factories derived from aggregate command creators.
- `dispatchTo` is the common variable name for that typed command factory.
- Prefer aggregate command creators over string command names for dispatch typing.

## SagaAggregate structure-only model

`SagaAggregate` is a **persistence/contract shape** for saga state and emitted records.
It is intentionally structure-only and does **not** define runtime worker behavior.

Ownership note:

- Runtime aggregate factory APIs (`createSagaAggregate`, `SagaAggregate` types) are provided by `@redemeine/saga-runtime`.
- `@redemeine/saga` remains the definition/identity package for saga authoring surfaces.

### Naming and wire format conventions

- Saga state uses **camelCase** keys (for example `createdAt`, `updatedAt`, `transitionVersion`).
- Code-level API keys use **camelCase** (for example plugin action names like `scheduleCommand`).
- Persisted/wire plugin routing metadata fields use **snake_case** (`plugin_key`, `action_name`, `response_handler_key`, `error_handler_key`, `handler_data`).
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

- **Intent**: a deterministic instruction emitted by saga logic (for example: dispatch command, schedule timer, cancel timer, plugin action intent).
- **Activity**: the side-effecting execution unit that happens at runtime when an emitted intent is executed.

In other words, the saga definition emits intents; runtime infrastructure may later execute activities.

> Out of scope for this reference: runtime worker/executor implementation details (queueing, polling, retries in workers, etc.).

## Migration summary (breaking)

If you used older/expanded saga docs, migrate as follows:

- **Keep using:** `createSaga` and retry helpers.
- **Use manifest-first builder form:** `createSaga<TState>({ name, plugins? })`.
- **Define plugin manifests with helper-based actions:** `defineOneWay`, `defineRequestResponse`, `defineCustomAction`.
- **Route request/response actions with durable named tokens:** `.withData(...)? .onRetry(...)? .onResponse(token).onError(token)`.
- **Semantics reminder:** `withData` and `onRetry` are optional; `onError` is terminal after retries are exhausted or on non-retryable errors.
- **Backwards compatibility:** legacy `action_kind` descriptors continue to work while migrating.
- **Deferred scope:** `forCommands` ergonomics remain tracked separately.
- **Use aggregate-typed handlers:** `.on(Aggregate, handlers)`.
- **Use mutation-style handlers:** update saga state directly in handler scope (Immer semantics).
- **Use typed dispatch factories:** `ctx.actions.core.dispatch(...)` / `dispatchTo.<commandCreator>(...)`.
- **Stop using as public imports:** registry/event taxonomy modules and runtime persistence/execution internals.
- **Treat internals as unstable:** anything outside package entry exports (for example `@redemeine/saga` and `@redemeine/saga-runtime`) is implementation detail.

## Migration note (additive plugin action helpers)

`@redemeine/saga` now also exports additive helper APIs for plugin manifests:

- `defineOneWay(...)`
- `defineRequestResponse(...)`
- `defineCustomAction(...)`

Compatibility note:

- Existing raw descriptors with explicit `action_kind` (`'void'` / `'request_response'`) remain fully supported.
- You can migrate incrementally by mixing helper-based and raw descriptors in the same plugin manifest.
