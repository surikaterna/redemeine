# @redemeine/aggregate-runtime

Core orchestration runtime for processing upstream command/event envelopes in disconnected sync scenarios. Part of the [Edge Sync Runtime epic (redemeine-4gs)](../../docs/architecture/edge-sync-runtime.md).

## Purpose

When upstream (edge) nodes submit commands to an authoritative node, those commands arrive as **sync envelopes** — self-contained messages that carry a command and, optionally, the events the edge node optimistically produced. This package provides the deterministic batch processor that validates, deduplicates, sequences, dispatches, and persists those envelopes.

The runtime is **stateless** — all state flows through pluggable adapter contracts. It does not own persistence, transport, or scheduling; it only orchestrates the processing pipeline.

## Envelope Types

Envelopes are modeled as a discriminated union (`SyncEnvelope`) with three variants:

| Type | Description | v1 Support |
|---|---|---|
| `command_only` | Command without pre-computed events. The runtime executes the command handler and produces events server-side. | ✅ Supported |
| `command_with_events` | Command together with optimistically-produced events. The runtime re-executes the command handler and compares results; divergence is delegated to a per-aggregate conflict resolver. | ✅ Supported |
| `events_only` | Events without a command. Reserved for future use. | ❌ Rejected in v1 |

Each envelope carries an `envelopeId` (for idempotency), `commandId`, aggregate identity (`aggregateType` + `aggregateId`), an optional `sequence` number, and extensible `metadata`.

## Key Features

- **Deterministic batch processing** — envelopes are processed sequentially in input order. The batch stops on first failure (rejected envelope or unhandled error) and returns partial results.
- **Idempotency** — every envelope is checked against an `IIdempotencyStore` before processing. Duplicate envelopes are returned as `duplicate` results without side effects.
- **Per-aggregate sequence enforcement** — when an envelope carries a `sequence` number, the runtime enforces strict monotonic ordering per `(aggregateType, aggregateId)` stream. Gaps and out-of-order envelopes are rejected.
- **Pluggable conflict resolution** — for `command_with_events` envelopes, the runtime compares server-produced events against upstream events. On divergence, a per-aggregate `ConflictResolver` plugin decides: `accept` the upstream events, `reject` the envelope, or `override` with a custom event set.
- **Audit trail** — every processing decision emits a typed `AuditSignal` through an `IAuditSink` adapter for observability.

## Non-Goals

This package intentionally does **not** provide:

- **Inbox / outbox** — no message queuing or delivery guarantees
- **Concrete event store** — no persistence implementation; use `IDepot` adapter
- **Transport adapters** — no HTTP, WebSocket, or scomp integration
- **Domain-specific logic** — aggregate registrations and conflict resolvers are consumer-provided

## Quick Start

```typescript
import {
  createAggregateRuntimeProcessor,
  type AggregateRegistration,
  type AggregateRuntimeOptions,
  type CommandOnlyEnvelope,
} from '@redemeine/aggregate-runtime';

// 1. Define aggregate registrations
const counterRegistration: AggregateRegistration = {
  aggregateType: 'counter',
  commandHandlers: {
    increment: (state: unknown, _payload: unknown) => {
      const current = (state as { count: number } | undefined)?.count ?? 0;
      return [{ type: 'incremented', payload: { count: current + 1 } }];
    },
  },
  // Optional: per-aggregate conflict resolver
  // conflictResolver: (ctx) => ({ decision: 'accept' }),
};

// 2. Wire up adapter contracts (provide your own implementations)
const options: AggregateRuntimeOptions = {
  registrations: [counterRegistration],
  idempotencyStore: myIdempotencyStore,   // IIdempotencyStore
  orderingStore: myOrderingStore,         // IOrderingStore
  auditSink: myAuditSink,                // IAuditSink
  depot: myDepot,                         // IDepot
};

// 3. Create the processor
const processor = createAggregateRuntimeProcessor(options);

// 4. Process a batch
const envelope: CommandOnlyEnvelope = {
  type: 'command_only',
  envelopeId: 'env-001',
  commandId: 'cmd-001',
  aggregateType: 'counter',
  aggregateId: 'counter-1',
  commandType: 'increment',
  payload: {},
  occurredAt: new Date().toISOString(),
};

const result = await processor.processBatch([envelope]);
// result.status === 'completed'
// result.results[0].status === 'accepted'
```

## Adapter Contracts

| Interface | Responsibility |
|---|---|
| `IIdempotencyStore` | Atomic envelope deduplication. `reserve(envelopeId)` returns `true` exactly once per envelope. |
| `IOrderingStore` | Per-aggregate sequence tracking. Stores and retrieves the last processed sequence for `(aggregateType, aggregateId)` pairs. |
| `IAuditSink` | Receives typed `AuditSignal` events (`accepted`, `duplicate`, `rejected`, `conflict`, `batch_failed`) for observability. |
| `IDepot` | Aggregate state persistence. `get()` hydrates current state; `save()` persists produced events. |

All adapters are **pluggable** — consumers provide implementations backed by their persistence and infrastructure of choice.

## Processing Pipeline

Each envelope flows through:

1. **Validate** — structural integrity checks (required fields, non-empty strings)
2. **Type guard** — `events_only` → rejected in v1
3. **Resolve registration** — lookup `AggregateRegistration` by `aggregateType`
4. **Idempotency** — `IIdempotencyStore.reserve()` — duplicate → skip
5. **Sequence enforcement** — `IOrderingStore` — gap/out-of-order → reject
6. **Hydrate** — `IDepot.get()` — load current aggregate state
7. **Dispatch** — execute `CommandHandler(state, payload)` → produced events
8. **Conflict resolution** (command_with_events only) — compare produced vs. upstream events
9. **Persist** — `IDepot.save()` — store resulting events

## Error Codes

| Code | Meaning |
|---|---|
| `UNKNOWN_AGGREGATE` | No registration found for the envelope's `aggregateType` |
| `MALFORMED_ENVELOPE` | Structural validation failure (missing/empty fields) |
| `SEQUENCE_GAP` | Envelope sequence is not contiguous with the last processed sequence |
| `EVENTS_ONLY_NOT_SUPPORTED` | `events_only` envelopes are rejected in v1 |
| `PROCESSING_ERROR` | Unhandled error or unresolved conflict during processing |

## Batch Result

```typescript
type BatchResult = {
  status: 'completed' | 'failed';
  processed: number;        // envelopes successfully processed
  total: number;             // total envelopes in the batch
  failedAtIndex?: number;    // index of first failure (if any)
  results: EnvelopeResult[]; // per-envelope results in input order
  ingestedAt: string;        // ISO-8601 batch ingestion timestamp
};
```

Per-envelope results are a discriminated union: `accepted`, `duplicate`, `rejected`, or `conflict_resolved`.

## Related Packages

- [`@redemeine/sync`](../sync/README.md) — edge sync runtime contracts (capabilities, manifest, pending events, upstream/downstream pipelines)
