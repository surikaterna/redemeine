---
"@redemeine/aggregate": minor
---

Allow createAggregatePlugin and createAggregatePluginFor to declare command/event
envelopes without calling state(). Stateless plugins enrich prepared envelope types
without mounting aggregate state or requiring snapshot namespaces. Preserve readonly
domain context, source/identity checks, ordered recipes and existing bridge pre-sink
preparation. State reducers still require an explicit state initializer; existing
state(() => ({})) plugins retain their stateful behavior and migration requirements.
