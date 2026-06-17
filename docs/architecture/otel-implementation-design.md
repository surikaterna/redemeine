# @redemeine/otel Implementation Design Spec

- **Bead:** `redemeine-h8i`
- **Status:** Architect design artifact (no implementation)
- **Last updated:** 2026-04-08
- **Depends on:** `redemeine-bxt` (`@redemeine/telemetry` SPI design)

## 1) Purpose and Scope

This document defines the concrete implementation design for `@redemeine/otel`, an OpenTelemetry adapter package that implements the backend-agnostic `@redemeine/telemetry` SPI.

### In scope

1. Mapping from `@redemeine/telemetry` SPI contracts to OpenTelemetry APIs.
2. Optional dependency model so runtime packages remain OTel-agnostic.
3. SPI conformance test design (adapter behavior tests against SPI expectations).
4. Package boundaries and rollout notes for Engineer handoff.

### Out of scope

- Runtime code implementation.
- Exporter wiring specifics for production vendors (Jaeger, OTLP collectors, etc.).
- Any direct OTel imports inside core runtime packages (`kernel`, `aggregate`, `mirage`, `projection`, `saga`, `saga-runtime`).

---

## 2) Architectural Positioning

`@redemeine/otel` is one pluggable implementation adapter. Runtime packages use only `@redemeine/telemetry` interfaces.

```text
runtime packages -> @redemeine/telemetry (SPI) -> @redemeine/otel (adapter) -> OpenTelemetry API/SDK
```

### Boundary rules

- `@redemeine/telemetry`: contracts, lifecycle, no-op defaults.
- `@redemeine/otel`: translates SPI calls/events to OTel primitives.
- Runtime packages never import `@opentelemetry/*` directly.
- Alternative adapters (future): e.g. `@redemeine/honeycomb`, `@redemeine/datadog`, custom sink adapter.

---

## 3) SPI → OTel Mapping

> Note: Names below use representative SPI naming from `redemeine-bxt` intent (provider, span, metric, propagation, logger correlation). Engineer should bind exact symbol names from final `@redemeine/telemetry` package exports.

### 3.1 Provider lifecycle

| SPI responsibility | OTel target | Mapping notes |
|---|---|---|
| `createTelemetryProvider(config)` | `TracerProvider` + `MeterProvider` + Context API | Build a composite adapter instance that owns OTel handles. |
| `provider.start()` | provider registration and setup | If SDK mode enabled, register global providers; otherwise remain local for test mode. |
| `provider.shutdown()` | `shutdown()`/`forceFlush()` | Flush and teardown in deterministic order (traces first, then metrics). |
| `provider.isEnabled()` | config gate | Reflect adapter activation state independent of runtime packages. |

### 3.2 Tracing

| SPI responsibility | OTel target | Mapping notes |
|---|---|---|
| `tracer.startSpan(name, options)` | `trace.getTracer(...).startSpan(...)` | Map attributes, kind, links, start time. |
| `tracer.withSpan(span, fn)` | `context.with(trace.setSpan(ctx, span), fn)` | Preserve async context propagation. |
| `span.setAttribute(k,v)` | `Span#setAttribute` | Normalize SPI value union to OTel-accepted scalar/array values. |
| `span.addEvent(name, attrs)` | `Span#addEvent` | Pass timestamps when provided; default now. |
| `span.recordException(err)` | `Span#recordException` | Include normalized error type/message/stack attributes. |
| `span.setStatus(code, message?)` | `Span#setStatus` | Map SPI status enum to `SpanStatusCode`. |
| `span.end(endTime?)` | `Span#end` | Ensure idempotent end in adapter wrapper. |

### 3.3 Metrics

| SPI responsibility | OTel target | Mapping notes |
|---|---|---|
| `meter.counter(name).add(value, attrs)` | `Meter#createCounter().add` | Lazy instrument cache by (name, unit, description). |
| `meter.histogram(name).record(value, attrs)` | `Meter#createHistogram().record` | Support number histograms only in v1 scope. |
| `meter.upDownCounter(name).add(...)` | `Meter#createUpDownCounter().add` | Optional: include if SPI includes this instrument. |
| `meter.observableGauge(name, callback)` | `Meter#createObservableGauge` | Bridge SPI observe callback to OTel callback semantics. |

### 3.4 Context propagation

| SPI responsibility | OTel target | Mapping notes |
|---|---|---|
| `propagation.inject(carrier, setter)` | `propagation.inject` | Use OTel global propagator configured in adapter options. |
| `propagation.extract(carrier, getter)` | `propagation.extract` | Return SPI context wrapper that can re-enter `withContext`. |
| `context.current()` | `context.active()` | SPI context object wraps raw OTel context. |
| `context.with(ctx, fn)` | `context.with(ctx, fn)` | Core mechanism for request/saga correlation continuity. |

### 3.5 Log correlation (non-logging backend)

OTel does not provide a canonical logs API in every deployment path used by Redemeine. In v1:

- `@redemeine/otel` must provide **log correlation helpers**, not a full logging implementation.
- SPI methods that request correlation fields should derive from active span context:
  - `trace_id`
  - `span_id`
  - `trace_flags`
- If no active span/context, return empty correlation object (no throw).

---

## 4) Semantic Conventions Mapping for Redemeine Runtime Signals

`packages/saga-runtime/src/runtimeObservabilityContracts.ts` defines runtime telemetry kinds that should map consistently into span/event names and metric dimensions.

### 4.1 Event name strategy

- Keep low-cardinality operation names (e.g., `redemeine.saga.dispatch`).
- Put dynamic details in attributes (IDs, status, kind) rather than span names.

### 4.2 Proposed attribute namespace

Use stable namespace prefix:

- `redemeine.saga.id`
- `redemeine.saga.type`
- `redemeine.intent.id`
- `redemeine.intent.execution_id`
- `redemeine.activity.id`
- `redemeine.trigger.key`
- `redemeine.correlation.id`
- `redemeine.causation.id`
- `redemeine.tenant.id`
- `redemeine.telemetry.kind`
- `redemeine.telemetry.level`

### 4.3 Runtime telemetry kind translation

| Runtime kind | Trace shape | Metric shape |
|---|---|---|
| `saga.lifecycle` | span event on saga operation span | counter `redemeine_saga_lifecycle_total` |
| `saga.transition` | span event `saga.transition` | counter `redemeine_saga_transition_total` |
| `source_event.observed` | span event `source_event.observed` | counter `redemeine_source_event_observed_total` |
| `intent.lifecycle` | child span or event by stage | counter `redemeine_intent_lifecycle_total` |
| `intent.execution` | child span around execution | histogram `redemeine_intent_execution_duration_ms` |
| `activity.lifecycle` | span event | counter |
| `scheduler.trigger` | span event | counter |
| `scheduler.misfire` | span event + warning status | counter |
| `dispatch.attempt` | span event | counter |
| `dispatch.response` | span event | counter + status dimension |
| `runtime.invariant` | error event / exception record | counter `redemeine_runtime_invariant_total` |

---

## 5) Optional Dependency Model

Goal: runtime package consumers can use Redemeine without installing OTel packages unless they choose `@redemeine/otel`.

### 5.1 Dependency policy

For `@redemeine/otel`:

- `dependencies`:
  - `@redemeine/telemetry`
- `peerDependencies` (preferred):
  - `@opentelemetry/api`
  - optional SDK peers used by adapter features (e.g., `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-metrics`)
- `peerDependenciesMeta` mark SDK peers optional where possible.

Rationale:

- Keeps core runtime install light.
- Lets app host control OTel package versions.
- Prevents duplicate global API instances from nested dependency trees.

### 5.2 Activation model

- Default runtime path uses `@redemeine/telemetry` no-op provider.
- Apps explicitly install and register `@redemeine/otel` provider.
- If required OTel peer not present, adapter should fail fast with actionable startup error message from provider creation (not silent partial mode).

### 5.3 Packaging/exports

`@redemeine/otel` should expose:

1. `createOtelTelemetryAdapter(options)` factory.
2. `createOtelPropagationBridge(...)` only if split utility is needed.
3. `semanticConventions` constants for Redemeine-specific attribute keys.

No global side effects on module import; registration should happen only in explicit factory/init calls.

---

## 6) Error Handling and Fallback Behavior

- Adapter must never throw from no-op-safe read helpers (e.g., correlation lookup).
- Operational startup errors (missing peer deps, invalid config) should throw clearly.
- Runtime telemetry publishing failures should be isolated:
  - do not crash domain execution path for non-fatal telemetry failures,
  - optionally route internal adapter errors to a provided diagnostics callback.

---

## 7) SPI Conformance Test Design (for Engineer)

Conformance tests validate adapter behavior against `@redemeine/telemetry` SPI contract, independent of vendor backend.

### 7.1 Test package and placement

- Package: `packages/otel` (future implementation slice).
- Tests:
  - `packages/otel/test/spi-conformance.tracing.test.ts`
  - `packages/otel/test/spi-conformance.metrics.test.ts`
  - `packages/otel/test/spi-conformance.propagation.test.ts`
  - `packages/otel/test/spi-conformance.lifecycle.test.ts`

### 7.2 Conformance matrix

| Contract area | Required assertions |
|---|---|
| Provider lifecycle | Start/shutdown are idempotent and flush hooks invoked once per lifecycle transition. |
| Tracing creation | `startSpan` returns valid wrapper; attributes/events/status map correctly. |
| Context continuity | `withSpan`/`withContext` preserve active span across async boundaries used by runtime. |
| Exception mapping | `recordException` emits expected exception fields. |
| Metrics instruments | Counter/histogram operations function and attribute sets preserved. |
| Propagation inject/extract | Round-trip carrier preserves trace context IDs. |
| Correlation lookup | Returns trace/span IDs when active span exists; empty object otherwise. |
| Failure isolation | Telemetry sink failure path does not break caller control flow (where contract defines non-fatal behavior). |

### 7.3 Test harness strategy

- Prefer in-memory/fake exporters/processors for deterministic assertions.
- Avoid dependence on external collectors in CI.
- Use adapter black-box tests through SPI interfaces only (do not assert private OTel internals).

---

## 8) Implementation Decomposition (Engineer-ready)

1. **Scaffold package** (`redemeine-26i`): package manifest, exports, baseline adapter factory.
2. **Tracing bridge**: SPI tracer wrapper + context bridge.
3. **Metrics bridge**: instrument registry and attribute normalization.
4. **Propagation bridge**: carrier extract/inject wrappers.
5. **Semantic mapping module**: constants and runtime kind translation helpers.
6. **Conformance tests**: full matrix in Section 7.

Dependencies/order:

- Requires finalized `@redemeine/telemetry` SPI symbols (from `redemeine-bxt` output).
- Conformance tests block production adoption of `@redemeine/otel` in runtime bootstrap examples.

---

## 9) Risks and Assumptions

### Assumptions

- `@redemeine/telemetry` provides stable abstractions for traces, metrics, context, and correlation helpers.
- Runtime packages will emit telemetry through SPI only.

### Risks

1. **SPI mismatch risk:** final SPI naming may differ from this design wording.
   - Mitigation: treat this spec as mapping intent; bind exact names during implementation.
2. **OTel version skew:** peer version incompatibility across app hosts.
   - Mitigation: define supported peer range and validate at startup.
3. **High-cardinality attributes:** unbounded IDs in metric labels.
   - Mitigation: keep identifiers in traces/events; limit metric labels to bounded dimensions.

---

## 10) Acceptance Criteria Coverage (redemeine-h8i)

Bead criterion: _“Design spec defines mapping from @redemeine/telemetry SPI to OpenTelemetry APIs, optional dependency model, and conformance tests against SPI.”_

Coverage:

1. **SPI → OTel mapping:** Section 3.
2. **Optional dependency model:** Section 5.
3. **SPI conformance tests:** Section 7.

This satisfies the design-only deliverable for `redemeine-h8i` and enables Engineer implementation on dependent bead(s).
