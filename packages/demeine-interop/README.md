# @redemeine/demeine-interop

Adapt a **built** Redemeine aggregate to an application-supplied legacy `demeine`
Aggregate. This replaces the removed Mirage bridge; it is not a Mirage runtime.

```ts
import demeine from 'demeine';
import { createDemeineBridge } from '@redemeine/demeine-interop';
import { definition } from './definition.js';

const { Aggregate } = demeine;

const Counter = createDemeineBridge(definition, {
  AggregateBase: Aggregate,
  envelope(event, command, aggregate) {
    // Optional synchronous, application-specific envelope enrichment.
    return { ...event, aggregateId: aggregate.id };
  },
});
const counter = new Counter(commandSink, eventHandler, commandHandler);
await counter.add(2); // Same arguments/pack behavior as definition.commandCreators.add
```

The constructor is a real subclass (`instanceof Aggregate`). It retains the
supplied sink, base UUID, command queue, promised-command support, errors, replay,
snapshot, version and uncommitted-event behavior. Initial state is cloned per
instance. Later factory assignments to `id`, `type` and `_state` are authoritative;
replacement state is not merged with defaults. Shortcuts supply only a missing
aggregateId and enter `_sink`; mismatched identities remain errors. Without a
sink, the inherited local sink calls `_process` but does not persist anything.

## Handlers and envelopes

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

Inherited `delete()` enters the sink with `$stream.delete.command`; both generated
and real Default* dispatchers reach inherited `processDelete` / `applyDeleted`.
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

- Qualified fixture: actual `demeine@1.3.0` Aggregate **and matching Repository**.
  It needs host `regenerator-runtime` (the legacy manifest incorrectly lists that
  runtime dependency under devDependencies). Tests explicitly provide 0.13.11.
  Native ESM must default-import this legacy CJS module, then take `Aggregate`;
  its generated barrel does not expose Node-detectable named ESM exports.
- No bundled/imported second demeine runtime; no Mirage, Depot or Surikat imports.
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
The source seed version is 0.1.0-pre.0, not a promise of the final Changesets
candidate. See `qualification/README.md` in the source tree for non-publishing
artifact reproduction. CLI remains a held, separately supplied developer tool.
