---
title: "Path-Aware Naming Conventions"
last_updated: 2026-03-22
status: stable
ai_priority: high
---

# Path-Aware Naming Conventions

## Summary
A comprehensive guide to Redemeine's "Targeted Naming" engine. This document details the automated routing rules that transform standard camelCase method calls into strict, dot-notation strings for your event store. It explains the core `aggregate.entity.action` pattern (e.g., mapping an `OrderLine`'s `amendProductType` command to `order.order_line.product_type.amended.event`) and how to use the `.overrideEventNames()` fallback for legacy compatibility.

## The Problem with Manual Naming
In traditional event-sourced systems, developers frequently maintain giant constants files mapping intent strings (`ORDER_LINE_PRODUCT_TYPE_AMENDED_EVENT`) to their literal configurations. This creates endless boilerplate and disconnects intent from the actual codebase.

## The "Targeted Naming" Engine
Redemeine's `NamingStrategy` solves this by automatically inferring your command and event strings directly from the property keys provided to the builders. 

When configuring `.events()` or `.commands()`, the system applies a standard conversion:
- `camelCase` keys are converted to `snake_case`.
- The aggregate's namespace (and any nested entity namespace) is automatically prepended.
- A standard suffix (`.command` or `.event`) is appended.

### Deep Entity Routing Example
If you define an `OrderLine` entity and inject it into an `Order` aggregate, Redemeine generates deeply scoped routing strings on your behalf.

```typescript
// Invoked by the client
await order.orderLines('123').amendProductType({ sku: 'NEW-SKU' });
```

Behind the scenes, Redemeine resolves the execution path:
1. **Aggregate Prefix:** `order`
2. **Entity Path:** `order_line` (derived from `orderLines`)
3. **Action:** `amend_product_type` (for the command) / `product_type_amended` (for the emitted event, assuming you named the event handler `productTypeAmended`)

This invocation will natively generate and route exactly:
- **Command:** `order.order_line.amend_product_type.command`
- **Emitted Event:** `order.order_line.product_type.amended.event`

## Overriding Unconventional Paths
In situations where you must conform to legacy event definitions existing in your event store, relying on auto-generation may be unsafe. Redemeine provides an escape hatch using `.overrideEventNames()` or `.overrideCommandNames()`.

```typescript
const LegacyMigrationAggregate = createAggregateBuilder('Customer', initialState)
  .events({
    profileUpdated: (state, event) => { /* ... */ }
  })
  .overrideEventNames({
    profileUpdated: 'legacy_v1_customer_profile_change' // Explicit override
  })
  .build();
```

When an override is present, it entirely bypasses the targeted naming engine and guarantees your legacy string is used during routing and serialization.