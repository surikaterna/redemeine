# Nonsharded projection P1 qualification

This qualification applies only to the single-coordinator, all-target atomic P1 implementation. Sharding, inbox admission, saga changes, and deployment orchestration are not implemented or certified here.

## Acceptance inventory

| Slice | Contract and scenario evidence | Final qualification command |
| --- | --- | --- |
| `.1` contracts | UUID22, sequence zero, complete commit envelopes, all three dedupe strategies, scalar checkpoints, registry validation, installed declarations | `pnpm run test:projection-consumer-types`; workspace tests and boundaries |
| `.2` reducer/coordinator | Multi-event reduction, target/no-target, P/N/Q mixed strategies, lane overlap, atomic request construction, links and conflicts | projection runtime/worker package tests; workspace tests |
| `.3` stores | Shared in-memory/Mongo conformance, snapshot/majority transactions, none zero dedupe operations, inline warning/capacity rejection, unknown outcomes | `pnpm run test:projection-mongo-real` |
| `.4` ordering/transport | Indexed complete-commit Tapeworm reader, gaps and redelivery dispatch, four SIGKILL windows, direct Rabbit ACK/retry/DLQ, immutable registry | `pnpm run test:projection-real-stack` |
| `.5` accepted baseline | Explicit operator B and risk acceptance, retained indexed tail, legacy first-touch CAS, and 24 combined original/accepted scenarios (11 original incl. unknown UUID, 13 accepted) | `pnpm run test:projection-real-stack`; `pnpm run test:projection-mongo-real` |

The scripts above finalize immutable JSON receipts only after logical resources, databases, and containers owned by the scenario have been cleaned up. Each receipt records the exact Git SHA and pinned service versions or image digests. A receipt from an earlier SHA does not qualify a later commit. The accepted-baseline procedure makes no claim of verified pre-cutover completeness, stopped old-writer credentials or future publisher availability; see [accepted-baseline cutover](./projection-accepted-baseline-cutover.md). A future rebuild is separately tracked as `redemeine-awq1`.

## Real MongoDB compatibility matrix

Run from the repository root on Linux with Docker available (the disposable replica set uses host networking and listens on loopback). Use a clean checkout for qualification evidence:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@redemeine/projection-runtime-store-mongodb... --filter=@redemeine/projection-transport...
for major in 6 8; do
  REDEMEINE_MONGO_MAJOR="$major" pnpm run test:projection-mongo-real || exit
  REDEMEINE_MONGO_MAJOR="$major" pnpm run test:projection-real-stack || exit
done
```

`REDEMEINE_MONGO_MAJOR=6` selects MongoDB 6.0.27; `8` (the default) selects 8.0.14. The transport runs the original and accepted-baseline scenarios against the same replica set and RabbitMQ 4.1.4. A receipt is not issued unless the replica-set suite or both transport suites, respectively, report the exact pinned MongoDB version through `buildInfo`. The receipts also identify the Docker image digests. This matrix is for the two real suites above, not the separate benchmark or joined-cutover runner.

Default receipt names under `${TMPDIR:-/tmp}` include the Git SHA and MongoDB version. Receipts are never overwritten; to repeat the same SHA/version, use a fresh `TMPDIR` or distinct paths via `REDEMEINE_ZYFY3_RECEIPT_PATH` (replica set) and `REDEMEINE_ZYFY4_RECEIPT_PATH` (transport). The GitHub Actions workflow `projection-mongo-qualification.yml` runs the same commands per version and uploads the receipts.

## Source-progress benchmark

Run exactly once for a qualification HEAD:

```sh
pnpm run bench:projection-source-progress -- \
  --events-per-commit 1,10,100 \
  --inline-source-counts 1000,1001 \
  --own-record-source-cardinalities 10000,100000 \
  --samples 30 \
  --seed-batch-size 1000
```

The harness measures actual in-memory and Mongo store calls. Mongo command monitoring supplies observed database read, write, index, and transaction counts; no synthetic database counts or SLOs are emitted. Results include nearest-rank p50/p95/p99 latency, process memory, BSON bytes, warning counts, none-strategy zero operations, requested logical operations, and actual coverage advances (zero for event/inline/own cases that never call the order port). A separate Mongo **standalone synthetic order-port CAS** case installs exactly one operator-accepted B=-1 baseline with a genuine empty indexed Tapeworm source and readiness probe; its synthetic wakeup and scalar coverage advances are **not** source-backed commit delivery. Its observed setup counts are reported separately from measured CAS counts. The 100,000-row own-record setup uses timed bounded batches and is excluded from commit latency while remaining visible in the receipt; it does not register 100,000 cutover records.

Automatic spill was removed in P1-r7. The benchmark therefore reports the physical Mongo BSON/document capacity rejection envelope for inline metadata and the scalar-row cardinality envelope for `own_record`; it does not claim spill behavior.

## Versioning disposition

The cumulative branch adds the public `@redemeine/projection` deduplication API and carries `.changeset/bright-commits-project.md` as a minor bump. Projection runtime, stores, worker, router, and transport packages are currently `private: true`; this migration-only deletion changes no publishable package. Existing draft changeset entries for private runtime packages describe the cumulative adoption work; `.changeset/observed-projection-tail.md` no longer implies a replay coordinator exists. Other inherited changesets, including `initial-release.md` and the saga changesets, are unrelated. This slice does not alter `packages/saga` or `packages/saga-runtime`.
