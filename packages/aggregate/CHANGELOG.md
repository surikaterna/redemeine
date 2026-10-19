# @redemeine/aggregate

## 1.0.0-pre.5

### Minor Changes

- [#148](https://github.com/surikaterna/redemeine/pull/148) [`72d0a7b`](https://github.com/surikaterna/redemeine/commit/72d0a7b8f3ca11413b06215d9076a27bc5c3fbdd) Thanks [@spralle](https://github.com/spralle)! - Allow createAggregatePlugin and createAggregatePluginFor to declare command/event
  envelopes without calling state(). Stateless plugins enrich prepared envelope types
  without mounting aggregate state or requiring snapshot namespaces. Preserve readonly
  domain context, source/identity checks, ordered recipes and existing bridge pre-sink
  preparation. State reducers still require an explicit state initializer; existing
  state(() => ({})) plugins retain their stateful behavior and migration requirements.

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

- [#143](https://github.com/surikaterna/redemeine/pull/143) [`ec16bcb`](https://github.com/surikaterna/redemeine/commit/ec16bcba7a193cd1ed687f48acc4a57ef72d4656) Thanks [@spralle](https://github.com/spralle)! - Add stateful Aggregate event plugin builders, immutable typed descriptors, builder registration and immutable built decoration. Apply domain projectors and plugin event handlers in one synchronous Immer transaction, including through Mirage, Depot replay, and the default demeine bridge event handler. Declare Immer for installed consumer Draft types. Existing snapshots need explicit migration for newly mounted plugin namespaces. Command preparation and persistence-plugin migration are deferred; existing lifecycle APIs remain unchanged.

- [#144](https://github.com/surikaterna/redemeine/pull/144) [`7c76529`](https://github.com/surikaterna/redemeine/commit/7c765293c17ba62fc89b701b96f8fb9c2aa20b76) Thanks [@spralle](https://github.com/spralle)! - Add symmetric command/event envelope descriptors and synchronous preparation recipes to aggregate plugin builders. Built aggregates expose `prepareCommand` and execute command/event preparation during `process`, with detached readonly snapshots (including cross-realm data), reserved-key/collision guards and plan-scoped repeat suppression. Mirage and Demeine bridge host integration ships in their accompanying minor changesets. Envelope-only declarations use `.state(() => ({}))`. Optional structural parsers validate or transform initializer and final recipe output, not incoming envelopes; historical reducer inputs are not automatically extended or validated, and replay never prepares.

### Patch Changes

- Export the AggregateDecoration type so inferred aggregates can emit portable declarations from the public package entry point, including plugin-mounted aggregates.

## 1.0.0-pre.3

### Major Changes

- [#116](https://github.com/surikaterna/redemeine/pull/116) [`7f5c04f`](https://github.com/surikaterna/redemeine/commit/7f5c04f6272361f14a476ff670fe942672047e73) Thanks [@spralle](https://github.com/spralle)! - BREAKING: Default aggregate events now use flat snake_case names (`itemAdded` becomes `order.item_added.event` instead of `order.item.added.event`). Commands remain unchanged. Consumers expecting the former dot-path event names can opt in with `.naming(namingStrategies.targeted)` and must update handler names/subscriptions otherwise. This project is greenfield with no stored events to migrate; no event-store migration is included.

### Minor Changes

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

## 0.2.0-pre.2

### Minor Changes

- [#134](https://github.com/surikaterna/redemeine/pull/134) [`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3) Thanks [@spralle](https://github.com/spralle)! - Move the legacy bridge out of Mirage into the new demeine-interop package. The
  replacement API requires the application's Aggregate base and returns a constructor,
  preserving its sink, dispatchers, queue, replay and reserved deletion lifecycle.
  Mirage no longer exports the old callable bridge. Kernel, aggregate and interop now
  provide independent CommonJS and ESM entry points with matching declarations.

### Patch Changes

- Updated dependencies [[`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3)]:
  - @redemeine/kernel@0.2.0-pre.2

## 0.2.0-pre.1

### Patch Changes

- [#88](https://github.com/surikaterna/redemeine/pull/88) [`15373fa`](https://github.com/surikaterna/redemeine/commit/15373fab154f77123fee0345dce2362c713a9d26) Thanks [@spralle](https://github.com/spralle)! - Prepare @redemeine/aggregate and @redemeine/saga for prerelease publishing by using npm-compatible prerelease dependency metadata and generating saga declaration files.

- [#127](https://github.com/surikaterna/redemeine/pull/127) [`0fac88c`](https://github.com/surikaterna/redemeine/commit/0fac88c5bcaeae48c164556f3a0f70f375233f77) Thanks [@spralle](https://github.com/spralle)! - Bundle testing's private projection runtime implementation while keeping public
  contracts external. Resolve aggregate and saga dependencies to the matching
  workspace release when packing with pnpm, instead of old prerelease pins.

- [#99](https://github.com/surikaterna/redemeine/pull/99) [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea) Thanks [@kennyek](https://github.com/kennyek)! - Replace bun with pnpm.

- Updated dependencies [[`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea)]:
  - @redemeine/kernel@0.2.0-pre.1

## 0.2.0-pre.0

### Minor Changes

- Initial release of the Redemeine CQRS/ES library. Provides type-safe event-sourced aggregates, projections, in-memory testing infrastructure, and test utilities built on sane defaults.

### Patch Changes

- Updated dependencies []:
  - @redemeine/kernel@0.2.0-pre.0
