---
"@redemeine/demeine-interop": patch
---

Preserve the supplied builder's ordinary event policy instead of rejecting unknown
event types before its applier runs. Default warn/skip replay and custom strict
policies now behave like direct builder application without a per-domain event
handler workaround. Reserved legacy deletion, explicit handler overrides and
synchronous evolution guards remain unchanged.
