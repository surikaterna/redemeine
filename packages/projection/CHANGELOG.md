# @redemeine/projection

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
