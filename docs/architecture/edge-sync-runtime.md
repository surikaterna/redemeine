# Architecture Decision Record: Edge Sync Runtime

**Status:** Accepted  
**Epic:** redemeine-4gs  
**Date:** 2026-04-11  
**Packages:** `@redemeine/aggregate-runtime`, `@redemeine/sync`

## Context

Disconnected nodes (edge devices, regional servers, on-site installations) need to process commands locally when the authoritative upstream node is unreachable, then reconcile when connectivity is restored. The system must support arbitrary topology depths (origin → relay → leaf chains) without protocol changes and without coupling the framework to any specific transport or persistence technology.

Prior approaches used ad-hoc synchronization with hard-coded topologies and tightly coupled persistence, leading to fragile deployments and difficulty scaling to new edge scenarios.

## Decision

Build a **capability-driven runtime** with **optimistic command processing** and **manifest-driven downstream replication**. The architecture is split into two packages:

- **`@redemeine/aggregate-runtime`** — the upstream-side batch processor that validates, deduplicates, sequences, and dispatches sync envelopes
- **`@redemeine/sync`** — the full sync framework contracts: capabilities, manifest, pending event lifecycle, upstream command submission, downstream replication, and store adapters

### Key Architectural Decisions

#### 1. Commands Flow Upstream, Authoritative Events Flow Downstream

All commands are submitted upstream via FIFO batch submission (scomp `request`). Authoritative events, projections, master data, and configuration flow downstream via per-lane feeds (scomp `feed`). This enforces a single source of truth: the upstream authority is always the definitive event producer.

```
     ─── commands flow UP ───▶
     ◀─── events flow DOWN ──

     Leaf → (Relay →) Origin → (Relay →) Leaf
```

#### 2. Pending Events Flagged in Main Store, Superseded on Divergence

Edge nodes process commands optimistically and store the resulting events with `pending` status in the main event store — not in a separate staging area. When authoritative events arrive from upstream:

- **Match**: pending events transition to `confirmed`
- **Divergence**: pending events are marked `superseded` (retained for audit) and authoritative replacements are inserted as `confirmed`
- **No match**: authoritative events are inserted directly as `confirmed`

This design keeps the event store as the single source of truth for aggregate state, with lifecycle metadata (`EventStatus: 'pending' | 'confirmed' | 'superseded'`) tracking the reconciliation state.

#### 3. Sync Manifest Is Upstream-Internal; Downstream Is Manifest-Unaware

The Sync Manifest is a continuously-recomputed reactive projection that determines what data each downstream node receives. It lives entirely on the upstream side. Downstream nodes simply consume whatever arrives on their feeds — they never see, request, or influence the manifest.

This means:

- Upstream can change what a node receives without coordination
- Filter changes propagate automatically through manifest recomputation
- Relay nodes derive sub-manifests for their children using `deriveChildManifest(parent, childId, filterFn)`

#### 4. Transport via scomp, Persistence via Adapter Contracts

The framework defines no concrete transport or persistence. All infrastructure concerns are behind pluggable adapter contracts:

**Transport (scomp):**
- `UpstreamSyncService.submitCommands()` — scomp `request` for command batches
- `DownstreamSyncService.eventStream()` / `.projectionStream()` / etc. — scomp `feed` for downstream lanes

**Persistence adapters:**
- `IIdempotencyStore` — envelope deduplication
- `IOrderingStore` — per-aggregate sequence tracking
- `IAuditSink` — audit signal emission
- `IDepot` — aggregate state persistence (aggregate-runtime)
- `ISyncEventStore` — sync-aware event store with pending/confirmed/superseded lifecycle
- `ICommandQueue` — durable FIFO command queue with peek/ack semantics
- `ICheckpointStore` — per-lane sync position tracking
- `IManifestStore` — manifest persistence
- `IManifestRuleEngine` — pluggable rule evaluation for manifest computation

#### 5. Same Protocol for All Topologies

The protocol is topology-agnostic. An origin, relay, or leaf node is defined by its **capabilities** — boolean flags that determine which runtime behaviors are activated:

| Capability | Origin | Relay | Leaf |
|---|---|---|---|
| `durableEventStore` | ✅ | ✅ | ✅ |
| `upstreamSync` | ❌ | ✅ | ✅ |
| `downstreamRelay` | ✅ | ✅ | ❌ |
| `optimisticProcessing` | ❌ | ✅ | ✅ |
| `scheduler` | ✅ | ✅ | ❌ |
| `projectionRuntime` | ✅ | ✅ | ❌ |

Role is derived from capabilities via `resolveRole()`:
- No upstream sync → `origin`
- Upstream sync + downstream relay → `relay`
- Upstream sync + no downstream relay → `leaf`

## Package Structure and Boundaries

```
packages/
├── aggregate-runtime/          @redemeine/aggregate-runtime
│   └── src/
│       ├── envelopes.ts        SyncEnvelope discriminated union
│       ├── runtime.ts          CommandHandler, ConflictResolver, AggregateRegistration
│       ├── adapters.ts         IIdempotencyStore, IOrderingStore, IAuditSink
│       ├── options.ts          IDepot, AggregateRuntimeOptions
│       ├── processor.ts        createAggregateRuntimeProcessor (batch pipeline)
│       ├── preflight.ts        Shared pre-flight: resolve → idempotency → sequence → hydrate → dispatch
│       ├── conflict-handler.ts Conflict detection and delegation
│       ├── sequence-enforcer.ts Per-aggregate sequence enforcement
│       ├── registration-resolver.ts O(1) aggregate registration lookup
│       ├── validation.ts       Structural envelope validation
│       ├── batch-result.ts     BatchResult and EnvelopeResult types
│       └── errors.ts           SyncErrorCode, SyncRuntimeError
│
└── sync/                       @redemeine/sync
    └── src/
        ├── capabilities/       NodeCapabilities, NodeRole, NodeIdentity, presets
        ├── manifest/           SyncManifest, LaneSelector, delta, lifecycle, rule engine, hierarchy
        ├── store/              ISyncEventStore, ICommandQueue, ICheckpointStore, StoredEvent, EventStatus
        ├── pending/            ReconciliationDispatcher, aggregate rebuilder, pending event factory
        ├── upstream/           UpstreamSyncService, QueueDrain, connection monitoring
        ├── downstream/         DownstreamSyncService, feed envelopes, EventStreamConsumer
        └── health/             (reserved) sync health metrics
```

**Import direction:** `@redemeine/aggregate-runtime` is independent. `@redemeine/sync` is independent. Neither depends on the other at the package level — they share only protocol-level concepts (envelope shapes, aggregate identity).

## Consequences and Trade-offs

### Benefits

- **Topology-agnostic**: same framework deploys at origin, relay, or leaf without code changes
- **Transport-agnostic**: scomp handles all RPC; the framework only defines service contracts
- **Persistence-agnostic**: every store interaction is behind an adapter interface
- **Deterministic processing**: batch processor is sequential, stateless, and produces predictable results
- **Offline-first**: pending events enable immediate local consistency; reconciliation restores global consistency on reconnect
- **Auditability**: superseded events are retained, all decisions emit audit signals

### Trade-offs

- **No built-in persistence**: consumers must implement 8+ adapter interfaces before the framework is usable — higher initial integration cost
- **events_only envelopes rejected in v1**: this limits flexibility for event-sourced systems that want to forward raw events; reserved for future expansion
- **Sequential batch processing**: envelopes within a batch are not parallelized, which may limit throughput for high-volume upstream nodes
- **Manifest complexity**: the rule engine + delta computation + lifecycle signal chain adds conceptual overhead for simple topologies
- **Deep-equal event matching**: the default reconciliation matcher uses structural comparison, which may produce false negatives if upstream produces semantically-equivalent but structurally-different events

### Mitigations

- Adapter contracts are minimal and well-documented — in-memory test implementations typically require <50 lines each
- `EventMatcher` is pluggable — consumers can provide domain-specific matching strategies
- Manifest complexity is only relevant for relay topologies; leaf nodes are manifest-unaware and simpler to configure
