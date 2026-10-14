# @redemeine/aggregate

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
