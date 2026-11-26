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

Add opt-in native projection join membership sets. `.joinRight()` selects candidate targets from typed events; joined handlers receive the deduplicated union with saved members and explicitly attach or detach their current target. Registration rejects selector maps without set-mode opt-in. Native stores fence even empty membership observations atomically with document writes, source progress and change receipts. Existing singleton generations stay unchanged; set generations require an explicit forward cutover and dedicated Mongo collections.

After explicit `.deduplication(...)`, `.build()` infers a commit-native definition through subsequent fluent calls; `.buildCommitDefinition()` remains available. MongoDB confirms an unknown set-turn outcome only from its durable receipt or an attempt-specific progress witness with matching document and membership writes.

Source-order ports now require an authoritative, versioned dispatch binding proof before admitting coverage. Set-mode writes reject malformed Unicode identifiers, and deterministic persisted membership validation failures are terminal.
