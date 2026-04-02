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

## Migration Mapping (Legacy -> Package Imports)

| Legacy import pattern | Target package import |
|---|---|
| `import { ... } from 'redemeine'` | `import { ... } from '@redemeine/<package>'` |
| `import { ... } from 'redemeine/sagas'` | `import { ... } from '@redemeine/saga'` |
| `import { ... } from 'redemeine/sagas/internal/runtime/*'` | `import { ... } from '@redemeine/saga-runtime'` (only public runtime exports) |
| `import { ... } from 'src/aggregate/*'` | `import { ... } from '@redemeine/aggregate'` |
| `import { ... } from 'src/mirage/*'` | `import { ... } from '@redemeine/mirage'` |
| `import { ... } from 'src/projections/*'` | `import { ... } from '@redemeine/projection'` |
| `import { ... } from 'src/sagas/*'` | `import { ... } from '@redemeine/saga'` or `@redemeine/saga-runtime` by responsibility |
| Shared contracts mixed into domain modules | Move to `@redemeine/kernel`, then import from `@redemeine/kernel` |

## Validation Guidance for Auditor

- Verify package edges against the matrix above.
- Flag any new or remaining legacy root imports after cutover as non-compliant.
- Flag kernel content that introduces behavior or package dependencies.
