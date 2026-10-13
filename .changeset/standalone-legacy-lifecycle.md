---
"@redemeine/demeine-interop": major
---

Replace the supplied AggregateBase API with an owned standalone compatibility
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
