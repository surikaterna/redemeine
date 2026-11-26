# Native join membership sets

Use `.join(Order, handlers)` to register handlers and `.joinRight(Order, selectors)` to opt into set membership for this projection generation. An explicit [join initializer](#initialize-a-new-membership) also opts in. Both handler and selector maps use the aggregate's **local event keys**, including when the wire name is overridden.

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

Do not enable set membership on an existing scalar generation. Plain `.join()` without `.joinRight()` or `.onJoinInitialize()` continues to use existing scalar semantics and registry identities. Stop old writers, choose and document the accepted forward cutoff **B**, and bind a new queue/manifest with a new projection generation. Declare `joined: true` and `joinMembership: 'set-v1'` in its definition entry. Use isolated collections for documents, memberships, progress, receipts and transport; seed accepted documents explicitly. Pass the same dedicated membership and document namespaces to `MongoProjectionStore` and the transport's joined inventory resources. Do not configure scalar or legacy writers against those collections.

At dispatch the worker presents its immutable manifest in a versioned proof, and the source-order adapter compares its contents with the authoritative queue binding before creating a coverage row. The worker also verifies the returned proof before reducing any event. A missing proof is not interpreted as legacy scalar mode. Custom source-order adapters must implement both sides of this handshake; a caller-provided manifest ID alone does not establish a match.

Prepare a complete, reviewed inventory from the stopped state. Map a known scalar link to a singleton set, a known scalar-null tombstone to `[]`, and absent rows to no entry. Never infer the inventory by letting the runtime scan or fill missing subscriptions. Group edges by source, sort target IDs, reject duplicate or ambiguous inputs, and preflight the 1,024-target and 1 MiB encoded ID-set bounds. The same bounds apply to the union on each handled event. Capacity failure aborts the source turn without truncation.

Supply a `JoinedApproval` with an inventory per joined definition, in registry order. The set inventory uses `format: 'set-v1'`, `expectedSets`, `maxLinkRows`, `maxEdges`, and `maxTargetBytes` (UTF-8 JSON bytes of the seed rows). Include `knownEmpty: true` and `emptyInventoryReference` when the reviewed inventory has no edges, even if it includes tombstones. Use `joinedMembershipSeedRow` to generate revision-zero rows, and `approvalDigest` to bind the exact approval. Seed only in the isolated collection before adoption. The worker checks exact membership and referenced documents before adoption, then uses durable adoption on restart rather than requiring reseeding. Do not edit the approval, reset revisions, delete empty membership rows, or place TTL indexes on these resources.

There is no automatic backfill, mixed-writer compatibility, or transparent downgrade. Capacity, cutoff, resource isolation and approval completeness are operator responsibilities. The transport gate checks the approved inventory; it does not infer the old application's state.

To exercise the synthetic coordinator and cutover scenarios, start an isolated Mongo replica set with `enableTestCommands=1`, supply its URI using `REDEMEINE_MONGO_URI`, and run `pnpm --dir packages/projection-transport run test:real-join-memberships` after building the workspace packages. The script uses a transient-read failpoint, creates and drops temporary databases, and reports fan-out command counts.

## Initialize a new membership

An initializer loads one latest persisted value when your handler explicitly attaches a new edge. It does not change the live source: both bindings below still receive `Order` **aggregate events** through `.join(Order, handlers)`.

```ts
import { createProjection, joinInitializer } from '@redemeine/projection';

// These are alternative definitions for this edge, not two registrations on one Order join.
const bookingInit = joinInitializer(Order, { from: 'projection', projection: OrderProjection });
const inventoryInit = joinInitializer(Order, { from: 'snapshot' });

const sailing = createProjection('sailing', () => ({ booked: 0, visits: 0 }))
  .from(Sailing, {
    bookingRequested(_draft, event, ctx) {
      ctx.subscribeTo(bookingInit, event.payload.orderId);
    },
  })
  .join(Order, {
    quantityChanged(draft, event, ctx) {
      draft.visits++; // Always run controls and other non-seeded logic.
      if (ctx.joinSeedCoverage !== 'covered') draft.booked += event.payload.amount;
    },
    bookingUnlinked(draft, event, ctx) {
      draft.booked = 0;
      ctx.unsubscribeFrom(Order, event.aggregateId);
    },
  })
  .onJoinInitialize(bookingInit, (draft, view) => {
    draft.booked = view.booking.total; // Readonly OrderProjection state.
  })
  .deduplication({ strategy: 'own_record' })
  .build();
```

For the snapshot alternative, register `inventoryInit` and attach with
`ctx.subscribeTo(inventoryInit, orderId)`. Its callback can read
`snapshot.warehouse.remaining` (aggregate state), not `view.booking.total`
(projection state). In both cases the seed is deeply readonly portable JSON,
and the callback receives the target's mutable draft. `ctx.subscribeTo(Order, orderId)`
is still forward-only, with **no** reader call. Repeated attaches to an existing
edge do not reseed or replace its coverage. Attach followed by detach in the
same handler does not read. A later reattach may initialize a new edge.

### Bind and prove a reader

Use `bindJoinSeedReader(binding, { seedGeneration, policy, readOne })` from
`@redemeine/projection-worker-core`. Register the resulting reader in the
consumer's `joinSeedReaders` and use `joinSeedDeployments(readers)` for the
matching manifest definition's `joinSeeds`. Keep kind, name, generation and
coverage policy stable in that deployment generation. Each joined aggregate
has at most one declared initializer. Use a new consuming generation and the
usual joined cutover; existing edges adopted as forward-only do not acquire
invented provenance. Do not mix old and initialized writers for a generation.
This is a native coordinator feature, not supported by legacy daemons or
`testProjection`.

`readOne(aggregateId, signal)` returns either `null` (not available yet) or
`{ state, provenance }`. Provenance names the `aggregateType`, `aggregateId`,
`from`, `seedName`, `seedGeneration`, logical `documentId` (the aggregate ID in
v1), and `position`. Use the projection's definition name as `seedName` for
`projection`, and the aggregate type for `snapshot`. A reader must honor one
explicit policy:

- `proven`: return a coherent state and exact **inclusive source-commit**
  position `{ kind: 'throughCommit', streamId, commitSequence }`. This covers
  every event in the matching source commit, including its later event
  indices. The ID must be the exact immutable source stream for this aggregate
  instance. A per-document revision, aggregate event version, queue
  checkpoint, timestamp, or independently loaded progress is not this proof.
  For example, a per-Order view with stable routing from a known complete base
  can read its state and that stream's `in_document` progress from one row.
  The reader must establish that state and proof belong together, and
  validate the mapping from aggregate type and ID to its immutable stream
  UUID. The coordinator validates the returned identity fields and proof
  shape. It checks the UUID against the live source when the trigger is
  from that aggregate instance. On a cross-source attach (for example,
  Sailing attaches an Order), the coordinator does not know the Order's
  UUID independently: a reader that supplies the wrong UUID can commit the
  attach, but a later handled event from that Order will fail closed before
  writing. A generic loaded document does not prove the mapping or a
  coherent producer read.
- `bestEffort`: return `{ kind: 'unknown' }` explicitly. The runtime never
  treats it as covered or suppresses an event. Prefer replacement/idempotent
  writes; additive fields may miss or double-count deltas with unknown
  coverage. In particular, the additive example above assumes `proven`.

The optional callback `info` contains immutable provenance, the triggering
event, target ID, and trigger coverage (`covered`, `uncovered`, `unknown`, or
`differentSource`). Only exact source commits are compared. When an `Order`
event attaches itself as a candidate, defer its seed-owned delta in the
attaching handler; fold it in the initializer only if the proof warrants it.
Later handlers can check `ctx.joinSeedCoverage` for the retained initialized
edge at event start. Do not use it to skip unlink or other membership controls.

The latest seed can be ahead or behind live delivery. The coordinator does not
hydrate aggregate history, replay an intervening tail, or wait for another
projection to catch up in the current turn. A missing seed, missing required
proof, or reader I/O failure does not acknowledge the turn; malformed evidence
or mismatched identities fail closed. Reads run outside the target lanes,
Immer, and write transaction; readers receive a five-second abort deadline.
Inputs are bounded (64 reads, 1 MiB per state, 8 MiB total per turn). The
runtime can rerun synchronous handlers and initializers when it replans, so
write only to the draft. Within that attempt it reuses the detached seed;
if an uncommitted turn is delivered again it can read a newer value. It
atomically persists the winning target changes,
membership and provenance, source progress, and configured change history.
Recorded history identifies the actual trigger and applied provenance without
re-reading today's seed.

Run `pnpm --dir packages/projection-transport run test:join-initialization`
for the in-memory scenarios. Set `REDEMEINE_MONGO_URI` to also run the actual
replica-set scenarios, including an atomic producer-view/progress read and
rollback when change history cannot be written.
