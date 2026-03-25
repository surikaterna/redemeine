# Path-Aware Routing

In traditional Event Sourcing and CQRS systems, one of the most tedious sources of boilerplate is maintaining massive enumerations of Action Types, Command Typos, and Event Strings. Developers often end up manually wiring up constants like `ORDER_LINE_ITEM_CANCELLED_EVENT` across dozens of files, heavily increasing the surface area for typos and cognitive load.

Redemeine solves this elegantly with its **Targeted Naming Engine** and **Path-Aware Routing**.

## The Redemeine Solution

Instead of declaring static string types, you declare executable JavaScript functions (Commands) and state reducers (Events). Redemeine automatically derives a strictly formatted, domain-driven string identifier behind the scenes by walking the proxy path you used to invoke it.

It translates the natural syntax of your Object-Oriented or functional execution into formal dot-notation event streams.

### The Problem: Massive String Enums

In a legacy codebase, handling an action inside a sub-entity might look like this:

```ts
// ❌ The old, verbose way
import { CANCEL_ORDER_LINE_ITEM_COMMAND } from './constants';

dispatch({ 
    type: CANCEL_ORDER_LINE_ITEM_COMMAND, 
    payload: { lineId: '123' } 
});
```

### The Magic: Path-Aware Routing

With Redemeine, your entities maintain their own private namespaces, and your invocation path becomes the literal routing key.
Furthermore, mapped nested entities act as **Immutable Hybrid Entity Collections**.

Let's look at an `Order` aggregate that encapsulates an `OrderLines` entity:

```ts
// Let's assume we have built an Order aggregate with nested entities
const OrderAggregate = createAggregate('Order', initialOrderState)
  .entities({ orderLines: OrderLineEntity })
  .build();

const order = createMirage(OrderAggregate, 'order-123');

// 1. Iterate over them like a normal, read-only array!
const totalItems = order.orderLines.length;

// 2. The Redemeine Way: Path-Aware Execution mapping the ID!
When you execute `order.orderLines('line-abc').cancel();`, Redemeine's internal engines step in:

1. **Path Traversal:** It detects you accessed the `orderLines` entity.
2. **Method Detection:** It detects you called the `cancel()` command.
3. **Payload Merging:** It automatically merges the ID `'line-abc'` into the command payload.
4. **Command Generation:** It generates and dispatches a strictly formatted command string: 
   👉 `'order.order_lines.cancel.command'`
5. **Event Emission:** When the pure command runs and returns an event called `cancelled`, the engine maps the resulting persistent event string to:
   👉 `'order.order_lines.cancelled.event'`

You get beautifully clean execution code, but your database still receives perfectly standardized event logging strings.

## Legacy Compatibility and Overrides

Sometimes you aren't building a greenfield project. You need to integrate an aggregate into a Kafka stream or Event Store that already expects a specific, legacy string format (like `USER_CREATED_V2_LEGACY`).

Redemeine allows you to bypass the Path-Aware routing locally using the Override builder methods.

```ts
const UserAggregate = createAggregate('User', initialUserState)
    .events({
        userCreated: (state, payload) => { state.active = true; }
    })
    // Force Redemeine to emit a legacy string instead of 'user.user_created.event'
    .overrideEventNames({
        userCreated: 'USER_CREATED_V2_LEGACY' 
    })
    .build();
```

By decoupling the execution function names (`userCreated`) from the persistent store string keys (`USER_CREATED_V2_LEGACY`), Redemeine preserves your modern Developer Experience without breaking backwards compatibility.