# AggregateIntent Plugin Capability Boundaries Policy (v1)

**Bead:** `redemeine-tdh`  
**Status:** Proposed-for-implementation contract  
**Scope:** Safety boundaries for plugin actions reachable from `AggregateIntent` handlers

---

## 1) Goal

Keep `AggregateIntent` deterministic, stream-local, and low-latency by default while still allowing controlled extensibility through plugins.

This policy defines:
- a capability declaration model,
- a capability matrix,
- compile-time + runtime enforcement points,
- conformance tests for SDK/runtime,
- explicit trust-model limits.

---

## 2) Core safety invariants

`AggregateIntent` execution MUST preserve these invariants:

1. **Stream-local default:** handlers operate on the current aggregate stream only.
2. **No hidden orchestration:** cross-stream coordination and long-running workflows are not allowed in `AggregateIntent`.
3. **Deterministic state transition:** aggregate state/resulting events must be replay-safe independent of plugin runtime timing.
4. **Bounded side effects:** plugin usage in aggregate path is explicit, declared, and policy-checked.
5. **Fail-closed on forbidden capabilities:** disallowed plugin actions reject before state mutation commit.

If business logic needs cross-stream, request/response orchestration, compensation, timers, or external dependency coupling, it MUST escalate to `SagaIntent`.

---

## 3) Capability model

Each plugin declares a manifest entry per action:

- `pluginKey`
- `actionName`
- `capabilityClass` (from taxonomy below)
- `interaction` (`fire_and_forget` or `request_response`)
- `scope` (`stream_local`, `cross_stream`, `external_io`, `process_runtime`)
- `determinism` (`deterministic`, `nondeterministic`)
- `requiresEscalation` (boolean)
- `defaultAggregatePolicy` (`allow`, `deny`, `allow_with_guard`)

Host runtime computes effective permission from:
1) plugin manifest,
2) host policy (global),
3) aggregate allowlist/denylist override (optional),
4) execution mode (`AggregateIntent` vs `SagaIntent`).

---

## 4) Capability matrix (AggregateIntent safety)

| Capability class | Example action | AggregateIntent | Conditions | Rationale |
| --- | --- | --- | --- | --- |
| `aggregate_dispatch_local` | dispatch command to same aggregate id/stream | **Allow** | command target must equal current stream identity | preserves stream locality |
| `domain_validation_pure` | schema/guard evaluation with no IO | **Allow** | pure function only | deterministic |
| `event_annotation_local` | attach metadata/audit tags to emitted events | **Allow with guard** | metadata size/key policy enforced | bounded write path |
| `idempotency_lookup_local` | local deterministic key check | **Allow with guard** | local store only; no network | replay-safe guardrail |
| `timer_schedule` | delayed callback/wakeup | **Deny** | escalate to SagaIntent | introduces orchestration/time coupling |
| `cross_stream_dispatch` | command to different aggregate id/type | **Deny** | escalate to SagaIntent | breaks stream-local boundary |
| `request_response` | outbound call expecting response | **Deny** | escalate to SagaIntent | non-deterministic roundtrip |
| `external_io_http` | HTTP/gRPC/queue publish | **Deny** | escalate to SagaIntent | external side effects |
| `integration_message_bus` | publish to broker/topic | **Deny** | escalate to SagaIntent | external/system coupling |
| `filesystem_process_env` | fs/process/env access | **Deny** | never from AggregateIntent | host compromise surface |
| `dynamic_code_execution` | eval/Function/vm execution | **Deny** | never | integrity/sandbox risk |
| `policy_override_admin` | bypass capability checks | **Deny** | host-internal only | trust boundary protection |

Policy default for unknown capability: **Deny**.

---

## 5) Enforcement points

### A. Definition-time (SDK compile/build)

1. **Manifest schema validation**
   - Reject plugin registration if capability metadata missing/invalid.
2. **Aggregate action typing constraints**
   - Aggregate handler context exposes only capability-eligible action surface.
   - Request/response or cross-stream builders are absent from aggregate context typings.
3. **Static lint rule (recommended)**
   - Flag prohibited API imports/usages in aggregate modules.

### B. Registration-time (runtime boot)

4. **Policy resolver preflight**
   - Compute effective policy for every plugin action.
   - Emit startup diagnostics for denied actions and escalation-required capabilities.
5. **Fail-fast in strict mode**
   - In strict policy mode, fail startup if aggregate-registered plugins include denied capabilities.

### C. Dispatch-time (before append/commit)

6. **Intent boundary guard**
   - Every plugin action invocation from aggregate path passes through `CapabilityGuard`.
7. **Scope validator**
   - Enforce same-stream target for `aggregate_dispatch_local`.
8. **Interaction validator**
   - Reject `request_response` from aggregate context.
9. **Determinism validator**
   - Reject capabilities declared `nondeterministic` in aggregate path.

### D. Post-dispatch observability

10. **Audit event emission**
    - Emit structured audit records for allow/deny decisions with policy reason.
11. **Security telemetry**
    - Increment counters for denied invocations by plugin/capability/reason.

---

## 6) Conformance test suite (required)

### SDK conformance

1. `plugin-manifest-requires-capability-metadata`
   - missing capability fields => registration error.
2. `aggregate-context-hides-disallowed-apis`
   - compile-time assertion that aggregate handlers cannot access request/response APIs.
3. `unknown-capability-default-deny`
   - unknown class cannot be declared as implicitly allowed.

### Runtime policy conformance

4. `aggregate-allows-stream-local-dispatch`
   - same-stream dispatch succeeds.
5. `aggregate-denies-cross-stream-dispatch`
   - target stream mismatch => denied with stable reason code.
6. `aggregate-denies-request-response`
   - interaction mode `request_response` => denied.
7. `aggregate-denies-external-io`
   - HTTP/broker/integration capability => denied.
8. `aggregate-enforces-fail-closed`
   - denied capability does not partially commit aggregate side effects.

### Observability conformance

9. `audit-event-on-capability-deny`
   - denial emits audit record with bead/correlation identifiers.
10. `metrics-tagged-by-plugin-capability-reason`
   - denied counter dimensions present and stable.

### Compatibility/escalation conformance

11. `escalation-path-to-saga-intent`
   - denied aggregate capability provides actionable escalation hint to SagaIntent.
12. `policy-mode-strict-fails-startup`
   - strict mode rejects invalid plugin registration at boot.

---

## 7) Trust model limits

This policy is a **runtime boundary control**, not a full sandbox.

Assumptions:
1. Plugin code executes with host process privileges unless separately sandboxed by deployment.
2. Capability checks protect framework entry points, not arbitrary host-language escape hatches.
3. Malicious plugin packages can still attempt supply-chain or runtime abuse outside declared APIs.

Limits (explicit):
- No guarantee against arbitrary code execution if untrusted JS/TS plugins are loaded in-process.
- No guarantee against exfiltration via side channels outside governed action APIs.
- No OS/container isolation provided by this policy alone.

Operational requirements:
- Treat plugin packages as **trusted-by-admission** unless run in external sandbox/runtime.
- Use package signing/allowlists and dependency scanning for supply-chain defense.
- Prefer process isolation for untrusted third-party plugins.

---

## 8) Recommended implementation slices

1. `CapabilityManifest` schema + validator.
2. `CapabilityGuard` runtime gate in aggregate intent dispatch path.
3. Aggregate context API narrowing (type-level and runtime-level).
4. Structured deny reason codes + audit/metric adapters.
5. Conformance suite wired into SDK/runtime CI.

---

## 9) Acceptance mapping for bead `redemeine-tdh`

This design satisfies requested acceptance by providing:
- **Capability matrix** (Section 4),
- **Enforcement points** (Section 5),
- **Conformance tests** (Section 6),
- **Trust model limits** (Section 7).
