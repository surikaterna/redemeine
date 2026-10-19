---
"@redemeine/cli": minor
---

Bound schema provenance by resolution-path depth instead of total syntax-node
count, allowing wide ordinary domain models such as PaymentAttempt to compile.
Add package-level `redemeine.schemas.maxProvenanceDepth` (default 256, integers
1–1024), separate from structural `maxDepth`. Apply it consistently to schema
references, declaration diagnostics, Aggregate/Projection output and registry
alias reconciliation. Preserve cycle termination, authored-schema protections,
and fail-before-write behavior. Graph traversal is iterative rather than growing
the JavaScript call stack with declaration depth.
