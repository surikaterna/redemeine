---
"@redemeine/mirage": patch
---

Reject aggregate event descriptors passed as host lifecycle plugins with guidance to attach them through Aggregate.plugins or built.withPlugins. Stateful aggregate event plugins execute through the existing application path.
