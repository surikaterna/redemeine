# Saga API Reference

This page is the quick reference for the **public** saga API exported from `@redemeine/saga`.

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

Usage note:

- `createSagaAggregate(nameOrOptions?)` exposes the public, structure-only saga aggregate contract used for persisted saga records and wire-level shape typing.

Anything outside these documented exports is runtime implementation detail and may change without semver guarantees.

## Saga identity contract (canonical)

Saga identity is definition-first and has a canonical source of truth.

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
- `version`:
  - Number form: must satisfy `Number.isSafeInteger(version) && version >= 1`
  - String form: must match `^[1-9][0-9]*$` exactly (no prefixes/suffixes/decimals)

### Normalization rules

Apply normalization before validation and derivation:

1. Trim leading/trailing whitespace from `namespace` and `name`.
2. Lowercase `namespace` and `name`.
3. Do not rewrite or infer separators beyond trimming/lowercasing; invalid separator or whitespace usage fails validation.
4. `version` must be an integer (`Number.isSafeInteger(version)`) and `version >= 1`.
5. Do not silently coerce non-canonical version strings (for example, `"01"`, `"v2"`, `"2.0"`) at runtime integration boundaries.

### Derived identity fields

From normalized structured fields:

- `sagaType = <namespace>.<name>.v<version>`
- `sagaUrn = urn:redemeine:saga:<namespace>:<name>:v<version>`
- `instanceUrn` is optional and, when used, extends `sagaUrn`:
  - `instanceUrn = <sagaUrn>:instance:<instanceId>`

Notes:

- `sagaType` and `sagaUrn` are **derived**, not independently authored.
- `instanceUrn` is optional because not all definition-only surfaces carry an instance identifier.

### Type contract

The public `sagas` module exposes lightweight declaration types:

- `SagaIdentityFields` (required structured source)
- `SagaIdentityDerived` (derived values + optional `instanceUrn`)
- `SagaIdentityContract` (combined view)

## Defining sagas (manifest-first)

Use `createSaga({ name, plugins? })` to build saga definitions with typed plugin actions.

- `name` is required.
- `plugins?` is an optional tuple of `defineSagaPlugin(...)` manifests.
- Handlers use mutation-style state updates (Immer draft semantics).
- Scope is **definition-only**: this API defines typed intent contracts and persisted routing metadata; it does **not** execute plugin runtimes.

### Canonical plugin + saga example (void + request_response)

```ts
import { createSaga, defineSagaPlugin } from '@redemeine/saga';

type InvoiceSagaState = { attempted: number; settled: boolean };

const InfraPlugin = defineSagaPlugin({
  plugin_key: 'infra',
  actions: {
    scheduleCommand: {
      action_kind: 'void',
      build: (name: 'invoice.retry', delayMs: number) => ({ name, delayMs })
    }
  }
});

const HttpPlugin = defineSagaPlugin({
  plugin_key: 'http',
  actions: {
    get: {
      action_kind: 'request_response',
      build: (url: string, headers?: Record<string, string>) => ({ url, headers })
    }
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
  name: 'invoice-saga',
  plugins: [InfraPlugin, HttpPlugin] as const
})
  .responseHandlers({
    invoiceFetchSucceeded: {
      plugin_key: 'http',
      action_name: 'get',
      phase: 'response'
    },
    invoiceFetchFailed: {
      plugin_key: 'http',
      action_name: 'get',
      phase: 'error'
    }
  })
  .initialState(() => ({ attempted: 0, settled: false }))
  .correlate(InvoiceAggregate, event => event.payload.invoiceId)
  .on(InvoiceAggregate, {
    created: (state, event, ctx) => {
      state.attempted += 1;

      // void action (manifest-defined)
      ctx.actions.infra.scheduleCommand('invoice.retry', 5_000);

      // request_response action chain
      ctx.actions.http
        .get(`https://api.example.com/invoices/${event.payload.invoiceId}`)
        .withData({ invoiceId: event.payload.invoiceId, attempt: state.attempted })
        .onResponse(ctx.onResponse.invoiceFetchSucceeded)
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
- Request/response plugin actions use the durable routing chain:
  - `.withData(handlerData)`
  - `.onResponse(responseToken)`
  - `.onError(errorToken)`
- Routing is persisted with named tokens only (`response_handler_key`, `error_handler_key`, `handler_data`) for restart safety; inline callback persistence is not supported.
- Built-ins remain available via `ctx.actions.core.*` (and legacy base helpers like `ctx.schedule(...)`).
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

## SagaAggregate structure-only model

`SagaAggregate` is a **persistence/contract shape** for saga state and emitted records.
It is intentionally structure-only and does **not** define runtime worker behavior.

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

- **Intent**: a deterministic instruction emitted by saga logic (for example: dispatch command, schedule timer, cancel timer, run activity).
- **Activity**: the side-effecting execution unit that happens at runtime when a `runActivity` intent is executed.

In other words, the saga definition emits intents; runtime infrastructure may later execute activities.

> Out of scope for this reference: runtime worker/executor implementation details (queueing, polling, retries in workers, etc.).

## Migration summary (breaking)

If you used older/expanded saga docs, migrate as follows:

- **Keep using:** `createSaga` and retry helpers.
- **Use manifest-first builder form:** `createSaga<TState>({ name, plugins? })`.
- **Define plugin manifests with:** `defineSagaPlugin({ plugin_key, actions })`.
- **Route request_response actions with durable named tokens only:** `.withData(...).onResponse(token).onError(token)`.
- **Use aggregate-typed handlers:** `.on(Aggregate, handlers)`.
- **Use mutation-style handlers:** update saga state directly in handler scope (Immer semantics).
- **Use typed dispatch factories:** `ctx.actions.core.dispatch(...)` / `dispatchTo.<commandCreator>(...)`.
- **Stop using as public imports:** registry/event taxonomy modules and runtime persistence/execution internals.
- **Treat internals as unstable:** anything outside `src/sagas/index.ts` exports is implementation detail.
