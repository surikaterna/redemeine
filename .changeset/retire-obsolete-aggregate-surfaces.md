---
"@redemeine/aggregate": major
"@redemeine/mirage": major
"@redemeine/demeine-interop": major
---

Retire obsolete public execution APIs (redemeine-skpd, bounded surface and event-dispatch slices).

Use `commandMetadata(built, localName).targets` instead of `pure.commandTargets`.
Command creators now expose only declared flat keys, including mounted names;
undeclared nested creator paths no longer fabricate command envelopes or inject IDs.
Use `eventNameOverrides` and `commandNameOverrides` for mount options instead of
`eventOverrides` and `commandOverrides`. Definition-level override fields, raw
command processors/event projectors, and current plugin and host contracts remain.

Remove the public `parseTargetedEventPath` export and all inferred event routing.
Events now match exact compiled wire registrations pairing a projector with its target
chain. Undeclared targeted-looking wires and synthetic unscoped entity-only wires use
`onUnmatchedEvent` or the default warning; invalid targets on known mounted wires throw
before projection. Declared dotted root names stay root-owned, scoped wires beat root
wire collisions, and the last actual scoped assignment wins as a complete pair.
Compiled event target chains snapshot their steps, state paths, and primary-key arrays;
later mutations of public reflection or caller-owned options cannot redirect replay.
The low-level source `applyEvent` / `applyEventToDraft` helpers now take one explicit
`CompiledEventDispatch` map instead of positional projector/override/target tables;
built aggregate `apply(state, event)` and `applyToDraft(draft, event)` are unchanged.
Naming formatters (including the targeted naming preset) remain. Mounted commands and
events now route only by declared leaf primary-key fields (map `key`) and exact
registered ancestor command prefixes plus capitalized primary-key fields. Missing
canonical fields and ambiguous layouts fail; inferred aliases and the private
`__entityPk` payload protocol are retired. Former aliases and authored `__entityPk`
are ordinary business data. Mirage injects only canonical leaf fields and preserves
business arguments. Consumers, including host/bridge handlers, must carry canonical
identities into emitted events; client/server adoption is outside this slice.

Bridge definitions now require an explicit nonempty string `aggregateType` and
reject invalid types before lifecycle inspection. Command-wire inference and the
`unknown` fallback are removed. The obsolete `AggregateBase` option and its named
migration guard are retired; it is not a public option or an implementation hook.
Demeine constructor services and the owned host-adaptation lifecycle remain supported.

Validate every list PK declaration, including behaviorless/composed mounts, at registration
and build capture. Only an absent (`undefined`) declaration defaults to `id`; empty names,
empty lists, duplicates, and invalid JavaScript declaration types reject before execution.
All nonempty field names, including `__proto__`, remain supported as own identity predicates;
empty-string and zero identity values remain valid. Caller arrays remain mutable and built
dispatch/query snapshots stay detached (redemeine-skpd C1/C2).
