# @redemeine/mirage

## 1.0.0-pre.7

### Major Changes

- [#160](https://github.com/surikaterna/redemeine/pull/160) [`d5e5ec9`](https://github.com/surikaterna/redemeine/commit/d5e5ec9212759ea5e9a86fc196d06596334c05c6) Thanks [@spralle](https://github.com/spralle)! - Retire obsolete public execution APIs (redemeine-skpd, bounded surface and event-dispatch slices).

  Use `commandMetadata(built, localName).targets` instead of `pure.commandTargets`.
  Command creators now expose only declared flat keys, including mounted names;
  undeclared nested creator paths no longer fabricate command envelopes or inject IDs.
  Use `eventNameOverrides` and `commandNameOverrides` for mount options instead of
  `eventOverrides` and `commandOverrides`. Definition-level override fields, raw
  command processors/event projectors, and current plugin and host contracts remain.

  Remove the public `parseTargetedEventPath` export and all inferred event routing.
  Events now match exact compiled wire registrations pairing a projector with its target
  chain. Undeclared targeted-looking wires and synthetic unscoped entity-only wires use
  `onUnmatchedEvent` or the default warning; invalid targets on known mounted wires throw
  before projection. Declared dotted root names stay root-owned, scoped wires beat root
  wire collisions, and the last actual scoped assignment wins as a complete pair.
  Compiled event target chains snapshot their steps, state paths, and primary-key arrays;
  later mutations of public reflection or caller-owned options cannot redirect replay.
  The low-level source `applyEvent` / `applyEventToDraft` helpers now take one explicit
  `CompiledEventDispatch` map instead of positional projector/override/target tables;
  built aggregate `apply(state, event)` and `applyToDraft(draft, event)` are unchanged.
  Naming formatters (including the targeted naming preset) remain. Mounted commands and
  events now route only by declared leaf primary-key fields (map `key`) and exact
  registered ancestor command prefixes plus capitalized primary-key fields. Missing
  canonical fields and ambiguous layouts fail; inferred aliases and the private
  `__entityPk` payload protocol are retired. Former aliases and authored `__entityPk`
  are ordinary business data. Mirage injects only canonical leaf fields and preserves
  business arguments. Consumers, including host/bridge handlers, must carry canonical
  identities into emitted events; client/server adoption is outside this slice.

  Bridge definitions now require an explicit nonempty string `aggregateType` and
  reject invalid types before lifecycle inspection. Command-wire inference and the
  `unknown` fallback are removed. The obsolete `AggregateBase` option and its named
  migration guard are retired; it is not a public option or an implementation hook.
  Demeine constructor services and the owned host-adaptation lifecycle remain supported.

  Validate every list PK declaration, including behaviorless/composed mounts, at registration
  and build capture. Only an absent (`undefined`) declaration defaults to `id`; empty names,
  empty lists, duplicates, and invalid JavaScript declaration types reject before execution.
  All nonempty field names, including `__proto__`, remain supported as own identity predicates;
  empty-string and zero identity values remain valid. Caller arrays remain mutable and built
  dispatch/query snapshots stay detached (redemeine-skpd C1/C2).

  Treat declared command and event names such as `__proto__`, `constructor`, and `toString`
  as ordinary own registration keys through component composition, compilation, creators,
  metadata, and exact replay. This does not relax host/bridge reserved-method collision rules
  (redemeine-skpd, PR160 r4386301131).

### Patch Changes

- [#154](https://github.com/surikaterna/redemeine/pull/154) [`91f0c2c`](https://github.com/surikaterna/redemeine/commit/91f0c2c8619eeeaa964c7bc8b7985bc867e95591) Thanks [@spralle](https://github.com/spralle)! - Treat callable command definitions as shorthand even when they carry a `pack`
  property. Scoped Mirage calls now supply the single object payload with selected
  identifiers, matching Aggregate's callable-first classification. Non-callable
  `{ pack, handler }` definitions retain their packed argument prefixes.

- [#160](https://github.com/surikaterna/redemeine/pull/160) [`d5e5ec9`](https://github.com/surikaterna/redemeine/commit/d5e5ec9212759ea5e9a86fc196d06596334c05c6) Thanks [@spralle](https://github.com/spralle)! - Normalize numeric and bigint identity components to their exact string forms in Mirage's internal entity cache keys. Match Aggregate scalar identity equality without bigint serialization errors or precision loss, while preserving composite field boundaries, version invalidation, and original state, command and event values.

- [#160](https://github.com/surikaterna/redemeine/pull/160) [`e99c57a`](https://github.com/surikaterna/redemeine/commit/e99c57a421af3d9e9c7c42c4d20ea63ac44db962) Thanks [@spralle](https://github.com/spralle)! - Preserve authored packed/shorthand command forms in entity command types. Selected Mirage commands inject only identity fields for object payloads, retaining required business fields, while packed commands omit the selected identity prefix. Reject conflicting caller identity on selected object commands instead of overriding selection.

- [#160](https://github.com/surikaterna/redemeine/pull/160) [`e99c57a`](https://github.com/surikaterna/redemeine/commit/e99c57a421af3d9e9c7c42c4d20ea63ac44db962) Thanks [@spralle](https://github.com/spralle)! - Execute mounted commands against the selected readonly entity instead of the aggregate root. Compile list/map target chains during mounting, validate existing targets before invoking handlers, and give nested command factories their own selectors. Preserve command definitions, contextual emits and intents. Replay registered scoped events through their compiled nested targets using existing identity fields, preserve falsy identifiers, and retain target metadata for surviving commands across repeated mounts.

  Resolve nested commands and replay using declared canonical leaf primary-key fields and exact qualified ancestor identities.

  Preserve resolved root event ownership when mounted entities reuse the same JavaScript event key. Keep scoped entity handlers and target chains independent, without changing entity-only last-mounted fallbacks or exact scoped wire collision precedence (GitHub #157).

  Require qualified identity fields for every ancestor, including custom and composite primary keys, so an unqualified leaf field is not compared against an ancestor with the same field name. This intentionally rejects previously accepted unqualified ancestor payloads such as `{ code: parentCode, id: childId }`; use `{ parentsCode: parentCode, id: childId }` instead. Ancestor qualification uses only the exact registered prefix (PR #156, Kenny r4359327745).

  Expose detached readonly final command-target provenance by local command name. Mirage uses each winning command's registration to derive canonical identity and packed arguments from the selected record across repeated mounts, preserving the live selection while rejecting incompatible or root-winning selected invocations before hooks.

  Add the standalone `commandMetadata(aggregate, commandKey)` query for compiled local registrations and final wire winners. Capture creators, dispatch and detached readonly target metadata from one registration snapshot, retained through supported plugin decoration. Mirage rejects wire-shadowed selected commands before packing or hooks, including collisions between different local names. Native concrete wire commands retain last-registration-wins dispatch.

  Preserve per-command scoped identity omission and packed prefix lengths across explicit repeated registrations, with latest-wins selection and command replacement. Optional object shorthand retains optionality and business-field checking. Selected shorthand rejects non-object payloads before creators/hooks instead of wrapping primitives in a `value` field; explicit packed scalar arguments and root shorthand remain supported.

  Preserve discriminated object payload branches when omitting injected identity fields. Admit explicitly bound earlier selector roles using surviving final command registrations, while retaining role-only command access and rejecting missing, root-winning, or incompatible registrations.

- [#160](https://github.com/surikaterna/redemeine/pull/160) [`d5e5ec9`](https://github.com/surikaterna/redemeine/commit/d5e5ec9212759ea5e9a86fc196d06596334c05c6) Thanks [@spralle](https://github.com/spralle)! - Omit unsupported descendant commands from selected parent proxies and scoped command types without blocking valid parent commands or changing flat nested command creators.

- Updated dependencies [[`db9bdf9`](https://github.com/surikaterna/redemeine/commit/db9bdf94a4358a45835dd85c7fbe3ff8ed410892), [`adca961`](https://github.com/surikaterna/redemeine/commit/adca96123e1a2fb9ff4740286c1bbdc9db5d9996), [`d5e5ec9`](https://github.com/surikaterna/redemeine/commit/d5e5ec9212759ea5e9a86fc196d06596334c05c6), [`e99c57a`](https://github.com/surikaterna/redemeine/commit/e99c57a421af3d9e9c7c42c4d20ea63ac44db962), [`e99c57a`](https://github.com/surikaterna/redemeine/commit/e99c57a421af3d9e9c7c42c4d20ea63ac44db962), [`d5e5ec9`](https://github.com/surikaterna/redemeine/commit/d5e5ec9212759ea5e9a86fc196d06596334c05c6), [`eb0d2e4`](https://github.com/surikaterna/redemeine/commit/eb0d2e419bbeadd3018b5a6f8e2375a68f4cddef)]:
  - @redemeine/aggregate@1.0.0-pre.7
  - @redemeine/kernel@0.2.0-pre.3

## 1.0.0-pre.6

### Patch Changes

- [#150](https://github.com/surikaterna/redemeine/pull/150) [`63c3068`](https://github.com/surikaterna/redemeine/commit/63c3068c39ed94ab9e047dacd88c5d8631ebc4d8) Thanks [@spralle](https://github.com/spralle)! - Let eventEnvelope output own typed headers, using its existing initializer/parser/recipe API in Aggregate, bridge and Mirage. Replace the unreleased boolean propagation flag with an explicit plugin-owned selection/validation policy. One writer may replace raw event headers; a second writer throws without implicit merging. Required header properties (whose value may be undefined) preserve sound prepared types, and installed data is detached. Callbacks retain registration order; there is no header prepass or universal copy default. An output with own undefined headers now creates that property even when the input omitted it. Command headers remain reserved in command extensions; metadata and replay are unchanged.

- Updated dependencies [[`696b850`](https://github.com/surikaterna/redemeine/commit/696b850bcf181d6e0de6494e8c10f39479515117), [`696b850`](https://github.com/surikaterna/redemeine/commit/696b850bcf181d6e0de6494e8c10f39479515117), [`63c3068`](https://github.com/surikaterna/redemeine/commit/63c3068c39ed94ab9e047dacd88c5d8631ebc4d8)]:
  - @redemeine/aggregate@1.0.0-pre.6

## 1.0.0-pre.5

### Patch Changes

- Updated dependencies [[`72d0a7b`](https://github.com/surikaterna/redemeine/commit/72d0a7b8f3ca11413b06215d9076a27bc5c3fbdd)]:
  - @redemeine/aggregate@1.0.0-pre.5

## 1.0.0-pre.4

### Major Changes

- [#143](https://github.com/surikaterna/redemeine/pull/143) [`4d5f4de`](https://github.com/surikaterna/redemeine/commit/4d5f4de5ee0240a995396251a1cbde76bd471d4c) Thanks [@spralle](https://github.com/spralle)! - BREAKING: expose coherent readonly aggregate state views for initial templates,
  commands, selectors, preparation and immutable application results, while keeping
  the original model for writable Immer drafts. Event-plugin mounting now uses
  Immer structural sharing and default auto-freeze instead of a writable shallow
  copy. Callers relinquish mutation rights to shared template data from creation;
  they must not assign readonly results to mutable model variables or mutate aliases.

  Mirage and Projection recover the original model marker for snapshot and reducer
  inference (with an initialState fallback for structural sources). Mirage public
  state views preserve callable Date readers without exposing setters. The Saga
  execution bridge now honestly exposes/stores readonly aggregate results; persistence
  callbacks must accept readonly views rather than assuming mutable model ownership.

  Keep replacement event-map generics scoped in inferred downstream declarations,
  fixing a pre-existing free `NewE` reference in Saga Runtime's generated public API.

### Minor Changes

- [#144](https://github.com/surikaterna/redemeine/pull/144) [`7c76529`](https://github.com/surikaterna/redemeine/commit/7c765293c17ba62fc89b701b96f8fb9c2aa20b76) Thanks [@spralle](https://github.com/spralle)! - Prepare aggregate command envelopes after Mirage routing and before legacy lifecycle hooks, preserving enriched events through Depot persistence and replay.

### Patch Changes

- [#143](https://github.com/surikaterna/redemeine/pull/143) [`ec16bcb`](https://github.com/surikaterna/redemeine/commit/ec16bcba7a193cd1ed687f48acc4a57ef72d4656) Thanks [@spralle](https://github.com/spralle)! - Reject aggregate event descriptors passed as host lifecycle plugins with guidance to attach them through Aggregate.plugins or built.withPlugins. Stateful aggregate event plugins execute through the existing application path.

- Updated dependencies [[`ec16bcb`](https://github.com/surikaterna/redemeine/commit/ec16bcba7a193cd1ed687f48acc4a57ef72d4656), [`4d5f4de`](https://github.com/surikaterna/redemeine/commit/4d5f4de5ee0240a995396251a1cbde76bd471d4c), [`7c76529`](https://github.com/surikaterna/redemeine/commit/7c765293c17ba62fc89b701b96f8fb9c2aa20b76)]:
  - @redemeine/aggregate@1.0.0-pre.4

## 1.0.0-pre.3

### Major Changes

- [#137](https://github.com/surikaterna/redemeine/pull/137) [`4744e8d`](https://github.com/surikaterna/redemeine/commit/4744e8d9266faccdc83c16776f57514e46fe4182) Thanks [@spralle](https://github.com/spralle)! - Make native Mirage version an event count: initial persisted baseline plus
  successfully replayed tail plus successfully applied live events. Add setup-only
  `initialVersion` (nonnegative safe integer, default zero, always BEFORE replay).
  Depot propagates snapshot counts and supplies the PRE-APPEND persisted count to
  `saveEvents.expectedVersion`, rather than a post-command value. Event-applied
  hooks now observe the just-applied event's version; zero-event commands do not
  increment it. Domain `version` properties remain unreserved.

  Event counts cannot exceed `Number.MAX_SAFE_INTEGER`. The ceiling is a valid
  baseline for empty replay/zero-event commands. Overflow throws `RangeError`
  before applying or buffering the offending live event, preserving any successful
  prefix. Hydration rejects before that event's hydration plugins or application;
  no rounded-version instance is returned and prior plugin effects are not undone.

  Breaking migration gate (redemeine-ov0e.7): retain authoritative store event counts,
  but rebuild historical command-count/reset-to-zero checkpoints from full event
  history or provide an operator-verified baseline. No arithmetic conversion or
  automatic data migration is provided. Audit and qualify adapters for pre-append
  comparison, inclusive 1-based snapshot-tail reads, and zero-based backend revision
  translation before consumer cutover. State-only snapshots default to baseline 0.

  Dispatch/save must remain serialized. This does not fix the existing concurrent
  buffer-clearing race (redemeine-98zi). Partial application retains counted events;
  command intents may not merge on failure. After-command hooks remain pre-apply;
  after-commit failures do not roll back storage or restore cleared pending events.
  This change is independent of standalone interop and introduces no shared runtime.

- [#137](https://github.com/surikaterna/redemeine/pull/137) [`f929559`](https://github.com/surikaterna/redemeine/commit/f929559eaa5f5b902f8759d8b8330cd7d2e107a8) Thanks [@spralle](https://github.com/spralle)! - Make Mirage read-side state and command results readonly and isolate supplied
  initial states/snapshots. Entity-list iteration and array callbacks return scoped
  proxies; scoped commands return readonly entity state. Remove unsupported map-root
  commands and require explicit keys. Missing direct entity selections throw.

  Resolve bound selector entities by declared role/mount instead of key shape;
  ambiguous/reused roles require explicit mount selection. Plain selector data stays
  readonly data: use bindContext for scoped commands. Selector utilities are captured
  by the Aggregate selector factory rather than inferred from function arity.

  Preserve selector/state/command inference in Depot and check runtime builder
  ownership on save. Raw dispatch accepts a command envelope and retains the state
  return type. Known namespace collisions and protocol names refuse construction.
  MirageCoreSymbol exposes readonly diagnostics, not a mutable implementation.

  Add mandatory source and built-declaration contract checks, including negative
  and accidental-any assertions, and include Mirage in code-principles enforcement.
  Event-count versioning and documented partial-failure semantics remain unchanged;
  dispatch/save concurrency and production data migration are not implemented here.
  The test-depot adapter now drains events through public Mirage helpers instead
  of mutating its private core through a symbol.

  Preserve safe object coercion on readonly proxies. Resolve subset-role command
  names with real Aggregate construction contexts and mount-local caching rather
  than empty placeholder contexts, preserving explicit subset-role bindings.
  Restore entity-map iteration with typed readonly scoped proxies rather than raw
  values, and use the OS temporary directory for portable packed qualification.

### Patch Changes

- Updated dependencies [[`f929559`](https://github.com/surikaterna/redemeine/commit/f929559eaa5f5b902f8759d8b8330cd7d2e107a8), [`7f5c04f`](https://github.com/surikaterna/redemeine/commit/7f5c04f6272361f14a476ff670fe942672047e73)]:
  - @redemeine/aggregate@1.0.0-pre.3

## 1.0.0-pre.2

### Major Changes

- [#134](https://github.com/surikaterna/redemeine/pull/134) [`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3) Thanks [@spralle](https://github.com/spralle)! - Move the legacy bridge out of Mirage into the new demeine-interop package. The
  replacement API requires the application's Aggregate base and returns a constructor,
  preserving its sink, dispatchers, queue, replay and reserved deletion lifecycle.
  Mirage no longer exports the old callable bridge. Kernel, aggregate and interop now
  provide independent CommonJS and ESM entry points with matching declarations.

### Patch Changes

- Updated dependencies [[`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3)]:
  - @redemeine/kernel@0.2.0-pre.2
  - @redemeine/aggregate@0.2.0-pre.2

## 0.2.0-pre.1

### Patch Changes

- [#99](https://github.com/surikaterna/redemeine/pull/99) [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea) Thanks [@kennyek](https://github.com/kennyek)! - Replace bun with pnpm.

- Updated dependencies [[`15373fa`](https://github.com/surikaterna/redemeine/commit/15373fab154f77123fee0345dce2362c713a9d26), [`0fac88c`](https://github.com/surikaterna/redemeine/commit/0fac88c5bcaeae48c164556f3a0f70f375233f77), [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea)]:
  - @redemeine/aggregate@0.2.0-pre.1
  - @redemeine/kernel@0.2.0-pre.1

## 0.2.0-pre.0

### Minor Changes

- Initial release of the Redemeine CQRS/ES library. Provides type-safe event-sourced aggregates, projections, in-memory testing infrastructure, and test utilities built on sane defaults.

### Patch Changes

- Updated dependencies []:
  - @redemeine/kernel@0.2.0-pre.0
  - @redemeine/aggregate@0.2.0-pre.0
