# hwj Epic: Abandoned Implementation Work

## Context

PR #27 (`feature/redemeine-hwj`) was a cross-cutting epic covering production hardening, observability, and infrastructure design. After PR #41 (`feature/mirage-api-cleanup`) merged — which refactored the mirage root namespace, projection module structure, and aggregate builder generics — several implementation commits from #27 became incompatible with main.

A selective cherry-pick was performed on 2026-04-29 to preserve all safe work (architecture docs + `@redemeine/otel` package). This document records what was left behind and what needs reimplementation.

## What Was Preserved (cherry-picked into `feature/hwj-architecture-docs`)

- 17 architecture documents (CI hardening waves 1-3, telemetry SPI, transactional outbox RFC, CDC relay semantics, projection-over-MQ, aggregate intent contracts, inspection hooks contract, etc.)
- `@redemeine/otel` package — no-op-safe telemetry facade with context propagation, adapter registry, semantic conventions, and tests
- Observability audit verification evidence

## What Was Abandoned (needs reimplementation)

### 1. Transactional Outbox Persistence Seam (`packages/mirage/src/Depot.ts`)
- **Original commit**: `d0bc8f1`
- **What it did**: Added outbox capability negotiation in Depot so append+enqueue can be atomically persisted via `saveEventsWithOutbox`, with `compatibility_inline` mode for legacy stores.
- **Why it conflicts**: PR #41 restructured Depot's internal API surface, inheritance model, and token passing. The outbox seam needs to be re-wired against the new `BuiltAggregate` generics and `.mirror()` builder pattern.
- **Design spec preserved**: `docs/architecture/transactional-outbox-rfc.md`

### 2. Outbox Dispatcher Worker (`packages/mirage/src/outboxDispatcher.ts`)
- **Original commit**: `5fc84be`
- **What it did**: Added a worker lifecycle for dispatching queued outbox entries to downstream consumers (CDC relay pattern).
- **Why it conflicts**: Depends on the outbox persistence seam above, plus references createMirage internals that were restructured.
- **Design spec preserved**: `docs/architecture/transactional-outbox-rfc.md`, `docs/architecture/cdc-relay-mq-inbox-durability-semantics.md`

### 3. Canonical Inspection Hook Envelope Emission (`packages/kernel/src/inspection.ts` + wiring)
- **Original commit**: `85e0367`
- **What it did**: Added `kernel/src/inspection.ts` with canonical inspection hook types, and wired emission into mirage (createMirage.ts), projection (ProjectionDaemon.ts), and saga-runtime (sagaExecutionBridge.ts).
- **Why it conflicts**: 
  - `ProjectionDaemon.ts` and its test were **deleted** on main (projection was migrated into `createProjection.ts` with a new architecture)
  - `createMirage.ts` was heavily refactored with new generics and token inheritance
  - `sagaExecutionBridge.ts` had minor changes but the import structure shifted
- **Design spec preserved**: `docs/architecture/inspection-hooks-contract-v1.md`

### 4. OTel Integration Across Runtime Boundaries (`packages/otel/test/otel-bridge.integration.test.ts` + wiring)
- **Original commit**: `5610ae8`
- **What it did**: Wired `@redemeine/otel` fallback-safe context propagation into mirage, saga-runtime, and projection inspection points. Added end-to-end trace continuity tests for command→event→outbox→side-effect→projection correlation.
- **Why it conflicts**: Depends on inspection hooks (#3 above) and references pre-refactor mirage/projection internals.
- **Design spec preserved**: `docs/architecture/otel-implementation-design.md`, `docs/architecture/telemetry-spi-design.md`

### 5. Audit Evidence Tests (outbox reliability, lease recovery)
- **Original commits**: `c834bad`, `bb42ead`
- **What they did**: Integration tests proving outbox reliability (guaranteed delivery) and lease recovery (stale reclaim fencing) for `redemeine-sy8`.
- **Why they conflict**: Test fixtures reference the old `referenceAdapters.ts` shape which was changed.
- **Audit spec preserved**: `docs/architecture/redemeine-sy8-auditor-reliability-verification-evidence.md` (was in the original PR but not cherry-picked since it references non-existent test paths)

## Reimplementation Guidance

When reimplementing these features against the post-PR-#41 codebase:

1. **Start with inspection hooks** — The kernel inspection contract (`inspection-hooks-contract-v1.md`) is still valid. Wire emission into:
   - `createMirage.ts` (new token-inherited builder)
   - `createProjection.ts` (replaces deleted `ProjectionDaemon.ts`)
   - `sagaExecutionBridge.ts` (minor adaptation)

2. **Then outbox** — The transactional outbox RFC is still valid. Adapt the Depot seam to use the new `BuiltAggregate` type surface and `.mirror()` pattern.

3. **Then OTel wiring** — The `@redemeine/otel` package is already in place. Just add the integration bridge tests and wire context propagation through the new inspection hook emission points.

4. **Finally audit tests** — Re-create reliability evidence against the new adapter shapes.

## Source Reference

- Original PR: #27 (`feature/redemeine-hwj`)
- Conflicting PR: #41 (`feature/mirage-api-cleanup`) — merged 2026-04-29
- Cherry-pick PR: (this branch, `feature/hwj-architecture-docs`)
