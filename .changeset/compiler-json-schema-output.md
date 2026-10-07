---
"@redemeine/cli": minor
---

Add compiler-only JSON Schema output to aggregate and projection extract-schemas,
with draft-7 and draft-2020-12 targets. Keep Zod as the unchanged default. JSON
conversion resolves structural data intersections without executing application
or schema modules, diagnoses unsupported/unresolved types before output writes,
and documents explicit any/unknown and void metadata semantics. CLI publication
remains held; this also supports separately supplied developer artifacts.
