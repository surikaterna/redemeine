---
"@redemeine/aggregate": minor
---

Retain nested entity-map declarations in entity package registry types, matching nested lists, so compiler-only tools can discover their declared events. Keep event replacement keys scoped in inferred consumer declarations rather than emitting an unbound generic name.

Export schemaBindings for immutable, JSON-safe schema-ID to actual compiled wire mappings, including collision winners, mounted declaration paths, and supported plugin decorations. Fail closed on ambiguous event schema IDs and unproven direct mixin event ownership without changing runtime dispatch.
