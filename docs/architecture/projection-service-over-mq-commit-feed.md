---
title: Projection Service over MQ Commit Feed
bead: redemeine-9ff
status: proposed
last_updated: 2026-04-08
---

# Projection Service over MQ Commit Feed

## 1) Goal and scope

Define a projection runtime that consumes commit envelopes from MQ (not direct event-store subscriptions) while preserving deterministic replay, partition-safe scaling, and failure isolation.

This spec covers:
- Processing model and worker topology
- Checkpoint transaction semantics
- Idempotency and partitioning strategy
- Replay/reset workflows
- Drift detection and correction
- DLQ behavior and recovery
- Lag monitoring and alerting

## 2) Canonical processing model

1. **CDC relay publishes commit envelopes** to a topic (at-least-once).
2. **Projection consumer group** subscribes and receives partition-ordered envelopes.
3. Worker executes **persist-before-ack** pipeline:
   - Deserialize + validate envelope
   - Apply idempotency gate
   - Execute projection mutation in local projection store
   - Persist checkpoint in the same local transaction
   - Commit transaction
   - Ack MQ message
4. If transaction fails, message is **not acked** and is retried by MQ.

### Envelope requirements

Each message must include at minimum:
- `stream_id`
- `commit_id` (globally unique)
- `stream_version`
- `commit_timestamp`
- `event_count`
- `events[]`
- `trace_id` / correlation metadata

`commit_id` is the primary dedupe key.

## 3) Partitioning and scaling

### Partition key

Default key: `stream_id`.

Rationale:
- Preserves ordering for all commits of a stream.
- Prevents cross-worker races on same aggregate history.

### Consumer group behavior

- Multiple projection workers join same consumer group.
- MQ guarantees one active consumer per partition.
- Rebalances are expected; worker must flush in-flight transaction before partition revoke.

### Horizontal scaling

- Throughput scales by increasing partitions and worker replicas.
- Per-partition strict order is preserved; global order is not required.

## 4) Checkpoint transaction semantics

Checkpoint must be written atomically with projection mutation.

### Required invariant

For a given projection + partition:
- Either both are committed:
  - projection row/document updates
  - checkpoint `(partition, offset, commit_id, processed_at)`
- Or neither is committed.

### Data model

`projection_checkpoints`
- `projection_name` (PK part)
- `partition_id` (PK part)
- `offset` (monotonic)
- `last_commit_id`
- `last_stream_version` (optional)
- `updated_at`

`projection_dedupe`
- `projection_name` (PK part)
- `commit_id` (PK part)
- `partition_id`
- `offset`
- `processed_at`
- retention policy (TTL/windowed cleanup)

### Commit algorithm

Within one DB transaction:
1. Verify offset progression (no regressions unless replay mode enabled).
2. Upsert dedupe key (`commit_id`), no-op if exists.
3. If newly inserted, apply projection mutation.
4. Upsert checkpoint to current offset.
5. Commit DB transaction.
6. Ack MQ offset after DB commit only.

## 5) Idempotency guarantees

Transport is at-least-once; projection correctness must be effectively-once.

### Rules

- `commit_id` dedupe is authoritative.
- Projection handlers must be deterministic and side-effect-free (or side-effects routed through outbox).
- Duplicate delivery must produce no net state change.

### Handler contract

`apply(commitEnvelope, state) -> newState` must satisfy:
- Pure function semantics for same input + prior state
- No dependency on wall clock without explicit event timestamp usage
- No non-deterministic random branching

## 6) Replay and reset semantics

## 6.1 Replay (non-destructive)

Use replay mode to rebuild or backfill a projection into a separate target table/namespace.

- Start from offset 0 (or requested start offset/time).
- Disable real-time lag alerts for replay job label.
- Produce progress metrics (`replay_processed_total`, ETA).
- Cutover by versioned alias/table swap after verification.

## 6.2 Reset (destructive)

Reset clears projection state and checkpoints for selected projection scope.

Required safeguards:
- Operator confirmation token
- Scoped reset boundary (`projection_name`, optional partition subset)
- Audit log entry with actor/reason/change-ticket

Post-reset behavior:
- Consumer starts from configured bootstrap offset (`earliest` by default).
- Dedupe table cleared only for reset scope.

## 7) Drift detection and correction

Drift = projection state not matching expected state from event history.

### Detection methods

1. **Continuous checksum sampling**
   - Periodically recompute deterministic hash for sampled entities from source events.
   - Compare against stored projection hash/version.
2. **Invariant probes**
   - Domain-level assertions (e.g., counters non-negative, referential links present).
3. **Replay-compare jobs**
   - Rebuild in shadow table and compare row counts + keyed hashes.

### Correction policy

- Minor/local drift: targeted entity replay by stream.
- Widespread drift: full projection reset + replay.
- Emit `projection_drift_detected` event/metric and open incident if threshold exceeded.

## 8) Failure isolation and DLQ policy

Classify errors to avoid blocking healthy partitions.

### Error classes

1. **Transient** (timeouts, network, lock contention)
   - Retry with exponential backoff + jitter.
2. **Poison payload / schema violation**
   - Non-retriable after bounded attempts.
3. **Code bug / invariant violation**
   - Retriable briefly, then DLQ and page owner.

### DLQ behavior

- After `max_attempts`, publish original envelope + error metadata to DLQ topic:
  - `projection_name`, `partition`, `offset`, `commit_id`, `error_class`, `stack_hash`, `attempts`, `failed_at`
- Ack source message only after DLQ publish succeeds (to prevent poison loop).
- Provide redrive tool for DLQ -> main topic after fix.

## 9) Lag monitoring and observability requirements

### Core metrics

- `projection_consumer_lag_messages{projection,partition}`
- `projection_consumer_lag_seconds{projection,partition}`
- `projection_throughput_commits_per_sec{projection}`
- `projection_apply_latency_ms{projection}` (p50/p95/p99)
- `projection_checkpoint_age_seconds{projection,partition}`
- `projection_dedupe_hits_total{projection}`
- `projection_failures_total{projection,error_class}`
- `projection_dlq_total{projection,error_class}`

### Alerts

- **Critical**: lag seconds above SLO for N minutes on any hot partition.
- **Warning**: checkpoint age increasing while input traffic exists.
- **Critical**: DLQ rate above threshold or any sustained poison stream.
- **Warning**: repeated rebalance churn indicating unstable consumers.

### Tracing/logging

- Propagate `trace_id` from envelope through handler pipeline.
- Structured logs include `projection_name`, `partition`, `offset`, `commit_id`, `attempt`.
- Emit span around `apply+checkpoint` transaction.

## 10) Operational runbooks (minimum)

1. **Lag spike runbook**: identify partition skew, consumer health, store bottlenecks.
2. **DLQ runbook**: classify failure, patch handler/schema, redrive safely.
3. **Drift runbook**: verify scope, choose targeted replay vs full reset, validate post-fix.
4. **Replay cutover runbook**: shadow rebuild, consistency checks, alias swap, rollback plan.

## 11) Acceptance mapping (redemeine-9ff)

- Processing model: defined in sections 2-4.
- Checkpoint transaction semantics: section 4 atomic invariant and algorithm.
- Idempotency/partitioning/replay/reset/drift: sections 3, 5, 6, 7.
- DLQ behavior: section 8.
- Observability + lag monitoring: section 9.

## 12) Open risks and assumptions

### Assumptions
- MQ supports partitioned ordered consumption with consumer groups.
- Projection store supports ACID transaction over mutation + checkpoint writes.
- CDC relay guarantees unique `commit_id` per commit envelope.

### Risks
- Hot-stream partition skew may dominate latency.
- Long-running handlers can cause rebalance thrash and lag cliffs.
- Incomplete schema evolution policy may inflate poison/DLQ rates.

Mitigations: partition planning, handler latency budgets, schema compatibility gates, replay rehearsal in staging.
