---
"@redemeine/aggregate": minor
"@redemeine/demeine-interop": patch
"@redemeine/mirage": patch
---

Let eventEnvelope output own typed headers, using its existing initializer/parser/recipe API in Aggregate, bridge and Mirage. Replace the unreleased boolean propagation flag with an explicit plugin-owned selection/validation policy. One writer may replace raw event headers; a second writer throws without implicit merging. Required header properties (whose value may be undefined) preserve sound prepared types, and installed data is detached. Callbacks retain registration order; there is no header prepass or universal copy default. An output with own undefined headers now creates that property even when the input omitted it. Command headers remain reserved in command extensions; metadata and replay are unchanged.
