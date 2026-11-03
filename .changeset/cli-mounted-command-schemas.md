---
"@redemeine/cli": patch
---

Resolve list-, map-, and nested-mounted command and event payload schemas in standalone extract-schemas, and canonical mounted command payloads in schema registries. Preserve authored schema links and canonical payloads rather than pack argument tuples. Event schema IDs use declaration mount paths, independently of wire naming. Registry event catalogs remain root-only.

Document explicitly building an aggregate and joining generated payload schemas to runtime schemaBindings, checking for missing schema entries and selecting inbound schemas by the compiled wire winner. Preserve authored callable signatures when validating inherited selectors in canonical aggregate registries. Extraction remains compiler-only.
