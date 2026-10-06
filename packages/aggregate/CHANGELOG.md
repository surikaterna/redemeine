# @redemeine/aggregate

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
