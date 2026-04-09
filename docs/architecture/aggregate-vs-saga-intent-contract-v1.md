# AggregateIntent vs SagaIntent Contract and Routing (v1)

- **Bead:** `redemeine-fa0`
- **Status:** Architect handoff draft (implementation-ready)
- **Scope:** Canonical intent split and routing policy between aggregate-local execution and saga/external orchestration.

## 1) Goals and non-goals

### Goals

1. Define a canonical envelope shared by `AggregateIntent` and `SagaIntent`.
2. Define capability boundaries so aggregate execution remains cheap, deterministic, and stream-local.
3. Define deterministic routing/escalation rules from aggregate flow to saga runtime.
4. Define idempotency keys and duplicate-handling expectations per intent class.
5. Provide compatibility notes for current `@redemeine/mirage`, `@redemeine/saga`, and `@redemeine/saga-runtime` contracts.

### Non-goals

- Replacing current saga plugin-intent wire model in this wave.
- Defining worker implementation internals (queue storage, lease strategy, scheduler backend).

## 2) Intent model overview

### `AggregateIntent` (push, stream-local automation)

Use when work is bounded to the current aggregate stream and can complete in the aggregate command transaction (or immediate post-commit handoff) without cross-stream coordination.

Properties:

- low-latency / bounded execution
- no long-running wait state
- no external request-response requirement
- no compensation workflow requirement

### `SagaIntent` (pull/orchestration, cross-stream/external)

Use when work needs orchestration semantics: external side effects, retries over time, compensation, schedule/wait, or multi-stream/cross-domain coordination.

Properties:

- execution lifecycle (`pending/in_progress/retrying/succeeded/failed/dead_letter`)
- persisted orchestration state and correlation routing
- explicit retry and escalation behavior

## 3) Canonical envelope schema

All intents (aggregate or saga) MUST carry this shared envelope:

```ts
export type IntentSchemaVersion = '1.0';

export type IntentClass = 'aggregate' | 'saga';

export interface CanonicalIntentEnvelopeV1<TPayload = unknown, TRoute = Record<string, unknown>> {
  schemaVersion: IntentSchemaVersion; // '1.0'
  intentClass: IntentClass;
  intentType: string;                 // semantic name (e.g. 'dispatch', 'plugin-intent')

  // identity
  intentId: string;                   // stable per logical instruction
  idempotencyKey: string;             // duplicate suppression key
  emittedAt: string;                  // ISO-8601 UTC

  // causality/correlation
  correlationId: string;
  causationId: string;
  traceId?: string;
  spanId?: string;

  // origin scope
  source: {
    runtimePackage: string;           // '@redemeine/mirage' | '@redemeine/saga-runtime' | ...
    aggregateId?: string;
    aggregateType?: string;
    sagaId?: string;
    sagaType?: string;
    commandType?: string;
    eventType?: string;
  };

  payload: TPayload;
  routing: TRoute;
}
```

## 4) Specialization schemas

### 4.1 AggregateIntent schema

```ts
export type AggregateIntentCapability =
  | 'append_events'
  | 'dispatch_local_command'
  | 'enqueue_post_commit';

export interface AggregateIntentV1<TPayload = unknown>
  extends CanonicalIntentEnvelopeV1<TPayload, {
    mode: 'inline' | 'post_commit';
    targetStreamId: string;
  }> {
  intentClass: 'aggregate';
  capabilities: readonly AggregateIntentCapability[];

  // MUST remain stream-local
  constraints: {
    crossStream: false;
    externalIo: false;
    supportsCompensation: false;
    maxExecutionMs?: number; // defensive budget for inline path
  };
}
```

Rules:

- `crossStream=false` is mandatory.
- External request-response is prohibited.
- If required capability exceeds aggregate boundaries, router MUST escalate to `SagaIntent`.

### 4.2 SagaIntent schema

```ts
export type SagaIntentCapability =
  | 'dispatch'
  | 'schedule'
  | 'cancel_schedule'
  | 'plugin_one_way'
  | 'plugin_request_response'
  | 'run_activity'
  | 'compensate'
  | 'cross_stream_coordination';

export interface SagaIntentV1<TPayload = unknown>
  extends CanonicalIntentEnvelopeV1<TPayload, {
    executionMode: 'queued' | 'scheduled';
    responseHandlerKey?: string;
    errorHandlerKey?: string;
    retryHandlerKey?: string;
    handlerData?: unknown;
  }> {
  intentClass: 'saga';
  capabilities: readonly SagaIntentCapability[];

  orchestration: {
    sagaId: string;
    retryPolicy?: {
      maxAttempts: number;
      initialBackoffMs: number;
      backoffCoefficient?: number;
      maxBackoffMs?: number;
    };
    compensation?: readonly {
      token: string;
      payload: unknown;
    }[];
  };
}
```

Rules:

- `plugin_request_response`, `run_activity`, `compensate`, and `cross_stream_coordination` are saga-only.
- Request-response intents MUST provide response + error routing handlers.
- Saga runtime owns lifecycle transitions and retry/dead-letter decisions.

## 5) Routing decision table

Router input = canonical envelope + declared capabilities + execution hints.

| Condition | Route | Why |
|---|---|---|
| Stream-local mutation only, no wait, no external IO | `AggregateIntent` inline | Keep command path cheap/deterministic |
| Stream-local action but must run after commit | `AggregateIntent` post_commit | Maintain atomic append before side effects |
| Requires external call with response correlation | `SagaIntent` (`plugin_request_response`) | Needs durable callback/error routing |
| Requires retries beyond immediate command turn | `SagaIntent` | Needs persisted retry policy state |
| Requires schedule/delay/wake-up | `SagaIntent` (`schedule`) | Needs scheduler integration |
| Requires compensation/rollback semantics | `SagaIntent` (`compensate`) | Aggregate path has no compensation ledger |
| Requires cross-stream or cross-aggregate coordination | `SagaIntent` (`cross_stream_coordination`) | Aggregate boundary intentionally local |
| Aggregate policy/capability violation detected | Escalate to `SagaIntent` + emit inspection warning | Safe fallback preserving bounded aggregate contract |

## 6) Escalation policy

Escalation means transforming a rejected `AggregateIntent` candidate into a canonical `SagaIntent` while preserving causality.

Escalation MUST:

1. Preserve `intentId`, `correlationId`, and `causationId`.
2. Recompute class-scoped `idempotencyKey` with saga namespace (see section 7).
3. Emit inspection signal (recommended name):
   - `inspection.intent.routing.escalated`
4. Record `escalationReason` from the finite set:
   - `cross_stream_required`
   - `external_io_required`
   - `response_correlation_required`
   - `retry_window_required`
   - `compensation_required`
   - `policy_violation`

Escalation MUST NOT happen for purely local operations where aggregate path is valid.

## 7) Idempotency contract

### 7.1 Key format

```txt
aggregate:{aggregateId}:{intentType}:{intentId}
saga:{sagaId}:{intentType}:{intentId}:{attempt?}
```

Guidance:

- Aggregate keys are stable across replays for the same logical intent.
- Saga keys MAY include attempt discriminator for observability, but dedupe key for side effects SHOULD remain stable across retries when target endpoint supports idempotency.

### 7.2 Duplicate handling

- `AggregateIntent`:
  - duplicate `idempotencyKey` in same stream/version window => no-op + informational inspection event.
- `SagaIntent`:
  - duplicate pending/in_progress key => collapse to existing execution record.
  - duplicate after terminal success => return cached terminal outcome where possible.
  - duplicate after terminal failure/dead-letter => require explicit re-drive key suffix or operator override.

## 8) Compatibility notes with current runtime

### 8.1 `@redemeine/saga` contract alignment

Current `SagaIntent` shape in `packages/saga/src/createSaga.ts` is a unified `plugin-intent` model with metadata (`sagaId`, `correlationId`, `causationId`).

Compatibility mapping:

- `CanonicalIntentEnvelopeV1.intentClass='saga'` maps to existing `SagaIntent` union semantics.
- Existing `routing_metadata` (`response_handler_key`, `error_handler_key`, `retry_handler_key`, `handler_data`) maps to `routing` in section 4.2.
- Existing `retry_policy_override` and `compensation` map to `orchestration.retryPolicy` / `orchestration.compensation`.

### 8.2 `@redemeine/saga-runtime` reference adapter alignment

Current runtime intents include `dispatch`, `schedule`, `cancel-schedule`, `run-activity`, `plugin-one-way`, `plugin-request`.

Compatibility note:

- Canonical `SagaIntentCapability` is a superset vocabulary; current runtime intent `type` values remain valid wire forms for v1 migration.
- Canonical envelope can be introduced as adapter layer without breaking existing reference adapter tests.

### 8.3 `@redemeine/mirage` / aggregate path compatibility

Current aggregate command routing is stream-centric and does not model long-running orchestration.

Compatibility note:

- `AggregateIntent` is additive as a formal contract around existing behavior.
- No mandatory behavior change for current command processors until router enforcement is enabled.

## 9) Backward/forward compatibility policy

1. Additive optional fields in envelope/specializations are non-breaking.
2. Required field additions require schema major bump (`1.x` -> `2.0`).
3. During migration, dual-shape emission is allowed:
   - existing runtime-native intent shape
   - canonical envelope wrapper
4. Toggle strategy:
   - `intentContractMode = 'legacy' | 'dual' | 'canonical'`

## 10) Examples

### 10.1 Aggregate-local dispatch

```json
{
  "schemaVersion": "1.0",
  "intentClass": "aggregate",
  "intentType": "dispatch_local_command",
  "intentId": "i-1001",
  "idempotencyKey": "aggregate:order-123:dispatch_local_command:i-1001",
  "emittedAt": "2026-04-08T20:00:00Z",
  "correlationId": "corr-1",
  "causationId": "cmd-1",
  "source": {
    "runtimePackage": "@redemeine/mirage",
    "aggregateId": "order-123",
    "aggregateType": "Order"
  },
  "payload": { "command": "reserve_inventory", "sku": "SKU-1", "qty": 2 },
  "routing": { "mode": "inline", "targetStreamId": "order-123" },
  "capabilities": ["dispatch_local_command"],
  "constraints": {
    "crossStream": false,
    "externalIo": false,
    "supportsCompensation": false
  }
}
```

### 10.2 Escalated external request-response

```json
{
  "schemaVersion": "1.0",
  "intentClass": "saga",
  "intentType": "plugin_request_response",
  "intentId": "i-1001",
  "idempotencyKey": "saga:saga-77:plugin_request_response:i-1001",
  "emittedAt": "2026-04-08T20:00:01Z",
  "correlationId": "corr-1",
  "causationId": "cmd-1",
  "source": {
    "runtimePackage": "@redemeine/saga-runtime",
    "aggregateId": "order-123",
    "sagaId": "saga-77",
    "sagaType": "order_fulfillment"
  },
  "payload": {
    "plugin_key": "http",
    "action_name": "get",
    "execution_payload": { "url": "https://api.example.com/invoices/order-123" }
  },
  "routing": {
    "executionMode": "queued",
    "responseHandlerKey": "invoice.fetch.succeeded",
    "errorHandlerKey": "invoice.fetch.failed",
    "retryHandlerKey": "invoice.fetch.retry",
    "handlerData": { "orderId": "order-123" }
  },
  "capabilities": ["plugin_request_response", "cross_stream_coordination"],
  "orchestration": {
    "sagaId": "saga-77",
    "retryPolicy": { "maxAttempts": 5, "initialBackoffMs": 500, "backoffCoefficient": 2 }
  }
}
```

## 11) Acceptance criteria mapping (`redemeine-fa0`)

- **Schemas:** Sections 3 and 4.
- **Routing table:** Section 5.
- **Idempotency/escalation rules:** Sections 6 and 7.
- **Compatibility notes:** Section 8.

## 12) Risks and assumptions

- **Assumption:** aggregate pipeline remains strict stream-local execution boundary.
- **Risk:** premature escalation may increase orchestration load; mitigate with explicit capability checks and metrics.
- **Risk:** inconsistent idempotency behavior across plugins; mitigate with canonical key guidance and adapter conformance tests.
