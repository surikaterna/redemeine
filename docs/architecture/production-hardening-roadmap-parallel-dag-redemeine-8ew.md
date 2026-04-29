# Production Hardening Roadmap + Parallel Delivery DAG (redemeine-8ew)

## Scope

This roadmap operationalizes Epic **redemeine-hwj** into execution-ready waves with explicit dependency order, parallel tracks, and role handoff gates for:
- Transactional outbox reliability
- Observability + inspectability
- CI/security enforcement
- Release readiness and communication

## Planning assumptions

1. Architecture contracts are baseline-complete (redemeine-4gu, redemeine-33p, redemeine-bxt, redemeine-h8i, redemeine-fa0, redemeine-48z, redemeine-yvf, redemeine-9ff, redemeine-1uh).
2. Implementation slices for outbox and telemetry have landed in feature branches, but release confidence depends on Auditor evidence beads.
3. Release gate remains blocked until reliability + observability verification and wave-3 release-integrity controls are all satisfied.

## Wave plan (P0 / P1 / P2)

### P0 (Stabilize and de-risk production path)

**Objective:** Prove core reliability/observability invariants before broader rollout.

- **redemeine-sy8** (Auditor): reliability verification suite for outbox
  - Validate atomicity, retries, dead-letter, lease recovery, idempotency
- **redemeine-vx5** (Auditor): observability verification suite
  - Validate canonical hook schema coverage and trace continuity
- **redemeine-1uh.5** (CI/Security): branch protection + release integrity controls
  - Enforce required checks/reviews and integrity evidence

**Exit gate (P0-GATE):**
- sy8 = verified
- vx5 = verified
- 1uh.5 = verified
- all required CI checks stable and branch protection enforceable without deadlock

### P1 (Scale confidence + operability hardening)

**Objective:** Raise confidence from correctness to operational resilience.

- Execute replay/lag/drift drills from MQ + projection architecture contracts
- Add failure-injection cadence in CI/nightly for outbox and projection paths
- Finalize operator runbook links and release evidence packaging for Diplomacy

**Exit gate (P1-GATE):**
- replay/recovery drill evidence attached
- SLO/alert thresholds validated in staging-like conditions
- on-call runbook complete and referenced in release template

### P2 (Institutionalize + optimize)

**Objective:** Make hardening durable and low-regression over time.

- Promote performance/telemetry budgets from advisory to enforced guardrails
- Add periodic dependency/security attestation audits
- Close loop from production incidents -> new discovered-from beads

**Exit gate (P2-GATE):**
- enforcement checks active
- periodic audit owners assigned
- feedback loop documented and in use

## Parallel delivery tracks

### Track A - Reliability path (Outbox)
- Inputs: redemeine-4gu, redemeine-42m, redemeine-ogq, redemeine-48z, redemeine-yvf
- Gate bead: **redemeine-sy8**
- Critical risk focus: atomicity regressions, lease recovery edge cases, duplicate dispatch

### Track B - Observability/Inspectability path
- Inputs: redemeine-33p, redemeine-xvr, redemeine-bxt, redemeine-h8i, redemeine-26i, redemeine-rt5, redemeine-9ff
- Gate bead: **redemeine-vx5**
- Critical risk focus: missing hook emission points, broken trace correlation, overhead drift

### Track C - CI/Security/Release integrity path
- Inputs: redemeine-1uh, redemeine-1uh.1, redemeine-1uh.2, redemeine-1uh.3, redemeine-1uh.4
- Gate bead: **redemeine-1uh.5**
- Critical risk focus: weak policy enforcement, untrusted artifact chain, merge/deploy deadlock

### Track D - Release communication path
- Input gate bead: **redemeine-haf**
- Depends on: sy8 + vx5 + 1uh.5
- Critical risk focus: releasing before verification evidence is complete

## Dependency DAG (implementation order)

```text
[Foundational architecture COMPLETE]
  4gu 33p bxt h8i fa0 48z yvf 9ff 1uh

Track A (Reliability):
  4gu + 33p + fa0 -> 42m -> ogq -> sy8
  48z + yvf ----------------------^ (supporting verification context)

Track B (Observability):
  bxt + h8i -> 26i -> xvr -> rt5 -> vx5
  33p + 9ff ----------------------^ (schema/taxonomy + projection model)

Track C (CI/Security):
  1uh.1 + 1uh.4 -> 1uh.2
  1uh.4 ---------> 1uh.3
  1uh.1 + 1uh.2 + 1uh.3 + 1uh.4 -> 1uh.5

Track D (Release handoff):
  sy8 + vx5 + 1uh.5 -> haf -> epic release close sequence
```

## Risk register

| ID | Risk | Probability | Impact | Detection signal | Mitigation | Owner stage |
|---|---|---:|---:|---|---|---|
| R1 | Outbox atomicity breaks under adapter edge cases | M | H | flaky rollback/failure-injection tests | enforce adapter conformance + sy8 failure matrix tests | Engineer + Auditor |
| R2 | Lease recovery causes duplicate side-effects | M | H | duplicate delivery IDs in test/prod telemetry | strengthen idempotency keys + lease expiry recovery assertions | Engineer + Auditor |
| R3 | Canonical hook coverage incomplete | M | M/H | missing taxonomy events in vx5 evidence | strict hook coverage checklist against redemeine-33p | Engineer + Auditor |
| R4 | Trace context discontinuity across command->projection path | M | H | orphan spans / broken parent-child chains | dedicated continuity E2E in rt5/vx5 | Engineer + Auditor |
| R5 | Security controls create merge deadlock | L/M | H | required check stuck/skipped states | single stable required gate + no path-filter required checks | Architect + Engineer |
| R6 | Release integrity evidence incomplete (SBOM/attestation/provenance) | M | H | missing artifact evidence at release cut | enforce 1uh.5 checklist before release candidate | Auditor + Diplomat |
| R7 | Coordination drift between tracks delays release | M | M | bead states inconsistent with gate assumptions | explicit gate checklist + bead-status audit cadence | Builder + Architect |

## Handoff gates by role

### Engineer -> Auditor gate
- Bead status: `implemented`
- Required artifact bundle:
  - test evidence (integration/E2E, failure injection where applicable)
  - docs delta (runbook/contracts updated if behavior changed)
  - known limitations list

### Auditor -> Diplomat gate
- Bead status: `verified` (or `changes_requested` with blocking defects)
- Required artifact bundle:
  - reproducible command log
  - acceptance mapping to bead criteria
  - explicit go/no-go recommendation

### Diplomat release gate
- Bead status: `in_review` during PR/release workflow, then close on merge/deploy
- Required readiness:
  - sy8 + vx5 + 1uh.5 all verified
  - rollout messaging + rollback notes linked to bead IDs
  - release notes include hardening evidence references

## Recommended execution sequence (fastest safe path)

1. Run **P0 in parallel** across Tracks A/B/C with daily gate check.
2. Treat **sy8, vx5, 1uh.5** as co-equal blockers; no partial release gate.
3. Once P0-GATE clears, run P1 operational drills and finalize haf.
4. Promote to P2 enforcement only after one successful release cycle.

## Bead traceability summary

- This roadmap bead: **redemeine-8ew**
- Epic: **redemeine-hwj**
- P0 release blockers: **redemeine-sy8**, **redemeine-vx5**, **redemeine-1uh.5**
- Release communication gate: **redemeine-haf**
