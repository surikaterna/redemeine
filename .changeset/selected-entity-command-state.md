---
"@redemeine/aggregate": patch
"@redemeine/mirage": patch
---

Execute mounted commands against the selected readonly entity instead of the aggregate root. Compile list/map target chains during mounting, validate existing targets before invoking handlers, and give nested command factories their own selectors. Preserve command definitions, contextual emits and intents. Replay registered scoped events through their compiled nested targets using existing identity fields, preserve falsy identifiers, and retain target metadata for surviving commands across repeated mounts.

Consume the existing `__entityPk` compatibility payload only at the leaf target, so nested commands and replay resolve qualified ancestor identities independently while still rejecting inconsistent leaf fields.

Preserve resolved root event ownership when mounted entities reuse the same JavaScript event key. Keep scoped entity handlers and target chains independent, without changing entity-only last-mounted fallbacks or exact scoped wire collision precedence (GitHub #157).

Require qualified identity fields for every ancestor, including custom and composite primary keys, so an unqualified leaf field is not compared against an ancestor with the same field name. This intentionally rejects previously accepted unqualified ancestor payloads such as `{ code: parentCode, id: childId }`; use `{ parentsCode: parentCode, id: childId }` instead. Qualified ancestor conflicts still reject, and unqualified leaf fields and leaf-only `__entityPk` remain supported (PR #156, Kenny r4359327745).

Expose detached readonly final command-target provenance by local command name. Mirage uses each winning command's registration to derive identity and packed arguments from the selected record across repeated mounts, preserving the live selection and existing wire aliases while rejecting incompatible or root-winning selected invocations before hooks.

Preserve per-command scoped identity omission and packed prefix lengths across explicit repeated registrations, with latest-wins selection and command replacement. Optional object shorthand retains optionality and business-field checking. Selected shorthand rejects non-object payloads before creators/hooks instead of wrapping primitives in a `value` field; explicit packed scalar arguments and root shorthand remain supported.

Preserve discriminated object payload branches when omitting injected identity fields. Admit explicitly bound earlier selector roles using surviving final command registrations, while retaining role-only command access and rejecting missing, root-winning, or incompatible registrations.
