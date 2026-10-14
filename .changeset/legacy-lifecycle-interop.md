---
"@redemeine/demeine-interop": minor
"@redemeine/kernel": minor
"@redemeine/aggregate": minor
"@redemeine/mirage": major
---

Move the legacy bridge out of Mirage into the new demeine-interop package. The
replacement API requires the application's Aggregate base and returns a constructor,
preserving its sink, dispatchers, queue, replay and reserved deletion lifecycle.
Mirage no longer exports the old callable bridge. Kernel, aggregate and interop now
provide independent CommonJS and ESM entry points with matching declarations.
