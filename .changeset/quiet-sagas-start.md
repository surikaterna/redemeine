---
'@redemeine/saga': major
---

Breaking: `.start()` now receives `(state: Draft<TState>, startInput, ctx)` instead of `(startInput, ctx)`. Use `runSagaStartHandler` to execute the start decision against `initialState()` with Immer drafting; it returns state and all emitted intents but does not persist or invoke itself from PR111. `core.dispatch` now stores the aggregate creator's returned envelope `type` (including naming overrides), not the local creator method key. A malformed type or missing/undefined payload throws before emission. Previously persisted local-key dispatch intents are **not migrated**: PR111 refuses all intents and contains no historical persisted intents; future durable readers must use a versioned schema and refuse unversioned/local-key records rather than reinterpret them.
