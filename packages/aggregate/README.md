# Aggregate

## Command shorthand: zero or one payload

Command shorthand handlers receive readonly state and **zero or one payload
argument**. This applies to `createAggregate`, `createMixin`, and `createEntity`,
including `{ handler, meta }` definitions. A handler without parameters or with
state only creates a command with the existing `void` payload type (`undefined`
at runtime). A required payload stays required; `payload?: P` allows omission or
explicit `undefined`, and the command payload is `P | undefined`, not `[P?]`.
A required `payload: P | undefined` still requires an argument. Domain Aggregate
payloads may be primitives; legacy bridge object restrictions are separate.

Multiple required/optional payload parameters and unbounded/generic rest
parameters are rejected: runtime forwards only the first caller argument as the
payload. Fixed zero/one-element tuple rest parameters are supported. Preserve
concrete signatures when storing definitions (prefer inference or `satisfies`);
broad shorthand annotations that erase arity cannot prove this contract.

For a multi-argument public API, migrate to the existing explicit packing form:

```ts
const order = createAggregate('order', { count: 0 }).commands(() => ({
  add: {
    pack: (name: string, amount: number) => ({ name, amount }),
    handler: (_state, payload: { name: string; amount: number }) => ({
      type: 'order.added.event', payload
    })
  }
})).build();
order.commandCreators.add('item', 2); // payload: { name: 'item', amount: 2 }
```

There is no automatic runtime argument packing or reinterpretation. Valid
shorthand and explicit packing retain their existing runtime behavior.

## State ownership and readonly views

Passing a model to `createAggregate(name, initialState)` relinquishes mutation
rights to that template and its shared data. Public `initialState`, command and
selector inputs, and `apply` results expose `AggregateStateView<S>`; projectors
and `applyToDraft` use Immer's `Draft<S>`. Keep the original model type `S` for
drafts, rather than deriving it from the readonly view. Built and decorated
aggregates retain that model through the optional `__stateType` type marker.

The template is not deep-cloned. Creation/build without event plugins does not
promise runtime freezing. Adding event plugins uses Immer to create a new outer
root, sharing unchanged domain and previously mounted plugin branches. With
Immer's default auto-freeze, mounting or applying events can freeze shared
caller data. Do not mutate it through retained aliases. No-op and legacy-only
registration preserve the initial state's identity.

Readonly views preserve optional/union models, arrays/tuples, callables, Date
read methods, and readonly Map/Set operations. They are a TypeScript contract,
not universal runtime immutability: Date internal slots and arbitrary callable
behavior are not made immutable by freezing. Immer-compatible function-bearing
objects and `immerable` classes remain supported without JSON/clone restrictions;
unsupported non-draftable class roots fail with Immer's own error when mounted.

Command inputs lazily wrap ordinary objects and arrays without cloning the state
graph. Their Date readers use private Date copies with native receivers, whether
the source is frozen or not. Date setters are absent, and calling native setters
with the exposed Date as receiver fails rather than mutating live input. This
command-specific protection does not freeze the template or change ownership of
retained aliases. Functions and class methods remain trusted code; Map/Set retain
the existing kernel runtime boundary rather than gaining new runtime guarantees.

Event-plugin callback state contexts detach supported own data (including Dates
and cycles), preserve function references, and retain Immer-compatible class
prototypes so ordinary readers work. Snapshot capture does not invoke prototype
getters; own accessors and opaque native objects are rejected. Class private
fields/native internals cannot be reproduced. Functions, prototype methods and
getters are trusted code, not sandboxed: closures can still mutate external data.
Methods operating on ordinary own data see the detached, frozen context rather
than live state. Date setters can mutate that detached Date, never the original.
Command/event envelope snapshots retain their stricter plain-data-only policy.

## Resolved command provenance

Use `commandMetadata(built, localName)` to inspect compiled command registration and deeply readonly structural `targets`. Root commands have an empty target chain. The query follows composition and mounting without parsing wire names; copied target arrays do not freeze caller-owned primary-key arrays. The former `built.pure.commandTargets` property has been removed. `pure.commandProcessors` and `pure.eventProjectors` remain available.

Command creators exist only for declared flat keys, including mounted keys such as `built.commandCreators.rowsRead(payload)`. Undeclared paths such as `built.commandCreators.rows(id).read()` are not supported. Mount wire overrides use `eventNameOverrides` and `commandNameOverrides`; the former mount-option aliases `eventOverrides` and `commandOverrides` have been removed. Definition-level override fields remain unchanged.
Scoped Mirage shorthand accepts a single object payload (including optional objects), or no payload/`undefined`. Scalars, arrays, functions, `null`, and unions containing these unsupported payloads are not callable in a selected scope and throw before command hooks if invoked from JavaScript. Root shorthand remains unchanged. Use an explicit `{ pack, handler }` command for scalar business arguments; its final packed payload must still contain the selected identity object.

Repeated explicit list/map registrations keep the latest selection descriptor while surviving commands retain their own type-only registration identity and packed prefix length. Selected calls omit only canonical leaf PK fields injected by that command's registration (`key` for maps). Former singular/plural aliases and synthetic `id` fields are ordinary business data, not identity inputs. Partially specified generic command descriptors without registration information retain descriptor-based selection; they do not establish command-specific provenance.

## Entity registration and replay

`createEntity('identifier', initialIdentifierState)` borrows an object template,
just as an aggregate borrows initial state. Do not mutate the template after
declaration. No serialization, cloning or freezing happens at declaration time.

Declare `.commands(factory, { static: ['register'] })` to allow the named commands
to decide against a missing final **list** leaf. Names are checked against that
factory's commands. A later registration without the option resets that command
to ordinary instance lookup. Handlers receive `(state, payload, { isNew })`;
the last argument is framework context, never a creator/pack argument. Annotate
packed handler payloads explicitly when sibling inference needs it.

For `{ domain: string; authority: string; identifier: string }` with primary key
`['domain', 'authority']`, `identifier` is business data, not identity. A register
handler can emit `registered` when `isNew`, return `[]` for an unchanged value,
or emit `amended` for a changed value. Validate domain rules before emitting.
State is borrowed readonly: missing lookups supply the template with `isNew=true`;
existing lookups supply actual state with `false`, even if equal to the template.
Processing never inserts; no events means no creation.

Applying an exactly registered ordinary entity event can initialize a missing
templated list leaf regardless of command classification. Replay applies canonical
PK fields and calls the normal mutable Immer projector `(state, event)`. Even a
no-op projector inserts the leaf. There are no static events, replacement-state
returns or special creation projectors. Full scalar canonical identity, a valid
list container and all ancestors must exist; duplicate identity matches reject
before a handler/projector runs. No ancestors are auto-created. Name-only entities
retain missing-target errors. New map-entry creation is not supported.

Creation and subsequent update work within one outer Immer transaction, including
raw ancestors inserted earlier in that transaction. Target paths are replaced at
the ownership boundary so borrowed input is not mutated and an outer throw rolls
back the transaction. Normal Immer structural sharing/auto-freezing still applies
when events are applied; templates should be treated as readonly throughout.

### Migration: mount and authored-name collisions

Different entity definitions at the same mount point now fail at build time.
Compose their commands into **one entity definition**, or reuse the exact same
definition object at that point. Mount different entities at distinct target paths.
Distinct authored command paths that flatten to the same compiled key also fail:
use distinct authored compiled paths, with explicit shared wire names if shared
dispatch is desired. Same authored command overrides remain valid; sharing a wire
name still routes both calls to the existing Aggregate winner.
