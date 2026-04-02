# Testing Pyramid (Typed-First) for `@redemeine/testing`

> Contract reference: [Testing DX v1 Contracts](/docs/architecture/testing-dx-v1-contracts) (bead `redemeine-t8g.1`) is the source of truth for v1 signatures and behavior.

Use this page as a quick map for **which fixture to use first**, with a typed-first default.

## Pyramid layers (fastest to broadest)

1. **`testAggregate`** (most focused)
   - Validate one aggregate command path with Given/When/Then semantics.
   - Assert emitted events, errors, and resulting state.
2. **`testSaga`**
   - Validate saga routing and intent emission.
   - Assert emitted commands and invoke async responses/errors with phase-safe tokens.
3. **`testProjection`**
   - Validate projection event handling and deterministic read-model output.
   - Assert final state and exact RFC6902 patch order.
4. **Mirage (`createMirage`)**
   - Useful for lightweight aggregate behavior tests against real aggregate surfaces.
   - Good for domain-focused tests when you do not need full fixture orchestration.
5. **`createTestDepot` v1** (broadest in-memory integration)
   - Deterministic in-memory command → event → projection flow.
   - Includes `dispatch`, `waitForIdle`, and projection query surface.
   - **v1 scope is incremental**: supports saga registration/routing hooks, but does **not** claim full worker/runtime simulation parity.

---

## Typed-first default policy

Default to typed domain builders:

- `commandCreators` for commands
- `eventCreators` for events

This keeps tests aligned with your real domain contracts and gives compile-time help for payloads and keys.

### Minimal typed-first examples

```ts
import { testAggregate } from '@redemeine/testing';

testAggregate(orderAggregate)
  .given([
    orderAggregate.eventCreators.created({ customerId: 'c-1' })
  ])
  .when(orderAggregate.commandCreators.confirm({ by: 'user-1' }))
  .expectEvents([
    orderAggregate.eventCreators.confirmed({ by: 'user-1' })
  ]);
```

```ts
import { testSaga } from '@redemeine/testing';

const flow = testSaga(paymentSaga)
  .given([paymentAggregate.eventCreators.paymentRequested({ amount: 125 })])
  .when(paymentAggregate.eventCreators.paymentRequested({ amount: 125 }))
  .expectCommands([
    billingAggregate.commandCreators.chargeCard({ amount: 125 })
  ]);

// token type/phase safety is part of the v1 contract
```

```ts
import { testProjection } from '@redemeine/testing';

testProjection(invoiceProjection)
  .withState({ total: 0 })
  .applyEvent(invoiceAggregate.eventCreators.created({ amount: 50 }))
  .expectState({ total: 50 });
```

```ts
import { createTestDepot } from '@redemeine/testing';

const depot = createTestDepot({
  aggregates: [invoiceAggregate],
  projections: [invoiceProjection]
});

await depot.dispatch(invoiceAggregate.commandCreators.create({ amount: 50 }));
await depot.waitForIdle();
expect(depot.query(invoiceProjection, 'invoice-1')).toMatchObject({ total: 50 });
```

---

## Raw-envelope fallback (allowed, explicit)

Use raw envelopes only when typed builders are not the right tool, including:

- **Boundary** tests (malformed/missing fields, parser guard rails)
- **Replay/import** regression verification for historical streams
- **Negative** protocol/path tests that must bypass normal builders
- **Interop** with legacy or external producers

Keep these tests explicit so typed-first remains the normal contributor path.

### Raw-envelope example (boundary/interop)

```ts
testProjection(invoiceProjection)
  .withState({ total: 0 })
  .applyEvent({
    type: 'invoice.created.event',
    aggregateId: 'invoice-1',
    payload: { amount: 50, source: 'legacy-import' }
  })
  .expectState({ total: 50 });
```

---

## Contributor checklist (typed-first)

- Start at the lowest pyramid layer that proves the behavior.
- Prefer `commandCreators` / `eventCreators` in examples and tests.
- Use `testAggregate` for aggregate invariants before broad integration.
- Use `testSaga` invoke APIs with phase-valid tokens only.
- Use `testProjection` to assert both final state and exact patch order when relevant.
- Use `createTestDepot` for in-memory E2E slices, not as a claim of full worker simulation in v1.
- If using raw envelopes, annotate why (boundary/replay/negative/interop).

## Related recipes

- [Testing Aggregates](/docs/recipes/testing-aggregates)
- [Testing Projections](/docs/recipes/testing-projections)
