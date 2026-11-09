---
'@redemeine/aggregate': patch
---

Export the AggregateDecoration type so inferred aggregates can emit portable declarations from the public package entry point, including plugin-mounted aggregates.

Export the named BuiltAggregateResult build contract so unannotated aggregate exports preserve canonical member provenance in emitted ESM and CJS declarations without changing their fields or runtime behavior.
