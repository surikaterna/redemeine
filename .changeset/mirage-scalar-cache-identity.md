---
"@redemeine/mirage": patch
---

Normalize numeric and bigint identity components to their exact string forms in Mirage's internal entity cache keys. Match Aggregate scalar identity equality without bigint serialization errors or precision loss, while preserving composite field boundaries, version invalidation, and original state, command and event values.
