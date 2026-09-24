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

Provision and inspect the durable Rabbit queue and publisher binding **before** the handoff;
retain complete indexed Tapeworm source commits from B+1 without a snapshot-to-queue gap.
Supply a read-only queue/tail binding probe and an indexed complete-commit reader to the
transport store. An empty new stream needs a separately verified authoritative creation-time
record, first-commit provenance and absence of an existing target/old writer; a UUID appearing
in a delivery is not such evidence. No default zero anchor is installed on admission.
`installAcceptedBaseline` persists a per-(queue, UUID) versioned, immutable majority-acknowledged
row and refuses conflicting reinsertion. Persist readiness references and explicit strategy scope
with B; verify the same queue and tail on each source admission/reconnect. A failing readiness
probe stops processing without a projection write or ACK. No global source or document scan occurs.

The first accepted commit is B+1 (B=-1 -> 0; B=0 -> 1). Gap catch-up reads only complete indexed
commits from B+1 onward in bounded pages. Deliveries at or below B never bootstrap catch-up or
advance transport coverage; `own_record` and eligible stable single-target `in_document` suppress
them before folding, while `none` dispatches actual redeliveries and can repeat effects. For
`in_document`, immutable direct one-source-to-one-target routing and stable target lifetime are
deployment assumptions; no joins, fanout or link mutation. For `own_record`, the first post-B
transaction writes the final sequence for this source even if it has no target. `none` has no
projection dedupe marker or checkpoint. Handler effects must remain pure and warnings advisory.

This foundation does **not** retire the prior draft migration path or its receipts. Those paths
are pending independent audit and are not qualification for this cutover. Do not use the old
migration bypass to claim accepted-baseline admission or run mixed writers. No sharding, saga,
SDK removal, automatic spill, or historical verification is included.
