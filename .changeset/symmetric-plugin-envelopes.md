---
"@redemeine/aggregate": minor
---

Add symmetric command/event envelope descriptors and synchronous preparation recipes to aggregate plugin builders. Built aggregates expose `prepareCommand` and execute command/event preparation during `process`, with detached readonly snapshots (including cross-realm data), reserved-key/collision guards and plan-scoped repeat suppression. Mirage and Demeine bridge host integration ships in their accompanying minor changesets. Envelope-only declarations use `.state(() => ({}))`. Optional structural parsers validate or transform initializer and final recipe output, not incoming envelopes; historical reducer inputs are not automatically extended or validated, and replay never prepares.

Preserve event extension union fields and discriminant/header correlation across attachment and chaining. Possible writers retain canonical unknown headers; guaranteed writers retain their exact header contracts.

Infer possible contributions as independently optional fields with unioned values, without cross-field correlation even for a single possible registration. Preserve exact guaranteed finite-key union branches and required literal keys when composing with open-ended extension indexes; unenumerated index slots conservatively become unknown. This repairs declaration soundness without changing runtime collision policy.
