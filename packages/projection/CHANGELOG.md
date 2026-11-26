# @redemeine/projection

## 0.2.0-pre.5

### Minor Changes

- [#175](https://github.com/surikaterna/redemeine/pull/175) [`968c015`](https://github.com/surikaterna/redemeine/commit/968c015aabb41c01b78726278a73a7b67d34de25) Thanks [@spralle](https://github.com/spralle)! - Enable durable change recording per projection generation in the coordinator and queue manifest. Stores atomically persist ordered, fine-grained JSON Patch transitions and revision receipts; `none` retains at-least-once application semantics. Source turns can pass ordered patch hints and the final document even when history is off. MongoDB plans native revision-guarded writes from one prepared snapshot and uses an acknowledged single-document update for eligible inline turns.

  Commit-native `afterEach` hooks run synchronously on the same Immer draft as the handler; their effects are finalized and captured together.

  Runtime state diagnostics are independently opt-in. The native Mongo path uses genuine same-store captures without replay or defensive whole-state freezing; trusted handlers must edit only the synchronous draft and must not retain or mutate state aliases. Direct untrusted requests retain verification or fall back to full writes.

  Pin Immer 11.2.10 across packages sharing draft APIs. Its finalizer avoids revisiting untouched array items in the Mongo draft-only path when a recipe reads one item and edits another.

  Reject empty document targets, staged link identifiers, and recorded transition event identifiers before writing the recorded turn.

## 0.2.0-pre.4

### Patch Changes

- [#174](https://github.com/surikaterna/redemeine/pull/174) [`2661989`](https://github.com/surikaterna/redemeine/commit/2661989d617334e7874922a3f2881fb769c317c2) Thanks [@spralle](https://github.com/spralle)! - Publish a CommonJS entry point and matching declarations alongside the existing ESM exports.

- [#174](https://github.com/surikaterna/redemeine/pull/174) [`916d5bc`](https://github.com/surikaterna/redemeine/commit/916d5bc9bf9acffe868d5c5b337a11da5f4a8cd0) Thanks [@spralle](https://github.com/spralle)! - Mirror canonical mounted events, preserving explicit overrides and inferring direct list/map mounted payloads from aggregate registry metadata. Nested and mixin events inherit at runtime; exhaustive static alias typing for their collisions remains limited by aggregate metadata.

## 0.2.0-pre.3

### Patch Changes

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

## 0.2.0-pre.2

### Patch Changes

- [#116](https://github.com/surikaterna/redemeine/pull/116) [`9cc4763`](https://github.com/surikaterna/redemeine/commit/9cc4763f4a199f310a780f5587cda0389d4b5b9c) Thanks [@spralle](https://github.com/spralle)! - Register projection handlers using the aggregate's resolved event-name map, so
  multiword snake_case defaults, explicit strategies and overrides dispatch correctly.
  Handler event types use the resolved map when available rather than inventing
  camelCase wire names; broad aggregate maps remain honestly typed as strings.
  Built handler maps are keyed by resolved wire names when a mapping is provided;
  direct handler-map consumers should use those names. Explicit wire keys and
  definitions without a name map retain their existing keys.

## 0.2.0-pre.1

### Minor Changes

- [#113](https://github.com/surikaterna/redemeine/pull/113) [`bc4c228`](https://github.com/surikaterna/redemeine/commit/bc4c228899d2d5a3eda430d1e0d578571461fb87) Thanks [@spralle](https://github.com/spralle)! - Add explicit per-projection commit deduplication strategies and a commit-definition builder.

### Patch Changes

- [#99](https://github.com/surikaterna/redemeine/pull/99) [`3602d22`](https://github.com/surikaterna/redemeine/commit/3602d22a4961eba06af4712febd14f4248eb36ea) Thanks [@kennyek](https://github.com/kennyek)! - Replace bun with pnpm.

## 0.2.0-pre.0

### Minor Changes

- Initial release of the Redemeine CQRS/ES library. Provides type-safe event-sourced aggregates, projections, in-memory testing infrastructure, and test utilities built on sane defaults.
