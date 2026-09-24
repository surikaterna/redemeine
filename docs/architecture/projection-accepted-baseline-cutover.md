# Accepted existing-state baseline (redemeine-yscg, foundation)

This is an **operator acceptance of existing state**, not a historical audit. Choose a complete
Tapeworm commit boundary B for each existing source UUID; a legacy event-level checkpoint does
not establish B. The operator accepts all pre-B omissions, duplicate effects, state and links
as-is. A wrong B can permanently skip commits. Never advertise pre-cutover completeness or
exactly-once processing. There is no automatic rollback that restores historical correctness.

Before admitting a source, stop and drain **every** old writer, including possible restarts.
Record operator identity/time and the old-writer stop declaration; this is an operational
attestation, **not** a fence or cryptographic proof. Prefer revoking old write credentials and
probing with the actual old identity where available. The same old collection remains writable:
an old writer continuing after cutover invalidates post-cutover guarantees. First-touch Mongo
transactions compare the original legacy state, checkpoint and updatedAt; detected stale writes
are rejected for operator inspection. Subsequent writes detect changed checkpoint/updatedAt
when possible; unchanged or deliberately restored values cannot prove an old writer absent.

Configure a **nonempty finite explicit list of UUIDs** bound to the same immutable queue; no
all-source enumeration or dynamic birth inference. A no-op poller cannot enable Rabbit consumption.
An operator may explicitly accept B=-1 on an existing empty source with its historical risk.
New-source birth registration is disabled until authoritative creation and absent-target evidence
can be checked. A seq0 commit or a queue delivery alone is not such evidence.
`installAcceptedBaseline` persists a per-(queue, UUID) v2 immutable majority-acknowledged row;
v1 rows are rejected because their caller-declared tail readiness did not prove source availability.
The unique non-TTL Tapeworm index supports an exact-B lookup (B>=0) and a descending per-source
high-watermark query H. H=-1 is genuine empty history only for B=-1. Missing B, H<B, malformed
boundaries and gaps reject. Observed H and index identity are persisted separately as diagnostic
readiness, not a promise of future publication.

Provision a durable named Rabbit queue and DLX; asserting them checks their actual topology, not
the producer or its availability. Rabbit is a latency/redelivery optimization, **not** evidence
that every commit was published. Before consume and again on reconnect, bounded complete indexed
pages from B+1 through H pass through the normal coordinator with coverage advanced only after
all definitions finish. A paced poll of the same configured sources continues during operation:
new commits can be picked up even when no Rabbit notification arrives. Every direct Rabbit
delivery above B, including an already-covered redelivery, must match a complete indexed
authoritative source commit before dispatch; a missing/mismatched notification is retried and
alerted, never folded or ACKed as supplied by the broker. Normal bounded-page continuation is
paced progress, not an alert. Poll errors, source stalls, expired
history and incompatible queue topology stop healthy admission/ACK and require alert/recovery;
retries are bounded and paced. A network outage longer than source retention may invalidate the
guarantee. Conditional post-cutover delivery requires an accurate B, immutable retained complete
source commits until consumed, continuing indexed polling and *actual* old-writer cessation.
Stopping cancels the consumer and joins in-flight deliveries before stopping the poller. A
delivery stopped before coordinator dispatch is requeued; an already-started durable commit may
ACK before shutdown completes. An uncertain settlement can redeliver (`none` may repeat).

The first accepted commit is B+1 (B=-1 -> 0; B=0 -> 1). Gap catch-up reads only complete indexed
commits from B+1 onward in bounded pages. Deliveries at or below B never bootstrap catch-up or
advance transport coverage; `own_record` and eligible stable single-target `in_document` suppress
them before folding without fetching pre-B history. The accepted B is not verification of an
old payload, and no unverified payload is folded by reliable modes. `none` dispatches a pre-B
redelivery only when its complete indexed historical commit is retained and matches the delivery;
otherwise it cannot promise the duplicate effect. Unavailable or mismatched history is DLQed
with `historical_commit_unavailable` or `historical_commit_mismatch` for operator recovery,
not folded from Rabbit or retried indefinitely. For
`in_document`, immutable direct one-source-to-one-target routing and stable target lifetime are
deployment assumptions; no joins, fanout or link mutation. For `own_record`, the first post-B
transaction writes the final sequence for this source even if it has no target. `none` has no
projection dedupe marker or checkpoint. Handler effects must remain pure and warnings advisory.

The prior draft rebuild migration modules, CLI, receipts and generation pointer have been removed.
Opt-in fresh-generation rebuild is tracked separately as `redemeine-awq1`, not inferred from
accepted existing documents. Do not run mixed writers. No sharding, saga, SDK removal, automatic
spill, or historical verification is included.
