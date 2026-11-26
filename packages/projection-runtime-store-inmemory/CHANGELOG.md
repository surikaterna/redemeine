# @redemeine/projection-runtime-store-inmemory

## 0.2.0-pre.1

### Minor Changes

- [#175](https://github.com/surikaterna/redemeine/pull/175) [`968c015`](https://github.com/surikaterna/redemeine/commit/968c015aabb41c01b78726278a73a7b67d34de25) Thanks [@spralle](https://github.com/spralle)! - Enable durable change recording per projection generation in the coordinator and queue manifest. Stores atomically persist ordered, fine-grained JSON Patch transitions and revision receipts; `none` retains at-least-once application semantics. Source turns can pass ordered patch hints and the final document even when history is off. MongoDB plans native revision-guarded writes from one prepared snapshot and uses an acknowledged single-document update for eligible inline turns.

  Commit-native `afterEach` hooks run synchronously on the same Immer draft as the handler; their effects are finalized and captured together.

  Runtime state diagnostics are independently opt-in. The native Mongo path uses genuine same-store captures without replay or defensive whole-state freezing; trusted handlers must edit only the synchronous draft and must not retain or mutate state aliases. Direct untrusted requests retain verification or fall back to full writes.

  Pin Immer 11.2.10 across packages sharing draft APIs. Its finalizer avoids revisiting untouched array items in the Mongo draft-only path when a recipe reads one item and edits another.

  Reject empty document targets, staged link identifiers, and recorded transition event identifiers before writing the recorded turn.

### Patch Changes

- Updated dependencies [[`968c015`](https://github.com/surikaterna/redemeine/commit/968c015aabb41c01b78726278a73a7b67d34de25)]:
  - @redemeine/projection-runtime-core@1.0.0-pre.1

## 0.1.1-pre.0

### Patch Changes

- [#113](https://github.com/surikaterna/redemeine/pull/113) [`722d1fe`](https://github.com/surikaterna/redemeine/commit/722d1fe667e8f003a0524b7752a568c10c8fe07d) Thanks [@spralle](https://github.com/spralle)! - Require explicit per-source accepted-baseline admission metadata for commit-native dispatch, and compare legacy document state and checkpoint before the first transactional v2 write. The source order port now requires an immutable cutover scope and anchor; old implementations must provide them before using this coordinator.

- [#99](https://github.com/surikaterna/redemeine/pull/99) [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea) Thanks [@kennyek](https://github.com/kennyek)! - Replace bun with pnpm.

- Updated dependencies [[`722d1fe`](https://github.com/surikaterna/redemeine/commit/722d1fe667e8f003a0524b7752a568c10c8fe07d), [`5c1b325`](https://github.com/surikaterna/redemeine/commit/5c1b325e632c9d2ca0830ec4ef120fd78c16b382), [`5fe413f`](https://github.com/surikaterna/redemeine/commit/5fe413f28dfe285d062b316217674601029c0046), [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea)]:
  - @redemeine/projection-runtime-core@1.0.0-pre.0
