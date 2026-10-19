# @redemeine/demeine-interop

## 1.0.0-pre.3

### Minor Changes

- [#144](https://github.com/surikaterna/redemeine/pull/144) [`7c76529`](https://github.com/surikaterna/redemeine/commit/7c765293c17ba62fc89b701b96f8fb9c2aa20b76) Thanks [@spralle](https://github.com/spralle)! - Prepare aggregate plugin command envelopes before external sinks and direct processing, preserve prepared event extensions through conversion, and replay persisted extensions without rerunning preparation.

## 1.0.0-pre.2

### Major Changes

- [#138](https://github.com/surikaterna/redemeine/pull/138) [`0b6030e`](https://github.com/surikaterna/redemeine/commit/0b6030e29ed40f5b78c8239568b0bb5ef25f7476) Thanks [@spralle](https://github.com/spralle)! - Replace the supplied AggregateBase API with an owned standalone compatibility
  lifecycle. Call createDemeineBridge(builder, { envelope }) or omit options; passing
  AggregateBase now fails explicitly. Use the exported CompatibleAggregateConstructor
  and neutral service types instead of importing a legacy Aggregate base. Constructor
  services remain ordered commandSink, eventHandler, commandHandler, with independent
  nullish defaults. The bridge no longer requires Demeine inheritance or a runtime
  Demeine dependency; existing host repositories may still depend on Demeine.

  Declare and explicitly reference the Node emitter type dependency in both public
  declaration formats, so minimal consumers need no ambient host/test typings.
  The browser runtime continues to use the `events` package.

  Observe promised command rejection across realms and promise implementations while
  waiting in FIFO order, adopting each input once. Expose kernel-compatible headers
  and metadata on neutral messages, and infer state-specific services on generated
  and authored-base constructors while retaining sound legacy handler compatibility.

  Use native promises for command processing and remove direct Bluebird runtime and
  test dependencies, including its typings. Handler invocation remains synchronous;
  only an exact operational-error marker triggers pending-array replacement, while
  the original rejection and state/version are preserved. Native scheduling replaces
  the previous library scheduling; no promise-extension methods are emulated.
  Operational-error logs contain a fixed message, not command data or rejection
  details; callers still receive the original rejection for host-controlled handling.
  Accept typed `PromiseLike<Command>` inputs to `_sink`, matching existing thenable
  adoption while retaining the native Promise return and FIFO processing contract.

### Patch Changes

- [#136](https://github.com/surikaterna/redemeine/pull/136) [`dc6fca2`](https://github.com/surikaterna/redemeine/commit/dc6fca276bb5a9b59a6795053720485df4a7b2e0) Thanks [@spralle](https://github.com/spralle)! - Preserve the supplied builder's ordinary event policy instead of rejecting unknown
  event types before its applier runs. Default warn/skip replay and custom strict
  policies now behave like direct builder application without a per-domain event
  handler workaround. Reserved legacy deletion, explicit handler overrides and
  synchronous evolution guards remain unchanged.

## 0.1.0-pre.1

### Minor Changes

- [#134](https://github.com/surikaterna/redemeine/pull/134) [`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3) Thanks [@spralle](https://github.com/spralle)! - Move the legacy bridge out of Mirage into the new demeine-interop package. The
  replacement API requires the application's Aggregate base and returns a constructor,
  preserving its sink, dispatchers, queue, replay and reserved deletion lifecycle.
  Mirage no longer exports the old callable bridge. Kernel, aggregate and interop now
  provide independent CommonJS and ESM entry points with matching declarations.

### Patch Changes

- [#134](https://github.com/surikaterna/redemeine/pull/134) [`f7d1476`](https://github.com/surikaterna/redemeine/commit/f7d14766a5885772bda05536eeae674194a3a219) Thanks [@spralle](https://github.com/spralle)! - Let generated no-payload shortcuts reach the legacy queue by normalizing missing
  or undefined creator payloads to a fresh empty object on a copied envelope.
  Preserve object pack identity and reject explicit null/scalar payloads as before.
  The sink and builder contract see the same object; void-only contracts are not
  bypassed and require an object-compatible contract at this legacy boundary.
- Updated dependencies [[`7cf5217`](https://github.com/surikaterna/redemeine/commit/7cf5217b3be22dd81c92892c24bc8b9e017e72a3)]:
  - @redemeine/kernel@0.2.0-pre.2
