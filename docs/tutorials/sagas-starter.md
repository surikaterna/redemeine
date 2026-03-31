# Redemeine Sagas Starter: Build a Retryable Billing Flow

This starter walks through the minimum moving parts for building an event-sourced saga in Redemeine.

You will:

1. Define a typed command map.
2. Build a saga with `createSaga`.
3. Persist emitted intents through the hidden runtime aggregate command path.
4. Track lifecycle events and query pending work.
5. Replay reducer output without re-running side effects.

## 1) Define command contracts

```ts
type BillingCommandMap = {
  'billing.charge': { invoiceId: string; amount: number };
  'billing.notify': { invoiceId: string; channel: 'email' | 'sms' };
};
```

`createSaga<BillingCommandMap>()` uses this map to type-check every `ctx.dispatch(...)` call.

## 2) Build the saga definition

```ts
import { createSaga } from 'redemeine';

export const BillingSaga = createSaga<BillingCommandMap>()
  .initialState(() => ({ attempts: 0, settled: false }))
  .correlate('invoice', event => event)
  .on('invoice', {
    created: ctx => {
      const chargeIntent = ctx.dispatch('billing.charge', {
        invoiceId: 'inv-1',
        amount: 250
      });

      const notifyIntent = ctx.dispatch('billing.notify', {
        invoiceId: 'inv-1',
        channel: 'email'
      });

      const timeoutIntent = ctx.schedule('invoice-timeout', 5_000);

      return {
        state: {
          ...ctx.state,
          attempts: ctx.state.attempts + 1
        },
        intents: [chargeIntent, notifyIntent, timeoutIntent]
      };
    }
  })
  .build();
```

Every handler returns `{ state, intents }`, which keeps state transitions deterministic and side effects explicit.

## 3) Persist reducer intents through runtime aggregate

```ts
import {
  persistSagaReducerOutputThroughRuntimeAggregate
} from 'redemeine';

const output = {
  state: { attempts: 1, settled: false },
  intents: [
    {
      type: 'dispatch' as const,
      command: 'billing.charge' as const,
      payload: { invoiceId: 'inv-1', amount: 250 },
      metadata: {
        sagaId: 'saga-1',
        correlationId: 'corr-1',
        causationId: 'cause-1'
      }
    }
  ]
};

await persistSagaReducerOutputThroughRuntimeAggregate(output, runtimeDepot, {
  sagaStreamId: 'saga-stream-1'
});
```

Runtime persistence now flows through the hidden `SagaRuntimeAggregate`; there is no separate runtime SagaEventStore model.

## 4) Record lifecycle and query pending work

```ts
import {
  PendingIntentProjection,
  InMemorySagaRuntimeEventBuffer,
  createSagaIntentRecordedEvents,
  appendSagaIntentStartedEvent,
  appendSagaIntentSucceededEvent
} from 'redemeine';

const eventBuffer = new InMemorySagaRuntimeEventBuffer();
const [recorded] = createSagaIntentRecordedEvents('saga-stream-1', output);
await eventBuffer.appendIntentRecordedBatch('saga-stream-1', [recorded]);

await appendSagaIntentStartedEvent(eventBuffer, {
  sagaStreamId: 'saga-stream-1',
  intentKey: recorded.idempotencyKey,
  metadata: recorded.intent.metadata
});

await appendSagaIntentSucceededEvent(eventBuffer, {
  sagaStreamId: 'saga-stream-1',
  intentKey: recorded.idempotencyKey,
  metadata: recorded.intent.metadata
});

const projection = new PendingIntentProjection<BillingCommandMap>();
projection.projectEvents(
  await eventBuffer.loadIntentRecordedEvents('saga-stream-1'),
  await eventBuffer.loadLifecycleEvents('saga-stream-1')
);

const executable = projection.getExecutablePendingIntents(new Date());
// empty after success
```

## 5) Replay safely

```ts
import { executeSagaReducerOutputInReplay } from 'redemeine';

const replay = await executeSagaReducerOutputInReplay(output);

console.log(replay.outcomes);
// [{ intentType: 'dispatch', executed: false, reason: 'replay-mode-suppressed' }]
```

Replay mode suppresses side effects and returns what would have run.

## 6) Optional runtime seams

- `createSagaRegistry`, `registerSaga`, `getSagaRegistry`: register and discover saga definitions.
- `decideIntentExecutionFromProjection` / `decideIntentExecutionFromRecordedLifecycleEvents`: dedupe guard helpers.
- `SagaRouterDaemon`: polling seam for worker loop orchestration.

For full API details, see `/docs/reference/sagas-reference` and `/docs/api/`.
