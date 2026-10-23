# @redemeine/aggregate

## 1.0.0-pre.7

### Patch Changes

- [#151](https://github.com/surikaterna/redemeine/pull/151) [`db9bdf9`](https://github.com/surikaterna/redemeine/commit/db9bdf94a4358a45835dd85c7fbe3ff8ed410892) Thanks [@spralle](https://github.com/spralle)! - Infer named entity command creators using their mount aliases, and accept concrete required, optional, and rest selector arguments in entity and mixin builders without widening their inferred signatures. Runtime behavior is unchanged.

  Preserve root and required named command creators when a named entity map includes optional mounts, without promising creators for possibly absent mounts.

- [#153](https://github.com/surikaterna/redemeine/pull/153) [`adca961`](https://github.com/surikaterna/redemeine/commit/adca96123e1a2fb9ff4740286c1bbdc9db5d9996) Thanks [@spralle](https://github.com/spralle)! - Preserve all registered entity and value object mounts when extending an aggregate builder, with registration-array snapshots that isolate later parent and child additions.

  Type aggregate and mixin selectors according to existing replacement order: root registrations first, then stored mixins with the last writer winning. Built selectors and command factories registered after composition now include mixin selectors. Widened arrays conservatively retain root fallbacks and optional keys rather than assuming a final member; order precision is not retained after an unknown-length spread. Callbacks registered before later builder mutation are not retyped.

- [#154](https://github.com/surikaterna/redemeine/pull/154) [`eb0d2e4`](https://github.com/surikaterna/redemeine/commit/eb0d2e419bbeadd3018b5a6f8e2375a68f4cddef) Thanks [@spralle](https://github.com/spralle)! - Align shorthand command declarations with the existing single-payload runtime
  contract across Aggregate, Mixin, and Entity builders. Reject multiple payload
  slots (including an optional second slot) and unbounded rest parameters; use the
  existing `{ pack, handler }` form for multi-argument public APIs. Correct optional
  single-payload command values to `P | undefined` while preserving caller arity,
  required payloads, and no-payload `void` semantics.

  This is a patch type-safety correction, following the existing unsupported-input
  typing-fix convention: previously accepted multi-argument shorthand programs
  already dropped arguments at runtime. No valid runtime behavior or packing
  policy changes. Broad shorthand annotations that erase safe arity must retain
  concrete signatures instead. No manifest versions are changed by this Changeset.

  Update the domain example's multi-argument identifier command to the supported
  `{ pack, handler }` form and exercise its emitted event and projected identifier.

- Updated dependencies [[`db9bdf9`](https://github.com/surikaterna/redemeine/commit/db9bdf94a4358a45835dd85c7fbe3ff8ed410892)]:
  - @redemeine/kernel@0.2.0-pre.3

## 1.0.0-pre.6

### Minor Changes

- [#150](https://github.com/surikaterna/redemeine/pull/150) [`63c3068`](https://github.com/surikaterna/redemeine/commit/63c3068c39ed94ab9e047dacd88c5d8631ebc4d8) Thanks [@spralle](https://github.com/spralle)! - Let eventEnvelope output own typed headers, using its existing initializer/parser/recipe API in Aggregate, bridge and Mirage. Replace the unreleased boolean propagation flag with an explicit plugin-owned selection/validation policy. One writer may replace raw event headers; a second writer throws without implicit merging. Required header properties (whose value may be undefined) preserve sound prepared types, and installed data is detached. Callbacks retain registration order; there is no header prepass or universal copy default. An output with own undefined headers now creates that property even when the input omitted it. Command headers remain reserved in command extensions; metadata and replay are unchanged.

### Patch Changes

- [#150](https://github.com/surikaterna/redemeine/pull/150) [`696b850`](https://github.com/surikaterna/redemeine/commit/696b850bcf181d6e0de6494e8c10f39479515117) Thanks [@spralle](https://github.com/spralle)! - Fix command preparation types to preserve discriminant/payload correlation without promising undeclared raw extras. Reject reserved keys anywhere in command-envelope initializer or parser output unions, and require envelope parsers to accept unknown input. These typing corrections reject unsupported inputs already unsafe at runtime; runtime preparation and parsing behavior are unchanged.

  Align builder event-envelope types with post-build attachment: only guaranteed header writers replace canonical unknown headers. Optional descriptors and ordinary plugin arrays cannot promise validated headers, including through chained attachment, while guaranteed union writers retain exact correlated body and header branches. Runtime event processing is unchanged.

  Preserve command and event descriptor union alternatives in ordinary arrays instead of intersecting them into never. Track guaranteed and possible contributions separately through builder and attachment chains, so absent descriptors and emptyable arrays cannot constrain a guaranteed writer's overlapping fields. Possible arrays use partial whole branches with optional companion fields to admit disjoint subsets without exponential subset inference; optional discriminants do not prove other field presence. Runtime collision handling and public preparation policy are unchanged.

  Account for optional output keys in both possible and guaranteed composition: optional anchor keys include companion writer values, required writers dominate competing optional keys on successful preparation, and two optional writers retain optional union values. Preserve whole output-branch correlation and required own-undefined writes without changing runtime collision semantics.

  Keep source-event validation declarations well-formed when bundled into downstream packages, without losing raw registration checks across builder batches.

- [#150](https://github.com/surikaterna/redemeine/pull/150) [`696b850`](https://github.com/surikaterna/redemeine/commit/696b850bcf181d6e0de6494e8c10f39479515117) Thanks [@spralle](https://github.com/spralle)! - Route explicitly overridden root and mixin event types to their root projectors before targeted path traversal, while preserving exact mounted event priority and existing wire names.

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
