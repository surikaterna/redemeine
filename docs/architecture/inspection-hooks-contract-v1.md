# Canonical Inspection Hooks Contract and Event Taxonomy (v1)

- **Bead:** `redemeine-33p`
- **Status:** Draft for Engineer/Auditor handoff
- **Scope:** Runtime inspection signals across Mirage/Depot, outbox lifecycle, saga runtime, and projection processing.

## 1) Goals

Define one canonical inspection contract that:

1. Standardizes hook names across runtime boundaries.
2. Uses a stable payload envelope with explicit versioning.
3. Maps existing plugin hooks and telemetry surfaces without breaking current behavior.
4. Supports low-overhead defaults and progressive adoption.

## 2) Runtime boundaries in scope

1. **Command ingress** (Mirage dispatch loop)
2. **Event hydration** (replay into aggregate state)
3. **Event append** (pre-persist and persisted)
4. **Outbox enqueue/dequeue** (post-commit execution pipeline)
5. **Side-effect execution** (attempt/success/failure)
6. **Retry/dead-letter** (policy and terminal handling)
7. **Projection batch processing** (batch lifecycle and per-event application)

## 3) Canonical envelope schema

All inspection signals MUST conform to this envelope:

```ts
export type InspectionSchemaVersion = '1.0';

export type InspectionLevel = 'debug' | 'info' | 'warn' | 'error';

export interface InspectionEnvelopeV1<TPayload = Record<string, unknown>> {
  // Contract version for envelope fields (breaking changes require major bump)
  schemaVersion: InspectionSchemaVersion; // '1.0'

  // Taxonomy version for hook/event naming set
  taxonomyVersion: '2026-04.v1';

  // Canonical inspection event name (see section 4)
  name: CanonicalInspectionEventName;

  // Event identity
  id: string;
  occurredAt: string; // ISO-8601 UTC
  level: InspectionLevel;

  // Runtime placement
  boundary: 'aggregate' | 'depot' | 'outbox' | 'saga_runtime' | 'projection';
  stage:
    | 'command_ingress'
    | 'event_hydration'
    | 'event_append'
    | 'outbox_enqueue'
    | 'outbox_dequeue'
    | 'side_effect_execution'
    | 'retry'
    | 'dead_letter'
    | 'projection_batch';

  // Correlation / causality
  correlationId?: string;
  causationId?: string;
  traceId?: string;
  spanId?: string;

  // Domain identity
  aggregateId?: string;
  aggregateType?: string;
  commandType?: string;
  eventType?: string;
  sagaId?: string;
  sagaType?: string;
  intentId?: string;
  executionId?: string;
  projectionName?: string;

  // Compatibility + source hints
  source: {
    runtimePackage: string; // e.g. '@redemeine/mirage'
    emitter: string;        // e.g. 'Depot.save'
    legacyHook?: string;    // e.g. 'onBeforeAppend'
    legacyTelemetryKind?: string;
    legacyMetric?: string;
    legacyEvent?: string;
  };

  payload: TPayload;
}
```

### Required vs optional rules

- Required: `schemaVersion`, `taxonomyVersion`, `name`, `id`, `occurredAt`, `level`, `boundary`, `stage`, `source`, `payload`.
- Optional but recommended: `correlationId`, `causationId`, `traceId`, `spanId`.
- Identity fields are conditionally required by stage (see section 5).

## 4) Canonical event taxonomy (v1)

### 4.1 Command ingress

- `inspection.command.ingress.received`
- `inspection.command.ingress.validated`
- `inspection.command.ingress.rejected`

### 4.2 Event hydration

- `inspection.event.hydration.read`
- `inspection.event.hydration.transformed`
- `inspection.event.hydration.applied`
- `inspection.event.hydration.failed`

### 4.3 Event append

- `inspection.event.append.intercepted`
- `inspection.event.append.persisted`
- `inspection.event.append.failed`

### 4.4 Outbox

- `inspection.outbox.enqueued`
- `inspection.outbox.dequeue.claimed`
- `inspection.outbox.dequeue.released`

### 4.5 Side effects

- `inspection.side_effect.execution.started`
- `inspection.side_effect.execution.succeeded`
- `inspection.side_effect.execution.failed`

### 4.6 Retry / dead-letter

- `inspection.retry.scheduled`
- `inspection.retry.exhausted`
- `inspection.dead_letter.recorded`

### 4.7 Projection batch

- `inspection.projection.batch.started`
- `inspection.projection.batch.event_applied`
- `inspection.projection.batch.completed`
- `inspection.projection.batch.failed`

## 5) Stage payload contracts

### 5.1 Command ingress payload

```ts
interface CommandIngressPayload {
  commandPayload?: unknown;
  commandMeta?: Record<string, unknown>;
  validation?: { status: 'passed' | 'failed'; reason?: string };
}
```

Required identities: `aggregateId`, `commandType`.

### 5.2 Event hydration payload

```ts
interface EventHydrationPayload {
  eventPayload?: unknown;
  eventMeta?: Record<string, unknown>;
  replayIndex?: number;
  replayVersion?: number;
  transformApplied?: boolean;
  error?: { message: string; code?: string };
}
```

Required identities: `aggregateId`, `eventType`.

### 5.3 Event append payload

```ts
interface EventAppendPayload {
  eventPayload?: unknown;
  eventMeta?: Record<string, unknown>;
  expectedVersion?: number;
  persistedVersion?: number;
  appendedCount?: number;
  error?: { message: string; code?: string };
}
```

Required identities: `aggregateId`; `eventType` required for single-event emissions, optional for multi-event summary emission.

### 5.4 Outbox payload

```ts
interface OutboxPayload {
  outboxId: string;
  topic?: string;
  partitionKey?: string;
  attempt?: number;
  leaseOwner?: string;
  visibleAt?: string;
}
```

Required identities: `aggregateId` OR `sagaId`, plus `intentId` when tied to intent execution.

### 5.5 Side-effect execution payload

```ts
interface SideEffectExecutionPayload {
  sideEffectType: 'plugin-one-way' | 'plugin-request' | 'run-activity' | 'dispatch';
  pluginKey?: string;
  actionName?: string;
  status?: 'started' | 'succeeded' | 'failed';
  durationMs?: number;
  error?: { message: string; code?: string; retriable?: boolean };
}
```

Required identities: `sagaId`, `intentId`, `executionId`.

### 5.6 Retry/dead-letter payload

```ts
interface RetryDeadLetterPayload {
  attempt: number;
  maxAttempts?: number;
  nextRunAt?: string;
  policy?: { mode?: string; backoffMs?: number };
  reason?: string;
}
```

Required identities: `sagaId` or `aggregateId`, `intentId`.

### 5.7 Projection batch payload

```ts
interface ProjectionBatchPayload {
  batchId: string;
  size: number;
  fromOffset?: string;
  toOffset?: string;
  applied?: number;
  skipped?: number;
  durationMs?: number;
  error?: { message: string; code?: string };
}
```

Required identities: `projectionName`; `eventType` required for `event_applied`.

## 6) Versioning strategy

1. **Envelope version (`schemaVersion`)**
   - `MAJOR` for breaking field/semantic changes.
   - `MINOR/PATCH` for additive non-breaking updates.

2. **Taxonomy version (`taxonomyVersion`)**
   - Locked per wave (`2026-04.v1`).
   - New names added additively within same version only if no semantic conflict.
   - Renames/removals require next taxonomy major wave (e.g., `2026-08.v2`).

3. **Payload evolution rules**
   - Additive optional fields are backward compatible.
   - Required-field additions require major bump.
   - Field deprecations require dual-emit window of at least one minor release wave.

4. **Compatibility emission mode**
   - Runtime MAY emit legacy + canonical side-by-side in transitional mode.
   - Canonical-only mode is allowed once dependent packages and dashboards migrate.

## 7) Compatibility mapping to current surfaces

### 7.1 Plugin hook mapping (`@redemeine/kernel`, `@redemeine/mirage`)

| Current hook | Current context | Canonical event(s) | Notes |
|---|---|---|---|
| `onBeforeCommand` | `CommandInterceptorContext` | `inspection.command.ingress.received` (+ `...validated/rejected`) | Preserve `pluginKey`, `aggregateId`, `commandType`, `payload`, `meta`. |
| `onHydrateEvent` | `EventInterceptorContext` | `inspection.event.hydration.transformed` (plus `...read`/`...applied`) | Payload mutation represented as `transformApplied=true`. |
| `onBeforeAppend` | `EventInterceptorContext` | `inspection.event.append.intercepted` | Preserve per-event interception semantics. |
| `onAfterCommit` | `AfterCommitContext` | `inspection.event.append.persisted` and/or `inspection.outbox.enqueued` | Inline post-commit is legacy bridge until outbox worker becomes primary. |

### 7.2 Runtime telemetry kind mapping (`packages/saga-runtime/src/runtimeObservabilityContracts.ts`)

| Current `RuntimeTelemetryKind` | Canonical mapping |
|---|---|
| `source_event.observed` | `inspection.event.hydration.read` |
| `intent.lifecycle` | `inspection.side_effect.execution.started` / `inspection.retry.scheduled` / `inspection.dead_letter.recorded` |
| `intent.execution` | `inspection.side_effect.execution.succeeded` / `inspection.side_effect.execution.failed` |
| `scheduler.trigger` | `inspection.outbox.dequeue.claimed` or `inspection.retry.scheduled` (context-dependent) |
| `scheduler.misfire` | `inspection.retry.scheduled` |
| `dispatch.attempt` | `inspection.command.ingress.received` |
| `dispatch.response` | `inspection.command.ingress.validated` or `inspection.command.ingress.rejected` |
| `saga.lifecycle`, `saga.transition`, `activity.lifecycle`, `runtime.invariant` | Remain runtime-domain telemetry; can be bridged into inspection namespace only for boundary events with explicit `stage`. |

### 7.3 Reference telemetry plugin mapping (`SagaRuntimeTelemetryPluginV1`)

| Current metric/event | Canonical event |
|---|---|
| `saga.intent.received` | `inspection.command.ingress.received` (for intent dispatch ingress) |
| `saga.intent.executed` | `inspection.side_effect.execution.succeeded/failed` |
| `saga.intent.execution_succeeded` | `inspection.side_effect.execution.succeeded` |
| `saga.intent.execution_failed` | `inspection.side_effect.execution.failed` |
| `saga.intent.scheduled` | `inspection.retry.scheduled` |
| `saga.intent.cancelled_schedule` | `inspection.retry.exhausted` (if terminal) or contextual scheduler cancellation event |
| `saga.schedule.created` | `inspection.retry.scheduled` |
| `saga.schedule.cancelled` | `inspection.retry.exhausted` (cancellation terminal path) |

## 8) Migration and rollout plan

1. **Phase A (bridge)**
   - Add canonical emitter adapter at each boundary.
   - Dual-emit legacy hook/telemetry + canonical envelope.

2. **Phase B (default canonical)**
   - Runtime internals and dashboards consume canonical names.
   - Legacy names marked deprecated.

3. **Phase C (legacy off by config)**
   - Keep compatibility toggle for one release wave.
   - Remove legacy emission in next major.

## 9) Engineer implementation guidance (dependency-aware)

1. Introduce shared contract types in telemetry SPI package (depends on `redemeine-bxt` / `redemeine-h8i`).
2. Add Mirage/Depot adapters first (`onBeforeCommand`, `onHydrateEvent`, `onBeforeAppend`, `onAfterCommit`).
3. Add saga-runtime telemetry bridge next.
4. Add outbox/projection boundary emissions as outbox architecture (`redemeine-4gu`) lands.
5. Validate compatibility matrix with contract tests in `redemeine-xvr`.

## 10) Acceptance criteria mapping (`redemeine-33p`)

- **Hook names defined:** Section 4 taxonomy.
- **Payload schemas defined:** Sections 3 and 5.
- **Versioning strategy defined:** Section 6.
- **Compatibility mapping provided:** Section 7 tables for plugin hooks and runtime telemetry.

## 11) Risks and assumptions

- **Assumption:** canonical inspection is not a replacement for domain telemetry; it is boundary-focused.
- **Risk:** overloading one event name with multiple semantics; mitigated via strict `stage` + payload typing.
- **Risk:** performance overhead from dual-emit; mitigated by lazy payload fields and batch-capable sinks.

