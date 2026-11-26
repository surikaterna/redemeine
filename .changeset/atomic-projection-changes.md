---
'@redemeine/projection': minor
'@redemeine/projection-runtime-core': minor
'@redemeine/projection-worker-core': minor
'@redemeine/projection-transport': minor
'@redemeine/projection-runtime-store-mongodb': minor
'@redemeine/projection-runtime-store-inmemory': minor
'@redemeine/aggregate': patch
'@redemeine/saga': patch
'@redemeine/testing': patch
---

Enable durable change recording per projection generation in the coordinator and queue manifest. Stores atomically persist ordered, fine-grained JSON Patch transitions and revision receipts; `none` retains at-least-once application semantics. Source turns can pass ordered patch hints and the final document even when history is off. MongoDB plans native revision-guarded writes from one prepared snapshot and uses an acknowledged single-document update for eligible inline turns.

Commit-native `afterEach` hooks run synchronously on the same Immer draft as the handler; their effects are finalized and captured together.

Runtime state diagnostics are independently opt-in. The native Mongo path uses genuine same-store captures without replay or defensive whole-state freezing; trusted handlers must edit only the synchronous draft and must not retain or mutate state aliases. Direct untrusted requests retain verification or fall back to full writes.

Pin Immer 11.2.10 across packages sharing draft APIs. Its finalizer avoids revisiting untouched array items in the Mongo draft-only path when a recipe reads one item and edits another.

Reject empty document targets, staged link identifiers, and recorded transition event identifiers before writing the recorded turn.
