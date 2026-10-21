# Aggregate envelope preparation

`built.prepareCommand(state, rawCommand)` prepares for **this built aggregate's
plugin plan**. Raw `commandCreators` remain raw. `built.process(state, command)`
also prepares, then runs the domain processor, then prepares its linked events.
`apply` / `applyToDraft` never prepare: persisted events replay without invoking
envelope initializers, recipes, parsers or clocks.

```ts
const audit = createAggregatePlugin('audit')
  .commandEnvelope(input => {
    const dateTime = input.dateTime === undefined ? clock() : input.dateTime;
    if (!(dateTime instanceof Date) || !Number.isFinite(dateTime.getTime())) {
      throw new TypeError('Invalid dateTime');
    }
    return { dateTime };
  })
  .eventEnvelope((_, context) => ({
    sourceCommandDateTime: new Date(context.command.dateTime.getTime()),
    auditRef: context.command.id
  }))
  .build();
const built = Order.withPlugins(audit);
const prepared = built.prepareCommand(built.initialState, Order.commandCreators.add(payload));
const events = built.process(built.initialState, prepared);
```

Envelope-only plugins may omit `.state()`. They mount no namespace, preserve the
original state type and initial-state reference, and need no snapshot migration.
Their context has `ownState: undefined`; `createAggregatePluginFor` still provides
typed readonly domain state. Prepared command/event extension types are independent
of aggregate state. Plugin IDs remain unique and cannot collide with domain fields
or mounts, even when no state is declared.

To maintain plugin-owned state, call `.state(initializer)` before declaring handlers
or envelopes. `.state(() => ({}))` remains stateful and still requires its namespace
in snapshots; it is not silently converted to a stateless plugin. `.events` and
`.onEvent` are unavailable without declared state. Command preparation does not
update plugin state. If a plugin declares audit state, derive it from enriched events
in these handlers so replay rebuilds it. The stateless example above has no audit
state to rebuild. Raw creators have no `dateTime`; `prepared.dateTime` above is a typed Date.
An external command's valid Date is retained; invalid Dates or strings fail before
host sinks. Serialized dates require an explicit decoder at ingress and replay.

Initializers receive readonly **unknown extras**, plus detached readonly contexts
(`state`, `ownState`, canonical `command`, and for events canonical `event`).
Event context includes only that plugin's command extension. Recipes run in order
with an Immer draft of **their extension only**; they must return `undefined`.
An optional structural `{ parse(value: unknown): X }` parser runs on initializer
output and final recipe output. Its final result is published. It must accept its
own output (or the recipe's update thereof); it is not a raw-envelope decoder.
No parser dependency is required. Without a parser, nested output typing is normal
TypeScript trust, not runtime schema validation; recipes may change extension shape
at runtime. Initializer keys are not a separate persistent ownership registry.

Envelope callbacks are wildcard callbacks, including with `createAggregatePluginFor`:
command/event payloads are `unknown` because descendants and raw ingress can carry
other payloads. Narrow them explicitly before use. Only matched `.events` handlers
retain source event payload types. Source state context remains readonly and typed.
Built descriptors track presence; optional or potentially undefined descriptors
provide only optional extension fields, not guaranteed prepared values.

Prepared results contain canonical `Command<P,T>` / `Event` fields plus declared
extensions—not arbitrary incoming extras. Core payload/header/metadata data is
preserved unless an event-header writer explicitly replaces headers. Explicit routing fields are `aggregateId`, `aggregateType`,
`correlationId`, `causationId`, `address`, `correlation`. Domain event IDs and
`metadata.command` are assigned first. Event `correlationId` is the command ID;
when command `aggregateId` is known, event `aggregateId` / `aggregateType` are
assigned before event preparation. Event payload inference remains as strong (or
weak) as the existing aggregate process API; historical reducer input remains
unenriched and must be narrowed explicitly.
Supplied `aggregateId`, `aggregateType`, `correlationId` and `causationId` must be
strings (or undefined); malformed values fail before envelope callbacks. Names are
preserved without coercion or invented defaults during command preparation.

Extensions must be synchronous plain objects with enumerable own data properties.
Arrays, thenables, accessors, reserved core/routing keys, `then` and Object prototype
keys are rejected, except for the event-only `headers` slot described below. Multiple plugins may publish only disjoint top-level keys.
Snapshots/results detach data recursively (plain objects, arrays and Dates;
unsupported class instances/functions/accessors throw). Frozen snapshots do **not**
make Date internal slots immutable: Date setters can mutate the detached snapshot
only, never live state, caller data or another callback's snapshot. Extension
results are cloned too. Prepared envelopes remain mutable for later sink headers
and status, rather than freezing the host's object.

An unchanged **prepared object** is returned by reference and skips repeat command
callbacks within the same built plan, even with a new state argument. The cache
compares a detached full envelope snapshot, including Date values and core data;
mutating identity, routing, headers, extensions, payload, metadata, or adding status
invalidates it. Raw inputs are not cached. Different plans do not share caches.
Reconstructed retries run initializers again: preserving supplied valid dates and
explicitly decoding JSON dates is the plugin/caller's responsibility. With no
envelope descriptors, direct `prepareCommand` still validates the four string routing
fields above, then returns the input reference unchanged: no ID generation, cloning,
namespace checks or recipes. Absent and explicitly undefined routing fields are valid.
Inactive `process`, Mirage and bridge dispatch retain their existing preparation bypass;
they do not gain this direct-call validation.

## Host integration and executable showcase

Mirage shortcuts and raw dispatch prepare after routing, before legacy lifecycle
callbacks and builder hooks. Depot persists enriched events and replays them without
preparation. Mirage command results remain readonly state, not command envelopes;
event extensions remain available through `extractUncommittedEvents`.

The Demeine bridge prepares inside its FIFO queue after normalization and **before
the external sink**. The sink owns forwarding to `_process`; merely accepting a
command changes no state. Event adapters must preserve all prepared top-level data,
including extensions, as well as protected identity and metadata. Same-object adapter
mutation is checked against a detached pre-conversion snapshot before any event is
applied. Changed sink status/refs/headers can invalidate the preparation cache;
recipes are not promised exactly once for arbitrarily modified commands.

**SHOWCASE:** [`packages/demeine-interop/test/aggregatePluginEnvelope.test.ts`](../demeine-interop/test/aggregatePluginEnvelope.test.ts),
test **`adds command dateTime before the sink and preserves it through event replay`**.
Its injected fixed clock produces a Date asserted by the sink before `_process`.
The emitted event owns `sourceCommandDateTime` and `auditRef`; plugin state records
both. Replay reconstructs the same state with a clock that throws if called. This
is event replay, not a persistence/afterCommit guarantee.

Projection integration, a new persistence adapter, and a public generic kernel
runner are not provided. Helpers and caches remain private.

## Typed event headers

An event extension may own `headers`, using the same `E` extension type as its
other fields. Command extensions still cannot own headers. Identity, type, payload,
metadata, routing, and prototype-unsafe keys remain reserved in both phases.

```ts
type TraceHeaders = { traceId: string };
function traceHeaders(value: unknown): TraceHeaders | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError('Expected trace headers');
  }
  const trace = Object.getOwnPropertyDescriptor(value, 'traceId');
  if (!trace || !('value' in trace) || !trace.enumerable || typeof trace.value !== 'string') {
    throw new TypeError('Expected own traceId');
  }
  return { traceId: trace.value };
}
const transport = createAggregatePlugin('transport')
  .commandEnvelope(input => ({ selected: traceHeaders(input.selected) }))
  .eventEnvelope((_, { event, command }) => ({
    headers: traceHeaders(Object.hasOwn(event, 'headers') ? event.headers : command.headers),
    selected: command.selected
  }))
  .prepareEvent(draft => {
    if (draft.headers) draft.headers.traceId = draft.headers.traceId.trim();
  }).build();
```

The contextual command headers stay unknown until validated. The plugin's own
validated command extra (`selected`) is typed in its event callback; this does
not infer other plugins' extras as callback inputs. The parser, if supplied,
validates initializer and recipe **output**, not the raw wire envelope.

This example chooses event-own-property precedence, including explicit `undefined`.
Its validator selects only `traceId` and rejects `{}`; a different validator may
accept empty headers. There is no universal copy/fallback policy, implicit merge,
principal duplication, or hidden prepass. The first output with own `headers` may
replace raw event headers; a second writer throws, even if both return `undefined`.
Callbacks run in registration order, and later ones see installed headers. Within
the writer's recipe, `draft.headers` is its typed output, whereas `context.event`
still describes the event before that writer's output is installed.

Header values must be plain data records or `undefined`; null, arrays, functions,
accessors and non-enumerable header properties are rejected. The output contract
must declare **required** `headers: H | undefined` if it writes headers: optional
`headers?: H` and conditional `{} | { headers: H }` contracts are rejected. A
header-free extension remains valid. Untyped callbacks claim the slot only when
their final output actually owns the property. All installed headers are detached
from external data before installation, without freezing the external source.

This replaces the unreleased boolean flag, not an alias for it. In particular an
initializer always returning `{ headers: undefined }` creates an own property
even when neither raw event nor command had one; the old flag left it absent.
Without an event-header writer, no command-to-event copying occurs. Bridge
`options.envelope` cannot erase or replace prepared headers/extensions, identity,
or metadata. Existing `metadata.command` derivation and replay remain unchanged.

## Optional parsers

No schema import is mandatory. A structural TypeScript parser can be supplied as
the second argument to `.commandEnvelope(initializer, parser)`:

```ts
const dates = {
  parse(value: unknown): { dateTime: Date } {
    if (!value || typeof value !== 'object') throw new TypeError('Expected object');
    const dateTime: unknown = Reflect.get(value, 'dateTime');
    if (!(dateTime instanceof Date) || !Number.isFinite(dateTime.getTime())) {
      throw new TypeError('Invalid dateTime');
    }
    return { dateTime };
  }
};
const audit = createAggregatePlugin('audit')
  .commandEnvelope(input => ({ dateTime: input.dateTime ?? clock() }), dates)
  .build();
```

Applications already using Zod can instead pass `z.object({ dateTime: z.date() })`
as that parser (`z` is the application's optional Zod import). Neither parser is
an automatic JSON date decoder: decode serialized strings explicitly first.
