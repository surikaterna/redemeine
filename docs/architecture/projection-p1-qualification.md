# Nonsharded projection P1 qualification

This qualification applies only to the single-coordinator, all-target atomic P1 implementation. Sharding, inbox admission, saga changes, and deployment orchestration are not implemented or certified here.

## Acceptance inventory

| Slice | Contract and scenario evidence | Final qualification command |
| --- | --- | --- |
| `.1` contracts | UUID22, sequence zero, complete commit envelopes, all three dedupe strategies, scalar checkpoints, registry validation, installed declarations | `pnpm run test:projection-consumer-types`; workspace tests and boundaries |
| `.2` reducer/coordinator | Multi-event reduction, target/no-target, P/N/Q mixed strategies, lane overlap, atomic request construction, links and conflicts | projection runtime/worker package tests; workspace tests |
| `.3` stores | Shared in-memory/Mongo conformance, snapshot/majority transactions, none zero dedupe operations, inline warning/capacity rejection, unknown outcomes | `pnpm run test:projection-mongo-real` |
| `.4` ordering/transport | Indexed complete-commit Tapeworm reader, gaps and redelivery dispatch, four SIGKILL windows, direct Rabbit ACK/retry/DLQ, immutable registry | `pnpm run test:projection-real-stack` |
| `.5` migration | Trusted bounded source scans, generation-isolated rebuild, crash restart, exact activation, verification, rejected post-activation rollback | `pnpm run test:projection-migration-real` |

The scripts above finalize immutable JSON receipts only after logical resources, databases, runtime artifacts, and containers owned by the scenario have been cleaned up. Each receipt records the exact Git SHA and pinned service versions or image digests. A receipt from an earlier SHA does not qualify a later commit.

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

The harness measures actual in-memory and Mongo store calls. Mongo command monitoring supplies database read, write, index, and transaction counts; no synthetic database counts or SLOs are emitted. Results include nearest-rank p50/p95/p99 latency, process memory, BSON bytes, warning counts, none-strategy zero operations, document fences, progress coverage, and a separate actual Mongo transport-coverage case. The 100,000-row own-record setup uses timed bounded batches and is excluded from commit latency while remaining visible in the receipt.

Automatic spill was removed in P1-r7. The benchmark therefore reports the physical Mongo BSON/document capacity rejection envelope for inline metadata and the scalar-row cardinality envelope for `own_record`; it does not claim spill behavior.

## Versioning disposition

The cumulative branch adds the public `@redemeine/projection` deduplication API and carries `.changeset/bright-commits-project.md` as a minor bump. Projection runtime, stores, worker, router, and transport packages are private, so their implementation, integration harness, and benchmark changes require no dedicated changeset. Every other changeset, including `initial-release.md` and the saga changesets, is inherited unchanged from the exact base and is unrelated to this qualification. Dependency-propagated patch entries shown by `changeset status` are not new private-package changesets. This slice does not alter `packages/saga` or `packages/saga-runtime`.
