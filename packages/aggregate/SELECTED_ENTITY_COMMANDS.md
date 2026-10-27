# Mounted command state

Root commands receive aggregate readonly state. Commands registered through an entity
list or map receive only the selected entity, using the same readonly command view
(including nested objects, Dates, Maps and Sets). Event projectors still receive drafts.

Mount registration compiles the target chain from actual state paths, collection kinds
and declared list primary keys. Lists default to `id`; custom single and composite PKs
use only their declared leaf fields. Maps use the leaf field `key` for an own entry.
Each ancestor uses exactly its registered `commandPrefix` plus the capitalized PK field
(map `Key`), without singularization or camel/snake alternatives. The prefix is the exact
mount registration name, not a path inferred from the wire name or state tree.
Former aliases, synthetic custom-PK `id`, and `__entityPk` have no routing meaning;
authored fields with those names remain ordinary business data and are never stripped.
String-equivalent numeric identifiers retain matching semantics without payload coercion.

Nested commands require distinct ancestor identity, for example
`{ parentsId: 'p2', id: 'child', qty: 3 }`. Unqualified `id`/`key` refer to the leaf;
ambiguous compiled layouts (including duplicate declared PK fields) are rejected at build.
For example `{ parentsCode: 'p', code: 'c' }` selects a custom-PK child, while
`{ parentsCode: 'p', childrenCode: 'c' }` does not. No new wire identity format is introduced.
Missing/incomplete/conflicting identity, duplicate matches, absent containers and missing
entities throw `Invalid mounted command target` before handler execution. There is no
root fallback, insertion or default entity creation. Register entities from root/parent
commands instead.

Selectors called with handler state see the selected entity. Nested factories receive
their own selector context, not their parent's selectors. Contextual event names and
command intents are unchanged. Handlers still explicitly author event identity fields;
command selection does not inject routing fields into emitted payloads.

Registered scoped projectors use compiled mount chains and the same identity resolver
on replay through both `apply` and `applyToDraft`, including nested list/map mounts.
Existing qualified ancestor fields must be preserved in emitted payloads; wire names
and payloads are not rewritten. Numeric zero and empty-string identities remain valid.
Repeated mounts retain each surviving command's registration target; a later colliding
command replaces both handler and target. Explicit root override routing retains its
existing precedence (an exact scoped registration wins a wire collision).

Internally, a weak side table on each definition-map object retains the winning target
at the exact command/projector assignment. Nested flattening reads that source map's
provenance; root command wire resolution copies handler and target in the same pass.
This is not keyed by handler identity (functions may be reused), and never reconstructs
winners from grouped mount iteration order. No wire fields are added.
Flattened event definition maps additionally retain actual reassignment order so
colliding scoped wires do not use a key's original insertion position as precedence.

Event dispatch matches only exact wire types compiled from declared root/mixin events
and mounted registrations. Each entry owns its projector and target chain together.
Unknown wires, including undeclared targeted-looking names, use `onUnmatchedEvent` or
the default warning without traversal or mutation. Known mounted wires with invalid
identity throw before projection, never falling back to root. Dots in root wire names
(including names produced by `namingStrategies.targeted`) do not imply a state path.
Exact scoped registrations win root collisions; repeated scoped wires use the last
actual registration's projector and target. Entity-only `pure.eventProjectors` reflection
keys do not declare unscoped root wires. The public `parseTargetedEventPath` formatter
companion has been removed; no event name is parsed for routing.
Original packed command definitions are captured as owned descriptor copies for creators
and introspection.

### Querying compiled command registrations

Import `commandMetadata` (and optionally the `CommandMetadata` type) from
`@redemeine/aggregate`. Call `commandMetadata(built, 'itemsSet')` with the actual
built definition and a **local command key**, not a wire name or Mirage proxy path.
It returns `undefined` for unknown keys. The readonly result contains `localName`,
`wireType`, `winnerLocalName`, `isWireWinner`, and deeply readonly structural `targets`.
Root commands have an empty target chain. No handler, packer, or entity object is exposed.

Different local keys can resolve to one wire type, including explicit overrides and
default camel/snake naming collisions. Native concrete wire dispatch remains last-wins.
Selected Mirage calls reject a shadowed local key before packing, hooks, or dispatch,
even when both registrations target the same path and primary key. The former
`pure.commandTargets` public view has been removed; use this standalone query instead.

Each build captures command-map entries, descriptor `pack`/`handler`/`meta` fields,
resolved wire names and detached structural targets together. Owned maps/descriptors
are readonly; caller-owned descriptors, functions, PK arrays and hooks are not frozen.
Later registration-field edits affect later builds, not an existing build. Captured packers
retain their original function identity in `pure.commandProcessors` and run internally
with the original descriptor receiver, preserving class private brands and identity
(including WeakMap keys). Receiver state remains live, just like closed-over business
data: changing `this.field` can change packed payloads, even though replacing `pack`
does not replace the captured function. The readonly descriptor's captured `meta` field
does not freeze or replace the receiver's own `meta`. This boundary preserves supported
method semantics without cloning arbitrary class state or mutating caller objects; it is
not a deep business-data snapshot or a replacement for pure packers. Handlers retain
their existing unbound invocation semantics. The metadata query exposes no receiver.
An internal non-enumerable association retains the receiver across supported recompilation
and Aggregate ESM/CJS composition; arbitrary descriptor spreads do not retain it.
Hook replacement remains supported. Replacing a built definition's runtime methods or
definition views is not a command-registration update API.

Supported `.withPlugins()` decoration explicitly retains the compiled association;
inheritance, mixins and repeated builds compile their own final registrations. An internal
non-enumerable symbol carrier supports Aggregate ESM/CJS definitions with Mirage ESM.
Arbitrary object spreads/clones do not preserve built-definition identity for this query.

### Selected Mirage command forms

For a mounted entity with `id` as its primary key, an authored shorthand handler
`set(state, payload: { id: string; qty: number })` is called as
`live.items(id).set({ qty: 2 })`. A packed command whose pack function accepts
`(id, qty)` is called as `live.items(id).setQuantity(2)`. Both handlers receive
the selected readonly entity state. Flat command creators retain their full
identity arguments. Selection injects composite keys in mount primary-key order;
map selection injects its key. Caller identity conflicting with selection is rejected.
Only canonical leaf fields are injected or omitted from scoped argument types; former
alias fields declared by a handler are business inputs with their declared requiredness.
Packed output must carry every canonical field and cannot retarget the selected record;
validation occurs before hooks. Selection never generates a private payload marker.

### Retirement inventory and consumer impact

Current contracts retained: exact compiled event dispatch and detached snapshots,
`commandMetadata` winner guards, per-command PK selection, scalar/composite selectors,
authored pack arguments, host class normalization, root-owned explicit-identifier events,
and string-normalized cache keys with unchanged payload values. The retired identity
surface is inferred alias routing, generated custom-PK `id`, and private payload markers.
Bridge host lifecycle behavior is preserved: flat host commands use the same canonical
payloads as native creators. This major requires an explicit nonempty `aggregateType`;
the bridge no longer infers it from command wires. Handler authors must preserve
canonical ancestor/leaf fields in events.

Every list mount validates its PK declaration at registration and again at build capture,
including behaviorless and composed mounts. Only `undefined` defaults to `id`; explicit
declarations require nonempty unique field names. All nonempty names (including
`__proto__`, `constructor`, and `toString`) are supported. Empty-string and zero identity
values remain valid. Caller PK arrays are not frozen; compiled dispatch and readonly
command metadata retain detached snapshots after build.
Existing client/server readers and downstream Lynx adoption are separate migrations;
they are not updated or certified by this greenfield breaking change. Bridge dependency
version propagation is left to the release workflow, not a manual version edit.
# Selected parent exposure

Selected Mirage parents expose their direct mounted commands, not flattened
descendant commands: a parent selection does not supply child identities. This
applies equally to list/map selections and bound selector roles, including earlier
roles on a repeated mount. Nested data remains readonly. Flat aggregate command
creators (for example `commandCreators.parentsChildrenRead`) remain available for
explicit nested identities, native processing and replay. Command spelling does
not determine ancestry; compiled structural targets do.

## Declared prototype-like names

Aggregate command and event registrations treat own names such as `__proto__`,
`constructor`, and `toString` as ordinary local keys, including component composition
and explicit wire-name overrides. Use computed object keys (`{ ['__proto__']: handler }`)
to declare an own `__proto__` property rather than JavaScript's prototype-setting literal form.
This is separate from host/bridge reserved-method collision checks, which remain enforced.
