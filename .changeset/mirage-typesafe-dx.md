---
"@redemeine/mirage": major
"@redemeine/aggregate": minor
"@redemeine/testing": patch
---

Make Mirage read-side state and command results readonly and isolate supplied
initial states/snapshots. Entity-list iteration and array callbacks return scoped
proxies; scoped commands return readonly entity state. Remove unsupported map-root
commands and require explicit keys. Missing direct entity selections throw.

Resolve bound selector entities by declared role/mount instead of key shape;
ambiguous/reused roles require explicit mount selection. Plain selector data stays
readonly data: use bindContext for scoped commands. Selector utilities are captured
by the Aggregate selector factory rather than inferred from function arity.

Preserve selector/state/command inference in Depot and check runtime builder
ownership on save. Raw dispatch accepts a command envelope and retains the state
return type. Known namespace collisions and protocol names refuse construction.
MirageCoreSymbol exposes readonly diagnostics, not a mutable implementation.

Add mandatory source and built-declaration contract checks, including negative
and accidental-any assertions, and include Mirage in code-principles enforcement.
Event-count versioning and documented partial-failure semantics remain unchanged;
dispatch/save concurrency and production data migration are not implemented here.
The test-depot adapter now drains events through public Mirage helpers instead
of mutating its private core through a symbol.
