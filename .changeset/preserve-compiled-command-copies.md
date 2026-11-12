---
"@redemeine/aggregate": patch
---

Preserve the existing frozen compiled-command metadata snapshot across shallow spread and Object.assign copies, including plugin-decorated definitions, so metadata-driven consumers retain type/runtime parity. Other metadata carrier contracts are unchanged.
