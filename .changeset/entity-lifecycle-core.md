---
"@redemeine/aggregate": major
---

Support templated list entities, checked static command declarations and framework-provided isNew context. Replay ordinary entity projectors to materialize missing final list leaves without creating ancestors or mutating command state.

Breaking: reject different entity definitions mounted at the same point and distinct authored command paths that flatten to the same compiled key. Compose commands into one entity definition or reuse the exact definition at that point; mount different entities at distinct target paths. Use distinct authored compiled paths and explicit shared wire names when shared dispatch is desired. Same authored command overrides remain valid.
