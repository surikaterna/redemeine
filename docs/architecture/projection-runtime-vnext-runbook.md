# Projection Runtime v3: Operational Runbook and Release Gates

This runbook is the operational source of truth for Projection Runtime v3 rollout, verification, and incident response.

Related references:

- [Projection Runtime v3 Contracts and Invariants](/docs/architecture/projection-runtime-v3-contracts-and-invariants)
- [Projection Runtime v3 Crash/Chaos Safety Matrix](/docs/architecture/projection-runtime-v3-crash-chaos-safety-matrix)

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

## B7Y contract map (implemented + verified)

This runbook operationalizes the following B7Y contracts/tests and keeps guidance transport-agnostic (no broker-specific implementation details):

- B7Y-01: ack barrier contract (ack only after durable fanout publish confirmation)
- B7Y-02: poison classification and action model
- B7Y-03: shard checkpoint/lease ownership model
- B7Y-04: durable dedupe policy and retention boundaries
- B7Y-05: hydration modes and `_projection.status` metadata contract
- B7Y-06: shadow rebuild generation lifecycle and cutover/rollback contract
- B7Y-07: store OCC semantics and deterministic failure taxonomy
- B7Y-08: cache eviction + requeue on retryable failures; default TTL behavior
- B7Y-09: `microBatch=all` global cross-document commit semantics
- B7Y-10: conformance test coverage for B7Y-01..04
- B7Y-11: conformance test coverage for B7Y-05..09
- B7Y-12: this runbook + crash/chaos matrix publication

## Durable vs in-memory boundaries

The following boundaries are mandatory for incident triage and recovery:

| Domain | Durable state (survives restart/crash) | In-memory state (ephemeral) | Operational expectation |
|---|---|---|---|
| Delivery safety | Ack barrier outcomes and durable publish evidence via transport adapter contract | In-flight delivery attempts, retry timers | Recovered workers may replay in-flight deliveries; no data loss if durable ack barrier contracts are honored |
| Poison handling | Poison classification/action policy and dead-letter/retry outcomes recorded by adapter/store boundary | Local parsing buffers and transient decode context | Crashes must not convert poison into silent success; policy remains deterministic after restart |
| Shard ownership/checkpoint | Lease owner token/epoch and shard checkpoint progress in durable store | Active lease heartbeats and local scheduling queues | Lease churn or process death is recovered by takeover from persisted lease/checkpoint |
| Dedupe | Dedupe keys/retention markers in projection store | Hot dedupe cache/lookups | Restart/cutover overlap may re-read events, but durable dedupe prevents duplicate apply |
| Hydration/rebuild status | `_projection.status` metadata (`hydrating`, `ready`, `rebuilding`, `failed`) and generation references | In-progress hydration buffers and local rebuild executors | Status must remain externally observable across crashes and resumes |
| OCC + cache policy | OCC preconditions and failure category (`conflict`/`transient`/`terminal`) persisted in write outcomes | Worker state cache entries and queue-local retry bookkeeping | Retryable failures evict affected cache and requeue; terminal failures do not loop |
| Global micro-batch (`all`) | Atomic/bulk commit outcome and watermark progression | Batch assembly window and local grouping queue | Crash before commit may replay whole window; crash after commit must not double-apply |

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

5. **Poison message surge**
   - Validate poison class distribution and action outcomes (retry/dead-letter/drop) against policy.

6. **Lease churn or shard starvation**
   - Validate lease handoff intervals, owner transitions, and checkpoint monotonic progression.

Diagnostics evidence to capture per incident:

- Runtime mode timeline (`catching_up` -> `ready_to_cutover` -> `live`).
- Last durable checkpoint before/after event window.
- Atomic write and dedupe error logs (timestamps + counts).
- Missing-target warn-and-skip samples.
- Poison class/action samples and recent counts.
- Lease owner transition timeline and affected shard checkpoints.
- OCC failure categories with retryability distribution.

## Recovery playbooks by failure mode (B7Y-01..12 aligned)

### Playbook A: Crash/restart during normal live processing

1. Stop affected worker(s) and capture latest durable checkpoint + runtime mode.
2. Confirm latest durable commit outcome and dedupe marker progression.
3. Restart worker(s) without mutating checkpoints manually.
4. Verify replay resumes and duplicate apply is suppressed by durable dedupe.
5. Confirm ack/nack decisions remain consistent with barrier contract (B7Y-01, B7Y-04).

### Playbook B: Poison/invalid payload spike

1. Sample recent nack decisions and classify by poison class.
2. Verify policy action for each class (retry/dead-letter/drop) is deterministic.
3. Confirm no poison class is accidentally acked as success.
4. If upstream schema drift is confirmed, isolate producer release and keep consumer policy unchanged until compatibility fix lands.
5. Re-run conformance-focused suites when patching policy boundaries (B7Y-02, B7Y-10).

### Playbook C: Lease churn or checkpoint takeover instability

1. Compare expected shard owner distribution vs current lease ownership.
2. Confirm checkpoints remain monotonic across owner transitions.
3. If churn is excessive, reduce parallel restarts and stabilize lease renewal cadence.
4. Resume normal scaling only after shard takeover behavior is deterministic.
5. Validate with conformance evidence for shard lease/checkpoint scenarios (B7Y-03, B7Y-10).

### Playbook D: OCC conflict/transient failures and cache correctness

1. Partition failures by category (`conflict`, `transient`, `terminal`).
2. Verify retryable categories trigger cache eviction and retryable nack/requeue.
3. Verify terminal categories do not spin in infinite retry loops.
4. Confirm state converges after retries and no stale cache entries persist.
5. Validate with worker + contract tests for OCC/cache semantics (B7Y-07, B7Y-08, B7Y-11).

### Playbook E: Hydration/rebuild interrupted near cutover

1. Capture `_projection.status` and current generation before any restart.
2. Determine whether generation is `rebuilding`, `ready`, or rollback-ready.
3. Resume rebuild/hydration; do not force cutover without readiness criteria.
4. If cutover failed, execute rollback-safe switch path and preserve evidence.
5. Confirm status transitions remain valid (`hydrating` -> `ready` -> `rebuilding`/`failed`) and test-matched (B7Y-05, B7Y-06, B7Y-11).

### Playbook F: Global micro-batch (`all`) interruption

1. Determine if interruption happened pre-commit or post-commit.
2. Pre-commit: allow replay of full batch window.
3. Post-commit: verify atomic result + watermark and dedupe prevent double apply.
4. Validate that behavior is projection-global (not lane-local) for all-mode operations.
5. Reconfirm with runtime-v3 matrix integration tests if behavior diverges (B7Y-09, B7Y-11).

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

Legacy v1 package status:

- `@redemeine/projection-runtime` is deprecated for production paths and must not be imported by active runtime/package `src/**` code.
- Production/runtime consumers must import v3 package entrypoints directly:
  - `@redemeine/projection-router-core`
  - `@redemeine/projection-worker-core`
  - `@redemeine/projection-worker-lite`
  - `@redemeine/projection-runtime-core`
  - `@redemeine/projection-runtime-store-inmemory`
  - `@redemeine/projection-runtime-store-mongodb`

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
- Output indicating no deprecated `@redemeine/projection-runtime` usage in production `src/**` paths.

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
