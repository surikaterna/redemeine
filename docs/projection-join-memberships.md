# Native join membership sets

Use `.join(Order, handlers)` to register handlers and `.joinRight(Order, selectors)` to opt into set membership for this projection generation. Both maps use the aggregate's **local event keys**, including when the wire name is overridden.

```ts
const boards = createProjection('boards', (id) => ({ id, updates: 0 }))
  .from(Board, { created: () => {} })
  .join(Order, {
    placed(draft, event, ctx) {
      if (draft.id !== event.payload.boardId) return;
      ctx.subscribeTo(Order, event.aggregateId);
    },
    moved(draft, event, ctx) {
      if (draft.id === event.payload.oldBoardId) ctx.unsubscribeFrom(Order, event.aggregateId);
      if (draft.id === event.payload.newBoardId) ctx.subscribeTo(Order, event.aggregateId);
    },
    updated(draft) { draft.updates++; }
  })
  .joinRight(Order, {
    placed: (event) => event.payload.boardId,
    moved: (event) => event.payload.newBoardId
  })
  .deduplication({ strategy: 'own_record' })
  .build();
```

A selector is a pure synchronous function of the event. Return a target document ID, an array of IDs, or `null`/`undefined` for no candidates. Do not do I/O or depend on mutable external state. There is no draft or context in this phase. An empty selector map opts in without adding candidates. The opt-in applies to all joins and context link operations for that definition; primary routing still uses `identity`, defaulting to `aggregateId`.

Set-mode identifiers must be well-formed Unicode. In particular, do not split a UTF-16 surrogate pair when deriving an ID: MongoDB cannot preserve a lone surrogate. Invalid IDs fail before any projection writes. A malformed stored membership blocks a fresh turn without advancing coverage. For a reliably deduplicated, recorded turn, an exact durable receipt can still prove the turn already committed and allow coverage to catch up. An unavailable receipt read is retryable; `none` does not reuse a prior receipt.

For each joined event the native coordinator takes the sorted unique union of staged saved members and candidates. An overlap runs once per **committed application**, not once across optimistic retries. A candidate is not automatically saved. `subscribeTo`/`unsubscribeFrom` affect only the current target's edge; the last explicit operation wins. Selecting or attaching B does not remove A. Later events in the same commit see earlier explicit changes, but cannot retroactively change an earlier event's recipients.

For a missing candidate-only target, the handler and `afterEach` run against `initialState(id)`. Listing the ID does not create it. The handler can create a document through a meaningful state change on its first visit, without subscribing it. It can also explicitly subscribe the target without changing state; if that intent is not canceled during the visit, the initial document is written so the edge has a target. Returning without either, including a veto, creates no placeholder or document transition. The runtime has no domain-specific rule about which other event must create the view first. An existing candidate uses the ordinary handler/no-op transition semantics. A no-target or skipped turn still commits its membership fence and any configured progress/receipt atomically. Handlers and hooks must be synchronous and deterministic.

`own_record` is recommended; proven replays do not re-route after membership drift. With `none`, each delivery is a new application and routes against current membership. Joined `in_document` is unsupported. The legacy daemon, processor and single-document testing fixture do not support this mode. Use the registered native coordinator with a capable store. There is no distributed selector execution or new transport payload.

For a fresh turn, the coordinator evaluates the event-local selectors once and batches the distinct candidates and saved targets before reducing events in order. It acquires a fresh snapshot and starts at event zero after a conflict or discovery of additional keys. In a single worker, target lanes serialize overlapping local turns; they are not distributed locks. If independent MongoDB writers interleave, candidate presence and saved membership are observed in one snapshot transaction. Atomic writes still check touched document revisions and the observed membership revisions, including empty sets. Thus a turn cannot combine a missing candidate from before a concurrent create-and-unlink with the empty membership from after it. A declined missing candidate does not create a view record just to fence the read.

Even without contention, a typical fresh set-mode MongoDB turn has two batched snapshot-read transactions (routing discovery, then the coherent turn read) and one write transaction. The original scalar/direct paths are unchanged. In addition to the per-event and per-row bounds below, set-mode routing is limited to 16,384 entries and 8 MiB of key bytes per discovery input (selector results, saved IDs, or snapshot key batches).

After an unknown MongoDB commit result, a recorded turn can be confirmed by its durable change receipt. With recording off and `own_record`, the store confirms a set-mode write only if a single snapshot matches the attempt's unique progress write ID, its written document revisions and write IDs, and every final membership set and revision. A rival advancing the same source sequence is not proof, even when it wrote the same membership. If the proof is missing, was superseded, or cannot be read, the result is retryable and ambiguous. With `none` and recording off there is no durable reconciliation proof.

## Forward-only Mongo cutover

Do not enable set membership on an existing scalar generation. Plain `.join()` without `.joinRight()` continues to use existing scalar semantics and registry identities. Stop old writers, choose and document the accepted forward cutoff **B**, and bind a new queue/manifest with a new projection generation. Declare `joined: true` and `joinMembership: 'set-v1'` in its definition entry. Use isolated collections for documents, memberships, progress, receipts and transport; seed accepted documents explicitly. Pass the same dedicated membership and document namespaces to `MongoProjectionStore` and the transport's joined inventory resources. Do not configure scalar or legacy writers against those collections.

At dispatch the worker presents its immutable manifest in a versioned proof, and the source-order adapter compares its contents with the authoritative queue binding before creating a coverage row. The worker also verifies the returned proof before reducing any event. A missing proof is not interpreted as legacy scalar mode. Custom source-order adapters must implement both sides of this handshake; a caller-provided manifest ID alone does not establish a match.

Prepare a complete, reviewed inventory from the stopped state. Map a known scalar link to a singleton set, a known scalar-null tombstone to `[]`, and absent rows to no entry. Never infer the inventory by letting the runtime scan or fill missing subscriptions. Group edges by source, sort target IDs, reject duplicate or ambiguous inputs, and preflight the 1,024-target and 1 MiB encoded ID-set bounds. The same bounds apply to the union on each handled event. Capacity failure aborts the source turn without truncation.

Supply a `JoinedApproval` with an inventory per joined definition, in registry order. The set inventory uses `format: 'set-v1'`, `expectedSets`, `maxLinkRows`, `maxEdges`, and `maxTargetBytes` (UTF-8 JSON bytes of the seed rows). Include `knownEmpty: true` and `emptyInventoryReference` when the reviewed inventory has no edges, even if it includes tombstones. Use `joinedMembershipSeedRow` to generate revision-zero rows, and `approvalDigest` to bind the exact approval. Seed only in the isolated collection before adoption. The worker checks exact membership and referenced documents before adoption, then uses durable adoption on restart rather than requiring reseeding. Do not edit the approval, reset revisions, delete empty membership rows, or place TTL indexes on these resources.

There is no automatic backfill, mixed-writer compatibility, or transparent downgrade. Capacity, cutoff, resource isolation and approval completeness are operator responsibilities. The transport gate checks the approved inventory; it does not infer the old application's state.

To exercise the synthetic coordinator and cutover scenarios, start an isolated Mongo replica set with `enableTestCommands=1`, supply its URI using `REDEMEINE_MONGO_URI`, and run `pnpm --dir packages/projection-transport run test:real-join-memberships` after building the workspace packages. The script uses a transient-read failpoint, creates and drops temporary databases, and reports fan-out command counts.
