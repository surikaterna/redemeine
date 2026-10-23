---
"@redemeine/aggregate": patch
---

Execute mounted commands against the selected readonly entity instead of the aggregate root. Compile list/map target chains during mounting, validate existing targets before invoking handlers, and give nested command factories their own selectors. Preserve command definitions, contextual emits and intents. Replay registered scoped events through their compiled nested targets using existing identity fields, preserve falsy identifiers, and retain target metadata for surviving commands across repeated mounts.

Consume the existing `__entityPk` compatibility payload only at the leaf target, so nested commands and replay resolve qualified ancestor identities independently while still rejecting inconsistent leaf fields.

Preserve resolved root event ownership when mounted entities reuse the same JavaScript event key. Keep scoped entity handlers and target chains independent, without changing entity-only last-mounted fallbacks or exact scoped wire collision precedence (GitHub #157).
