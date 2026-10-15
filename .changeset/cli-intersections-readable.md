---
"@redemeine/cli": major
---

Preserve supported TypeScript intersections in generated Zod schemas instead of
falling back to z.any(). Resolve structural object properties together, preserving
overlapping constraints and requiredness; use intersections for supported array,
record and supplied-schema combinations. Unsupported intersection shapes now
report an error before output files are written.

Generate consistently formatted source with safe readable keys, deterministic
sections and schema ordering, source-relative provenance, concise source JSDoc,
and source comments. Existing map/export names and void payload semantics remain.

Default schema compilation to zod-first, configured per owning package through
redemeine.schemas.mode and redemeine.schemas.maxDepth (default 60, range 1–256).
Types-only projects must explicitly select types-first. Both modes prefer existing
importable Zod schemas, including recoverable primitive aliases, instead of
regenerating them. Missing schemas in zod-first and private/unresolvable exports
fail before writing output. Existing runtime builder signatures are unchanged.

Support structural readonly arrays/tuples and preserve unknown as z.unknown().
Reject unresolved types, unsupported shapes, recursion and depth exhaustion rather
than silently widening to z.any(). Require strictNullChecks for structural fidelity.
Raw compiler-only JSON is types-first only and refuses recognized authored schema
references; use linked Zod/registry modules and explicit z.toJSONSchema evaluation
to preserve those schemas. No application source is executed during extraction,
and no handwritten application validator is replaced automatically.
