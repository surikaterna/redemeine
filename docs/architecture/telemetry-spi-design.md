# @redemeine/telemetry SPI Design (Backend-Agnostic)

**Bead:** `redemeine-bxt`  
**Status:** Architect deliverable (design-only)  
**Last updated:** 2026-04-08

---

## 1) Scope and intent

Define a stable, backend-agnostic telemetry SPI package (`@redemeine/telemetry`) that runtime packages can depend on without importing OpenTelemetry (or any other backend) directly.

This design covers:
- tracing interfaces and span lifecycle contracts,
- metrics interfaces,
- log-correlation context contracts,
- provider registration / runtime lifecycle,
- hook sink contracts for runtime inspection events,
- no-op defaults and failure-isolation semantics,
- package boundaries and dependency rules,
- migration path from direct OTel assumptions.

## 2) Goals / non-goals

### Goals
1. Runtime packages (`mirage`, `projection`, `saga-runtime`, etc.) depend only on SPI contracts.
2. Backends (e.g. `@redemeine/otel`) are pluggable adapters.
3. Telemetry calls are safe by default (no provider required).
4. Hook sinks can be attached once and reused across runtimes.
5. Migration can be incremental without behavioral breakage.

### Non-goals
- Implementing concrete OpenTelemetry integration (belongs to `redemeine-h8i`).
- Final semantic convention naming for all domain events (handled in inspection/outbox beads).
- Rewriting runtime internals in this bead.

---

## 3) Package boundaries

### New package
- `packages/telemetry` (`@redemeine/telemetry`)

### Dependency policy
- `@redemeine/telemetry` MAY depend on `@redemeine/kernel` for shared primitive contracts.
- Runtime packages MAY depend on `@redemeine/telemetry`.
- Runtime packages MUST NOT depend on `@redemeine/otel` directly.
- `@redemeine/otel` MUST depend on `@redemeine/telemetry` (SPI -> implementation direction).
- `@redemeine/telemetry` MUST NOT depend on backend SDKs (OTel, Datadog, etc.).

### Boundary matrix extension
| from \\ to | `@redemeine/kernel` | `@redemeine/telemetry` | `@redemeine/otel` |
|---|---:|---:|---:|
| `@redemeine/telemetry` | allowed | same-package | forbidden |
| runtime packages (`mirage`, `projection`, `saga-runtime`) | allowed | allowed | forbidden |
| `@redemeine/otel` | allowed | allowed | same-package |

---

## 4) SPI contracts (proposed)

> Naming is intentionally interface-first to keep implementation freedom.

```ts
// packages/telemetry/src/contracts.ts

export type TelemetryAttributes = Record<string, string | number | boolean | null | undefined>;

export interface TelemetryContextCarrier {
  traceId?: string;
  spanId?: string;
  correlationId?: string;
  causationId?: string;
  baggage?: Record<string, string>;
}

export interface TelemetrySpan {
  setAttribute(key: string, value: TelemetryAttributes[string]): void;
  addEvent(name: string, attributes?: TelemetryAttributes): void;
  recordError(error: unknown, attributes?: TelemetryAttributes): void;
  setStatus(status: 'ok' | 'error', message?: string): void;
  end(endTime?: number): void;
}

export interface TelemetryTracer {
  startSpan(name: string, options?: {
    kind?: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
    attributes?: TelemetryAttributes;
    parent?: TelemetryContextCarrier;
    startTime?: number;
  }): TelemetrySpan;

  withSpan<T>(name: string, fn: (span: TelemetrySpan) => T | Promise<T>, options?: {
    kind?: 'internal' | 'server' | 'client' | 'producer' | 'consumer';
    attributes?: TelemetryAttributes;
    parent?: TelemetryContextCarrier;
  }): T | Promise<T>;
}

export interface TelemetryMeter {
  counter(name: string, options?: { description?: string; unit?: string }): {
    add(value: number, attributes?: TelemetryAttributes): void;
  };
  histogram(name: string, options?: { description?: string; unit?: string }): {
    record(value: number, attributes?: TelemetryAttributes): void;
  };
  gauge(name: string, options?: { description?: string; unit?: string }): {
    set(value: number, attributes?: TelemetryAttributes): void;
  };
}

export interface TelemetryLogger {
  bind(context: TelemetryContextCarrier): TelemetryLogger;
  info(message: string, fields?: TelemetryAttributes): void;
  warn(message: string, fields?: TelemetryAttributes): void;
  error(message: string, fields?: TelemetryAttributes): void;
  debug?(message: string, fields?: TelemetryAttributes): void;
}

export interface TelemetryHookSink {
  emit(eventName: string, payload: {
    ts: number;
    source: string; // mirage | projection | saga-runtime | ...
    attributes?: TelemetryAttributes;
    context?: TelemetryContextCarrier;
  }): void | Promise<void>;
}

export interface TelemetryProvider {
  readonly name: string;
  tracer(scope: string): TelemetryTracer;
  meter(scope: string): TelemetryMeter;
  logger(scope: string): TelemetryLogger;

  inject?(context: TelemetryContextCarrier, carrier: Record<string, string>): void;
  extract?(carrier: Record<string, string>): TelemetryContextCarrier;

  hookSink?(): TelemetryHookSink;
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
}
```

Design notes:
- `TelemetryProvider` is the only backend-facing contract runtime code sees.
- Runtime packages request scoped tracer/meter/logger by logical package scope string.
- Hook sink is optional to keep minimal providers lightweight.

---

## 5) Provider registration and lifecycle

### Registry API

```ts
export interface TelemetryRegistry {
  register(provider: TelemetryProvider): void;
  get(): TelemetryProvider;
  resetForTests?(): void;
}
```

### Lifecycle rules
1. **Default state:** registry returns a built-in no-op provider.
2. **Registration:** first explicit `register` replaces no-op provider.
3. **Idempotency:** repeated register of same logical provider is allowed; last-write-wins.
4. **Failure isolation:** telemetry failures MUST NOT break domain command processing by default.
5. **Shutdown:** host application may call `flush` then `shutdown` during process drain.

### Startup/teardown guidance
- Application bootstrap selects implementation package and calls `register(...)` once.
- Tests can keep no-op or inject fake provider.
- Runtime packages never construct provider directly.

---

## 6) Hook sink contracts

Hook sink is the transport-neutral emission point for inspection signals that are not strictly span/metric operations.

Contract rules:
1. `emit(eventName, payload)` must be stable and versionable.
2. Payload must include `ts` and `source` to support replay/auditing.
3. Event names should follow namespaced convention (`runtime.<domain>.<action>`).
4. Hook sink failures are swallowed + surfaced as logger warnings unless explicitly configured fail-closed by host.
5. Hook sinks must support no-op behavior with near-zero overhead.

Recommended initial event families:
- `runtime.command.received`
- `runtime.event.appended`
- `runtime.outbox.enqueued`
- `runtime.intent.dispatched`
- `runtime.intent.failed`
- `runtime.projection.batch.processed`

(Exact taxonomy will align with inspection-hook bead deliverables.)

---

## 7) No-op defaults

`@redemeine/telemetry` ships a no-op provider implementing all interfaces.

No-op requirements:
- Every method is safe to call with no side effects.
- `withSpan` executes callback directly and still catches/records nothing.
- Counter/histogram/gauge operations are no-op.
- Logger methods are no-op unless debug test mode explicitly enabled.
- `hookSink().emit(...)` resolves immediately.

Rationale:
- No runtime package needs conditional telemetry guards.
- Feature works in minimal/edge environments without SDK footprint.

---

## 8) Migration path (from direct OTel assumptions)

### Phase 0: SPI introduction
- Add `@redemeine/telemetry` interfaces + no-op provider + registry.
- No runtime behavior change.

### Phase 1: runtime dependency swap
- Replace direct OTel references in runtime packages with SPI calls.
- Keep emitted names/attributes aligned with existing behavior.

### Phase 2: concrete adapter package
- Implement `@redemeine/otel` against SPI.
- Add conformance tests proving adapter satisfies SPI contract.

### Phase 3: host wiring + docs
- Bootstrap docs show `registerTelemetryProvider(createOtelProvider(...))`.
- Optional alternative provider examples (console/fake/custom).

### Compatibility guarantee
- If host app does nothing, system uses no-op provider and remains functional.

---

## 9) Risks and mitigations

1. **Risk:** SPI too thin, forcing runtime leaks.  
   **Mitigation:** add extension points via optional methods (`inject/extract/hookSink`) before backend-specific escape hatches.

2. **Risk:** Hook sink schema drift across packages.  
   **Mitigation:** central event-name registry and shared payload contracts in telemetry package.

3. **Risk:** Provider lifecycle mismanaged in tests.  
   **Mitigation:** explicit `resetForTests` support in test utilities.

---

## 10) Acceptance mapping (`redemeine-bxt`)

Bead acceptance text:  
> "Design spec defines SPI interfaces, provider lifecycle, package boundaries, and migration path from direct OTel assumptions."

| Acceptance requirement | Where covered in this document |
|---|---|
| SPI interfaces | Section 4 (`TelemetryProvider`, tracer/meter/logger/span/context/hook sink) |
| Provider lifecycle | Section 5 (registry, registration rules, startup/teardown) |
| Package boundaries | Section 3 (new package, dependency policy, matrix extension) |
| Migration path from direct OTel assumptions | Section 8 (phased migration and compatibility guarantee) |

Result: **All acceptance criteria are explicitly mapped and satisfied at design level.**
