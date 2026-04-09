# Monorepo Import Boundaries and Kernel Scope

This decision artifact defines import boundaries for the Bun+Turbo monorepo migration.

## Decision Summary

- **Clean break:** no compatibility facade package will be provided.
- **Legacy root imports:** imports from `redemeine` and root `src/*` paths are deprecated during migration and **unsupported after migration cutover**.
- **Kernel package:** `@redemeine/kernel` is required to hold only cross-package contracts and dependency-free helpers.

## Import Policy (No Facade)

1. Consumers and internal packages must import from `@redemeine/*` package entry points.
2. Do not add alias shims that preserve legacy root import paths.
3. Package-internal modules should prefer local relative imports and explicit package exports.

## Package Dependency Matrix

Legend: ✅ allowed, ❌ forbidden, — same package

| from \\ to | `@redemeine/kernel` | `@redemeine/aggregate` | `@redemeine/mirage` | `@redemeine/projection` | `@redemeine/saga` | `@redemeine/saga-runtime` |
|---|---:|---:|---:|---:|---:|---:|
| `@redemeine/kernel` | — | ❌ | ❌ | ❌ | ❌ | ❌ |
| `@redemeine/aggregate` | ✅ | — | ❌ | ❌ | ❌ | ❌ |
| `@redemeine/mirage` | ✅ | ✅ | — | ❌ | ❌ | ❌ |
| `@redemeine/projection` | ✅ | ❌ | ❌ | — | ❌ | ❌ |
| `@redemeine/saga` | ✅ | ❌ | ❌ | ❌ | — | ❌ |
| `@redemeine/saga-runtime` | ✅ | ❌ | ✅ | ✅ | ✅ | — |

### Matrix Notes

- `@redemeine/kernel` is leaf-free and has no dependencies on domain/runtime packages.
- `@redemeine/saga-runtime` may depend on `mirage` and `projection` for runtime orchestration needs.
- Reverse/runtime-to-definition cycles are forbidden (for example `saga -> saga-runtime` is not allowed).

## Kernel Ownership Rules

`@redemeine/kernel` may contain only:

- Shared TypeScript types/interfaces used across package boundaries.
- Cross-package contracts (event metadata contracts, stable protocol shapes).
- Minimal pure helpers with **no** external package dependency and **no** domain behavior.

`@redemeine/kernel` must not contain:

- Aggregate, projection, saga, or runtime business logic.
- Infrastructure adapters, persistence logic, dispatch/runtime orchestration.
- Any imports from `aggregate`, `mirage`, `projection`, `saga`, or `saga-runtime`.

## Legacy Import Deprecation Policy

- **Migration window:** legacy root imports may temporarily exist only while files are actively being moved.
- **Post-cutover:** legacy imports are unsupported and should fail review.
- **Compatibility:** no facade package and no long-term alias compatibility layer will be maintained.

### Projection runtime v1 deprecation guardrail

- Deprecated package: `@redemeine/projection-runtime` (v1 legacy runtime contract bundle).
- Production-path policy: imports from `@redemeine/projection-runtime` are not allowed in package/root `src/**` paths.
- Migration target: import from v3 split packages (`@redemeine/projection-router-core`, `@redemeine/projection-worker-core`, `@redemeine/projection-worker-lite`, `@redemeine/projection-runtime-core`, and store adapters) based on responsibility.
- Historical/tests-only references are allowed when explicitly documenting migration history or compatibility context.

## Migration Mapping (Legacy -> Package Imports)

| Legacy import pattern | Target package import |
|---|---|
| `import { ... } from 'redemeine'` | `import { ... } from '@redemeine/<package>'` |
| `import { ... } from 'redemeine/sagas'` | `import { ... } from '@redemeine/saga'` |
| `import { ... } from 'redemeine/projections'` | `import { ... } from '@redemeine/projection'` |
| `import { ... } from 'redemeine/sagas/internal/runtime/*'` | `import { ... } from '@redemeine/saga-runtime'` (only public runtime exports) |
| `import { ... } from 'src/aggregate/*'` | `import { ... } from '@redemeine/aggregate'` |
| `import { ... } from 'src/mirage/*'` | `import { ... } from '@redemeine/mirage'` |
| `import { ... } from 'src/projections/*'` | `import { ... } from '@redemeine/projection'` |
| `import { ... } from 'src/sagas/*'` | `import { ... } from '@redemeine/saga'` or `@redemeine/saga-runtime` by responsibility |
| Shared contracts mixed into domain modules | Move to `@redemeine/kernel`, then import from `@redemeine/kernel` |

## Second-Pass Cohesion-First Ownership Guidance

> Bead note: `redemeine-8n8.9` (second-pass architecture review after kernel refactor)

### Ownership Matrix by Category

| Category | Ownership bin | Guidance |
|---|---|---|
| Aggregate command naming, aggregate-specific event naming, event `apply*` logic | **A) Must stay package-local** (`@redemeine/aggregate`) | Keep behavior with the aggregate model to preserve cohesion and local reasoning. |
| Invariants, state transitions, versioning rules, aggregate lifecycle decisions | **A) Must stay package-local** | Domain behavior is not reusable utility; keep it next to the aggregate state. |
| Projection-specific shaping, saga policy decisions, runtime orchestration decisions | **A) Must stay package-local** (owning package) | Keep decision logic in the package that owns that bounded context/runtime responsibility. |
| Pure primitives reused by multiple packages (e.g., stable event envelope type, result/error algebra, tiny deterministic helpers) | **B) Kernel-eligible if generic and cross-package** (`@redemeine/kernel`) | Only move when truly generic, dependency-free, and already needed by 2+ packages. |
| Cross-package contracts (protocol/type shapes) with no embedded policy | **B) Kernel-eligible if generic and cross-package** | Kernel is the contract boundary; do not include package-specific semantics. |
| Naming normalizers, ID helpers, mappers that look generic but encode domain assumptions | **C) Ambiguous** | Keep local by default; promote only if assumptions are removed and usage is broad. |
| Validation helpers reused by several packages but carrying package vocabulary | **C) Ambiguous** | Split into generic kernel core + package-local wrapper only when it reduces duplication without leaking policy. |

### How to decide where a symbol lives

Apply this decision rule in order:

1. **Does it encode business policy or bounded-context semantics?**
   - Yes -> package-local (A).
2. **Is it dependency-free and semantically generic (no aggregate/projection/saga vocabulary)?**
   - No -> package-local (A).
3. **Is it consumed by at least two packages through stable public APIs?**
   - No -> keep local for now (A).
4. **Would moving to kernel improve consistency without forcing extra abstractions?**
   - Yes -> kernel-eligible (B).
5. **Still unclear?**
   - Treat as ambiguous (C), keep local first, and revisit after a second real consumer appears.

Default principle: **optimize for cohesion first; promote to kernel only for proven, generic, cross-package utility.**

### Guardrails for code review

- [ ] Symbol moved to kernel is used by 2+ packages (or has clear imminent second consumer).
- [ ] Kernel candidate has no imports from domain/runtime packages and no domain vocabulary.
- [ ] Aggregate behavior (naming, apply, invariants, transitions) remains in `@redemeine/aggregate`.
- [ ] Runtime/policy decisions remain in owning package (`projection`, `saga`, `saga-runtime`, etc.).
- [ ] Ambiguous helpers are kept local unless explicit generic extraction rationale is documented in PR notes.
- [ ] New kernel exports are contract-oriented and covered by package-boundary review.
## Validation Guidance for Auditor

- Verify package edges against the matrix above.
- Flag any new or remaining legacy root imports after cutover as non-compliant.
- Flag kernel content that introduces behavior or package dependencies.
