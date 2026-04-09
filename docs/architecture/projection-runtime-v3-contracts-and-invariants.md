# Projection Runtime v3 Contracts and Invariants (RT3-01)

Status: **locked for v3 baseline**

This document freezes the v3 contract decisions used by router/worker/store redesign work.
These invariants are binding for downstream RT3 beads unless a new ADR explicitly supersedes them.

## 1) Ingestion model: push-first live path

- Live ingestion is **push-first**.
- Worker ingress contract is defined around:
  - `push(envelope)`
  - `pushMany(envelopes)`
- Both methods return **per-item decision outcomes** (ack/nack), not a single batch-wide status.
- Nack outcomes carry:
  - `retryable: boolean`
  - `reason: string`

## 2) Catchup polling boundary

- Catchup polling remains supported, but **only via an adapter boundary**.
- Catchup polling contract is separate from live push ingress contract.
- No contract may require live runtime components to poll directly for new events.

## 3) Routing fanout keying and deterministic source

- Router output is a fanout envelope keyed by:
  - `projectionName`
  - `targetDocId`
- Canonical lane/shard key source is fixed to:
  - ``${projectionName}:${targetDocId}``
- This source string must be carried in the router fanout envelope contract.

## 4) reverseSubscribe and join-link fanout expectations

- `join` events are routed only when link/subscription resolution identifies target document(s).
- `reverseSubscribe` and dynamic join-link updates are expected to produce deterministic fanout behavior:
  - add/remove link operations must map to predictable routing decisions
  - missing reverse targets are observable via warnings/diagnostics, not silent mutation

## 5) Store write contract and atomicMany result

- Store contracts must support both write forms:
  - full document writes
  - patch writes
- `atomicMany`-style result contract must return:
  - `highestWatermark`
- Forward-compatible extension point is reserved for:
  - `byLaneWatermark?`

## 6) Per-lane watermark status

- Per-lane watermark persistence/reporting is explicitly marked **deferred extension** for v3.
- `byLaneWatermark` stays optional in contract shapes until dedicated implementation bead lands.

## 7) Public handler context surface (projection package)

- Public projection handler context is write-only and limited to:
  - `subscribeTo(...)`
  - `unsubscribeFrom(...)`
- Getter methods such as `getSubscriptions()` / `getUnsubscriptions()` are internal runtime concerns and must not be exposed in public projection contracts.
