# Aggregate event plugins

This API maintains **event-derived, plugin-owned aggregate state** and supports
symmetric command/event envelope preparation. No plugin schema or Zod dependency is required:
normal TypeScript contracts describe state and payloads. Existing host contract
validation (including existing Zod-based contracts) remains optional and unchanged.

```ts
import { createAggregate, createAggregatePlugin, createAggregatePluginFor } from '@redemeine/aggregate';
import type { Event } from '@redemeine/kernel';

const Counter = createAggregate('counter', { count: 0 })
  .events({ added(state, event: Event<number>) { state.count += event.payload; } })
  .commands(emit => ({ add: (_state, amount: number) => emit.added(amount) }))
  .build();

// Generic plugins have unknown payload/context state: narrow before using them.
const observed = createAggregatePlugin('observed')
  .state(() => ({ nested: { count: 0 } }))
  .onEvent(draft => { draft.nested.count++; })
  .build();

// Source-bound plugins infer matched payloads and readonly aggregate context.
const totals = createAggregatePluginFor(Counter, 'totals')
  .state(() => ({ values: [] as number[], lastTotal: 0 }))
  .events({ added(draft, event, context) {
    draft.values.push(event.payload);
    draft.lastTotal = context.state.count;
  } })
  .build();

const Instrumented = Counter.withPlugins(observed, totals);
const state = Instrumented.apply(Instrumented.initialState, {
  type: 'counter.added.event', payload: 2
});
state.totals.lastTotal; // 2; Mirage exposes this state deeply readonly

// Builder registration is also supported (generic descriptors are reusable).
const Other = createAggregate('other', {}).plugins(observed).build();
```

Register descriptors with builder `.plugins(...)` or immutable built
`.withPlugins(...)`. When `.state()` is declared, state is mounted directly at `state[plugin.id]`. Initializers
are lazy until build/decoration and run once for each newly attached descriptor,
not once per applied event. Return fresh plugin-owned Immer-compatible objects;
the factory is trusted, not sandboxed. Normal immutable application preserves the
host's initial state.

Direct arguments and `as const` tuples guarantee their mounted namespaces.
Spreading an ordinary array guarantees no elements (it may be empty), so each
possible stateful plugin ID has optional state, preserving that ID's own state type
even for heterogeneous arrays. Narrow a namespace before reading its state.
Empty, stateless-only and entirely legacy arrays add no mounted state. Array elements still need
literal, non-union IDs that do not collide with any host-state branch. Since
arrays prove neither presence nor order, source prerequisites must already exist
on every host-state branch; attach prerequisites first or use an ordered tuple.
Runtime uniqueness and source-identity checks still apply to the actual elements.

Application runs the domain projector first, then each registration's matched
handler followed by its catchall. Replay uses the same pure application path;
command processing enriches events but does not apply state reducers. `applyToDraft` uses the caller's
Immer transaction; let failures escape that transaction to discard its changes.
Callbacks must be synchronous. A missing stateful plugin namespace is an error before any
domain write: migrate older snapshots explicitly rather than lazily backfilling.
Mirage and Depot also check namespace presence when accepting initial/snapshot
state, even without replay events. This check does not validate the namespace's
schema and never reruns initializers to repair a snapshot.
Alternatively rebuild state by full replay from the decorated initial state.
This is an event-level transaction, not a multi-event command/persistence transaction.
Nested plugin state uses Immer `Draft<S>`; never retain a draft outside its callback.
Return no value from handlers. Async/thenable initializers and handlers fail clearly.

`.events(...)` keys resolve through the host's event naming/override mappings;
fallback keys are literal applied event types. Repeated keys replace prior handlers;
`.onEvent(...)` replaces the catchall. The catchall payload is deliberately `unknown`:
it also sees unmatched/future events when the domain unmatched policy permits them.
Registration order is significant: domain, first plugin matched then catchall,
second plugin matched then catchall, and so on. Context/event input is readonly;
only the plugin's namespaced draft is writable. IDs must be unique literal names
and must not collide with domain state, mounts, or reserved object properties.

Source-bound descriptors require the actual source aggregate or its descendants,
including a decorated source's prerequisites. Names alone do not establish
identity. Decorate the prerequisite source first, then attach dependent plugins.
The callback context reports the actual host's `aggregateType` as a string, not
the source name literal, since descendants can have different names.

Legacy lifecycle descriptors remain in `built.plugins`. Event descriptors are
exposed separately in readonly `built.aggregatePlugins` so existing lifecycle
hosts do not receive a new descriptor through unchecked legacy erasure.

## Host capabilities and migration

| Host | Event-derived state | Lifecycle/persistence |
| --- | --- | --- |
| Aggregate `apply` / `applyToDraft` | Domain then event plugins, including replay | No new lifecycle runner |
| Mirage shortcuts / raw dispatch | Once per event via Aggregate `apply`; initial/snapshot state cloned per instance | Existing before-command behavior unchanged |
| Depot load / snapshot tail / commands | Same application path, no replay-generated pending events | Existing hydration/before-append/after-commit behavior unchanged; after-commit requires successful store append |
| `createDemeineBridge` defaults | Shortcuts and replay use Aggregate `apply` | Legacy hooks/plugins and intents remain rejected; queue drain/event clearing is not persistence acknowledgement |
| Projection | API and hooks unchanged | No new projection plugin API |

Attach event descriptors on the aggregate, **not** Mirage/Depot `setup.plugins`:
the latter accepts legacy lifecycle plugins only and rejects misplaced event
descriptors at runtime as well as in normal TypeScript. The bridge supports the
decorated aggregate through its default event handler; a custom event handler is
still a full override and is responsible for applying events itself.

Factories must return fresh owned, Immer-compatible data. Drafting does not make
`Date` methods immutable, proxy class/private state, or enable Map/Set support by
itself. Prefer plain objects/arrays; treat Dates as immutable values and replace
them instead of calling mutating methods. Plugin callbacks are trusted application
code, not a sandbox. Snapshot serializers must preserve supported value types.
Plugin readonly input types retain Date readers (such as `getTime` and
`toISOString`) while omitting `set*` mutators; freezing a Date does not itself
make its internal timestamp immutable.

See [envelope preparation](../../ENVELOPES.md) for typed command `dateTime`,
event extensions, optional parsers, Mirage/bridge pre-sink integration, and the
executable fixed-clock/replay showcase. Envelope-only plugins omit `.state()` and
mount no namespace; their `ownState` is `undefined`. The same fluent envelope API
works with `createAggregatePlugin` and source-bound `createAggregatePluginFor`.
State reducers require `.state()` first. Explicit `.state(() => ({}))` remains
stateful, including its snapshot requirements. Command preparation itself never updates state.

**Deferred, not shipped:** universal command payload extensions, full
persistence-plugin migration, a new bridge persistence adapter, and projection hooks.

## Source-bound descendant event contracts

Matched source-bound handlers require host payloads assignable to the source payloads.
Only registered keys participate; catchall handlers and envelope callbacks retain unknown
payloads and do not impose this matched-event requirement. Descendants may rename inherited
events, add events, and replace unrelated projectors.

Runtime payload types are erased. Attachment therefore conservatively requires each matched
key to retain its source projector identity. Replacing a matched projector is rejected even
when its declared payload is compatible: bind the plugin to the built descendant instead.
This check runs before plugin state initialization or event application.
## Initial state ownership

Aggregate templates are borrowed readonly from creation, not deep-cloned.
Mounting event plugins uses Immer to add only the new namespaces: it creates a
new root and shares untouched domain/prior-plugin branches. Default Immer
auto-freeze may freeze that shared caller data; retaining an alias does not
retain mutation rights. Before mounting/applying there is no runtime-freeze
promise. Date readers remain available in the readonly API, but freezing does
not universally prevent Date internal-slot mutation. See the Aggregate README
for the common `AggregateStateView<S>`/`Draft<S>` contract.

Initializers run once per new registration, must return fresh plugin-owned
state, and are not rerun when decorating an already decorated aggregate.
No-op, stateless-only and legacy-only registrations preserve the initial-state reference.
