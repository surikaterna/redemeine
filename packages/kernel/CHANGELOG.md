# @redemeine/kernel

## 0.2.0-pre.3

### Patch Changes

- [#151](https://github.com/surikaterna/redemeine/pull/151) [`db9bdf9`](https://github.com/surikaterna/redemeine/commit/db9bdf94a4358a45835dd85c7fbe3ff8ed410892) Thanks [@spralle](https://github.com/spralle)! - Infer named entity command creators using their mount aliases, and accept concrete required, optional, and rest selector arguments in entity and mixin builders without widening their inferred signatures. Runtime behavior is unchanged.

  Preserve root and required named command creators when a named entity map includes optional mounts, without promising creators for possibly absent mounts.

## 0.2.0-pre.2

### Minor Changes

- [#134](https://github.com/surikaterna/redemeine/pull/134) [`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3) Thanks [@spralle](https://github.com/spralle)! - Move the legacy bridge out of Mirage into the new demeine-interop package. The
  replacement API requires the application's Aggregate base and returns a constructor,
  preserving its sink, dispatchers, queue, replay and reserved deletion lifecycle.
  Mirage no longer exports the old callable bridge. Kernel, aggregate and interop now
  provide independent CommonJS and ESM entry points with matching declarations.

## 0.2.0-pre.1

### Patch Changes

- [#99](https://github.com/surikaterna/redemeine/pull/99) [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea) Thanks [@kennyek](https://github.com/kennyek)! - Replace bun with pnpm.

## 0.2.0-pre.0

### Minor Changes

- Initial release of the Redemeine CQRS/ES library. Provides type-safe event-sourced aggregates, projections, in-memory testing infrastructure, and test utilities built on sane defaults.
