# @redemeine/testing

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
