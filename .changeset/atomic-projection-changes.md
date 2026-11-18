---
'@redemeine/projection': minor
'@redemeine/projection-runtime-core': minor
'@redemeine/projection-worker-core': minor
'@redemeine/projection-runtime-store-mongodb': minor
'@redemeine/projection-runtime-store-inmemory': minor
---

Opt commit-native projections into durable change records. Each successful application atomically records ordered per-event JSON Patch transitions and target revisions, or an empty receipt if no targets are handled. Reliable strategies verify the exact turn receipt on replay; `none` retains at-least-once application semantics. Both stores reject non-portable JSON and receipt metadata before writing.
