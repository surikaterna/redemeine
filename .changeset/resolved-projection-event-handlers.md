---
"@redemeine/projection": patch
---

Register projection handlers using the aggregate's resolved event-name map, so
multiword snake_case defaults, explicit strategies and overrides dispatch correctly.
Handler event types use the resolved map when available rather than inventing
camelCase wire names; broad aggregate maps remain honestly typed as strings.
Built handler maps are keyed by resolved wire names when a mapping is provided;
direct handler-map consumers should use those names. Explicit wire keys and
definitions without a name map retain their existing keys.
