# MongoDB projection runtime store

Commit-native projection writes require a transaction-capable MongoDB replica set or sharded deployment. Call
`initializeProjectionSourceCommitStore()` during startup. Initialization creates and verifies the unique, non-TTL
own-record progress index and proves that snapshot/majority transactions are available; startup fails closed otherwise.

## Source progress strategies

- `in_document` stores the complete UUID22-to-commit-sequence map beside each target's user state. Reads remain `_id`
  point reads and user state returned to reducers never contains this metadata. Use this strategy only when both user
  state and per-target source cardinality are operationally bounded with margin below MongoDB's physical BSON limit.
  Deleting and recreating a target deletes its inline marker history, so a later redelivery can apply again.
- `own_record` stores one scalar sequence per projection name, generation, and source stream. Prefer it for unbounded
  source fan-in. Target deletion does not delete this record, and the record suppresses redelivery rather than rebuilding
  deleted target state. It does not make oversized user state valid.
- `none` performs no projection dedupe collection reads or writes and can reapply effects after an ambiguous outcome.

`warnAtSourceCount` and `warnAtMetadataBytes` are observational only. Byte warnings use BSON serialization of the
actual stored document, including store-owned metadata. Warning thresholds and callback failures never reject, spill,
evict, downgrade, or otherwise change a commit. Warnings are rate-limited per projection generation, target, and kind.

There is no automatic spill, backing progress collection, placement state, or progress scan. A known physical
document-capacity failure is returned as terminal and nonretryable, and the transaction rolls back every target, link,
and progress write. No universal safe byte ceiling is promised because BSON overhead and server/driver behavior vary.
