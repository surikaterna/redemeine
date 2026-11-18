---
'@redemeine/projection-runtime-core': minor
'@redemeine/projection-worker-core': minor
'@redemeine/projection-transport': minor
'@redemeine/projection-runtime-store-mongodb': minor
'@redemeine/projection-runtime-store-inmemory': minor
---

Enable durable change recording per projection generation in the coordinator and queue manifest. Stores atomically persist ordered JSON Patch transitions and revision receipts; `none` retains at-least-once application semantics.
