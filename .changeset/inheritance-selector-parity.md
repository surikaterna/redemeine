---
'@redemeine/aggregate': patch
---

Preserve all registered entity and value object mounts when extending an aggregate builder, with registration-array snapshots that isolate later parent and child additions.

Type aggregate and mixin selectors according to existing replacement order: root registrations first, then stored mixins with the last writer winning. Built selectors and command factories registered after composition now include mixin selectors. Widened arrays conservatively retain root fallbacks and optional keys rather than assuming a final member; order precision is not retained after an unknown-length spread. Callbacks registered before later builder mutation are not retyped.
