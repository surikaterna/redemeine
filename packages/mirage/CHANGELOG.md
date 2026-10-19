# @redemeine/mirage

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
