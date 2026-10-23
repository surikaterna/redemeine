# @redemeine/demeine-interop

Give a **built** Redemeine aggregate a standalone, legacy-compatible lifecycle.
No Demeine base, import, or runtime dependency is required. This is not a Mirage
runtime. The constructor retains the legacy service order.

```ts
import { createDemeineBridge } from '@redemeine/demeine-interop';
import { definition } from './definition.js';

const Counter = createDemeineBridge(definition, {
  envelope(event, command, aggregate) {
    // Optional synchronous, application-specific envelope enrichment.
    return { ...event, aggregateId: aggregate.id };
  },
});
const counter = new Counter(commandSink, eventHandler, commandHandler);
await counter.add(2); // Same arguments/pack behavior as definition.commandCreators.add
```

Options are optional and contain only `envelope`. The removed `AggregateBase`
option is rejected at runtime rather than silently ignored. Instances do **not**
inherit from Demeine; compatibility with its Factory/Repository is structural.
The owned lifecycle supplies UUID v4 (`uuid@9.0.1`), the command queue,
promised-command support, errors, replay, snapshots, versions and pending events.
Initial state is cloned per
instance. Later factory assignments to `id`, `type` and `_state` are authoritative;
replacement state is not merged with defaults. Shortcuts fill a missing
aggregateId and enter `_sink`; mismatched identities remain errors. Without a
sink, the local sink calls `_process` but does not persist anything.

### Authored subclasses and neutral types

Use the base constructor type to hide generated shortcut signatures when retaining
authored methods (including methods whose parameters differ from creator packs):

```ts
import { createDemeineBridge, type CompatibleAggregateConstructor,
  type CommandSink } from '@redemeine/demeine-interop';

type State = { count: number };
const Base: CompatibleAggregateConstructor<State> = createDemeineBridge(definition);
class Counter extends Base {
  constructor(sink?: CommandSink<State>) { super(sink); }
  add(data: { amount: number }) {
    return this._sink({ ...definition.commandCreators.add(data.amount), aggregateId: this.id });
  }
}
```

`CompatibleAggregate<S>`, `CompatibleAggregateConstructor<S>`, `CommandSink<S>`,
`CommandHandler<S>`, `EventHandler<S>`, object-payload `Command<P>` / `Event<P>`,
and `Queue` / `QueueOptions` are public neutral exports. Both constructor types
infer `S` in inline handlers and accept named `EventHandler<S>` / `CommandHandler<S>`.
A separate, strictly object-accepting command-handler overload preserves real legacy
handlers whose declarations return object-state aggregates. The stored command
handler retains that explicit alternative rather than erasing a state-specific
handler; calling it still requires an aggregate with state `S`. Its result may have
object state, as in the legacy contract. No broader asynchronous handler return
type or compatibility cast is required for the qualified Factory/Repository.

Neutral commands and events expose optional `headers` and `metadata` as
`Record<string, unknown>`, matching kernel envelopes. Services can read these
fields and callers can supply them without casts. Values such as
`event.metadata?.command` remain unknown until narrowed; there is no hardcoded
application envelope schema or synthesized metadata on raw events.

### Intentional lifecycle compatibility

- Queue uses `p-queue@6.6.2`, concurrency one, and browser-resolvable `events@3.3.0`.
  Its public emitter contract uses the declared production type dependency
  `@types/node@24.13.2`; both declaration formats explicitly reference it, including
  for consumers with automatic ambient types disabled. This adds Node typings,
  not a Node runtime import: browser bundles still resolve the `events` package.
  Public `_queue` retains its actual nominal PQueue type. `isProcessing()` checks
  queued size, **not** running count: a synchronous pending read can succeed during
  the sole running task. Async reads wait for idle and recheck queued work.
- `_sink` adopts its input once immediately and observes rejection across native,
  cross-realm promises and arbitrary thenables. Throwing `then` getters
  reject the adopted promise, not the synchronous `_sink` call. Command validation,
  id/type mutation, sink invocation and caller-visible settlement remain queued;
  adoption does not process commands early or assimilate the input a second time.
  Its input type is `Command | PromiseLike<Command>`; its return remains a native
  `Promise<CompatibleAggregate<S> | true>`. Custom typed thenables need no cast.
- `_process` invokes its handler synchronously inside a native Promise executor;
  native resolution assimilates returned values, promises and thenables. Its native
  catch logs and replaces the pending array only for an object/function whose
  `isOperational` marker is exactly `true`. Ordinary errors, primitives and other
  marker values preserve the array. A throwing marker getter is treated as unmarked.
  The original rejection is rethrown, without wrapping or state/version rollback.
  Scheduling is native microtask scheduling; no promise-extension methods are provided.
- Pending arrays and snapshots are live references. Clearing assigns and returns
  a new empty array without modifying references retained by a Repository.
- Event ids are assigned before validation. Successful application normalizes
  version -1 to zero, then increments once, even for an accepted unknown event.
  Ordinary events delegate to the builder's warn/skip/throw policy unchanged.
- Replay uses the supplied snapshot reference, yields after event indices 0, 100,
  etc., and finishes with `version || computedVersion`: explicit zero does not
  override a nonzero count, while -1 does. Replay does not buffer new events.

### Generated shortcut arguments

`BridgeArguments<Creator>` is the exported argument-tuple mapping used by generated
methods. Zero-argument creators accept either no arguments or an empty object.
Exactly one required object argument becomes optional only if `{}` satisfies that
object type; required fields remain required. Already-optional and multi-argument
signatures are unchanged. Unknown, primitive and mixed object/primitive payloads
are not widened. Host helpers can use this mapping with `BridgeConstructor` without
recreating constructor overloads or casting generated methods.

A creator declared with a correlated rest tuple retains that correlation in its
shortcut:

```ts
// Creator signature: (...args: ['a', { a: number }] | ['b', { b: string }]) => Command
await aggregate.go('a', { a: 1 });
await aggregate.go('b', { b: 'ok' });
// aggregate.go('a', { b: 'wrong branch' }); // Type error
```

This mapping uses TypeScript's `Parameters` utility; it does **not** preserve
arbitrary overload sets or higher-order generic relationships. Those contracts
remain outside this fix (HOST-T8 is unresolved); naming a wrapper does not solve
that limitation.

At runtime, **every empty argument list forwards one fresh `{}` to the creator**,
matching the legacy shortcut default. Creator wrappers erase TypeScript arity, so
this cannot be limited to the signatures widened above. In particular, an optional
or defaulted pack called with no arguments receives `{}`, not `undefined`; pass
explicit `undefined` to retain its authored default/undefined behavior. Supplied
arguments (including explicit `undefined` and multiple arguments) are forwarded
unchanged. This is an intentional bridge-only default, not native creator parity;
call native creators directly when their empty-argument-list semantics are needed.

For generated shortcuts only, a creator's missing/undefined payload (including a
no-argument command or a pack function intentionally returning undefined) becomes
a fresh `{}` in a shallow copy of its envelope. Original commands are not mutated;
object pack results retain payload identity. Explicit null/scalar results still
fail the legacy object-payload guard. Raw legacy methods and event payload rules
are unchanged.

The sink, dispatcher, built contract and handler all see that **same canonical
object**; the adapter never secretly restores undefined after the sink. A legacy-
bound no-payload contract must therefore accept `{}`. A void-only contract such as
`z.void()` still accepts the native creator's undefined payload in direct builder
processing, but rejects the normalized shortcut command with the normal contract
error and no fallback. Use an object-compatible contract for the legacy bridge;
this adaptation does not promise native void-contract equivalence.

## Handlers and envelopes

Built definitions with an active command or event descriptor in `aggregatePlugins`
and `prepareCommand(state, command)` prepare inside the FIFO
queue, after legacy id/address normalization and **before** the external sink.
Direct `_process` and generated `processXxx` dispatch also prepare commands. Raw
command creators remain unextended: a plugin-provided `dateTime: Date` exists only
after preparation. A valid provided date is preserved by the plugin; validation
errors reject before the sink is invoked. Method presence alone does not activate
preparation: zero-plugin and state-only definitions retain their original command
references and behavior. Handbuilt definitions must expose their envelope descriptors;
active descriptors without a preparation method are rejected at bridge creation.

For example, a command-envelope plugin can use an injected clock to add a Date,
and an event-envelope plugin can copy it into `sourceCommandDateTime` alongside
an `auditRef` derived from the command id. The sink sees the prepared command and
still decides whether to call `_process`. Unchanged prepared objects use the built
definition's cache; changed dates/headers/routing are revalidated by that definition.
Legacy transport `status` and `refs` survive bridge preparation, while other
unowned extras follow the aggregate's canonical projection policy. Transport
mutations may cause re-preparation; initializers should preserve supplied values.

At this active preparation boundary, legacy command classes and nested data classes
are normalized to plain own data, including classes assigned by a sink before
`_process`. Queued ingress validates and takes ownership of class data before legacy
routing reads or writes, including frozen own-data commands. No host cloning wrapper
is needed. Graph aliases/cycles, ordinary Dates, symbol
keys and non-enumerable data are preserved; own accessors, functions and native
containers such as Map/Set and prototype-tagged opaque objects are rejected rather
than silently erased. Dates with any own properties are rejected rather than losing
their decorations during preparation. Prototype
methods/private fields are not envelope data. Already-plain prepared commands
retain identity and the definition's cache semantics. Native Aggregate preparation
still requires plain data; inactive bridge dispatch and deletion are unchanged.

Event preparation runs in the aggregate with final aggregate addressing and command
correlation already available. Conversion must preserve all prepared extension
values (including Dates), core identity and metadata; all converted events are
checked before the first apply. Replay (`_rehydrate`) applies persisted events,
not command/event preparation or clocks. If persistence serializes Dates to JSON,
decode those fields explicitly before replay. This provides no afterCommit or
durability guarantee and does not roll back external sink side effects.

With either envelope phase active, conversion protects all prepared top-level
fields, even for command-only plans. Event-only plans also prepare command routing
before the sink. Without an active plan, legacy conversion may change or remove
ordinary headers and domain extras; identity, addressing and metadata remain protected.

**SHOWCASE:** `packages/demeine-interop/test/aggregatePluginEnvelope.test.ts`,
`adds command dateTime before the sink and preserves it through event replay`.
The fixed-clock sink asserts a Date before `_process`; events retain their own
`sourceCommandDateTime`/`auditRef`, and replay rebuilds audit state with a throwing
clock. See [envelope preparation](../aggregate/ENVELOPES.md) for schema-free and
optional Zod parser examples. Envelope-only plugins currently require
`.state(() => ({}))`; command preparation does not change state.

Each nullish handler slot independently receives a generated dispatcher. Supplied
handlers are full overrides, called once with their original receiver and
arguments. Errors never trigger fallback. Generated `processXxx`/`applyXxx`
methods support explicit legacy DefaultCommandHandler/DefaultEventHandler
instances; ambiguous names and lifecycle collisions fail at bridge creation.
The sink owns forwarding to `_process`: the bridge never processes a second time.
Event evolution and the envelope callback must be synchronous. Detectable async
handlers fail immediately; returned thenables also fail, without undoing already
started side effects. Do not supply async event handlers.

Builder-produced events keep id and metadata, gain live `aggregateId` and
top-level `correlationId = command.id`, then pass through the optional envelope
callback exactly once. The callback receives the **full post-sink command** and
live aggregate. Identity, addressing and metadata must survive conversion. Standard
builder metadata contains the lightweight `command` link (`id`, `type`, optional
`summary`, optional `storeRef`), not the command payload or all headers. Sibling
metadata survives. The builder replaces any previous `metadata.command`.
The bridge neither synthesizes links for raw/replayed events nor recovers
`commandSummary`/`commandStoreRef` erased by a sink's header reset. Configure
post-reset modifiers deliberately. Arbitrary summaries are not sanitized.
Plain metadata objects/arrays and dates may be cloned; opaque class instances must
retain reference identity. Cyclic/shared metadata is not promised deep-clone support.

## Reserved destructive legacy deletion

`delete()` enters the sink with `$stream.delete.command`; both generated
and real Default* dispatchers reach the owned `processDelete` / `applyDeleted`.
Calling `processDelete(domainRemoveCommand)` directly also retains the domain
command id as correlation. The event carries live aggregateId and
`payload.aggregateType`; applyDeleted is a no-op. This path deliberately does NOT
call the builder, envelope callback, or synthesize `metadata.command`.

The real Repository opens the stream and intercepts the **first** buffered
`$stream.deleted.event`, calling `partition.delete` instead of normal append/commit.
Other events in a mixed buffer are not appended by that branch; the legacy delete
branch does not clear the buffer. Do not infer transactional mixed-batch behavior.
Tapeworm 0.5.0 qualification exercises active-history truncation, one tombstone
with a fresh commit id, snapshot-removal capability and commit dispatch. These are
store responsibilities, not bridge implementations. Deletion does not reset state
or prohibit later local commands. It is not secure all-copies erasure, a universal
deleted-read rejection, or an immutable no-recreation guarantee.

## Supported boundary

- Differential fixture: actual `demeine@1.3.1` Aggregate **and matching Repository**.
  It needs host `regenerator-runtime` (the legacy manifest incorrectly lists that
  runtime dependency under devDependencies). Tests explicitly provide 0.13.11.
  Native ESM must default-import this legacy CJS module, then take `Aggregate`;
  its generated barrel does not expose Node-detectable named ESM exports.
- No production Demeine, Mirage, Depot or Surikat imports. Demeine is a dev fixture
  only. A consuming application's host Repository/Factory or `lynx3-utils` can still
  depend on Demeine transitively; this package does not promise host-wide removal.
- Interop has no direct Bluebird runtime or test dependency, including its typings.
  Real legacy Demeine/Tapeworm fixtures use it transitively. Demeine 1.3.1 ships
  its required Bluebird typings, so current strict legacy qualification needs no
  exception. The older 1.3.0 missing-declaration baseline remains historical;
  no fake types, hidden direct installs or skipped-library checks are used.
- Exposed configured hooks/nonempty plugins fail at creation; non-null defined
  `__intents` (even `{}`) fail before applying events. Opaque wrappers cannot be
  inspected fully. No afterCommit, rollback or plugin parity is promised.
- Command validation belongs on the built definition's contract. `process` validates
  success but does not replace/coerce the original payload; `apply` does not validate
  event/state schemas. There is no bridge schema argument.
- Queue drain is not disk durability. Command/commit save initiation, commit-driven
  sender correlation and projection completion remain legacy runtime concerns.
  No crash-safe outbox, exactly-once, zero-event transmission or ACK/projection promise.
- Old client 0.3.x and mixed old Repository/1.3.0 async Aggregate are unqualified.

Both import and require have matching declarations (`index.d.ts` / `index.d.cts`).
The supplied-base removal requires a major changeset; derive the prerelease using
Changesets rather than guessing or overwriting an earlier artifact. Standalone
qualification uses a fresh `.cache/standalone-ov0e6` namespace and published
dependencies. Source qualification is not publication authorization; consult
`docs/releasing.md` for the normal reviewed release workflow.
