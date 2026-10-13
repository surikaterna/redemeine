---
title: "Aggregate Naming Conventions"
last_updated: 2026-09-28
status: stable
ai_priority: high
---

# Aggregate Naming Conventions

By default, aggregate command and event keys are converted from camelCase to flat snake_case. The aggregate name and, for mounted entities, the mount path are prepended. For example, `addItem` becomes `order.add_item.command` and `itemAdded` becomes `order.item_added.event`. An `orderLines` mount with event key `productTypeAmended` uses `order.order_lines.product_type_amended.event`. Event projectors, metadata, emitted event types, and replay use the same resolved event name.

This default is a breaking change for consumers expecting the former targeted dot-path event names (for example, `order.item.added.event`). In a greenfield application no stored events need migration. Consumers that require the old convention can opt in explicitly:

```typescript
import { createAggregate, namingStrategies } from '@redemeine/aggregate';

const order = createAggregate('order', initialState)
  .naming(namingStrategies.targeted)
  .events({ itemAdded: (state, event) => { state.items.push(event.payload); } })
  .build(); // order.item.added.event
```

`namingStrategies.snakeCase` explicitly selects the new default event convention; `namingStrategies.flat` preserves the original camelCase key without conversion. The command convention remains snake_case for every preset. A custom `.naming({ event: (aggregateName, key, path) => ... })` can replace the event formatter. `.overrideEventNames({ itemAdded: 'custom.item.event' })` takes precedence over any naming strategy for that key. Update consumer event handlers and subscriptions to match the selected event type; this guide does not prescribe a stored-event migration.
