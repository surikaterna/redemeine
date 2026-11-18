---
'@redemeine/projection-runtime-core': minor
'@redemeine/projection-worker-core': minor
'@redemeine/projection-transport': minor
'@redemeine/projection-runtime-store-mongodb': minor
'@redemeine/projection-runtime-store-inmemory': minor
---

Enable durable change recording per projection generation in the coordinator and queue manifest. Stores atomically persist ordered, fine-grained JSON Patch transitions and revision receipts; `none` retains at-least-once application semantics. Source turns can pass ordered patch hints and the final document even when history is off. MongoDB plans native revision-guarded writes from one prepared snapshot and uses an acknowledged single-document update for eligible inline turns.
