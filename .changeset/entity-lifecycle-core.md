---
"@redemeine/aggregate": major
---

Support templated list entities, checked static command declarations and framework-provided isNew context. Replay ordinary entity projectors to materialize missing final list leaves without creating ancestors or mutating command state.

Preserve ancestor prototypes and own descriptors when replacing materialized paths, without invoking inherited setters. Public command metadata omits borrowed initial-state templates. Explicit `undefined` entity templates behave like omitted templates.

Retain resolved mount semantic names and literal registry semantic names for Mirage's static parent aliases, including explicit `semanticName` overrides; flat creator names, navigation and PK qualifiers remain unchanged.

Breaking: reject different entity definitions mounted at the same point and distinct authored command paths that flatten to the same compiled key. Compose commands into one entity definition or reuse the exact definition at that point; mount different entities at distinct target paths. Use distinct authored compiled paths and explicit shared wire names when shared dispatch is desired. Same authored command overrides remain valid.

Breaking: mounted commands and events now use complete semantic entity-name paths rather than navigation keys/flattened command names. For `identifier` mounted at `identifiers`, use `party.identifier.register.command` and `party.identifier.registered.event`; nested `customer` adds `party.customer.identifier`. Old defaults are not dispatched. Flat creators, state keys and PK qualifiers are unchanged. Use the fourth mount option `semanticName` for one nonempty, nondotted semantic segment, or full mount wire overrides for explicit names. Reused definitions share default wires and last-registration-wins dispatch; assign distinct semantic aliases for independent routing. Entity-relative overrides resolve at their declaring entity path; full mount overrides stay verbatim through nesting.
