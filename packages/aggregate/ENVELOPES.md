# Aggregate envelope preparation

`built.prepareCommand(state, rawCommand)` prepares for **this built aggregate's
plugin plan**. Raw `commandCreators` remain raw. `built.process(state, command)`
also prepares, then runs the domain processor, then prepares its linked events.
`apply` / `applyToDraft` never prepare: persisted events replay without invoking
envelope initializers, recipes, parsers or clocks.

```ts
const audit = createAggregatePlugin('audit').state(() => ({}))
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

Envelope-only plugins currently require `.state(() => ({}))`; there is no
state-less declaration overload. Command preparation does not update plugin state.
Audit state must be derived from enriched events in `.onEvent` / `.events` so replay
rebuilds it. Raw creators have no `dateTime`; `prepared.dateTime` above is a typed Date.
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
preserved. Explicit routing fields are `aggregateId`, `aggregateType`,
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
keys are rejected. Multiple plugins may publish only disjoint top-level keys.
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
envelope descriptors, command preparation returns the input reference unchanged.

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
const audit = createAggregatePlugin('audit').state(() => ({}))
  .commandEnvelope(input => ({ dateTime: input.dateTime ?? clock() }), dates)
  .build();
```

Applications already using Zod can instead pass `z.object({ dateTime: z.date() })`
as that parser (`z` is the application's optional Zod import). Neither parser is
an automatic JSON date decoder: decode serialized strings explicitly first.
