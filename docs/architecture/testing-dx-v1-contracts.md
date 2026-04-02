# Testing DX v1 Contracts (Implementation Lock)

This document is the **v1 source of truth** for testing DX contract decisions under **bead `redemeine-t8g.1`** (epic `redemeine-t8g`).

Scope: lock API and behavior expectations for implementation beads. This is a contract for delivery, not a claim that all APIs are already shipped.

---

## Locked decisions (v1)

1. **Typed-first default** across all fixtures (`commandCreators` / `eventCreators` first).
2. **Raw envelope fallback allowed** only for boundary/replay/interoperability tests.
3. **`testAggregate` uses Given/When/Then flow** with deterministic hydration from events.
4. **`testSaga` invoke APIs are phase-safe** (compile-time token constraints + runtime guard errors).
5. **`testProjection` asserts exact RFC6902 patches** in emitted order, plus final state.
6. **`createTestDepot` is a thin orchestration layer** over existing runtime components.
7. **Failure semantics are explicit and stable** (named reasons for runtime fixture failures).
8. **Downstream implementation beads must conform** to this document and acceptance matrix.

---

## Public API surface contracts (v1)

> Contract notation below defines required shape/semantics for implementation.

### `testAggregate`

```ts
testAggregate(aggregate)
  .given(events)
  .when(command)
  .expectEvents(expected)
  .expectNoEvents()
  .expectError(matcher)
  .expectState(matcherOrState);
```

Contract expectations:
- `given(...)` hydrates aggregate deterministically from prior events.
- `when(...)` executes exactly one command attempt.
- Event assertions compare emitted domain events from the `when` phase only.
- `expectError(...)` asserts invariant/handler failures without swallowing unexpected errors.
- `expectState(...)` asserts post-command state snapshot.

### `testSaga`

```ts
testSaga(saga)
  .given(events)
  .when(event)
  .expectCommands(expected)
  .invokeResponse(token, response)
  .invokeError(token, error)
  .expectFailure(reason);
```

Contract expectations:
- Tokens passed to `invokeResponse` / `invokeError` must be phase-valid (typed constraint).
- Runtime dequeue for repeated token invocations is FIFO.
- Runtime failures use explicit reasons (at minimum): `unknown_token`, `queue_empty`, `handler_failure`.

### `testProjection`

```ts
testProjection(projection)
  .withState(initial)
  .applyEvent(event)
  .expectState(expectedOrMatcher)
  .expectPatches(expectedRfc6902);
```

Contract expectations:
- Applies projection handler with the same semantics as projection runtime.
- Returns/asserts exact RFC6902 patch operations and order.
- Supports deterministic assertion of resulting projection state.

### `createTestDepot`

```ts
const depot = createTestDepot(options);

await depot.dispatch(command);
await depot.waitForIdle();
const view = depot.query(projection, id);
```

Contract expectations:
- In-memory command → event → projection flow is deterministic.
- `waitForIdle()` drains scheduled work for predictable assertions.
- Projection querying is available without external infrastructure.
- v1 includes saga registration/routing hooks, but not full worker simulation.

---

## Behavioral semantics and failure semantics

- Fixtures are deterministic for identical Given/When inputs.
- Assertion failures must clearly indicate phase (`given`, `when`, `then`) and mismatch.
- Runtime guard failures should be machine-checkable with stable reason codes.
- No implicit retries or hidden async side effects in fixture APIs.

---

## Typed-first default + raw-envelope fallback policy

Default policy:
- Prefer typed builders from aggregate/saga/projection surfaces.
- Examples and docs should lead with typed command/event construction.

Fallback policy (allowed, explicit):
- Raw envelopes are permitted for boundary coverage:
  - replay/import regression tests,
  - malformed payload/interop scenarios,
  - legacy stream compatibility checks.
- Raw mode must not weaken typed-first defaults in primary examples.

---

## Acceptance matrix (downstream bead mapping)

| Bead | Required alignment to this contract |
| --- | --- |
| `redemeine-t8g.2` | Implements `testAggregate` fluent API + deterministic Given/When/Then behavior and error/event/state semantics. |
| `redemeine-t8g.3` | Implements `testProjection` state + exact RFC6902 patch-order assertions. |
| `redemeine-t8g.4` | Implements phase-safe `testSaga` invoke typing + runtime reasoned failures/FIFO semantics. |
| `redemeine-t8g.5` | Implements `createTestDepot` v1 dispatch/waitForIdle/query deterministic orchestration. |
| `redemeine-t8g.8` | Ensures docs/recipes reflect typed-first defaults and raw-envelope fallback policy. |
| `redemeine-t8g.9` | Verifies acceptance tests and quality gates against these locked v1 contracts. |

---

## Non-goals / deferred scope

- Not defining v2 ergonomics or alternate fluent DSL variants.
- Not promising full production-runtime parity for all edge scheduling cases in v1.
- Not expanding raw-envelope flows into first-class primary examples.
- Not locking benchmark thresholds in this document (covered separately).

---

## Benchmark baseline policy (v1)

- Benchmark collection for testing DX is **informational-only** in v1.
- The benchmark command must report:
  - elapsed time,
  - assertion volume,
  - lightweight run metadata (runtime/platform/timestamp).
- CI benchmark execution is **non-blocking** and must not fail merge decisions.
- v1 benchmark output establishes trend data only; hard performance gates are a follow-up decision after baseline stability is observed.
