---
'@redemeine/projection-worker-core': major
'@redemeine/projection-runtime-core': minor
---

Require a separate polled-commit coordinator operation so indexed source catch-up shares source ordering without treating already covered commits as Rabbit redeliveries; restrict migration receipt bypass to explicitly isolated replay coordinators.
