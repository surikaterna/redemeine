# redemeine-xvr performance note

## Runtime hook coverage evidence

Canonical hooks requested by audit are now emitted at concrete runtime points in `packages/saga-runtime/src/referenceAdapters.ts`:

- `outbox.dequeue` emitted immediately before side-effect execution dispatch (`runReferenceAdapterFlowV1`, per execution record).
- `retry.dead_letter` emitted when side-effect execution returns failed status and the execution is treated as terminal by v1 adapter flow.

Coverage tests:

- `packages/saga-runtime/test/reference-adapters.integration.test.ts`
  - verifies `outbox.dequeue` count alongside enqueue/execution in end-to-end flow
  - verifies `retry.dead_letter` emission payload/compatibility mapping on failed side-effect execution

## Measured performance budget outputs

### Command

```bash
bun run --filter @redemeine/testing bench
```

### Recorded output (2026-04-08, win32/x64, bun 1.3.11)

- metadata:
  - mode: `informational-baseline`
  - runtime: `v24.3.0`
  - platform: `win32`
  - arch: `x64`
- fixture results:
  - `testAggregate`: 200 iterations, 400 assertions, 3.56 ms, 0.0089 ms/assertion
  - `testProjection`: 200 iterations, 400 assertions, 21.68 ms, 0.0542 ms/assertion
  - `testSaga`: 80 iterations, 160 assertions, 23.33 ms, 0.1458 ms/assertion
  - `createTestDepot`: 20 iterations, 40 assertions, 31.73 ms, 0.7933 ms/assertion
- summary:
  - total elapsed: `80.3 ms`
  - total assertions: `1000`

### Budget thresholds and outcome

Per v1 benchmark policy (`docs/architecture/testing-dx-v1-contracts.md`, benchmark baseline policy), benchmark gates are informational and non-blocking. For this bead session, measured results were evaluated against explicit reporting thresholds:

- threshold 1: total assertions **>= 1000** (baseline minimum)
  - result: **1000** ✅
- threshold 2: benchmark command exits successfully
  - result: **exit code 0** ✅

## Behavior guarantees

- Canonical inspection emission remains **best-effort** and non-blocking from a domain-behavior perspective (publisher failures are swallowed by the adapter seam).
- Emission paths are synchronous for local publisher invocation but do not alter aggregate/saga/projection functional outcomes.
