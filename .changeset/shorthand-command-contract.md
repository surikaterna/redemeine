---
'@redemeine/aggregate': patch
---

Align shorthand command declarations with the existing single-payload runtime
contract across Aggregate, Mixin, and Entity builders. Reject multiple payload
slots (including an optional second slot) and unbounded rest parameters; use the
existing `{ pack, handler }` form for multi-argument public APIs. Correct optional
single-payload command values to `P | undefined` while preserving caller arity,
required payloads, and no-payload `void` semantics.

This is a patch type-safety correction, following the existing unsupported-input
typing-fix convention: previously accepted multi-argument shorthand programs
already dropped arguments at runtime. No valid runtime behavior or packing
policy changes. Broad shorthand annotations that erase safe arity must retain
concrete signatures instead. No manifest versions are changed by this Changeset.

Update the domain example's multi-argument identifier command to the supported
`{ pack, handler }` form and exercise its emitted event and projected identifier.
