# Projection Runtime v3: Operational Runbook and Release Gates

This runbook is the operational source of truth for Projection Runtime v3 rollout, verification, and incident response.

## Scope and non-goals

- Scope: operations and release readiness for projection runtime vNext semantics and runtime guarantees.
- Non-goal: changing runtime/store behavior from this runbook.

## Frozen semantics (must not drift)

These semantics are frozen and must be treated as release invariants:

1. `.join` remains unchanged for projection state updates.
2. `.reverseSubscribe` is supported.
3. `context.unsubscribeFrom` is supported.
4. Relink semantics are explicit `remove` + `add`; there is no `replace` mutation.
5. Missing reverse targets are handled as **warn-and-skip** (no hard failure, no implicit create).

Operational implication: any future change proposal that violates one of the above requires explicit design review and a new bead, not an implementation-side interpretation.

## Runtime guarantees (production contract)

Projection runtime v3 guarantees:

1. **Single atomic production write path** for docs, links, cursor/checkpoint, runtime mode transitions, and dedupe markers.
2. **Durable dedupe persisted in store** so replay/restart/cutover overlap does not double-apply events.
3. **EventStore catch-up with automatic cutover to live MQ** using mode transitions:
   - `catching_up`
   - `ready_to_cutover`
   - `live`

## Runtime modes and operator playbooks

### Mode: `catching_up`

Expected behavior:

- Runtime consumes historical events and advances durable checkpoint.
- Dedupe markers are persisted as atomic side effects with projection updates.

Operator checks:

- Check checkpoint is advancing.
- Check no growth in dedupe or atomic-commit failures.
- Verify logs contain no repeated missing-target warnings beyond expected noise baseline.

Actions if degraded:

1. Pause upstream if event lag is unstable and store pressure rises.
2. Investigate store health first (latency/errors) before runtime restart.
3. Restart runtime only after confirming store path recovers; dedupe durability should prevent duplicate apply.

### Mode: `ready_to_cutover`

Expected behavior:

- Catch-up boundary reached.
- Runtime is prepared to switch to live MQ consumption.

Operator checks:

- Confirm transition trigger conditions are met (checkpoint aligned with expected boundary).
- Confirm no unresolved atomic write errors at boundary.

Actions if degraded:

1. Hold cutover while validating latest committed checkpoint and dedupe state.
2. If needed, restart runtime and re-evaluate boundary condition; behavior should remain deterministic.

### Mode: `live`

Expected behavior:

- Runtime consumes live MQ events continuously.
- Overlap events from cutover/restarts are suppressed by durable dedupe.

Operator checks:

- Track ingest latency and consumer lag.
- Monitor dedupe suppression metrics/logs for unusual spikes.
- Monitor missing-target warn-and-skip rate to detect upstream data contract drift.

Actions if degraded:

1. Triage message transport and store commit health.
2. If rollback is required, stop consumers, preserve checkpoint/dedupe evidence, and recover with controlled restart.

## Alerts and diagnostics triage

Use this order during incidents:

1. **Atomic commit failures** (highest priority)
   - Symptom: write-path errors or commit retries exhausted.
   - Check store availability/transaction health first.
2. **Dedupe persistence failures**
   - Symptom: duplicate-apply risk after restart/cutover.
   - Treat as release-blocking until durable writes are restored.
3. **Mode transition stalls** (`catching_up` never reaches `ready_to_cutover`, or cutover not entering `live`)
   - Validate checkpoint progress and cutover predicate.
4. **Warn-and-skip volume increase**
   - Indicates missing target references; should not crash runtime but signals data quality/integration drift.

Diagnostics evidence to capture per incident:

- Runtime mode timeline (`catching_up` -> `ready_to_cutover` -> `live`).
- Last durable checkpoint before/after event window.
- Atomic write and dedupe error logs (timestamps + counts).
- Missing-target warn-and-skip samples.

## Rollback and recovery expectations

- Recovery must be deterministic due to durable checkpoint + dedupe state.
- Restart during catch-up or cutover must not produce partial apply or double-apply.
- Rollback expectation: if runtime binaries/config are rolled back, persisted checkpoint/dedupe guard against duplicate effects when consumers resume.

Operator rollback steps:

1. Stop projection consumers safely.
2. Capture current checkpoint, runtime mode, and dedupe diagnostics.
3. Roll back deployment artifact/config.
4. Restart runtime and verify:
   - checkpoint resumes from persisted position,
   - dedupe suppression remains effective,
   - no duplicate projection state transitions are observed.

## Package boundary guardrail (hard release gate)

`@redemeine/projection` is definition-only and **must not depend on runtime packages**.

Forbidden dependency direction:

- `@redemeine/projection` -> `@redemeine/projection-runtime-core`
- `@redemeine/projection` -> `@redemeine/projection-runtime-store-inmemory`
- `@redemeine/projection` -> `@redemeine/projection-runtime-store-mongodb`

Enforcement command:

```bash
bun run check:projection-runtime-boundaries
```

## Validation matrix (RT3-13)

Run these focused suites to validate cross-package integration behavior before full workspace verification.

| Matrix area | Command | Expected evidence |
|---|---|---|
| Router fanout (reverse + persisted links) | `bun run --cwd packages/projection-router-core test` | Router tests pass for reverse rules + persisted link union, relink remove+add, and warn-and-skip semantics |
| Lane ordering + batching modes | `bun run --cwd packages/projection-worker-core test` | Worker-core tests pass for per-lane ordering, cross-lane parallelism, and micro-batching modes (`none`/`single`/`all`) |
| Watermark semantics | `bun run --cwd packages/projection-runtime-store-inmemory test` and `bun run --cwd packages/projection-runtime-store-mongodb test` | Conformance tests pass for `commitAtomicMany`, `highestWatermark`, `byLaneWatermark`, and rejection semantics |
| Cross-package router+worker+store integration | `bun test packages/projection/test/runtime-v3-validation-matrix.integration.test.ts` | Matrix integration suite passes for router fanout + worker-core execution against both in-memory and mongodb-backed stores |
| Runtime replay/cutover continuity | `bun test packages/projection/test/runtime-core-e6-1-cross-store-e2e.test.ts` | E2E catches dedupe/cutover/restart invariants across both stores |

## Worker-lite limitations (intentional, non-blocking)

`@redemeine/projection-worker-lite` is intentionally best-effort and is **not** a release gate for durable runtime guarantees.

- No durable dedupe guarantees
- No transactional/atomic persistence guarantees
- No strong ordering guarantees across process boundaries

Use `@redemeine/projection-worker-core` + runtime stores for production durability semantics.

## Release gate checklist (commands + evidence)

All gates below are required for release sign-off.

### Gate A: Documentation/build integrity

Command:

```bash
bun run docs:build
```

Evidence to capture:

- Command exit status `0`.
- Build output snippet showing successful docs build completion.

### Gate B: Workspace verification

Command:

```bash
bun run verify:workspace
```

Evidence to capture:

- Exit status and package-level summary.
- Any unrelated baseline failures must be explicitly listed with package names.

### Gate C: Package boundary enforcement

Command:

```bash
bun run check:projection-runtime-boundaries
```

Evidence to capture:

- Exit status `0`.
- Output indicating no projection -> runtime dependency violations.

### Gate D: Principles lint

Command:

```bash
bun run lint:principles
```

Evidence to capture:

- Exit status `0`.
- Output confirming no principle violations.

### Gate E: Projection package validation

Command:

```bash
bun test packages/projection/test
```

Evidence to capture:

- Total tests passed/failed.
- Confirmation reverse semantics contract coverage remains green.

### Gate F: Mongo store runtime validation

Command:

```bash
bun test packages/projection-runtime-store-mongodb/test
```

Evidence to capture:

- Total tests passed/failed.
- Confirmation failure/restart scenarios pass.

### Gate G: Runtime core type safety

Command:

```bash
bunx tsc -p packages/projection-runtime-core/tsconfig.json --noEmit --ignoreDeprecations 5.0
```

Evidence to capture:

- Exit status `0`.
- No type errors in runtime core package.

### Gate H: Mongo store type safety

Command:

```bash
bunx tsc -p packages/projection-runtime-store-mongodb/tsconfig.json --noEmit --ignoreDeprecations 5.0
```

Evidence to capture:

- Exit status `0`.
- No type errors in mongodb store package.

## Sign-off template

Use this for release gate evidence logging:

- Bead: `<bead-id>`
- Commit: `<hash>`
- Gate A (`docs:build`): pass/fail + output snippet
- Gate B (`verify:workspace`): pass/fail + summary counts
- Gate C (`check:projection-runtime-boundaries`): pass/fail + output snippet
- Gate D (`lint:principles`): pass/fail + output snippet
- Gate E (`projection tests`): pass/fail + summary counts
- Gate F (`mongodb tests`): pass/fail + summary counts
- Gate G (`runtime-core tsc`): pass/fail
- Gate H (`mongodb-store tsc`): pass/fail
- Runtime mode validation observed: `catching_up` / `ready_to_cutover` / `live`
- Notes: alerts, warnings, or deviations
