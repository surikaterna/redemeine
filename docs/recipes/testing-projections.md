# Testing Projections

> Contract reference: see [Testing DX v1 Contracts](/docs/architecture/testing-dx-v1-contracts) for locked fixture API and semantics under bead `redemeine-t8g.1`.
> See also: [Testing Pyramid (Typed-First)](/docs/recipes/testing-pyramid) for fixture layering, typed-first policy, and allowed raw-envelope fallback cases.

Use this recipe when you want fast, deterministic tests for projection behavior.

## 1) Build with `createProjection`

```ts
import { createProjection } from '@redemeine/projection';

const invoiceSummary = createProjection<{
  total: number;
  orderIds: string[];
}>('invoice-summary', () => ({ total: 0, orderIds: [] }))
  .from(invoiceAgg, {
    'invoice.created': (state, event, ctx) => {
      state.total = event.payload.amount;
      ctx.subscribeTo(orderAgg, event.payload.orderId);
    }
  })
  .join(orderAgg, {
    'order.shipped': (state, event) => {
      state.orderIds.push(event.aggregateId);
    }
  })
  .build();
```

## 2) Projection inference model (`.from()` + `.join()`)

- Handler keys in `.from()` and `.join()` are inferred from the actual aggregate event map.
- `event.payload` is inferred per handler key, so payload fields are type-safe without manual casts.
- `event.type` narrows to the selected handler key and may include the aggregate’s canonical scoped event type (for example, `'created' | 'invoice.created.event'`).

Example (`.from()` + `.join()`):

```ts
const projection = createProjection<{ seen: string[] }>('projection', () => ({ seen: [] }))
  .from(invoiceAgg, {
    created: (state, event) => {
      // event.type: 'created' | 'invoice.created.event'
      state.seen.push(event.type);
      state.seen.push(event.payload.id);
    }
  })
  .join(orderAgg, {
    shipped: (state, event) => {
      // event.type: 'shipped' | 'order.shipped.event'
      state.seen.push(event.type);
      state.seen.push(event.payload.invoiceId);
    }
  })
  .build();
```

## 3) `.from()` / `.join()` lifecycle semantics

- `.from()` is the **owner stream**. Events from this aggregate can create or update documents.
- `.join()` is **opt-in correlation**. A join event is processed only after a `.from()` handler calls `ctx.subscribeTo(joinAgg, joinAggregateId)`.
- If no subscription exists, `.join()` events are ignored (prevents ghost documents).

## 4) Identity override example

Default routing uses `event.aggregateId`. Override it when your projection document id differs:

```ts
const byCustomer = createProjection<{ invoices: number }>('customer-summary', () => ({ invoices: 0 }))
  .from(invoiceAgg, {
    'invoice.created': (state) => {
      state.invoices += 1;
    }
  })
  .identity((event) => `customer-${event.payload.customerId as string}`)
  .build();
```

## 5) Unit-test handlers as pure functions (Immer)

You can test a handler without daemon/store setup:

```ts
import { produce } from 'immer';

const state = { total: 0 };
const event = { payload: { amount: 125 } };

const onInvoiceCreated = (draft: { total: number }, evt: { payload: { amount: number } }) => {
  draft.total = evt.payload.amount;
};

const next = produce(state, (draft) => {
  onInvoiceCreated(draft, event);
});

// next.total === 125
// state.total === 0 (unchanged)
```

## 6) Cursor semantics (quick note)

- `fromCursor` is **exclusive** (`sequence > fromCursor.sequence`).
- `nextCursor` points to the **last processed event** (not last + 1).
- If no events are returned, keep the cursor unchanged.

## 7) Reverse semantics contract (spec-level)

For reverse mutation planning, the current contract is intentionally explicit and narrow:

- **Relink is `remove` + `add` only**. There is no `replace` operation in the contract.
- **`reverseSubscribe` supports multi-target** (`targetDocIds` can be one id or many).
- **Missing target is warn-and-skip** for remove paths (`relink` removals and `unsubscribe`).

Reference implementation-level contract helpers:

- `planReverseSubscribe(spec)`
- `planReverseRelink(spec)`
- `planReverseUnsubscribe(spec)`

Contract fixtures/tests live in:

- `packages/projection/test/fixtures/reverse-semantics.contract.fixture.ts`
- `packages/projection/test/reverse-semantics-contract.test.ts`

## 8) Projection runtime v3 operations and release gates

For operational rollout guidance and release evidence requirements for runtime vNext, see:

- [Projection Runtime v3: Operational Runbook and Release Gates](/docs/architecture/projection-runtime-vnext-runbook)

This runbook documents frozen semantics (`.join` unchanged, `.reverseSubscribe`, `context.unsubscribeFrom`, explicit remove+add relink, and missing-target warn-and-skip), runtime guarantees (atomic write path, durable dedupe, and catch-up-to-live cutover), validation matrix commands for router/worker/store integration, worker-lite limitations, and the command-based gate checklist used for release sign-off.
