# Projection commit migration runbook

This procedure migrates one nonsharded projection from legacy event markers or a scalar transport cursor to complete Tapeworm commits and generation-scoped scalar deduplication. It does not reinterpret legacy markers. A scalar cursor, unknown event marker, or partial event history is not evidence of a complete commit.

## Manifest and evidence

The version 1 JSON manifest is accepted by `validateProjectionMigrationManifest`. Unknown fields are rejected. It binds:

- complete old and new immutable registry/queue manifests;
- projection name, old/new generation, and old/new `in_document`, `own_record`, or `none` strategy;
- immutable UUID source identities with an explicit no-reset declaration;
- a separate transport start anchor for every source (zero is a valid first sequence);
- contiguous complete-commit range count, boundaries, and SHA-256 digest for every source;
- SHA-256 digests for the authoritative source ranges, executable code, and runtime configuration;
- for certified in-place adoption, state and link snapshot digests at the exact same source boundary;
- retention of the old feed, queue, code, and state artifacts for rollback.

Compute each range digest as `projectionMigrationDigest(commits.map(projectionMigrationDigest))`, then compute `authoritativeSourceDigest` and `authoritativeBoundaryDigest` with `projectionMigrationDigest(sourceCommitRanges)`. Compute `manifestDigest` with `projectionMigrationDigest(projectionMigrationManifestPayload(manifestWithoutDigest))`. Digests authenticate bytes/evidence; operators must acquire the range and snapshot evidence from their authoritative Tapeworm and state stores.

Prefer `mode: "rebuild"` with a new generation. Replay every complete Tapeworm commit from each declared `firstSequence` through `lastSequence`, including commits with no target for the projection. The replay application must preserve source UUIDs and produce the verification evidence consumed below. `in_place` is accepted only when complete source boundaries and state/link snapshots share the declared boundary.

Any logical strategy change or reset requires a new generation and rebuild/certified replay. `in_document -> own_record` cannot infer no-target commits; `own_record -> in_document` cannot infer target histories; `none` has no history to migrate. Inline document capacity is an operational sizing concern, not a strategy migration.

## Commands

All commands emit one JSON receipt. Set the connection explicitly; examples use the private transport package from the repository root.

```bash
pnpm --filter @redemeine/projection-transport migration preflight --dry-run --manifest ./migration.json
pnpm --filter @redemeine/projection-transport migration preflight --manifest ./migration.json --mongo-uri "$MONGODB_URI" --database redemeine
```

The dry run performs no Mongo connection, index creation, binding, or state write. After preflight, stop the old worker, prevent the new worker from starting, and drain the old queue. Record independently measured evidence such as:

```json
{"oldQueueDepth":0,"oldActiveWriters":0,"newActiveWriters":0,"drainedAt":"2026-09-22T00:00:00.000Z","digest":"sha256:<64 lowercase hex>"}
```

```bash
pnpm --filter @redemeine/projection-transport migration quiesce --manifest ./migration.json --evidence ./quiesce.json --mongo-uri "$MONGODB_URI" --database redemeine
```

For a rebuild, call `replayProjectionMigrationRanges(manifest, completeTapewormReader, targetPort)` from the application-owned migration entrypoint against the **new generation**. The target port must atomically apply each commit and persist its migration-only source sequence; `loadAppliedSequence` makes a restarted replay skip already applied commits while still re-reading and digesting the entire authoritative range. This is required even when the live strategy is `none`. The function rejects sliced, missing, noncontiguous, oversized, or digest-mismatched history and applies every complete commit, including no-target commits. It returns the `replay.json` evidence with `replayedRangesDigest`, rebuilt `stateDigest` and `linkDigest`, and `completedAt`. Retain the old feed/artifacts and do not start either live writer during replay. Then immutably bind the new registry and atomically activate the migration state:

```bash
pnpm --filter @redemeine/projection-transport migration activate --manifest ./migration.json --evidence ./replay.json --mongo-uri "$MONGODB_URI" --database redemeine
```

Start exactly one new worker. Transport coverage anchors only establish ordering/catch-up coverage; they never suppress projection dispatch, including definitions using `none`. Compare rebuilt state/links and replay range evidence, then provide:

```json
{"replayedRangesDigest":"sha256:<manifest authoritativeSourceDigest>","stateDigest":"sha256:<observed>","linkDigest":"sha256:<observed>","activeWriters":1,"verifiedAt":"2026-09-22T01:00:00.000Z"}
```

```bash
pnpm --filter @redemeine/projection-transport migration verify --manifest ./migration.json --evidence ./verify.json --mongo-uri "$MONGODB_URI" --database redemeine
```

Every phase is compare-and-set and restart-safe; rerunning a completed command returns an unmutated success receipt. A concurrent phase change is rejected.

## Rollback

Before activation, fix evidence and rerun, or leave the preflight/quiesced state without deleting legacy artifacts. After activation, rollback is permitted only while the old feed/code/state/queue remain retained and there have been no conflicting writes. Stop and drain the new worker first:

```bash
pnpm --filter @redemeine/projection-transport migration rollback --manifest ./migration.json --reason "verification failed" --old-feed-available true --conflicting-writes false --mongo-uri "$MONGODB_URI" --database redemeine
```

If the old feed/artifacts are unavailable or either generation has conflicting writes, the command rejects with `manualRebuildRequired`. Perform a new-generation rebuild; never infer rollback anchors from scalar cursors or legacy markers. The tool never deletes old collections, queues, code, or feeds.

Legacy polling APIs retain their existing sequence semantics and deprecation state. This tooling is additive and performs no automatic reinterpretation.
