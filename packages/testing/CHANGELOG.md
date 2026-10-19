# @redemeine/testing

## 0.2.0-pre.4

### Patch Changes

- Updated dependencies [[`4d5f4de`](https://github.com/surikaterna/redemeine/commit/4d5f4de5ee0240a995396251a1cbde76bd471d4c), [`7c76529`](https://github.com/surikaterna/redemeine/commit/7c765293c17ba62fc89b701b96f8fb9c2aa20b76), [`ec16bcb`](https://github.com/surikaterna/redemeine/commit/ec16bcba7a193cd1ed687f48acc4a57ef72d4656)]:
  - @redemeine/mirage@1.0.0-pre.4
  - @redemeine/projection@0.2.0-pre.3
  - @redemeine/saga@0.1.1-pre.4

## 0.2.0-pre.3

### Patch Changes

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

- Updated dependencies [[`4744e8d`](https://github.com/surikaterna/redemeine/commit/4744e8d9266faccdc83c16776f57514e46fe4182), [`f929559`](https://github.com/surikaterna/redemeine/commit/f929559eaa5f5b902f8759d8b8330cd7d2e107a8), [`9cc4763`](https://github.com/surikaterna/redemeine/commit/9cc4763f4a199f310a780f5587cda0389d4b5b9c)]:
  - @redemeine/mirage@1.0.0-pre.3
  - @redemeine/projection@0.2.0-pre.2
  - @redemeine/saga@0.1.1-pre.3

## 0.2.0-pre.2

### Patch Changes

- Updated dependencies [[`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3)]:
  - @redemeine/mirage@1.0.0-pre.2
  - @redemeine/projection@0.2.0-pre.1
  - @redemeine/saga@0.1.1-pre.2

## 0.2.0-pre.1

### Patch Changes

- [#127](https://github.com/surikaterna/redemeine/pull/127) [`0fac88c`](https://github.com/surikaterna/redemeine/commit/0fac88c5bcaeae48c164556f3a0f70f375233f77) Thanks [@spralle](https://github.com/spralle)! - Bundle testing's private projection runtime implementation while keeping public
  contracts external. Resolve aggregate and saga dependencies to the matching
  workspace release when packing with pnpm, instead of old prerelease pins.

- [#99](https://github.com/surikaterna/redemeine/pull/99) [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea) Thanks [@kennyek](https://github.com/kennyek)! - Replace bun with pnpm.

- Updated dependencies [[`bc4c228`](https://github.com/surikaterna/redemeine/commit/bc4c228899d2d5a3eda430d1e0d578571461fb87), [`b425b78`](https://github.com/surikaterna/redemeine/commit/b425b786dbfec709a789b5a84a61590c91cca17f), [`b902445`](https://github.com/surikaterna/redemeine/commit/b90244571a8d7934f5acb22b844b6f0d66d77dd2), [`c9fbd23`](https://github.com/surikaterna/redemeine/commit/c9fbd231c9748812295a4d8122f94a46dd3b5e80), [`15373fa`](https://github.com/surikaterna/redemeine/commit/15373fab154f77123fee0345dce2362c713a9d26), [`4d17590`](https://github.com/surikaterna/redemeine/commit/4d17590776e98161da557178ac7562e42dfb3d4e), [`0fac88c`](https://github.com/surikaterna/redemeine/commit/0fac88c5bcaeae48c164556f3a0f70f375233f77), [`e0afb8a`](https://github.com/surikaterna/redemeine/commit/e0afb8aa5e88e2930a18c7a870383d76fb977762), [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea)]:
  - @redemeine/projection@0.2.0-pre.1
  - @redemeine/saga@0.1.1-pre.1
  - @redemeine/mirage@0.2.0-pre.1

## 0.2.0-pre.0

### Minor Changes

- Initial release of the Redemeine CQRS/ES library. Provides type-safe event-sourced aggregates, projections, in-memory testing infrastructure, and test utilities built on sane defaults.

### Patch Changes

- Updated dependencies []:
  - @redemeine/projection@0.2.0-pre.0
  - @redemeine/mirage@0.2.0-pre.0
  - @redemeine/saga@0.1.1-pre.0
