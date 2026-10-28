# @redemeine/demeine-interop

## 1.0.0-pre.5

### Major Changes

- [#160](https://github.com/surikaterna/redemeine/pull/160) [`d5e5ec9`](https://github.com/surikaterna/redemeine/commit/d5e5ec9212759ea5e9a86fc196d06596334c05c6) Thanks [@spralle](https://github.com/spralle)! - Retire obsolete public execution APIs (redemeine-skpd, bounded surface and event-dispatch slices).

  Use `commandMetadata(built, localName).targets` instead of `pure.commandTargets`.
  Command creators now expose only declared flat keys, including mounted names;
  undeclared nested creator paths no longer fabricate command envelopes or inject IDs.
  Use `eventNameOverrides` and `commandNameOverrides` for mount options instead of
  `eventOverrides` and `commandOverrides`. Definition-level override fields, raw
  command processors/event projectors, and current plugin and host contracts remain.

  Remove the public `parseTargetedEventPath` export and all inferred event routing.
  Events now match exact compiled wire registrations pairing a projector with its target
  chain. Undeclared targeted-looking wires and synthetic unscoped entity-only wires use
  `onUnmatchedEvent` or the default warning; invalid targets on known mounted wires throw
  before projection. Declared dotted root names stay root-owned, scoped wires beat root
  wire collisions, and the last actual scoped assignment wins as a complete pair.
  Compiled event target chains snapshot their steps, state paths, and primary-key arrays;
  later mutations of public reflection or caller-owned options cannot redirect replay.
  The low-level source `applyEvent` / `applyEventToDraft` helpers now take one explicit
  `CompiledEventDispatch` map instead of positional projector/override/target tables;
  built aggregate `apply(state, event)` and `applyToDraft(draft, event)` are unchanged.
  Naming formatters (including the targeted naming preset) remain. Mounted commands and
  events now route only by declared leaf primary-key fields (map `key`) and exact
  registered ancestor command prefixes plus capitalized primary-key fields. Missing
  canonical fields and ambiguous layouts fail; inferred aliases and the private
  `__entityPk` payload protocol are retired. Former aliases and authored `__entityPk`
  are ordinary business data. Mirage injects only canonical leaf fields and preserves
  business arguments. Consumers, including host/bridge handlers, must carry canonical
  identities into emitted events; client/server adoption is outside this slice.

  Bridge definitions now require an explicit nonempty string `aggregateType` and
  reject invalid types before lifecycle inspection. Command-wire inference and the
  `unknown` fallback are removed. The obsolete `AggregateBase` option and its named
  migration guard are retired; it is not a public option or an implementation hook.
  Demeine constructor services and the owned host-adaptation lifecycle remain supported.

  Validate every list PK declaration, including behaviorless/composed mounts, at registration
  and build capture. Only an absent (`undefined`) declaration defaults to `id`; empty names,
  empty lists, duplicates, and invalid JavaScript declaration types reject before execution.
  All nonempty field names, including `__proto__`, remain supported as own identity predicates;
  empty-string and zero identity values remain valid. Caller arrays remain mutable and built
  dispatch/query snapshots stay detached (redemeine-skpd C1/C2).

  Treat declared command and event names such as `__proto__`, `constructor`, and `toString`
  as ordinary own registration keys through component composition, compilation, creators,
  metadata, and exact replay. This does not relax host/bridge reserved-method collision rules
  (redemeine-skpd, PR160 r4386301131).

### Patch Changes

- [#155](https://github.com/surikaterna/redemeine/pull/155) [`9d0a140`](https://github.com/surikaterna/redemeine/commit/9d0a140a67d14e8df0ed013bc62f6e9f41183d79) Thanks [@spralle](https://github.com/spralle)! - Admit command creators with correlated rest-tuple parameters without widening generated shortcut arguments. Preserve existing legacy argument defaults and runtime forwarding. This fixes creator admission only, not arbitrary overload or higher-order generic signature preservation.

- [#151](https://github.com/surikaterna/redemeine/pull/151) [`db9bdf9`](https://github.com/surikaterna/redemeine/commit/db9bdf94a4358a45835dd85c7fbe3ff8ed410892) Thanks [@spralle](https://github.com/spralle)! - Check bridge and authored-subclass constructor service inputs contravariantly. Reject command handlers, event handlers, and sinks that require state the aggregate does not provide, while preserving exact-state services, supported broader services, and the legacy object-state command-handler overload. Runtime behavior is unchanged; previously accepted unsupported handlers may now produce type errors.

- Updated dependencies [[`db9bdf9`](https://github.com/surikaterna/redemeine/commit/db9bdf94a4358a45835dd85c7fbe3ff8ed410892)]:
  - @redemeine/kernel@0.2.0-pre.3

## 1.0.0-pre.4

### Major Changes

- [#150](https://github.com/surikaterna/redemeine/pull/150) [`63c3068`](https://github.com/surikaterna/redemeine/commit/63c3068c39ed94ab9e047dacd88c5d8631ebc4d8) Thanks [@spralle](https://github.com/spralle)! - Export BridgeArguments and use it for generated shortcuts: zero-argument creators
  accept an empty legacy object, and a single required empty-compatible object can
  be omitted without widening other signatures.

  Empty shortcut argument lists now forward one fresh object to creators before
  normalizing undefined result payloads. This legacy default is observable for
  optional/defaulted packs too because runtime creators erase TypeScript arity;
  explicit undefined and all supplied argument lists remain unchanged. The major
  bump records that no-argument optional packs previously received undefined.

### Patch Changes

- [#150](https://github.com/surikaterna/redemeine/pull/150) [`63c3068`](https://github.com/surikaterna/redemeine/commit/63c3068c39ed94ab9e047dacd88c5d8631ebc4d8) Thanks [@spralle](https://github.com/spralle)! - Normalize legacy command and nested class own data before active envelope preparation, including post-sink re-preparation, without weakening data guards or changing inactive dispatch.

  Normalize undecorated Date subclasses even in otherwise plain graphs, preserving instants, aliases and cycles without invoking inherited accessors. Ordinary Date-only prepared commands retain identity and preparation caching.

- [#150](https://github.com/surikaterna/redemeine/pull/150) [`63c3068`](https://github.com/surikaterna/redemeine/commit/63c3068c39ed94ab9e047dacd88c5d8631ebc4d8) Thanks [@spralle](https://github.com/spralle)! - Let eventEnvelope output own typed headers, using its existing initializer/parser/recipe API in Aggregate, bridge and Mirage. Replace the unreleased boolean propagation flag with an explicit plugin-owned selection/validation policy. One writer may replace raw event headers; a second writer throws without implicit merging. Required header properties (whose value may be undefined) preserve sound prepared types, and installed data is detached. Callbacks retain registration order; there is no header prepass or universal copy default. An output with own undefined headers now creates that property even when the input omitted it. Command headers remain reserved in command extensions; metadata and replay are unchanged.

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
