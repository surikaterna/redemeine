# Commit-native projection change records

Opt in on a commit-native projection definition:

```ts
const definition = createProjection('orders', () => ({ status: 'new' }))
  .from(Order, {
    Opened(draft) {
      draft.status = 'open';
    },
  })
  .deduplication({ strategy: 'own_record' })
  .recordChanges('order_views')
  .buildCommitDefinition();
```

`order_views` is the logical name of the collection containing the projected documents. Use a dedicated MongoDB `projection_changes` collection on the same transactional deployment and pass it as `MongoProjectionStore`'s `changeCollection` option (typed as `db.collection<MongoProjectionChangesRecord>('projection_changes')`). Provision it before running workers. Its built-in unique `_id` index enforces one row per receipt. Enable recording for a generation from its accepted start; it does not backfill turns already processed without the feed. Workers require `projectionChangesCapability: 'atomic-turn-receipts-v1'`; custom adapters must preserve both receipt lookups and atomic writes before declaring support.

## What is written

- `commitProjectionSourceCommit` accepts a typed `additionalWrites` entry with `kind: 'projection_changes'`, alongside the full final documents. A successful result includes the committed record in `additionalWrites`. Legacy daemon and batch write paths are unchanged.
- One record groups all affected targets for an application of a source turn. It includes the logical collection, source and commit identities, source commit sequence, and an opaque `resumeToken` (also the Mongo `_id`). Each target includes its document ID and before/after **commit-level** revisions. The token is an identity, not a sortable global cursor; sequences are per source and revisions are per target.
- Each target's transitions are ordered by source `eventIndex` and include `eventId`. An event that first creates a document produces an RFC 6902 root `add` containing the initial defaults plus handler and `afterEach` results. A later handled event records the difference from the preceding state; a handled event with no state change records `noop` and an empty patch. Unhandled, unrouted, or deduplicated events do not produce transitions.
- A committed turn with no targets writes a `projection_changes_empty` receipt and returns it separately as `emptyChangeReceipt`. It is proof of a completed turn, not a change record. Consumers of the Mongo collection should select `kind: 'projection_changes'` to read changes only. An accepted reliable baseline skip writes neither.
- For JSON objects, patches edit top-level members with escaped JSON Pointers and replace changed nested objects or arrays as values. A change involving a non-object root uses a root `replace`. The patch sequence must reproduce the final document from the revision-checked snapshot. Both stores reject values that BSON could reinterpret or lose before mutation: DBRef-shaped objects (a string `$ref` and non-null `$id`), non-null `_bsontype` markers, NULs in keys, and unpaired UTF-16 surrogates in keys or strings. These restrictions apply recursively to snapshots, resulting states and persisted patch values when recording is enabled.
- Recording also validates persisted receipt identifiers and write metadata before any commit mutation. Identifiers and revision keys must be well-formed Unicode without NUL; valid Unicode is preserved without normalization. Progress maps must be BSON-safe, and ambiguous link revision keys within one write are rejected. These checks do not apply when recording is disabled.
- MongoDB stores receipt revision maps as `[key, revision]` entries so identifiers such as `_bsontype` and `__proto__` are data rather than BSON or JavaScript field names. Store results still expose ordinary revision maps, and MongoDB can replay older receipts stored as maps.

The receipt, target documents, staged links, and source progress commit in one MongoDB transaction. In-memory storage mirrors commit/rollback without persistence. With `own_record` or `in_document`, replay checks the exact source position, commit ID, and collection. A matching older receipt deduplicates even when progress has advanced. A missing receipt is terminal when source progress or admitted queue coverage proves a turn was processed. Accepted baseline skips remain exempt.

With `none`, direct deliveries may reapply a source turn, including covered and retained pre-baseline deliveries. Every successful application gets a fresh store-generated `applicationId` and its own receipt, even if the source commit is identical. Covered polling still does not reapply. No application ID is needed from callers, and there is no cross-delivery deduplication or exactly-once guarantee.

## Limits

The Mongo delta planner is reused only for a single transition on an existing native revision, with distinct, safe, top-level scalar writes or member removals. The store verifies the patch against the transactional snapshot and keeps the source commit revision/progress checks. Creation, legacy adoption, multi-event chains, root edits, unsafe field paths, and other unproven shapes use a full document write. Delta writes reduce update payload size, not snapshot reads. As with other commit-native writes, keep legacy and out-of-band writers off active targets and isolate generations' target data.

One grouped record must fit MongoDB's BSON document limit, independently of the limits on individual target documents. A definite MongoDB append validation failure rejects the turn terminally after rollback. An unknown commit outcome is reconciled from the durable receipt, including empty turns. With `none`, only the current store invocation's receipt is evidence; a previous application's receipt cannot settle the new write. Without a visible receipt the outcome remains ambiguous and retryable. If the write did commit, a later redelivery can apply it again and append another record. Records contain projection data and also serve as receipts; do not grant broad read access or add TTL/deletion without designing retention and retry guarantees.

This path does not publish to a message queue, call an arbitrary side effect, or expose a feed delivery API.
