# Private live projection runtime

Implementation scope: **redemeine-olwl.2**, approved Beads contract
**redemeine-olwl.1 / live-inline-v3**, units 2a then 2b. This is an additive
private runtime, not a runnable application or a production CDC certifier.
The existing `ProjectionRabbitWorker` and its required `SourceTailPoller`
remain unchanged.

## Meaning and ownership

`LIVE_FROM_BOUNDARY` folds **suffix contributions** from a qualified native CDC
interval into an isolated generation. It does not reconstruct aggregate
history, hydrate dormant sources, establish source birth, or accept an
existing-state baseline. A first source sequence of 42 applies 42 without
reading 0–41. The durable source floor has null coverage until every definition
finishes. Coverage orders work; even covered broker duplicates dispatch through
the per-definition markers.

`normalizeLiveRegistration` supplies the private `in_document` default.
Explicit `own_record` remains supported without synthesizing a baseline.
Public SDK builders still require their existing explicit strategy choices.
The supported declaration is pure, event-stable, commutative routing with
suffix-valid initialization. Dynamic/current-link routing, subscription intents,
history-dependent initialization, mixed generations, and no-deduplication mode
are refused. Handler purity and commutativity are semantic qualifications, not
properties this library can infer from JavaScript function bodies. Each event
has at most one bounded event-derived target ID; arbitrary static fanout is not qualified
by this slice. Multiple events may affect different targets in one commit.

Inline same-commit events read the pre-commit marker snapshot and save one
final state/marker per target in the existing transaction. Definitions remain
independent: A may commit before B fails; retry deduplicates A and completes B
before shared coverage advances. Existing physical deletion is unchanged.
Covered deterministic target/marker loss pauses when detectable. Erasure after
a partial definition commit but before coverage can be indistinguishable from
an unapplied turn; **there is no complete detection or recovery guarantee**.
The active generation owner must retain documents and markers. No tombstones,
hidden receipts, marker spill, or own-record fallback are introduced. Existing
store fan-in warnings remain advisory; physical storage-capacity failure rejects
the transaction rather than changing strategy.

## Required evidence boundary

`LiveFeedEvidencePort` is a required trusted integration port. Its session must
inspect durable provisioning, native start/resume continuity, complete source
scope, serialized no-skip publisher/confirm/checkpoint history, intended queue
routing, no-drop broker policy, and exclusive consumer ownership. A payload,
an authoritative Mongo row, a redelivered flag, or a Boolean is not this proof.
Sessions reserve actual channel delivery tags before asynchronous work and
certify only the original earliest live delivery for an absent source.

The included **test-only** ordered-feed model tracks publication, intended-queue
confirmation, durable native checkpoint, FIFO queue, issued deliveries and
session reservations. It is not a production evidence provider. Unknown-source
redelivery without preserved original-first proof pauses; a durable known floor
allows ordinary restart/redelivery. Cancellation/disconnect/requeue invalidate
all old session evidence. Ambiguous floor/coverage writes require exact majority
readback identity; they never derive a new floor from a later message.

Actual provisioning/cursor/publisher qualification and the guarded SDK launcher
belong to **redemeine-olwl.3 / redemeine-hpq1**. They must establish the port's
predicates or remain unready, including stop-before-unsafe-expiry-fallback.
There is no external dispatcher dependency or real-service qualification here.

## Bounds and lifecycle

The live worker uses exactly `rdm.projection.commits`, exclusive consumption,
prefetch 1 and a synchronously reserved callback slot. Raw partition, collection,
tenant, message identity and complete authoritative payload are checked before
admission. The coordinator exposes its epoch/registry/generation identity for
startup agreement. The immutable registry/artifact digest must be qualified by
the trusted provisioning integration, not invented from a handler name.

Source order is point-loaded; there is no source census, poll timer, source-tip
probe, or inactive-source cache. Gaps use one complete source commit per bounded
page, never below F. Turn budgets cap commits, bytes, events and cooperative
elapsed time; result metadata is constant-size. Atomic store calls cannot be
preempted by a cooperative time budget. Original deliveries remain unACKed
across paced continuations. A stalled continuation or uncertain outcome pauses
rather than dropping/requeueing into an unbounded hot loop.

`stop()` invalidates admission immediately, closes the channel to preserve
unACKed obligations, and waits to its deadline. It reports `drained: false`
while an old database turn or channel close remains outstanding. Reconnect
cannot begin while either is outstanding; the service must not release its
writer lock merely because the deadline elapsed. No cross-session ACK or
terminal non-requeue NACK exists in this mode. The later service owns the
single-host lock, restart policy, health and process lifecycle.
