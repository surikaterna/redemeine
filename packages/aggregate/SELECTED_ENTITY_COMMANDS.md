# Mounted command state

Root commands receive aggregate readonly state. Commands registered through an entity
list or map receive only the selected entity, using the same readonly command view
(including nested objects, Dates, Maps and Sets). Event projectors still receive drafts.

Mount registration compiles the target chain from actual state paths, collection kinds
and declared list primary keys. Lists default to `id`; custom single and composite PKs
use their declared fields (or the existing `__entityPk` payload). Maps use an own entry
key. Existing mount-qualified `Id`/`Key` aliases are supported. String-equivalent numeric
identifiers retain compatibility. For composite PKs, unrelated `key` values are not IDs.

Nested commands require distinct ancestor identity, for example
`{ parentsId: 'p2', id: 'child', qty: 3 }`. Unqualified `id`/`key` refer to the leaf;
ambiguous reuse across levels is rejected. No new wire identity format is introduced.
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
winners from grouped mount iteration order. No public metadata or wire fields are added.

Undeclared legacy targeted events retain their legacy routing, with presence-based alias
lookup rather than truthiness fallback. This does not change Mirage scoped argument
types (the separate T10 slice) or promise class normalization outside interop. Original
packed command definitions remain available to creators and introspection.

### Selected Mirage command forms

For a mounted entity with `id` as its primary key, an authored shorthand handler
`set(state, payload: { id: string; qty: number })` is called as
`live.items(id).set({ qty: 2 })`. A packed command whose pack function accepts
`(id, qty)` is called as `live.items(id).setQuantity(2)`. Both handlers receive
the selected readonly entity state. Flat command creators retain their full
identity arguments. Selection injects composite keys in mount primary-key order;
map selection injects its key. Caller identity conflicting with selection is rejected.
