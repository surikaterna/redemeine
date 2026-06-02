# @redemeine/saga

Definition-time saga builder for long-running process managers.

## Module format and stability

`@redemeine/saga` is ESM-only (`"type": "module"`). Import it with ESM syntax
from the package root or the documented aggregate bridge subpath.

This package is currently published as a prerelease. Public exports are intended
to be stable within prerelease constraints, but some compatibility exports may be
refined before a stable `1.0` release.

## Public API groups

- **Builder DSL**: `createSaga`, saga definition types, plugin helper contracts,
  handler/intent types, and response/error/retry handler token types.
- **Trigger contracts**: `createSagaTriggerBuilder`, trigger definitions,
  trigger start contracts, and scheduler trigger policy contracts.
- **Retry policy**: retry policy validation, retryable error classification, and
  next-attempt scheduling helpers.
- **Identity utilities**: canonical saga names, namespaces, keys, URNs, and
  normalization errors.
- **Runtime execution helpers**: `runSagaHandler`, `runSagaResponseHandler`, and
  `runSagaErrorHandler` for runtimes that execute built definitions.
- **Aggregate bridge compatibility**: `createAggregate` and bridge-oriented types
  kept for integrations that consume saga definitions through aggregate-like
  contracts.

Some exported types are compatibility surface for generated declarations,
persisted contracts, or runtime bridges. Prefer higher-level builders unless a
runtime integration specifically requires those lower-level contracts.

## Type-safety guidance

- Prefer inferred builders: let `createSaga(...).initialState(...).start(...)`
  carry state, start input, plugin, and handler payload types through the chain.
- Avoid manually widening handler payloads to `unknown`, `any`, or broad record
  types; doing so discards event and response-token inference.
- Consume the generated `.d.ts` declarations from the published package instead
  of importing internal source files.

## Minimal example

```ts
import { createSaga } from '@redemeine/saga';

type StartInput = { invoiceId: string };

export const invoicePaymentSaga = createSaga({
  identity: {
    namespace: 'billing',
    name: 'invoice-payment',
    version: 1
  }
})
  .initialState(() => ({ attempts: 0 }))
  .start((start: StartInput) => {
    void start;
  })
  .correlateBy((start) => start.invoiceId)
  .triggeredBy({
    kind: 'direct',
    toStartInput: (source: { invoiceId: string }) => ({
      invoiceId: source.invoiceId
    })
  })
  .build();
```

The example constructs a saga definition and trigger metadata only; executing the
definition is the responsibility of a runtime package or host integration.
