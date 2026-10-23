---
'@redemeine/mirage': patch
---

Treat callable command definitions as shorthand even when they carry a `pack`
property. Scoped Mirage calls now supply the single object payload with selected
identifiers, matching Aggregate's callable-first classification. Non-callable
`{ pack, handler }` definitions retain their packed argument prefixes.
