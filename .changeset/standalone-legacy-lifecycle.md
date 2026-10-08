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
