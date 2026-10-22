---
'@redemeine/aggregate': patch
---

Fix command preparation types to preserve discriminant/payload correlation without promising undeclared raw extras. Reject reserved keys anywhere in command-envelope initializer or parser output unions, and require envelope parsers to accept unknown input. These typing corrections reject unsupported inputs already unsafe at runtime; runtime preparation and parsing behavior are unchanged.

Align builder event-envelope types with post-build attachment: only guaranteed header writers replace canonical unknown headers. Optional descriptors and ordinary plugin arrays cannot promise validated headers, including through chained attachment, while guaranteed union writers retain exact correlated body and header branches. Runtime event processing is unchanged.

Preserve command and event descriptor union alternatives in ordinary arrays instead of intersecting them into never. Track guaranteed and possible contributions separately through builder and attachment chains, so absent descriptors and emptyable arrays cannot constrain a guaranteed writer's overlapping fields. Possible arrays use partial whole branches with optional companion fields to admit disjoint subsets without exponential subset inference; optional discriminants do not prove other field presence. Runtime collision handling and public preparation policy are unchanged.

Account for optional output keys in both possible and guaranteed composition: optional anchor keys include companion writer values, required writers dominate competing optional keys on successful preparation, and two optional writers retain optional union values. Preserve whole output-branch correlation and required own-undefined writes without changing runtime collision semantics.

Keep source-event validation declarations well-formed when bundled into downstream packages, without losing raw registration checks across builder batches.
