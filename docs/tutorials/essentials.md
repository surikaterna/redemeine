# Redemeine Essentials: Building a Shopping Cart

Welcome to Redemeine! Let's skip the boilerplate and dive straight into building a fully-functional Event Sourced and CQRS-powered Shopping Cart. 

Redemeine is built on a **Type-Transparent architecture**. What does that mean? You define your domain using plain TypeScript interfaces, and Redemeine automatically handles the runtime validation for you. No manual `z.parse()`, no verbose `if (!payload.id) throw new Error(...)` checks inside your business logic. You just write TypeScript, and it just works.

Let's build.

## 1. Define Your Contracts

First, we define the shape of our state, the events that have happened, and the commands we want to execute. 

```ts
// types.ts
export interface CartItem {
  productId: string;
  quantity: number;
}

export interface CartState {
  id: string;
  items: CartItem[];
  status: 'active' | 'checkout';
}
```

## 2. Bootstrapping the Aggregate

We use `createAggregate` to start constructing our domain model. Think of this as the Redux Toolkit `createSlice` on steroids.

```ts
import { createAggregate } from 'redemeine';
import type { CartState, CartItem } from './types';

const initialState: CartState = {
  id: '',
  items: [],
  status: 'active'
};

export const CartAggregate = createAggregate<CartState, 'Cart'>('Cart', initialState)
```

## 3. The Rules of State: Events and Immer

Here is the golden rule of Redemeine: **State mutation is strictly isolated to your `.events()` handlers.** 

Because Redemeine is wrapped with Immer under the hood, you can write standard, mutable-looking JavaScript to update your state. It evaluates to safe, immutable updates.

```ts
  // ... continuing from above
  .events({
    itemAdded: (state, payload: { item: CartItem }) => {
      // Look ma, direct mutation! (Safely powered by Immer)
      state.items.push(payload.item);
    }
  })
```

## 4. Keeping Commands Pure

Your commands represent *intent*. They don't change the state directly. Instead, they run pure business logic and return the events that should be applied.

Notice how we aren't validating the `payload` structure here? Because of Redemeine's Type-Transparent validation, if someone passes a payload missing the `item` property, it gets rejected before this function is even executed.

```ts
  .commands((emit) => ({
    addItem: { pack: (productId: string, quantity: number = 1) => ({ item: { productId, quantity } }), handler: (state, payload: { item: CartItem }) => {
      // 1. Business Logic / Invariants
      if (state.status === 'checkout') {
        throw new Error("Cannot add items during checkout.");
      }

      // 2. Purely return the events that occurred
      return emit.itemAdded({ item: payload.item });
      }
    }
  }))
  .build();
```

## 5. Taking It Live

Now we take our static blueprint and breathe life into it using `createMirage`. This proxy object maps our commands securely to our instance while tracking uncommitted events.

```ts
import { createMirage } from 'redemeine';

async function runCartFlow() {
  // 1. Create a living instance of our aggregate
  const cartId = 'cart-123';
  const cart = createMirage(CartAggregate, cartId);

  // 2. Dispatch a command!
  // Type inference and runtime validation are fully active.
  await cart.addItem('prod-99', 1);

  // 3. Inspect the updated, readonly state
  console.log(cart.items); 
  // [{ productId: 'prod-99', quantity: 1 }]
}

runCartFlow();
```

### Wrapping Up

And just like that, you have a strongly-typed, CQRS-compliant aggregate. 
- **Interfaces** defined your contract.
- **Commands** handled the intent purely.
- **Events** handled the state transitions mutably via Immer.
- **Type-Transparency** handled the runtime guardrails unseen.

Ready for more? Next, we'll look at breaking complexity down using Mixins and Path-Aware routing!
