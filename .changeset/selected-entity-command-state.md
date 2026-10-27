---
"@redemeine/aggregate": minor
"@redemeine/mirage": patch
---

Execute mounted commands against the selected readonly entity instead of the aggregate root. Compile list/map target chains during mounting, validate existing targets before invoking handlers, and give nested command factories their own selectors. Preserve command definitions, contextual emits and intents. Replay registered scoped events through their compiled nested targets using existing identity fields, preserve falsy identifiers, and retain target metadata for surviving commands across repeated mounts.

Resolve nested commands and replay using declared canonical leaf primary-key fields and exact qualified ancestor identities.

Preserve resolved root event ownership when mounted entities reuse the same JavaScript event key. Keep scoped entity handlers and target chains independent, without changing entity-only last-mounted fallbacks or exact scoped wire collision precedence (GitHub #157).

Require qualified identity fields for every ancestor, including custom and composite primary keys, so an unqualified leaf field is not compared against an ancestor with the same field name. This intentionally rejects previously accepted unqualified ancestor payloads such as `{ code: parentCode, id: childId }`; use `{ parentsCode: parentCode, id: childId }` instead. Ancestor qualification uses only the exact registered prefix (PR #156, Kenny r4359327745).

Expose detached readonly final command-target provenance by local command name. Mirage uses each winning command's registration to derive canonical identity and packed arguments from the selected record across repeated mounts, preserving the live selection while rejecting incompatible or root-winning selected invocations before hooks.

Add the standalone `commandMetadata(aggregate, commandKey)` query for compiled local registrations and final wire winners. Capture creators, dispatch and detached readonly target metadata from one registration snapshot, retained through supported plugin decoration. Mirage rejects wire-shadowed selected commands before packing or hooks, including collisions between different local names. Native concrete wire commands retain last-registration-wins dispatch.

Preserve per-command scoped identity omission and packed prefix lengths across explicit repeated registrations, with latest-wins selection and command replacement. Optional object shorthand retains optionality and business-field checking. Selected shorthand rejects non-object payloads before creators/hooks instead of wrapping primitives in a `value` field; explicit packed scalar arguments and root shorthand remain supported.

Preserve discriminated object payload branches when omitting injected identity fields. Admit explicitly bound earlier selector roles using surviving final command registrations, while retaining role-only command access and rejecting missing, root-winning, or incompatible registrations.
