# redemeine-vpn — ADR Traceability Matrix (Saga Runtime v1)

## Purpose

Operational handoff artifact mapping **accepted ADR decisions** in `docs/architecture/decision-log.md` to delivered beads, validation evidence, and explicitly deferred scope for saga runtime v1.

## Source ADRs in scope

1. **ADR: Event-Sourced Process Managers (Sagas)** — Status: Accepted (2026-03-30)
2. **ADR: Typed-first Testing Pyramid and In-Memory Integration Depot** — Status: Accepted (Epic kickoff, 2026-04-02)

## Traceability matrix

| Accepted ADR decision | Implemented beads (runtime v1 wave) | Validation / evidence references | Deferred scope / explicit non-goals |
|---|---|---|---|
| **Event-Sourced Process Managers (Sagas): canonical lifecycle + intent taxonomy, deterministic replay, persisted intent execution** | `redemeine-9dd`, `redemeine-g74`, `redemeine-dtt`, `redemeine-efj`, `redemeine-rvb`, `redemeine-r04`, `redemeine-sfc`, `redemeine-1d7`, `redemeine-c6o`, `redemeine-ckb`, `redemeine-mbi`, `redemeine-u3w` | Bead evidence notes show passing focused suites, including: `bun test ./test/saga-runtime-domain-contracts.test.ts`; `bun test ./test/saga-aggregate-transition-invariants.test.ts`; `bun test ./test/reference-adapters.integration.test.ts`; `bun test ./test/reliability-delivery-modes.integration.test.ts`; `bun test packages/saga-runtime/test/order-workflow-v1.e2e.test.ts`; `bun test ./test/runtime-audit-projections.test.ts`; plus merge evidence in Draft PR #25 / commits cited in bead notes. | `decision-log.md` keeps **Transactional Outbox for Post-Commit Hooks** as TODO/pending ADR. Current short-term policy remains inline post-commit behavior; full outbox worker model is deferred beyond runtime v1 scope. |
| **Event-Sourced Process Managers (Sagas): pluginized runtime seams and scheduling policy contracts** | `redemeine-c3p`, `redemeine-88r`, `redemeine-p1s`, `redemeine-auj`, `redemeine-tor`, `redemeine-06k`, `redemeine-777`, `redemeine-dsk` | Contract + conformance evidence in bead notes, including: `bun test ./test/runtime-contracts-structure.test.ts`; `bun test ./test/plugin-registry-precedence.test.ts`; `bun test ./test/plugin-spi-conformance-harness.test.ts`; `bun test ./test/scheduler-policy-evaluator.test.ts`; `bun test ./test/reference-adapters.integration.test.ts`. | `redemeine-88r` notes runtime-loaded hot-plugin model remains out of scope for v1 (compile-time registry delivered). |
| **Typed-first Testing Pyramid + In-Memory Integration Depot: deterministic, typed-first validation strategy** | Runtime v1 evidence-producing beads: `redemeine-dsk`, `redemeine-ckb`, `redemeine-c6o`, `redemeine-b13`, `redemeine-t2v` | Delivered artifacts and checks include: plugin SPI conformance harness (`plugin-spi-conformance-harness.test.ts`), end-to-end workflow validation (`order-workflow-v1.e2e.test.ts`), reliability fault-injection tests (`reliability-delivery-modes.integration.test.ts`), scale report (`docs/architecture/redemeine-b13-scale-validation-report.md`), and runtime contract documentation updates (`docs/reference/sagas-reference.md`). | ADR scope note in `decision-log.md`: **full worker response simulation** is an explicit follow-up slice after v1; raw envelope dispatch retained for boundary/replay/negative-shape tests. |

## Coverage summary

- Accepted ADR decisions traced: **2 / 2** in scope.
- Runtime v1 implementation beads referenced: **21** (`redemeine-06k`, `1d7`, `777`, `88r`, `9dd`, `auj`, `b13`, `c3p`, `c6o`, `ckb`, `dsk`, `dtt`, `efj`, `g74`, `mbi`, `p1s`, `r04`, `rvb`, `sfc`, `t2v`, `u3w`).
- Deferred scope explicitly captured from ADRs and bead notes: **3 items**
  1. Transactional outbox ADR still pending.
  2. Runtime-loaded hot plugins out of scope for v1.
  3. Full worker response simulation deferred post-v1.

## Handoff notes

- This matrix is derived from accepted ADR content in `docs/architecture/decision-log.md` and implementation/validation evidence recorded in child bead notes under epic `redemeine-8te`.
- Intended consumer: Auditor/Diplomat handoff for runtime v1 closure and release traceability.
