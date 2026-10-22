---
"@redemeine/demeine-interop": major
---

Export BridgeArguments and use it for generated shortcuts: zero-argument creators
accept an empty legacy object, and a single required empty-compatible object can
be omitted without widening other signatures.

Empty shortcut argument lists now forward one fresh object to creators before
normalizing undefined result payloads. This legacy default is observable for
optional/defaulted packs too because runtime creators erase TypeScript arity;
explicit undefined and all supplied argument lists remain unchanged. The major
bump records that no-argument optional packs previously received undefined.
