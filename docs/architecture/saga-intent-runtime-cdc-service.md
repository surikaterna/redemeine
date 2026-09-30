---
title: 'Architecture Decision Record: CDC-fed saga intent runtime service'
last_updated: 2026-09-30
status: proposed
---

# CDC-fed saga intent runtime service (redemeine-beau)

## Status and context

**Proposed, not qualified for activation.** This records the selected *intended* service
boundary, not an implemented transport or a claim of lossless CDC coverage. The accepted
[event-sourced saga ADR](./decision-log.md#adr-event-sourced-process-managers-sagas)
remains the model for recording decisions. The atomic saga turn and its complete Tapeworm
commit remain authoritative; Rabbit messages, work queues and timer deliveries are not saga
state or proof of an effect. Durable saga-turn/intent recording is the presently verified
part. CDC intake relay, durable internal work dispatch, effect execution, outcome continuation
and timer dispatch are **not implemented/executed or certified** by this ADR.

The unfenced `_id` keyset static scan is not an approved substitute: the real Mongo precode
experiment in `redemeine-vpwm.4.1` showed a delayed, preassigned lower `_id` can be inserted
after the scan passes a higher one and then be missed. A selective index does not fence an
in-flight insert. `redemeine-regy` still gates the supported source/append-fence or gap-free
CDC decision. The existing Tapeworm dispatcher fallback/checkpoint behavior is **not** a
proof that every saga commit reaches this service.

## Decision: one service, distinct ownership

One **separate saga intent-runtime service** owns all of: intake from a durable CDC queue,
relay/fanout to durable runtime-owned internal work queue(s), consumption and effect
execution, and future timer dispatch. It is not a component of the saga turn worker. This
ADR does not propose independently deployed relay, executor and scheduler services. The
saga turn worker continues to atomically append saga decisions, recorded intents and timer
facts; it does not execute the external effects as part of that append. The intent runtime
must reconcile claims, outcomes and callbacks against the authoritative saga stream with
OCC before declaring progress. External effects remain at-least-once/ambiguous across
crashes; exactly-once execution is not promised.

### Intake and durable handoff contract (proposed)

1. Provision a **durable intake queue** bound to Tapeworm's CDC **HEADERS exchange** using
   the actual published headers for collection and `partitionId`, and tenant **only if the
   publisher actually publishes that header**. Prove actual header names/values and routing
   on the real stack. Rabbit binds queues to exchanges, **not queues to queues**. Do not bind
   by event type: a commit may contain multiple event types and multiple facts. Queue and
   DLQ topology, binding, ownership and permissions are explicitly asserted before consume.
2. For each CDC delivery, validate the complete authoritative physical saga-turn commit,
   including all of `commit.events[]` (not just the first or a notification's event type).
   Extract every supported recorded intent and timer fact, including multiple intents,
   multiple timers and mixed commits. Validate schema/version, provenance, source commit
   identity and full material; unexpected or malformed facts cannot be silently skipped.
3. Fan out each fact to the appropriate **runtime-owned durable queue(s)** using persistent
   messages, mandatory routing and publisher confirms. Confirm every downstream item in
   the commit, and prove it reached a durable routed queue, **before ACKing the CDC intake
   delivery**. A confirm alone without a routed durable target, a returned mandatory
   message, a timeout, an uncertain confirm or a failed publish cannot permit ACK. Retry
   only with reconciliation; stop intake/readiness on uncertainty or quarantine with an
   explicit operator recovery path, never ACK away an unpersisted fact.
4. Partial fanout can publish some items before a crash or rejection. On full-commit
   redelivery, replay *all* facts with a stable identity derived from source collection,
   partition, tenant if applicable, physical commit identity and fact position/ID (including
   type); compare the complete versioned fact/source material at each downstream consumer
   and against durable reconciliation state. Exact duplicates are harmless only after
   full-material equality and authoritative status reconciliation; same identity with
   changed material is poison, quarantined and blocks progress, never last-write-wins.
   Rabbit queues alone do not provide this comparison or exactly-once fanout.
5. Bound intake prefetch, in-flight commit count, fanout count, total bytes per batch and
   per-message size; enforce backpressure and retry budgets. Oversized or unrecognized
   commits fail closed and alert rather than partially ACKing. Retain source until coverage
   and downstream settlement are proven; poison/retention recovery must not advance a
   checkpoint past an unhandled commit. Queue durability is not evidence of source coverage.

The runtime consumer reads its durable internal queue(s), validates the same stable
identity and full material, then uses a persisted per-intent stream claim/lease/epoch and
OCC reconciliation before an eligible effect. It records outcomes and delivers correlated
callbacks durably through the saga turn authority. A crash after effect but before recorded
outcome can cause repeat execution; idempotent destinations are required for safe retries,
and ambiguous non-idempotent work must park for intervention. Neither dequeue nor relay
publication proves success, and timer delivery never directly changes saga state.

### Timers (future candidate, not a certified schedule)

A **separate timer TTL/DLX delivery queue** within the *same* service is a candidate for
due notifications, not the same parked retry queue and not a second service. Compute
remaining delay from persisted `dueAt` at dispatch/recovery, rather than restarting a full
duration on replay; check broker TTL limits and clock behavior. TTL/DLX ordering, expiry
and wake-up are hints, not schedule authority. Before any firing, reread authoritative
saga state and validate schedule identity, current cancellation/reschedule generation,
due time and terminal status under OCC; stale or cancelled generations are no-ops. A
lost/early/duplicate wake-up must be recoverable from a separately proven complete due
discovery/reconciliation path. Do not assert timer readiness from a TTL queue alone.

## Coverage, readiness and recovery contracts

The service owns its queues, bindings, DLQs/quarantine, credentials, consumers, alarms and
bounded replay controls. Startup and reconnection remain **unready for effects/timers**
until topology is asserted and an independently verified complete retained source position
and backlog handoff are reconciled. Pause intake/processing on unknown schema, publisher
gap, missing source commit, changed-same-ID material, missing return/confirm or source
retention uncertainty; no false ACK or optimistic checkpoint. A poison record needs a
durable diagnostic and operator decision/replay procedure; DLQing it alone does not certify
coverage. Restart replay must tolerate duplicate full batches and incomplete fanout without
losing any fact. Track source-to-work coverage and durable consumer reconciliation so
readiness is based on evidence, not queue emptiness or notification arrival.

Before GO, independently demonstrate on a real stack that the actual Tapeworm CDC publisher
routes every relevant complete commit without skip, with safe checkpoint/ACK ordering and
no poison skip. Prove retention and a **gap-free anchored CDC/backfill overlap** from a
known source boundary through live delivery, including previously unseen and final streams,
late inserts, crashes, reconnects and expired resume tokens. On expired token or lost
history, stop unready and rebuild from a provably complete retained anchor, or obtain an
explicit user-approved guarantee change; never resume from an unverified cursor. Test
missing/changed commits, partial confirm/redelivery, duplicate identity, bounded poison
handling and queue routing/returns. An unfenced direct `_id` scan, unanchored watch,
best-effort dispatcher fallback or silently weakened delivery guarantee is **NO-GO**.

## Alternatives and consequences

- **Execute inside the saga turn worker:** fewer deployments but couples append/ACK to
  effect latency and makes source coverage and effect readiness inseparable; rejected for
  the chosen boundary. Atomic turn recording remains with that worker.
- **Multiple independently deployed relay/executor/timer services:** more independent
  scaling but additional cross-service handoffs, topology and failure ownership; not the
  user-selected architecture. Internal queues and components do not imply multiple services.
- **Direct indexed `_id` scan:** a supported selective index is useful for bounded lookup
  but cannot rule out late lower-ID inserts without a proven append-time fence; the
  observed counterexample makes this unfenced design NO-GO. Do not silently fall back to it.
- **CDC-only notification or timer TTL as authority:** neither proves missing commits
  cannot occur nor settles saga state; rejected without anchored coverage and stream OCC.

This choice adds queue/topology operations, source retention pressure, durable replay,
poison quarantine and at-least-once duplicate effects. It isolates the saga turn's atomic
append from execution and gives one service responsibility for relay, effects and eventual
timer delivery, conditional on the release gates above. No activation, deployment,
exactly-once claim or relaxed durability guarantee is authorized here.

## Follow-up gates and traceability

- `redemeine-regy` and `redemeine-vpwm.4.1`: source/index/fence or proven gap-free CDC
  coverage, publisher no-skip, retention, anchor/backfill and expired-token decisions;
  independent audit **before** executor readiness.
- `redemeine-vpwm.4.2`: eligible intent claims, execution, full-material identity,
  persisted reconciliation and crash/poison testing.
- `redemeine-vpwm.4.3`: durable correlated outcome/callback continuation and OCC races.
- `redemeine-vpwm.5`: schedule/cancel generation, due recovery and terminal behavior;
  TTL/DLX alone is not the qualification.
- `redemeine-fyp3.5.3`: delayed saga retry real-stack qualification is **parked**; this
  ADR neither un-parks it nor treats its incomplete receipts as timer/relay evidence.

GO requires these scoped implementation/proof gates and independent real-stack audit of
no-skip, routing, fanout, crash/replay, expiration and stale-generation behavior. Until
then the recorded design is Proposed and runtime execution stays disabled.
