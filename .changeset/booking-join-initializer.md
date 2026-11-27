---
'@redemeine/projection': minor
'@redemeine/projection-runtime-core': minor
'@redemeine/projection-runtime-store-inmemory': minor
'@redemeine/projection-runtime-store-mongodb': minor
'@redemeine/projection-worker-core': minor
'@redemeine/projection-transport': minor
'@redemeine/projection-runtime': patch
'@redemeine/testing': patch
---

Initialize an explicitly attached native projection join from either a typed aggregate snapshot or a named projection document. Keep live aggregate events, ordinary forward-only subscriptions, and membership controls unchanged. Deployment-bound readers choose exact inclusive source-commit proof or explicit unknown coverage; both native stores persist initialized membership provenance atomically with the target, progress, and configured change history.

Prepared native turns reuse a fenced read set across seed waits, and recorded turns recover exact durable receipts after a seed provider failure. New Mongo receipts with seed provenance intern repeated descriptors on disk without changing public ordered transitions. Upgrade raw readers before using the new encoding; forward-only cutover and seed reads do not bridge pre-activation events.
