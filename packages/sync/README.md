# @redemeine/sync

Edge sync runtime contracts — a capability-driven, transport-agnostic framework for optimistic command processing and manifest-driven downstream replication across disconnected nodes. Part of the [Edge Sync Runtime epic (redemeine-4gs)](../../docs/architecture/edge-sync-runtime.md).

## Purpose

This package defines the contracts, types, and orchestration logic for synchronizing data between nodes in a disconnected topology. It does not contain concrete persistence or transport implementations — those are provided by consumers through adapter contracts.

The framework supports any topology: `origin ↔ relay ↔ leaf`, `origin ↔ leaf` (direct), or deeper relay chains. The same protocol applies regardless of topology depth.

## Architecture Overview

```
                ┌──────────────┐
                │    Origin    │  Authoritative source of truth
                │  (upstream)  │  Processes commands, emits events
                └──────┬───────┘
                       │
            ┌──────────┴──────────┐
            │                     │
     ┌──────┴───────┐     ┌──────┴───────┐
     │    Relay      │     │    Leaf      │  Edge consumer
     │ (up + down)   │     │  (upstream)  │  Optimistic processing
     └──────┬───────┘     └─────────────┘
            │
     ┌──────┴───────┐
     │    Leaf       │
     │  (upstream)   │
     └──────────────┘

     ─── commands flow UP ───▶
     ◀─── events flow DOWN ──
```

**Commands flow upstream** (leaf → relay → origin). Edge nodes process commands optimistically, producing pending events. When the authoritative response arrives from upstream, pending events are either confirmed or superseded.

**Authoritative data flows downstream** (origin → relay → leaf) across four lanes: event streams, projections, master data, and configuration. Upstream nodes use a **Sync Manifest** to control what each downstream node receives — downstream nodes are **manifest-unaware**.

## Module Overview

### `capabilities/` — Node Capabilities and Roles

Declares what a node can do. The runtime branches behavior based on capability flags rather than hard-coded roles.

| Export | Description |
|---|---|
| `NodeCapabilities` | Boolean flags: `durableEventStore`, `upstreamSync`, `downstreamRelay`, `optimisticProcessing`, `scheduler`, `projectionRuntime` |
| `NodeRole` | Derived convenience role: `'origin'` \| `'relay'` \| `'leaf'` |
| `NodeIdentity` | Combines `nodeId`, `tenant`, capabilities, and derived role |
| `resolveRole(caps)` | Infers role from capabilities |
| `createNodeIdentity(...)` | Factory for `NodeIdentity` |
| `createOriginCapabilities()` | Preset: authoritative node |
| `createRelayCapabilities()` | Preset: relay (upstream + downstream) |
| `createLeafCapabilities()` | Preset: edge consumer |

### `manifest/` — Sync Manifest and Rule Engine

The Sync Manifest is an **upstream-internal** control document that describes what data a downstream node should receive. It is a live reactive projection: continuously recomputed from domain state, versioned monotonically, and content-hashed for fast equality checks. Downstream nodes never see the manifest.

| Export | Description |
|---|---|
| `SyncLane` | `'events'` \| `'projections'` \| `'masterData'` \| `'configuration'` |
| `LaneSelector` | Discriminated union of per-lane selectors (`EventStreamSelector`, `ProjectionSelector`, `MasterDataSelector`, `ConfigurationSelector`) |
| `SelectorFilter` | Opaque filter expression evaluated by consumer-provided rule engine |
| `SyncManifest` | The manifest document: `nodeId`, `version`, `etag`, `selectors`, `updatedAt` |
| `ManifestByLane` | Convenience grouping of selectors by lane |
| `ManifestDelta` | Diff between two manifest versions: `added`, `removed`, `changed` selectors |
| `computeManifestDelta(prev, curr)` | Pure function to compute deltas |
| `ManifestLifecycleSignal` | `stream_added` \| `stream_removed` signals derived from deltas |
| `deriveLifecycleSignals(delta)` | Converts deltas to lifecycle signals |
| `IManifestRuleEngine` | Pluggable adapter: evaluates domain rules to produce selectors for a node |
| `IManifestStore` | Pluggable adapter: manifest persistence (`getManifest`, `saveManifest`, `getManifestVersion`) |
| `deriveChildManifest(parent, childId, filter)` | Derives sub-manifests for relay topologies |

### `store/` — Event Store, Command Queue, Checkpoint Store

Adapter contracts for sync-aware persistence. No concrete implementations.

| Export | Description |
|---|---|
| `EventStatus` | `'pending'` \| `'confirmed'` \| `'superseded'` |
| `StoredEvent` | Persisted event record with lifecycle status, command correlation, versioning |
| `AggregateSnapshot` | Point-in-time aggregate state for hydration acceleration |
| `ISyncEventStore` | Full event store contract: `saveEvents`, `confirmEvents`, `supersedeEvents`, `readStream`, `loadSnapshot`, `importSnapshot` |
| `ICommandQueue` | Durable FIFO queue: `enqueue`, `peekBatch`, `ackBatch`, `depth` — peek/ack pattern for at-least-once delivery |
| `ICheckpointStore` | Per-lane position tracking: `getCheckpoint`, `saveCheckpoint` |

### `pending/` — Pending Event Lifecycle and Reconciliation

Orchestrates the lifecycle of optimistically-produced events: pending → confirmed or pending → superseded.

| Export | Description |
|---|---|
| `ReconciliationResult` | Discriminated union of outcomes: `confirmed`, `superseded`, `new`, `already_confirmed`, `error` |
| `ReconciliationDispatcher` | Orchestrates reconciliation of authoritative events against local pending events |
| `EventMatcher` | Strategy interface for comparing pending vs. authoritative events |
| `defaultEventMatcher()` | Default: match on `type` + deep-equal `payload` |
| `rebuildFromConfirmed(store, streamId, applyEvent)` | Rebuilds aggregate state from confirmed-only events after supersession |
| `createPendingEvents(produced, now?)` | Factory: converts locally-produced events to `NewEvent` records for `pending` storage |

### `upstream/` — Command Submission Pipeline

Types and orchestration for submitting commands from a downstream node to its upstream node via scomp.

| Export | Description |
|---|---|
| `UpstreamCommandEnvelope` | A single command for upstream submission |
| `UpstreamBatchRequest` | Batch of command envelopes with `batchId`, `nodeId`, `sentAt` |
| `UpstreamBatchResult` | Per-command results: `accepted`, `rejected`, `duplicate` |
| `UpstreamSyncService` | scomp service contract: `submitCommands(batch) → result` |
| `IConnectionMonitor` | Adapter: monitors upstream connectivity (`online`, `offline`, `reconnecting`) |
| `QueueDrain` | Orchestrator: drains the local command queue by submitting batches upstream |
| `createQueueDrain(options)` | Factory: creates a `QueueDrain` that auto-drains on reconnect |

### `downstream/` — Feed Contracts and Envelope Types

Types and orchestration for receiving authoritative data from upstream via scomp feeds.

| Export | Description |
|---|---|
| `EventStreamEnvelope` | Discriminated union: `snapshot`, `events`, `stream_added`, `stream_removed` |
| `ProjectionEnvelope` | Discriminated union: `snapshot`, `delta`, `removed` |
| `ConfigEnvelope` | Discriminated union: `snapshot`, `delta` |
| `DownstreamSyncService` | scomp feed contract: `eventStream()`, `projectionStream()`, `masterDataStream()`, `configStream()` — each returns `AsyncIterable<Envelope>` |
| `EventStreamConsumer` | Consumes event stream feeds, reconciles with pending, persists checkpoints |
| `createEventStreamConsumer(options)` | Factory: creates an `EventStreamConsumer` |

### `health/` — Sync Health and Observability

Reserved for sync health metrics and alerting contracts. Currently a placeholder for future implementation.

## Key Concepts

### Pending / Confirmed / Superseded Events

Edge nodes process commands **optimistically** — they execute the command handler locally and store the resulting events with `pending` status. These events are immediately visible to local projections and queries.

When the authoritative response arrives from upstream:

- **Match** → pending events transition to `confirmed`
- **Divergence** → pending events are marked `superseded` and authoritative events are inserted as `confirmed` replacements
- **No pending match** → authoritative events are inserted directly as `confirmed` (new)
- **Already confirmed** → idempotent no-op

Superseded events are retained for audit trail purposes.

### Command-Up, Events-Down

The framework enforces a strict directional flow:

- **Commands** are the only thing that flows **upstream** (via scomp `request`)
- **Events, projections, master data, and configuration** flow **downstream** (via scomp `feed`)

This ensures a single source of truth: the upstream authority is always the definitive event producer.

### Manifest-Driven, Downstream-Unaware

The **Sync Manifest** is an upstream-internal document. Upstream nodes use it to decide what data enters each downstream feed. Downstream nodes simply consume whatever arrives on the feed — they never request specific data or know about the manifest's existence.

This design means:

- Upstream can change what a node receives without the node's knowledge
- Filter changes propagate automatically through manifest recomputation
- Relay nodes derive sub-manifests for their children from their own manifest

## Non-Goals

This package intentionally does **not** provide:

- **Concrete persistence** — no database, file system, or in-memory store implementations
- **Concrete transport** — no HTTP, WebSocket, or gRPC; transport is via scomp (`@scomp/*`)
- **Domain-specific language** — no business terms; the framework uses generic topology terms (origin, relay, leaf, upstream, downstream)
- **Projection runtime** — projection building is a separate concern
- **Scheduling** — deferred work scheduling is a separate concern

## Quick Start

```typescript
import {
  createNodeIdentity,
  createLeafCapabilities,
  createQueueDrain,
  type QueueDrainOptions,
} from '@redemeine/sync';

// 1. Create a node identity
const identity = createNodeIdentity(
  'node-edge-001',
  'tenant-a',
  createLeafCapabilities(),
);
// identity.role === 'leaf'
// identity.capabilities.upstreamSync === true
// identity.capabilities.optimisticProcessing === true

// 2. Wire up the command submission pipeline
const drainOptions: QueueDrainOptions = {
  queue: myCommandQueue,                 // ICommandQueue
  syncService: myUpstreamSyncService,    // UpstreamSyncService
  connectionMonitor: myConnectionMonitor, // IConnectionMonitor
  nodeId: identity.nodeId,
  batchSize: 25,
};

const drain = createQueueDrain(drainOptions);
drain.start(); // auto-drains when connection goes online
```

## Related Packages

- [`@redemeine/aggregate-runtime`](../aggregate-runtime/README.md) — upstream-side batch processor for sync envelopes
