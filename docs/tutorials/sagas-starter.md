# Redemeine Sagas Starter: Build a Retryable Billing Flow

This starter walks through the minimum moving parts for building an event-sourced saga in Redemeine.

> ⚠️ **Breaking change:** this tutorial now focuses on the minimal public API (`createSaga` + retry helpers).

You will:

1. Define saga state.
2. Build a saga with `createSaga<TState>(nameOrOptions?)`.
3. Wire aggregate-typed handlers with `.on(Aggregate, handlers)`.
4. Dispatch typed commands with `commandsFor(...)` / `dispatchTo`.
5. Attach retry policy where needed.
6. Normalize trigger sources into one `StartInput` and use `correlateBy`.

## 1) Define saga state

```ts
type BillingSagaState = {
  attempts: number;
  settled: boolean;
};
```

`createSaga<BillingSagaState>(...)` uses this type to keep handler state usage fully inferred.

## 2) Build the saga definition

```ts
import { createSaga } from 'redemeine';

const BillingAggregate = {
  __aggregateType: 'billing',
  pure: {
    eventProjectors: {
      created: (state: unknown, event: { payload: { invoiceId: string; amount: number } }) => state
    }
  },
  commandCreators: {
    charge: (input: { invoiceId: string; amount: number }) => ({
      type: 'billing.charge',
      payload: input
    }),
    notify: (input: { invoiceId: string; channel: 'email' | 'sms' }) => ({
      type: 'billing.notify',
      payload: input
    })
  }
} as const;

export const BillingSaga = createSaga<BillingSagaState>('billing-saga')
  .initialState(() => ({ attempts: 0, settled: false }))
  .correlate(BillingAggregate, event => event.payload.invoiceId)
  .on(BillingAggregate, {
    created: (state, event, ctx) => {
      state.attempts += 1;

      const commands = ctx.commandsFor(BillingAggregate, event.payload.invoiceId);
      commands.charge({
        invoiceId: event.payload.invoiceId,
        amount: 250
      });
      commands.notify({
        invoiceId: event.payload.invoiceId,
        channel: 'email'
      });
      ctx.schedule('invoice-timeout', 5_000);
    }
  })
  .build();
```

Handlers are mutation-style (Immer semantics): mutate `state`, then emit intents through `ctx` helpers.

## 2b) Normalize `StartInput` + `correlateBy` across trigger families

When startup can come from multiple sources (event, direct API invocation, schedule, recovery), map every source into one `StartInput` shape.

```ts
import { createSaga, createSagaTriggerBuilder } from 'redemeine';

type BillingStartInput = {
  invoiceId: string;
  source: 'event' | 'direct' | 'schedule';
};

const trigger = createSagaTriggerBuilder<BillingStartInput>();

const BillingSaga = createSaga<BillingSagaState>('billing-saga')
  .initialState(() => ({ attempts: 0, settled: false }))
  .start(async (start, ctx) => {
    const commands = ctx.commandsFor(BillingAggregate, start.invoiceId);
    commands.notify({ invoiceId: start.invoiceId, channel: 'email' });
  })
  .correlateBy(start => start.invoiceId)
  .triggeredBy(
    trigger.event({
      event: 'billing.created',
      toStartInput: source => ({
        invoiceId: source.payload.invoiceId,
        source: 'event'
      })
    }).build()
  )
  .triggeredBy(
    trigger.direct({
      channel: 'api',
      toStartInput: source => ({
        invoiceId: source.invoiceId,
        source: 'direct'
      })
    }).build()
  )
  .triggeredBy(
    trigger.schedule.cron({
      cron: '0 9 * * *',
      timezone: 'Europe/Stockholm',
      toStartInput: source => ({
        invoiceId: source.occurrenceId,
        source: 'schedule'
      })
    }).build()
  )
  .build();
```

### `correlateBy` example checklist

- Pick a stable business key (`invoiceId`, `orderId`) rather than transient metadata.
- Use the same key regardless of trigger family.
- Keep `toStartInput` small and deterministic so correlation remains predictable.

You can also gate trigger activation with `.when(...)`:

```ts
const guardedTrigger = trigger
  .event({
    event: 'billing.created',
    toStartInput: source => ({ invoiceId: source.payload.invoiceId, source: 'event' })
  })
  .when(source => source.payload.status === 'ready')
  .build();
```

## 3) Add retry policy to activity intents

```ts
import {
  createSaga,
  validateRetryPolicy
} from 'redemeine';

const policy = validateRetryPolicy({
  maxAttempts: 5,
  initialBackoffMs: 500,
  backoffCoefficient: 2,
  maxBackoffMs: 30_000,
  jitterCoefficient: 0.2
});

const sagaWithActivity = createSaga<BillingSagaState>('billing-saga')
  .initialState(() => ({ attempts: 0, settled: false }))
  .on(BillingAggregate, {
    created: (state, event, ctx) => {
      ctx.runActivity('charge-card', async () => {
        // external call
      }, policy);
    }
  })
  .build();
```

`ctx.runActivity(...)` keeps retries explicit and typed while the runtime handles scheduling/execution internally.

## 4) Keep integration boundaries explicit

Saga definitions are pure contracts: they describe state transitions and emitted intents.

### SagaAggregate terminology (intent vs activity)

When persisting saga progress as a structure-only `SagaAggregate` model, keep these terms distinct:

- State keys remain camelCase.
- Event/command `type` values on the wire are snake_case.
- Timestamps are ISO8601 strings.
- Recent transitions/events/activities are compact bounded windows with separate totals.
- **Intent** means the declarative instruction produced by saga logic.
- **Activity** means the runtime side effect that executes from a prior intent.

Runtime worker/executor implementation is intentionally out of scope for this tutorial.

In practice:

- Keep consumer code on exported saga definition APIs.
- Prefer aggregate command creators for typed dispatch (`commandsFor` / `dispatchTo`).
- Avoid importing runtime execution/persistence helpers from internal paths.
- Treat runtime wiring as application-level integration detail.

## Optional public seams

- `validateRetryPolicy`, `computeNextAttemptAt`, `isRetryableError`, `classifyRetryableError`: retry behavior helpers.

## Idempotent `order.link`-style startup guidance

To avoid duplicate starts and command loops in link-style sagas:

- Correlate by the link target key (`orderId`) and keep it consistent across all trigger mappings.
- Add `.when(...)` guards so already-linked orders do not re-enter the start path.
- Persist a saga-side marker (`linkRequested`, `linkCompletedAt`) before dispatching follow-up commands.
- Emit idempotency keys in commands (`orderId:step`) so downstream handlers can de-duplicate.
- Ignore self-originated echo events unless they represent the next intended state transition.

## DST behavior quick matrix

| Schedule entrypoint | Semantics | DST behavior |
| --- | --- | --- |
| `schedule.interval` / `schedule.isoInterval` | elapsed-time (DST-neutral) | uses elapsed duration, unaffected by wall-clock jumps |
| `schedule.cron` / `schedule.rrule` | wall-clock + explicit IANA timezone | fall-back ambiguous -> first-occurrence-only, spring-forward nonexistent -> next-valid-time |

For full API details, see `/docs/reference/sagas-reference` and `/docs/api/`.
