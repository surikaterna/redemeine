---
"@redemeine/cli": patch
---

Keep distinct compiler payload types and generated/imported schema bindings independent, and reject strict-mode restricted scaffold names before writing files.

Do not memoize depth-truncated alias conversions or their enclosing aliases as
complete schemas. Later direct payload conversions retain their validation
regardless of traversal order; the existing bounded-depth fallback remains.
