# Domain Modeling Engine

This document captures the current Redemeine architecture direction for Aggregate consumption and nested domain structures.

## 1) Mirage Layer (Consumption)

- Mirage is a read-only reactive Proxy over a built Aggregate.
- Mirage merges state access and command invocation into one surface.
- Nested list entities are exposed as hybrid collections:
  - callable for entity selection by identity
  - array-like for read-only iteration and indexing
- Direct mutation through Mirage throws at runtime.

## 2) Command Architecture (Pack Pattern)

- Commands can be declared in packed form:

```ts
{
  pack: (...args) => payload,
  handler: (state, payload) => Event | Event[]
}
```

- `pack` defines the public command signature and serializable payload format.
- For child entity commands, identity values are injected automatically into pack arguments.
- This supports positional APIs on Mirage while preserving event-store-friendly payloads.

## 3) Specialized Sub-Structures

- `.entityList(name, schema, { pk })`
  - List-backed entities.
  - Supports a simple key (`"id"`) or composite keys (`["country", "label"]`).
  - Exposed as hybrid collection proxies.

- `.entityMap(name, schema, { knownKeys })`
  - Record-backed entities.
  - Enables property-style access for known keys while injecting map key identity.

- `.valueObject(name, schema)`
  - Read-only nested state branch without identity.
  - No command routing under the value object branch.

## 4) Example

```ts
party.identifiers.VAT.verify();
party.addresses("primary").amend("123 Main St");
party.preferences.theme;
```
