---
"@redemeine/mirage": major
---

Expose explicitly marked static entity commands on Mirage root list collections with full authored arguments and readonly aggregate dispatch results. Preserve static classification in compiled command metadata and public declarations; reject collection namespace collisions without exposing ordinary, map, or nested commands.

Collection navigation and static call signatures are unchanged by Aggregate's semantic wire naming; use mount `semanticName` aliases when reused definitions should route independently.

Expose explicit static commands as root and selected-list-parent aliases named authored command plus capitalized semantic entity name (for example `registerIdentifier`). Reuse the collection method, preserving complete pack tuples, ancestor-bound shorthand, readonly aggregate results and asynchronous dispatch. No aliases are inferred for ordinary commands, maps or navigation keys; widened semantic names need literal typing for inferred properties.

Breaking: construction now rejects generated parent-alias ambiguity against sibling aliases, parent state/commands, root selectors and reserved protocols, even with empty parents. Use distinct semantic names for reused siblings; retain explicit shared wire overrides when shared winner dispatch is intended. Equal wire names alone remain legal, but do not excuse duplicate generated aliases.
