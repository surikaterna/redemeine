---
'@redemeine/projection-runtime-core': major
'@redemeine/projection-worker-core': major
'@redemeine/projection-runtime-store-mongodb': patch
'@redemeine/projection-runtime-store-inmemory': patch
---

Require explicit per-source accepted-baseline admission metadata for commit-native dispatch, and compare legacy document state and checkpoint before the first transactional v2 write. The source order port now requires an immutable cutover scope and anchor; old implementations must provide them before using this coordinator.
