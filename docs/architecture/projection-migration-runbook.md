# Projection rebuild migration runbook

This P1 procedure supports only a complete-commit rebuild into a fresh, physically isolated generation. In-place migration is rejected. Legacy event markers and scalar cursors are never interpreted as commit evidence. No command deletes old or new data.

## Provision immutable records

Before migration, provision two immutable `projection_generation_control` generation records and the old active pointer. Each generation record stores the complete queue registry manifest and its exact document, link, progress, and migration-receipt collection names. Every new collection name must differ from every old collection name. Persist the old immutable queue binding in `projection_transport`.

The version 2 migration manifest contains only operator intent and expected source ranges. It binds:

- distinct old/new generations and complete old/new queue registry manifests;
- immutable source UUID/no-reset declaration;
- sorted, contiguous source ranges, each with count and expected streaming digest;
- new live queue anchors equal to the final replayed sequence plus one;
- a domain-separated streaming digest of all canonical range descriptors.

The manifest is limited to 10,000 ranges and 8 MiB. Commit range digests use canonical BSON/EJSON-compatible encoding with length-framed, domain-separated incremental SHA-256. Generate them from the authoritative Tapeworm Mongo collection, not from legacy markers. Every command recomputes `manifestDigest`.

## Required configuration

All commands require these options (equivalent uppercase underscore environment variables are accepted):

```text
--manifest ./migration-v2.json
--mongo-uri "$TARGET_MONGO_URI"
--database redemeine
--source-mongo-uri "$TAPEWORM_MONGO_URI"
--source-database events
--source-collection tw_orders_commits
--source-partition orders
--documents projection_v2_documents
--links projection_v2_links
--progress projection_v2_progress
--migration-receipts projection_v2_migration_receipts
--runtime-module ./dist/projection-migration-runtime.bundle.mjs
```

`--runtime-module` must identify a regular, non-symlink, read-only JavaScript bundle. The bundle must be self-contained: deployment code and its runtime dependencies are bundled rather than resolved transitively at migration time. The CLI resolves the real path, opens and hashes the actual bytes with SHA-256 before import, validates file identity and metadata while reading, and re-hashes after import and after the command. Deployment must place the bundle on an immutable filesystem for the command duration; this does not claim to hash code outside the required self-contained bundle.

The bundle exports `migrationDefinitions` and `migrationDeploymentDefinitions`. The latter declares identity configuration alongside canonical names, generations, source/join/reverse aggregate types, handler key sets, subscriptions, hooks, deduplication options and warning thresholds. The CLI derives the same material from the executable definition objects and rejects stale declarations. Definition hashes bind this normalized configuration to the actual bundle-byte digest; the definition registry, runtime configuration and queue manifest digests are recomputed and compared with persisted generation and queue identities before every phase. There is no caller-supplied executable digest. Changed handler bytes reject even if names and declarations remain unchanged; changed routing or handler configuration rejects even if declarations remain stale. Functions are covered by bundle bytes and are never authenticated with `Function.toString()`.

The source collection must have exactly one usable unique `{streamId:1, commitSequence:1}` nonpartial, nonsparse index.

## Lifecycle

Set a shell variable containing all required options, then run:

```bash
pnpm --filter @redemeine/projection-transport migration preflight --dry-run $MIGRATION_ARGS
pnpm --filter @redemeine/projection-transport migration preflight $MIGRATION_ARGS
pnpm --filter @redemeine/projection-transport migration verify-sources $MIGRATION_ARGS
pnpm --filter @redemeine/projection-transport migration replay $MIGRATION_ARGS
pnpm --filter @redemeine/projection-transport migration activate $MIGRATION_ARGS
pnpm --filter @redemeine/projection-transport migration verify $MIGRATION_ARGS
```

`--dry-run` performs read-only checks and creates no index, journal, binding, pointer, or projection write. Preflight compares caller intent to persisted immutable old/new generation records, the old queue binding and active pointer, and proves all new collections are empty.

`verify-sources` reads every range from real Tapeworm Mongo in pages capped at 100 commits and 8 MiB. It writes only non-TTL migration journal rows. Projection, link, live progress, transport binding, and active-pointer data remain untouched until exact global journal coverage is established. A restart skips only an exact journal row with the same manifest and expected/observed digest.

`replay` rereads and verifies each authoritative range before applying it through the real projection commit coordinator and Mongo store. The applying scan also streams and compares the complete count/digest, so a mismatch on either pass rejects the command. A mismatch detected during the applying scan is an integrity failure and does not claim rollback of already committed replay receipts; the required Tapeworm UUID/no-reset and fixed-range immutability guarantee prevents that race in supported deployments. Every definition receives an atomic migration-only scalar receipt in the same snapshot/majority transaction as its documents, links and live strategy progress. This receipt makes restart safe for `none` without changing ordinary `none` behavior. Live transport coverage is not advanced during rebuild; its first live anchor is the declared replay end plus one.

After replay, tooling streams the actual isolated document, link, live-progress and migration-receipt collections in stable `_id` order with batch size 100 and stores canonical counts/digests. It never accepts caller-authored output evidence.

`activate` performs one snapshot/majority Mongo transaction. It rechecks the immutable new generation, replayed state revision and manifest, inserts-or-matches the new queue binding, switches the active pointer from old to new, and advances migration state. An unknown result is successful only when rereads prove all three exact postconditions. Serving processes resolve the selected generation through `MongoProjectionGenerationResolver`; process startup and publisher routing remain deployment responsibilities.

`verify` rereads source journal coverage, queue/pointer state, and actual output collections and compares them with the trusted replay snapshot.

Every command emits a version 2 JSON receipt. Rejected, conflicting, or wrong-phase commands exit nonzero. Idempotent successful reruns exit zero.

## Rollback and recovery

Before activation only, run:

```bash
pnpm --filter @redemeine/projection-transport migration rollback $MIGRATION_ARGS
```

This marks the migration rolled back while leaving the old pointer active and preserving all source, old-generation, new-generation, queue and journal data. It deletes nothing.

Rollback after activation is unsupported and exits nonzero with `postActivationForwardRebuildRequired`. Recovery is a new forward rebuild into another fresh generation. Continuing old writers cannot alter active new reads because generations use distinct collections.

Out of scope: in-place migration, post-activation rollback, process supervision, deletion, unbounded external manifests, sharding, inbox and saga.
