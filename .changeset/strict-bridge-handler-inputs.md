---
'@redemeine/demeine-interop': patch
---

Check bridge and authored-subclass constructor service inputs contravariantly. Reject command handlers, event handlers, and sinks that require state the aggregate does not provide, while preserving exact-state services, supported broader services, and the legacy object-state command-handler overload. Runtime behavior is unchanged; previously accepted unsupported handlers may now produce type errors.
