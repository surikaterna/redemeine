# @redemeine/mirage

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
