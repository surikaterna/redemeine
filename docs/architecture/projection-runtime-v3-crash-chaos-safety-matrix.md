# Projection Runtime v3 Crash/Chaos Safety Matrix (B7Y-12)

This matrix defines failure-mode guarantees, durable boundaries, and operator recovery expectations for Projection Runtime v3 safety hardening.

Related references:

- [Projection Runtime v3 Operational Runbook and Release Gates](/docs/architecture/projection-runtime-vnext-runbook)
- [Projection Runtime v3 Contracts and Invariants](/docs/architecture/projection-runtime-v3-contracts-and-invariants)

## How to use this matrix

For each failure mode:

1. identify contract scope,
2. verify durable evidence,
3. execute playbook,
4. confirm the referenced conformance/integration tests stay green.

All guidance is transport-agnostic and applies to any compliant adapter.

## Failure-mode matrix

| Failure / chaos mode | Contract area (B7Y) | Durable evidence | In-memory risk surface | Expected outcome / guarantee | Recovery playbook |
|---|---|---|---|---|---|
| Consumer crash after ingest but before durable ack barrier completion | B7Y-01, B7Y-10 | Durable publish/commit outcome and ack barrier decision trail | In-flight message handling and retry timers | Message is not falsely acked; replay is safe once durable boundary is restored | Runbook Playbook A |
| Malformed/garbage/oversized/binary payload flood | B7Y-02, B7Y-10 | Poison class/action decisions in adapter/store boundary logs/metrics | Parser/decode buffers and local transient classification context | Deterministic class->action behavior (retry/dead-letter/drop) with no silent success | Runbook Playbook B |
| Lease owner death and shard takeover churn | B7Y-03, B7Y-10 | Lease owner token/epoch and checkpoint monotonic history | Local lease heartbeat loop and in-memory scheduling backlog | New owner can continue from checkpoint without reordering guarantees violation | Runbook Playbook C |
| Replay overlap during restart/cutover | B7Y-04, B7Y-10 | Durable dedupe key/retention markers and checkpoint progression | Hot dedupe cache and in-flight fanout | Duplicate apply prevented by durable dedupe even when events reappear | Runbook Playbook A |
| Hydration interrupted mid-transition | B7Y-05, B7Y-11 | `_projection.status` persisted with hydration status fields | Temporary hydration buffers and local state assembly | Status remains externally visible; resume does not invent hidden transition states | Runbook Playbook E |
| Shadow rebuild interrupted near cutover | B7Y-06, B7Y-11 | Generation id + readiness status + cutover/rollback state | Local rebuild executor and cutover coordination queue | Cutover only when readiness criteria met; rollback-safe path preserved | Runbook Playbook E |
| OCC conflict storm (high write contention) | B7Y-07, B7Y-11 | Failure category (`conflict`) and write precondition evidence | Stale worker cache entry and retry queue pressure | Retryable conflict behavior deterministic; terminal vs retryable remains explicit | Runbook Playbook D |
| Transient store instability | B7Y-07, B7Y-08, B7Y-11 | Failure category (`transient`) and retry outcome trail | Queue-local backoff state + cache locality artifacts | Retryable failures evict relevant cache and requeue; no stale-commit assumption | Runbook Playbook D |
| Terminal write failures (invalid requests) | B7Y-07, B7Y-08, B7Y-11 | Failure category (`terminal`) in write outcomes | Message-local transient state | Terminal failures do not endlessly retry/requeue | Runbook Playbook D |
| Crash between cache eviction and retry enqueue | B7Y-08, B7Y-11 | Retry decision and subsequent replay evidence in durable checkpoints | Eviction metadata and volatile retry bookkeeping | Recovery replay remains safe; stale cache entries are not relied upon for correctness | Runbook Playbook D |
| Global `microBatch=all` interruption pre-commit | B7Y-09, B7Y-11 | No atomic commit result/watermark advance for batch window | Batch assembly queue/window | Full-window replay acceptable; commit remains all-or-nothing | Runbook Playbook F |
| Global `microBatch=all` interruption post-commit | B7Y-09, B7Y-11 | Atomic commit result + watermark progression + dedupe markers | Local queue may still contain already-applied entries | Replayed inputs are suppressed by durable commit+dedupe semantics | Runbook Playbook F |

## Observability checklist per incident

- Runtime mode timeline (`catching_up` -> `ready_to_cutover` -> `live`)
- Last known durable checkpoint and shard ownership state
- Dedupe marker progression for affected stream/document keys
- OCC/transient/terminal error category distribution
- Poison class/action distribution and recent outliers
- Relevant test suite references for the impacted contract area

## Minimum evidence for closure

Before closing an incident as mitigated:

1. durable boundary integrity is verified,
2. recovery playbook steps are executed and logged,
3. no contradiction is found against B7Y contract tests,
4. release gates (`docs:build`, `lint:principles`, boundary checks as needed) are green.
