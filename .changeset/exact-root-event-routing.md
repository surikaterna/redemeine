---
"@redemeine/aggregate": patch
---

Fix targeted event routing so exact root event handlers run against the aggregate
root before entity path traversal. Preserve mounted scoped handler precedence and
legacy targeted event routing to core handlers.
