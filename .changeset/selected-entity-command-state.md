---
"@redemeine/aggregate": patch
---

Execute mounted commands against the selected readonly entity instead of the aggregate root. Compile list/map target chains during mounting, validate existing targets before invoking handlers, and give nested command factories their own selectors. Preserve command definitions, contextual emits and intents. Replay registered scoped events through their compiled nested targets using existing identity fields, preserve falsy identifiers, and retain target metadata for surviving commands across repeated mounts.
