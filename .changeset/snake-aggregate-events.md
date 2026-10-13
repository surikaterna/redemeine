---
'@redemeine/aggregate': major
---

BREAKING: Default aggregate events now use flat snake_case names (`itemAdded` becomes `order.item_added.event` instead of `order.item.added.event`). Commands remain unchanged. Consumers expecting the former dot-path event names can opt in with `.naming(namingStrategies.targeted)` and must update handler names/subscriptions otherwise. This project is greenfield with no stored events to migrate; no event-store migration is included.
