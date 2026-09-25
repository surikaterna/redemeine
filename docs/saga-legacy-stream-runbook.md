# Legacy saga stream quarantine (`redemeine-371j`)

This is an operator procedure, not an automatic migration or availability guarantee. Old PR111 initial commits contain three events (`instanceCreated`, `sourceEventObserved`, `businessStateRecorded`) and **no** `DefinitionIdentityV1` (`definitionIdentityRecorded`). The current replay refuses them before processing/ACK: Rabbit settlement is `NACK(false)` (no requeue) to the **asserted configured DLQ**. Do not ACK, silently upgrade a stream, or repeatedly republish to the source queue. Preserve the original source commit and delivery; do not skip it.

1. **Quarantine and correlate.** Stop/drain the old worker on the single-node deployment before changing intake or redriving. Verify the source queue's DLX/routing key and actual DLQ binding, and inspect the dead letter without ACKing it until captured. Record queue/vhost, message ID, source event/commit ID, `x-death` reason and count, timestamps, routing headers, worker refusal/error logs and delivery body. Correlate these with the worker's route/instance log to obtain a **known `instanceId`** and partition ID. If correlation is ambiguous, KEEP parked and escalate; never infer IDs by enumerating streams. Restrict access to evidence containing payloads/secrets.
2. **Inventory only that known instance.** On an authorized read-only Mongo connection, confirm the collection for the known partition is `tw_<partitionId>_commits` and inspect its **exact unique** `{ streamId: 1, commitSequence: 1 }` index. Replace placeholders with *validated* known IDs, not arbitrary request input. Example `mongosh` inspection (run for each specifically correlated instance):

   ```js
   const commits = db.getCollection('tw_<partitionId>_commits');
   const streamId = '<known instanceId>';
   const index = { streamId: 1, commitSequence: 1 };
   if (!commits.getIndexes().some(i => i.unique === true &&
     JSON.stringify(i.key) === JSON.stringify(index))) {
     throw new Error('Missing unique streamId/commitSequence index; keep parked');
   }
   const cursor = commits.find({ streamId })
     .sort({ commitSequence: 1 }).hint(index).limit(64).batchSize(1);
   // Inspect one bounded batch, close the cursor; continue with commitSequence > last seen
   // only when the next bounded batch is needed (keep the same streamId and hint).
   ```

   For subsequent batches use `find({ streamId, commitSequence: { $gt: lastSeen } })` with the same ascending sort, hint, limit and batchSize. Before fetching more, enforce an operator-set cumulative byte budget and per-row byte budget (for example BSON size measured on the returned rows); stop and escalate on oversized rows, gaps, missing index or budget exhaustion. Save ordered commit IDs/sequences, event kinds/versions and identity payload evidence, not an unbounded result array. Do **not** use `queryAll`, all-stream enumeration, an unbounded `toArray()`, or a partition scan. A known-instance inventory cannot certify that *every* legacy instance is found; maintain a DLQ/log-derived case register as new failures appear.
3. **Classify and decide per case.** Classify `legacy` (identity missing, including three-event PR111), `malformed` (invalid shape/order/duplicate identity), `version` (unknown schema or definition version), or `policy` (registered policy fingerprint mismatch). Preserve the original commit, refusal reason, index/stream evidence, message ID, x-death and signoff in the incident record. Choose **KEEP parked** by default. The only alternative is an explicitly, separately approved rebuild/migration plan with backup, identity provenance, consistency checks and rollback; no automatic migration tool is supplied. Never insert an identity fact into an old stream merely to make replay pass.
4. **If separately approved for redrive:** first verify a compatible target identity and approved migration/rebuild have been deployed and tested against the preserved stream, including a replay test. On the single node confirm the old worker remains stopped/drained, install the compatible worker, and redrive a controlled single DLQ message (preserve its message ID and original source material). Observe its actual ACK or `NACK(false)` plus x-death/DLQ state, stream commit count and handler effects before proceeding to the next message. On any mismatch stop redrive, KEEP parked, and investigate. Never claim ACK/availability from an empty queue alone, and never discard/skip the source event.

Callback, handler, trigger, parser, build or closure behavior changes require a **definition version bump** even if `policySha256` is unchanged; the policy fingerprint cannot attest callback equivalence across restarts. See [definition identity](./saga-definition-identity.md) and [bounded replay limits](./saga-bounded-replay.md).
