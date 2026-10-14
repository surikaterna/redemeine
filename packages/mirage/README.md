# @redemeine/mirage

Mirage turns a built Redemeine aggregate into a typed live object: commands are
methods, state is readonly, selectors are queries and mounted entities are scoped
proxies. Persistence remains an adapter responsibility.

## Commands and state

```ts
import { createAggregate } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';
import { createMirage } from '@redemeine/mirage';

const Order = createAggregate('order', { total: 0 })
  .events({ added: (state, event: Event<number>) => { state.total += event.payload; } })
  .commands(emit => ({ add: (_state, amount: number) => emit.added(amount) }))
  .selectors({ above: (state, limit: number) => state.total > limit })
  .build();

const order = createMirage(Order, 'order-1');
await order.add(3);
order.above(2); // boolean
order.total; // readonly number
```

Commands decide zero or more events; projectors apply those events to controlled
state. Each successfully applied event advances the version once. Zero-event
commands advance it zero times, but still notify after successful dispatch.
Commands return readonly post-command state. Before-command plugins can make
dispatch asynchronous, so command results are `ReadonlyDeep<S> | Promise<ReadonlyDeep<S>>`.

Initial state and supplied snapshots are cloned per instance. Root state is a domain
record; use plain structured-cloneable records and arrays inside it. Read views, selector results and subscribers cannot
write aggregate state. Command results and subscriber notifications are readonly
snapshots, not mutable aliases. Event extraction returns detached event copies.
Snapshots from `extractState` or command results can be supplied to creation or
Depot hydration; the receiving instance still gets its own copy.
Do not mutate state through stored external references or internal implementation
modules. `MirageCoreSymbol` exposes only readonly diagnostics (version and copied
pending results), not a mutable core. Normal helpers use private instance identity.

## Entity collections

For `.entityList('lines', Line)`:

```ts
order.lines('line-1').setQty(3);
order.lines[0]?.setQty(4);
order.lines.at(-1)?.setQty(5);
order.lines.find(line => line.qty > 0)?.setQty(6);
for (const line of order.lines) await line.setQty(7);
```

Indexed reads, iteration and array callbacks receive scoped readonly entity
proxies. `filter`, `slice` and identity `map` results retain those proxies. A mapper
that constructs new data returns its own data, not invented entity capabilities.
The list is callable and array-like, not a native Array object. Collection mutators
(`push`, `splice`, `sort`, `reverse`, `fill`, etc.) refuse; commands are the write path.
Direct key selection throws if the entity is absent; normal array `find`/`at`
operations return `undefined` when no item matches. A retained proxy re-resolves
its key against the latest state and throws if its entity has been removed.
Scoped commands return readonly entity state, not root state.

For entity maps, select a key first: `order.entries.VAT.verify()`. There is no
`order.entries.verify()` command without a selected entity. Missing keys return
`undefined`; known-key declarations expose the configured keys in the type system.
Value objects and non-entity data remain deeply readonly data, without commands.
Entity maps are iterable: `for (const entry of order.entries)` and
`[...order.entries]` yield readonly scoped entity proxies in `Object.keys` order,
not raw state values or key/value pairs. Each yielded proxy retains its map key
for commands and live reads. The key list is captured when iteration begins;
retained proxies throw on state reads or command-result resolution after removal.

## Selectors and explicit bindings

Selector argument tuples and results are inferred independently. Optional/default
and rest arguments are supported. Utilities come from the factory closure:

```ts
.selectors(({ bindContext }) => ({
  hasLine: (state, id: string) => state.lines.some(line => line.id === id),
  active: state => bindContext(state.lines.filter(line => line.active), Line),
  shipping: state => bindContext(state.shipping[0], Line, { mount: 'shipping' })
}))
```

Mirage invokes selectors as `selector(readonlyState, ...arguments)`. It no longer
guesses a `(state, utils, ...arguments)` convention from `Function.length`.
Plain selector data stays readonly data. Use `bindContext` when the result should
carry scoped commands; bound arrays support indexed reads, iteration, `at` and
`first`. Null/undefined single bindings remain null/undefined.

The developer owns selector correctness and primary-key uniqueness **within a
mount**. IDs need not be globally unique across collections. Mirage resolves a
declared entity definition to its actual mount, never the first object with an
`id` field. Reusing that definition in several mounts requires `{ mount: 'name' }`.
For a role that projects a subset of another mounted entity's commands, explicitly
identify the mount; the role's commands must exist on that mount.
Subset-role command names are discovered using the target mount's real emitter,
the role's selectors with root-selector fallback, and Aggregate's command-intent
context. Names are cached per role and mount, not globally. Factories should be
deterministic for that construction context. Calls dispatch the mounted entity's
handlers; a role describes a command subset, not replacement implementations.

Polymorphic views can specify a mount as the fourth argument:

```ts
bindContext(state.lines, 'kind', { LEG: LegRole, STOP: StopRole }, { mount: 'lines' })
```

Unknown role mappings, missing mounts and ambiguous bindings throw. No expensive
provenance scan or global duplicate-key policing is performed.

## Namespace rules

State, commands and selectors must have distinct names. Known root collisions are
rejected by the types and checked at construction; entity state/command collisions
present in the initial data also refuse. Protocol-sensitive names `then`, `toJSON`,
`toString`, `valueOf` and `inspect` are reserved. This avoids Promise assimilation
and inspection behavior silently overriding domain methods. Keep state schemas
consistent over their lifetime; a projector must not introduce conflicting keys.
Readonly object proxies retain safe `toString`/`valueOf` and primitive coercion;
`then`, `toJSON` and `inspect` do not become callable protocol hooks.

## Helpers and hydration

- `extractState(mirage)` returns a readonly state snapshot.
- `extractUncommittedEvents(mirage)` returns detached pending events.
- `clearUncommittedEvents(mirage)` clears pending events/intents, not state/version.
- `subscribe(mirage, listener)` provides readonly notifications and returns an unsubscribe function.
- `dispatch(mirage, command)` accepts a command envelope and returns typed readonly state or its Promise.

Raw dispatch preserves envelope/state types but does not promise command-name /
payload correlation beyond the built aggregate's current command envelope API.
Prefer generated command methods for exact arguments. Helpers reject non-Mirage
objects through a private instance registry.

```ts
const fresh = createMirage(Order, 'one'); // synchronous
const restored = await createMirage(Order, 'one', {
  snapshot: cachedState,
  initialVersion: 42,
  events: storedTail
});
```

`events` accepts sync or async iterables and always makes creation asynchronous.
`initialVersion` is the persisted starting-state event count, not a final override.
It defaults to zero and must be a nonnegative safe integer. State alone cannot
establish its history. Replay adds one for each successfully applied event,
including accepted unchanged-state events, and does not buffer events or notify.
Replay yields to the Node event loop every 250 events and preserves plugin order.
At a snapshot baseline of `Number.MAX_SAFE_INTEGER`, Depot still requests the
exclusive-beyond-snapshot lower bound `B + 1` (`2^53`). That cursor is exactly
representable but is not a safe stored event count; adapters must support it or
reject it explicitly. An empty tail preserves B; any yielded event is rejected
before application. Depot does not skip the read and silently hide an extra tail.

## Depot

```ts
const depot = createDepot(Order, store);
const loaded = await depot.get('one');
loaded.above(2); // same selector arguments/results as direct createMirage
await loaded.add(1);
await depot.save(loaded);
```

`Depot<BuiltBuilder>` derives the complete `MirageOf<BuiltBuilder>`: state,
commands, selectors and mounted entities are not separately erased generic fields.
`get` accepts builder-specific initial state or `{ snapshot: { state, version } }`.
`save` verifies the instance belongs to the exact builder object owning the Depot.

```ts
interface EventStore {
  readStream(id: string, options?: { fromVersion?: number }): AsyncIterable<Event>;
  saveEvents(id: string, events: Event[], expectedVersion?: number): Promise<void>;
}
```

`fromVersion` is 1-based and inclusive. Snapshot count B reads from B+1; it seeds
Mirage with baseline B. `saveEvents.expectedVersion` is the persisted event count
**before** append, captured before awaiting append plugins. The adapter must
compare-and-append atomically. A backend with zero-based revisions translates
count B to B−1 using its own new-stream sentinel.

**Serialize dispatch and save.** The existing overlapping dispatch/save buffer
race (`redemeine-98zi`) is not fixed by this DX work. Append/pre-append failure
retains pending events and state; post-commit failure occurs after storage/clear.
No durable outbox, retry loop, automatic rollback or production adapter is supplied.

## Failure, versioning and evolution

The event-count invariant is initial baseline + successful replay + successful
live applications. It is bounded by `Number.MAX_SAFE_INTEGER`. Overflow refuses
the offending event before application. A valid prefix is retained if a later
event fails; there is no whole-command rollback. Event-applied hooks run after
application/buffering/counting; a throwing hook leaves that event applied.
Before/after-command hooks retain their pre-application order. Observer failures
do not roll back committed state. Command intents merge only after the full event
loop; partial application is not a transactional intent guarantee.

Old command-count/zero-after-replay checkpoints cannot be converted arithmetically.
Use authoritative history or an operator-verified baseline, and preserve historical
event naming during replay. Clear/discarding unsaved events requires re-establishing
an authoritative baseline before persistence. No migration or rollout is automatic.

## Verification

`pnpm --filter @redemeine/mirage test` runs strict source and built-declaration
contract fixtures before runtime tests. Build dependencies and Mirage first.
The fixtures cover exact inference, negative calls, accidental-any rejection,
readonly results/subscribers, selectors, maps and Depot. Mirage production source
is included in `lint:principles`; dynamic dispatch assertions are localized and
documented. Source/declaration gates do not replace final packed-consumer and real
adapter qualification before release.

`pnpm --filter @redemeine/mirage test:packed` uses the operating system temporary
directory (`os.tmpdir()`, honoring `TMPDIR` where supported) for isolated evidence.
No agent-specific temporary directory is required. Build dependencies and Mirage
before running this non-publishing check.
