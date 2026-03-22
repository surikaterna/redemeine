# Writing Logic with Immer

When migrating to CQRS and Event Sourcing architectures from traditional Object-Oriented Programming (OOP) or vanilla Redux setups, managing state transitions is often the steepest learning curve. You are balancing two conflicting desires: the safety of immutable data flow versus the clean DX (Developer Experience) of typical object mutation.

Redemeine resolves this friction by enforcing a strict physical boundary using **Immer**. 

## The Golden Rule of Redemeine

> **State mutation is strictly isolated to `.events()` handlers.** 
> Your `.commands()` handlers are inherently pure.

By enforcing this boundary, you gain the mathematical safety and auditability of Event Sourcing without sacrificing the joy of writing clean, readable JavaScript.

---

## Modifying State: Events

In native immutable paradigms like vanilla Redux, updating a deeply nested structure requires verbose spread operator syntax. With Redemeine's `.events()` block, the `state` argument is wrapped in an Immer `draft` proxy. You can write "mutable" code that secretly produces a pure, immutable next state.

### The Bad / Traditional Way ❌

Without Immer, appending an item to a list and updating a nested timestamp requires recreating the entire tree:

```ts
.events({
  itemAdded: (state, payload: { item: CartItem, updatedAt: number }) => {
    // ❌ Error-prone, noisy, and difficult to read
    return {
      ...state,
      metadata: {
        ...state.metadata,
        updatedAt: payload.updatedAt
      },
      items: [...state.items, payload.item]
    };
  }
})
```

### The Redemeine Way ✅

Because Redemeine uses Immer internally, you can execute direct property assignments and array mutations safely.

```ts
.events({
  itemAdded: (state, payload: { item: CartItem, updatedAt: number }) => {
    // ✅ Clean, readable, natively mutable syntax
    state.metadata.updatedAt = payload.updatedAt;
    state.items.push(payload.item);
    
    // Note: No return statement is needed. Immer tracks the draft changes.
  }
})
```

---

## Defending the Boundary: Commands

Your commands represent *business intent*. They receive a proposed change, run validations, check invariants against the current data, and definitively emit the resulting events. They **must not** modify the data directly.

To enforce this at compile time, Redemeine wraps the `state` argument inside your `.commands()` handlers using a sophisticated `ReadonlyDeep<State>` generic.

### Anti-Pattern: Mutating Inside Commands ❌

If you attempt to modify the state directly inside a command handler, TypeScript will immediately throw an error.

```ts
.commands((emit) => ({
  addItem: (state, payload: { item: CartItem }) => {
    
    // 🚨 TypeScript Error: Cannot assign to 'items' because it is a read-only property.
    state.items.push(payload.item); 

    // 1. Validate Intent...
    if (state.status === 'checkout') {
      throw new Error("Cannot modify during checkout");
    }

    // 2. Purely emit the result
    return emit.itemAdded({ 
      item: payload.item, 
      updatedAt: Date.now() 
    });
  }
}))
```

### Why is this boundary important?

1. **Auditability:** State can only ever exist as a byproduct of a recorded Event. You can reconstruct the aggregate at any point in history.
2. **Sideology:** If commands could mutate state, a rejected command could leave the aggregate in a corrupted, partially updated "dirty" state. By forcing mutations strictly into purely isolated event transitions, rejected logic has zero side-effects.

Redemeine removes the mental overhead by catching these architectural flaws gracefully at compile-time via `ReadonlyDeep`, and letting you write clean mutations safely inside Immer-powered events.