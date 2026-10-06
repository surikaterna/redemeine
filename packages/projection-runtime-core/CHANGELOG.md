# @redemeine/projection-runtime-core

## 1.0.0-pre.0

### Major Changes

- [#113](https://github.com/surikaterna/redemeine/pull/113) [`722d1fe`](https://github.com/surikaterna/redemeine/commit/722d1fe667e8f003a0524b7752a568c10c8fe07d) Thanks [@spralle](https://github.com/spralle)! - Require explicit per-source accepted-baseline admission metadata for commit-native dispatch, and compare legacy document state and checkpoint before the first transactional v2 write. The source order port now requires an immutable cutover scope and anchor; old implementations must provide them before using this coordinator.

### Minor Changes

- [#113](https://github.com/surikaterna/redemeine/pull/113) [`5c1b325`](https://github.com/surikaterna/redemeine/commit/5c1b325e632c9d2ca0830ec4ef120fd78c16b382) Thanks [@spralle](https://github.com/spralle)! - Require a separate polled-commit coordinator operation so indexed source catch-up shares source ordering without treating already covered commits as Rabbit redeliveries. Serving commits no longer expose rebuild-only receipt bypass.

- [#113](https://github.com/surikaterna/redemeine/pull/113) [`5fe413f`](https://github.com/surikaterna/redemeine/commit/5fe413f28dfe285d062b316217674601029c0046) Thanks [@spralle](https://github.com/spralle)! - Allow immutable queue registries to declare joined projection definitions for fail-closed cutover admission.

### Patch Changes

- [#99](https://github.com/surikaterna/redemeine/pull/99) [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea) Thanks [@kennyek](https://github.com/kennyek)! - Replace bun with pnpm.
