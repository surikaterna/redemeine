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
