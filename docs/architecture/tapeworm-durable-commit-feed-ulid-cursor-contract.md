# Tapeworm Durable Commit Feed + ULID Cursor Contract (redemeine-48z)

## Status
- Owner: Architect
- Bead: redemeine-48z
- Scope: Durable commit-feed contract for Tapeworm adapters (MongoDB, IndexedDB, others)
- Depends on: redemeine-4gu (transactional outbox architecture)

## 1) Goals and Non-goals

### Goals
1. Define a **portable commit envelope** emitted by all Tapeworm adapters.
2. Define a **ULID cursor contract** for ordered catch-up and resume.
3. Specify **ordering guarantees** and adapter conformance boundaries.
4. Specify **backfill/rehydration API semantics** for consumers that fall behind oplog/change-stream windows.
5. Define **index/checkpoint/failure-recovery** rules to guarantee at-least-once delivery with deterministic replay.

### Non-goals
1. No transport binding decision (Kafka/SQS/etc. is out of scope here).
2. No implementation details for specific storage engines beyond conformance requirements.
3. No change to domain event schema itself beyond feed envelope wrapping.

---

## 2) Commit Envelope Schema (Canonical)

Every committed unit (aggregate append + optional outbox intents) MUST be exportable as one immutable envelope.

```ts
type TapewormCommitEnvelopeV1 = {
  schemaVersion: 1;

  // globally unique, lexicographically sortable cursor key
  commitId: string; // ULID

  // commit metadata
  committedAt: string; // RFC3339 UTC timestamp
  stream: {
    aggregateType: string;
    aggregateId: string;
    expectedVersion?: number;
    nextVersion: number;
  };

  // deterministic ordering tie-breakers when storage clock granularity is coarse
  ordering: {
    partitionKey: string;      // typically aggregateType|aggregateId
    partitionOffset: number;   // monotonic within partition
    globalSequence?: string;   // optional adapter-native sequence if available
  };

  causation?: {
    commandId?: string;
    correlationId?: string;
    actorId?: string;
    tenantId?: string;
  };

  events: Array<{
    eventId: string;
    eventType: string;
    eventVersion: number;
    payload: unknown;
    metadata?: Record<string, unknown>;
  }>;

  outbox?: Array<{
    intentId: string;
    intentType: 'command' | 'integration' | 'timer' | 'compensation';
    topic?: string;
    payload: unknown;
    headers?: Record<string, string>;
    notBefore?: string; // RFC3339
  }>;

  integrity: {
    checksum?: string;      // optional content hash for corruption detection
    adapterName: string;
    adapterVersion: string;
  };
};
```

### Envelope invariants
- `commitId` MUST be unique in adapter scope and stable forever.
- `events[]` order MUST match append order in the transactional boundary.
- If outbox exists, outbox intents MUST represent the same atomic commit boundary as events.
- Envelope is append-only and immutable after commit success.

---

## 3) ULID Cursor Model

### Cursor type
```ts
type TapewormCursor = {
  v: 1;
  afterCommitId?: string; // ULID, exclusive lower bound
  limit?: number;         // requested batch size
  partition?: string;     // optional future extension for sharded scans
};
```

### Cursor semantics
1. `afterCommitId` is **exclusive**: next page begins strictly after this commit.
2. Empty cursor means from oldest retained commit in feed.
3. Returned page includes `nextCursor` with the last envelope `commitId`.
4. Cursor is opaque to external consumers once serialized; producers may add fields with version bump.

### Why ULID
- Lexicographic ordering makes checkpoint persistence simple.
- Monotonic ULID generation minimizes collision risk within same millisecond.
- Works across adapters lacking native global sequence primitives.

---

## 4) Ordering Guarantees

### Required guarantees (all adapters)
1. **Per-commit atomicity**: envelope is either fully visible or not visible.
2. **Total feed order by (`commitId`, adapter tie-breaker)** for replay APIs.
3. **Per-partition monotonic order** by `partitionOffset` for same aggregate partition.
4. **No mutation/rewrite** of committed envelopes.

### Allowed behavior
- Feed is **at-least-once consumable**; duplicates are possible under retry/resume.
- Cross-partition real-time causality is not guaranteed beyond feed order.

### Consumer requirement
- Consumers MUST dedupe by `commitId` (and optionally `eventId`/`intentId` downstream).

---

## 5) Backfill / Rehydration API Semantics

### Contract
```ts
interface DurableCommitFeed {
  readPage(input: {
    cursor?: TapewormCursor;
    limit?: number;
    fromCommittedAt?: string; // optional bounded-time recovery
  }): Promise<{
    envelopes: TapewormCommitEnvelopeV1[];
    nextCursor?: TapewormCursor;
    highWatermark?: { commitId: string; committedAt: string };
  }>;

  getByCommitId(commitId: string): Promise<TapewormCommitEnvelopeV1 | null>;

  getWindow(input: {
    fromCommitId?: string;
    toCommitId?: string;
    limit?: number;
  }): Promise<TapewormCommitEnvelopeV1[]>;
}
```

### Semantics
- `readPage` MUST return envelopes in ascending feed order.
- `highWatermark` indicates snapshot upper bound observed during request.
- If `fromCommittedAt` precedes retention floor, adapter returns an explicit retention error with oldest available watermark.
- `getByCommitId` enables point recovery after partial batch processing crash.

---

## 6) Adapter Conformance Requirements

Each adapter MUST provide:
1. **Atomic write boundary** for events + outbox intents in one commit package.
2. **Deterministic ULID assignment** at commit creation time.
3. **Durable feed storage** retaining envelopes at least for configured replay horizon.
4. **Idempotent read behavior** (same cursor boundary always yields stable ordering for retained data).
5. **Conformance tests** validating ordering, dedupe keys, and crash recovery.

### MongoDB adapter
- Use transaction/session for atomic append+outbox.
- Required indexes:
  - unique `{ commitId: 1 }`
  - `{ committedAt: 1, commitId: 1 }`
  - `{ stream.aggregateType: 1, stream.aggregateId: 1, ordering.partitionOffset: 1 }`

### IndexedDB adapter
- Use one transaction spanning event/outbox object stores and commit feed store.
- Required indexes:
  - primary key `commitId`
  - secondary `committedAt`
  - compound `(partitionKey, partitionOffset)`

---

## 7) Index and Checkpoint Strategy

### Producer-side indexes
- Primary lookup: `commitId`.
- Sequential scan: `(committedAt, commitId)` for stable pagination.
- Partition debugging/rebuild: `(partitionKey, partitionOffset)`.

### Consumer checkpoints
Checkpoint record:
```ts
type FeedCheckpoint = {
  consumerId: string;
  lastProcessedCommitId: string;
  lastProcessedAt: string;
  updatedAt: string;
  leaseToken?: string;
};
```

Rules:
1. Persist checkpoint **after** successful processing side-effects for the commit.
2. Resume with `afterCommitId=lastProcessedCommitId`.
3. On duplicate redelivery, skip when `commitId <= lastProcessedCommitId` (or dedupe table hit).

---

## 8) Failure / Recovery Flows

### A) Consumer crash after processing, before checkpoint
- On restart, same commit may replay.
- Required mitigation: idempotent side-effect handlers + dedupe by commitId/intentId.

### B) Cursor references pruned data
- Adapter returns `RetentionWindowExceeded` with `oldestAvailableCommitId`.
- Consumer performs bounded backfill from retention floor and emits observability alert.

### C) Partial adapter outage during read
- Reader retries with same cursor (safe due to immutable ordering).
- Exponential backoff with jitter required at integration layer.

### D) Cross-node clock skew
- ULID monotonic factory per node + tie-break with adapter-native sequence where present.
- Conformance tests must prove stable order under skew simulation.

---

## 9) Acceptance Mapping (redemeine-48z)

- API contract: Defined in sections 2, 3, 5.
- Index strategy: Section 7 (+ adapter specifics in section 6).
- Checkpoint semantics: Section 7.
- Failure/recovery for catch-up + resume: Section 8.
- Adapter conformance across MongoDB/IndexedDB/etc.: Section 6.

## 10) Engineer Handoff Notes

1. Implement `TapewormCommitEnvelopeV1` and `TapewormCursor` as shared contracts package-level.
2. Add adapter conformance test suite with fixtures for ordering, retention errors, resume, and dedupe replay.
3. Wire runtime checkpoint abstraction to persist `lastProcessedCommitId` atomically with consumer progress where possible.
4. Emit metrics:
   - feed_read_lag_ms
   - backfill_window_exceeded_total
   - replay_duplicate_total
   - checkpoint_write_latency_ms
