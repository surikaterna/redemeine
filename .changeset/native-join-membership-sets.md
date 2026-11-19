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

Add opt-in native projection join membership sets. `.joinRight()` selects candidate targets from typed events; joined handlers receive the deduplicated union with saved members and explicitly attach or detach their current target. Native stores fence even empty membership observations atomically with document writes, source progress and change receipts. Existing singleton generations stay unchanged; set generations require an explicit forward cutover and dedicated Mongo collections.
