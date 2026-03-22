---
title: "Strict Domain Contracts with Zod"
last_updated: 2026-03-22
status: stable
ai_priority: high
---

# Strict Domain Contracts with Zod

## Summary
This guide explains how to define and enforce immutable, runtime-validated schemas for your Domain using Zod. It covers the best practices for structuring your `contract.ts` files, separating State, Commands, and Events into distinct namespaces. By binding these Zod schemas to the Redemeine builders, developers ensure that invalid data is caught at the boundary before it ever reaches the Command Processors or Event Applyers.

## Designing the Contract File
A core tenant of Redemeine is separating your domain's interfaces from its execution implementation. We recommend managing your aggregate structures cleanly within a `contract.ts` file utilizing Zod for automatic runtime parsing and TypeScript inference.

This allows your IDE, AI tooling, and developers to look at a single file to understand exactly what shapes flow into and out of an aggregate.

### Example `contract.ts`

```typescript
import { z } from 'zod';

// 1. Define the State
export const OrderStateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['pending', 'shipped', 'cancelled']),
  totalAmount: z.number().min(0)
});
export type OrderState = z.infer<typeof OrderStateSchema>;

// 2. Define Command Payloads
export const OrderCommands = {
  placeOrder: z.object({
    customerId: z.string(),
    items: z.array(z.string()).min(1)
  }),
  cancelOrder: z.object({
    reason: z.string()
  })
};
export type OrderCommandPayloads = {
  [K in keyof typeof OrderCommands]: z.infer<typeof OrderCommands[K]>
};

// 3. Define Event Payloads
export const OrderEvents = {
  orderPlaced: OrderCommands.placeOrder,
  orderCancelled: OrderCommands.cancelOrder.extend({ cancelledAt: z.date() })
};
export type OrderEventPayloads = {
  [K in keyof typeof OrderEvents]: z.infer<typeof OrderEvents[K]>
};
```

## Enforcing the Contract on the Builder
Once the schemas are verified with Zod, you pass the inferred types as exactly mapped payloads into your `createAggregate`. By declaring `<State>` and defining handler types, Redemeine securely infers validations directly into the `.commands()` and `.events()` interfaces.

```typescript
import { OrderState, OrderCommandPayloads, OrderEventPayloads } from './contract';

export const OrderAggregate = createAggregate<OrderState, 'Order'>('Order', { 
  id: '', status: 'pending', totalAmount: 0 
})
// Enforce Event Payloads
.events<{
  orderPlaced: (state: OrderState, event: Event<OrderEventPayloads['orderPlaced']>) => void
}>({
  orderPlaced: (state, event) => {
    state.status = 'pending'; // Safe to mutate via Immer validation
  }
})
// Enforce Command Payloads
.commands<{
  placeOrder: (state: ReadonlyDeep<OrderState>, payload: OrderCommandPayloads['placeOrder']) => Event[]
}>((emit) => ({
  placeOrder: (state, payload) => {
    // payload is guaranteed to match the Zod contract typing
    return emit('orderPlaced', payload);
  }
}))
.build();
```

Because Redemeine reads these typed payloads intrinsically, attempting to access an unknown property inside a `.commands()` payload will result in an immediate TypeScript failure, safeguarding your core business logic organically.