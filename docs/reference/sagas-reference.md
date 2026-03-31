# Saga API Reference

This page is the quick reference for Redemeine's saga modules exported from `src/sagas`.

For generated API signatures, use `/docs/api/`.

## Module overview

- `createSaga.ts`: typed saga definition builder and intent types.
- `SagaRuntimeEvents.ts`: runtime intent/lifecycle event contracts and helper appenders.
- `SagaRuntimeAggregate.ts`: hidden runtime aggregate command/event contract used for persistence/execution.
- `SagaRuntimePersistenceAdapter.ts`: reducer output -> runtime aggregate command bridge.
- `PendingIntentProjection.ts`: read model for pending/executable intent queries.
- `RuntimeIntentProjection.ts`: createProjection-based pending/due index over runtime aggregate events.
- `DedupeGuard.ts`: no-op decision helpers for replay and crash recovery.
- `RetryPolicy.ts`: retry validation, backoff scheduling, and classification helpers.
- `replayExecution.ts`: replay-mode execution suppression helpers.
- `SagaRouterDaemon.ts`: worker polling/orchestration seam.
- `SagaRegistry.ts`: registration/discovery helper for saga definitions.
- `events.ts`: canonical saga taxonomy event names.

## Defining sagas

Use `createSaga<TCommandMap>()` to build a saga definition with compile-time command payload checks.

```ts
import { createSaga } from 'redemeine';

type InvoiceCommandMap = {
  'invoice.create': { invoiceId: string; amount: number };
};

const saga = createSaga<InvoiceCommandMap>()
  .initialState(() => ({ attempted: 0 }))
  .on('invoice', {
    created: ctx => {
      const dispatchIntent = ctx.dispatch('invoice.create', {
        invoiceId: 'inv-1',
        amount: 100
      });

      const scheduleIntent = ctx.schedule('invoice-reminder', 5_000);

      return {
        state: { ...ctx.state, attempted: ctx.state.attempted + 1 },
        intents: [dispatchIntent, scheduleIntent]
      };
    }
  })
  .build();
```

Core contracts:

- `SagaReducerOutput<TState, TCommandMap>`: required handler output shape.
- `SagaIntent<TCommandMap>`: union of `dispatch`, `schedule`, `cancel-schedule`, and `run-activity`.
- `SagaIntentMetadata`: `sagaId`, `correlationId`, `causationId` attached to all intents.

## Persisting intents through runtime aggregate

Use `persistSagaReducerOutputThroughRuntimeAggregate` to translate reducer output into runtime aggregate queue commands and save through Depot.

```ts
import {
  persistSagaReducerOutputThroughRuntimeAggregate
} from 'redemeine';

await persistSagaReducerOutputThroughRuntimeAggregate(output, runtimeDepot, {
  sagaStreamId: 'saga-stream-1'
});
```

No separate SagaEventStore model is required in the runtime path.

Runtime helper contracts:

- `createSagaIntentRecordedEvents(...)`
- `createSagaIntentIdempotencyKey(...)`
- `InMemorySagaRuntimeEventBuffer` (test/local helper)

## Lifecycle events

Intent lifecycle helpers append standardized events:

- `appendSagaIntentStartedEvent`
- `appendSagaIntentDispatchedEvent`
- `appendSagaIntentSucceededEvent`
- `appendSagaIntentFailedEvent`
- `appendSagaIntentRetryScheduledEvent`
- `appendSagaIntentRetryScheduledEventFromPolicy`

Lifecycle event union: `SagaLifecycleEvent`.

## Pending intent projection

`PendingIntentProjection` materializes recorded + lifecycle streams into queryable execution state.

Common methods:

- `projectEvents(recordedEvents, lifecycleEvents)`
- `getByIntentKey(intentKey)`
- `query({ statuses, dueAtBeforeOrEqual, dueAtAfterOrEqual })`
- `getExecutablePendingIntents(now)`

Record shape: `PendingIntentRecord<TCommandMap>` with `status`, `dueAt`, and lifecycle timestamps.

## Runtime intent projection (createProjection-based)

`createRuntimeIntentProjection()` materializes `SagaRuntimeAggregate` events into a read-only pending/due index.

Use it with `ProjectionDaemon` + `InMemoryRuntimeIntentProjectionStore` (or another `IProjectionStore` implementation) to query worker-ready intents while keeping runtime aggregate events as source of truth.

Common query methods on `InMemoryRuntimeIntentProjectionStore`:

- `getByIntentKey(intentKey)`
- `query({ statuses, dueAtBeforeOrEqual, dueAtAfterOrEqual })`
- `getPendingIntents()`
- `getDueIntents(now)`

Record shape: `RuntimeIntentProjectionRecord` with `status`, `attempts`, `dueAt`, `nextAttemptAt`, and lifecycle timestamps.

## Dedupe and recovery decisions

Use these helpers before executing a worker intent:

- `decideIntentExecutionFromProjection(projection, intentKey)`
- `decideIntentExecutionFromRecordedLifecycleEvents(eventReader, sagaStreamId, intentKey)`

Decision result: `SagaExecutionDecision` with reasons:

- `execute`
- `no-op-already-dispatched`
- `no-op-already-succeeded`
- `skip-intent-not-found`

## Retry policy helpers

Retry helpers in `RetryPolicy.ts`:

- `validateRetryPolicy(policy)`
- `computeNextAttemptAt(policy, attempt, now, jitter?)`
- `isRetryableError(error, options?)`
- `classifyRetryableError(error, options?)`

Policy shape: `SagaRetryPolicy` (`maxAttempts`, `initialBackoffMs`, `backoffCoefficient`, optional caps/jitter).

## Replay behavior

`executeSagaReducerOutputInReplay(output)` suppresses side-effect execution and returns typed outcomes.

Result shape: `SagaReplayExecutionResult<TState>` with `outcomes` entries tagged `replay-mode-suppressed`.

## Router daemon seam

`SagaRouterDaemon` provides the polling lifecycle shell around worker routing.

- Constructor options: `pollIntervalMs`, `processTick`, `logger`, `onHealthEvent`, `createTimestamp`.
- Health events: `started`, `tick`, `stopped` via `SagaRouterDaemonHealthEvent`.
- Methods: `start()`, `stop()`, `tick()`.

## Registry helpers

Use `SagaRegistry` helpers for runtime registration/discovery:

- `createSagaRegistry()`
- `registerSaga(...)`
- `getSagaRegistry()`

Registered shape: `RegisteredSagaDefinition<TState, TCommandMap>`.

## Canonical saga event names

`SAGA_EVENT_NAMES` exports the canonical taxonomy, and `SagaEventName` is its union type.

This taxonomy is aligned with the ADR entry in `docs/architecture/decision-log.md`.

## `commandsFor` and projection indexing notes

- `ctx.commandsFor(Aggregate, aggregateId, metadataOverride?)` creates typed command factories from aggregate definitions while preserving saga intent metadata defaults.
- Runtime pending/due worker scans should use `createRuntimeIntentProjection()` + projection identity indexing (`intent:${intentKey}`) instead of a separate saga event-store read model.
