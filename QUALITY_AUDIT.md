# 12-Dimension Code & Architecture Quality Audit

Use this prompt to evaluate any package, PR, or codebase area. Score each dimension 1–5 (1 = critical issues, 5 = exemplary). Flag specific violations with file:line references.

---

## Dimensions

### 1. Type Safety & Correctness
> Does the code leverage TypeScript's type system to prevent bugs at compile time?

- [ ] No `as any` without a `// SAFETY:` justification
- [ ] No `@ts-ignore` or `@ts-expect-error` without expiration context
- [ ] Generics are constrained (no unbounded `<T>` where `<T extends X>` is possible)
- [ ] Union types are exhaustively handled (switch/if with `never` assertions)
- [ ] `unknown` preferred over `any` at trust boundaries
- [ ] Return types are explicit on public API functions
- [ ] Discriminated unions over boolean flags for state machines
- [ ] No type assertions that widen (`as SomeWiderType`) — only narrow

### 2. API & DX (Developer Experience)
> Is the public surface intuitive, discoverable, and hard to misuse?

- [ ] API follows principle of least surprise (naming, argument order, return types)
- [ ] Builder/fluent patterns provide compile-time feedback on invalid sequences
- [ ] Error messages are actionable (not "invalid input" but "expected X, got Y")
- [ ] Overloads have clear documentation on when to use each
- [ ] Default parameters eliminate boilerplate for common cases
- [ ] Types are exported for consumers who need them (not hidden internal-only)
- [ ] No required configuration that could have a sane default
- [ ] IDE autocomplete produces useful results (no `any`-typed suggestions)

### 3. SOLID Principles
> Does each unit have a single reason to change? Are dependencies inverted?

- [ ] **S**ingle Responsibility: Each file/class/module owns one concept
- [ ] **O**pen/Closed: Extension without modification (plugins, generics, callbacks)
- [ ] **L**iskov Substitution: Subtypes are safe substitutes (no override that narrows)
- [ ] **I**nterface Segregation: Consumers don't depend on methods they don't use
- [ ] **D**ependency Inversion: High-level modules depend on abstractions, not concretions
- [ ] No god objects (files > 400 lines signal a cohesion problem)
- [ ] No circular dependencies between modules

### 4. DRY & Cohesion
> Is knowledge expressed once and only once?

- [ ] No copy-pasted logic (extract shared functions/types)
- [ ] No parallel type hierarchies that drift (single source of truth for shapes)
- [ ] Constants/configs defined once, imported everywhere
- [ ] No re-implementation of standard library or dependency functionality
- [ ] Related code lives together (feature-sliced, not layer-sliced where inappropriate)
- [ ] Shared utilities are genuinely reusable (not forced abstractions)

### 5. Dead Code & Unused Exports
> Is everything in the codebase reachable and serving a purpose?

- [ ] No unreachable code paths (after unconditional return/throw)
- [ ] No unused function parameters (use `_prefix` if structurally required)
- [ ] No exported symbols that have zero consumers
- [ ] No commented-out code blocks (use git history instead)
- [ ] No `TODO`/`FIXME` without a linked issue
- [ ] No deprecated functions without a removal timeline
- [ ] No feature flags that are permanently on/off

### 6. Unwired Code & Stubs
> Is every declared contract actually implemented and connected?

- [ ] No interfaces without implementations
- [ ] No implemented methods that are never called
- [ ] No event handlers that are registered but never triggered
- [ ] No configuration options that have no effect
- [ ] No test utilities that are never used in actual tests
- [ ] No `throw new Error('not implemented')` stubs
- [ ] No empty function bodies (`() => {}`) that should have logic
- [ ] No middleware/plugins registered but not exercised by any code path

### 7. Error Handling & Resilience
> Does the code fail gracefully and provide diagnosability?

- [ ] Errors are caught at appropriate boundaries (not swallowed, not over-caught)
- [ ] Error types are discriminated (not all `Error` — use custom classes or codes)
- [ ] Async operations have timeout/cancellation semantics
- [ ] Retry logic has backoff and maximum attempts
- [ ] Resource cleanup happens in `finally` (or via disposable patterns)
- [ ] Validation errors are surfaced early (fail fast at boundaries)
- [ ] No silent fallbacks that mask bugs in production

### 8. Testing Quality
> Do tests verify behavior, not implementation?

- [ ] Tests describe _what_ not _how_ (behavior-driven, not mock-driven)
- [ ] Edge cases covered: empty inputs, boundaries, error paths, concurrency
- [ ] No tests that always pass (tautological assertions)
- [ ] No tests coupled to internal structure (refactor-resistant)
- [ ] Test helpers don't hide assertions (every test has visible expect/assert)
- [ ] Integration tests exist for cross-module contracts
- [ ] No flaky tests (time-dependent, order-dependent, network-dependent)

### 9. Naming & Readability
> Can a new developer understand the code without asking questions?

- [ ] Names reveal intent (not `data`, `info`, `temp`, `result`, `handler`)
- [ ] Abbreviations are domain-standard or spelled out
- [ ] Boolean names are questions (`isReady`, `hasPermission`, not `ready`, `flag`)
- [ ] Function names are verbs, type names are nouns
- [ ] No misleading names (function named `get` that mutates state)
- [ ] Consistent vocabulary (don't mix `create/make/build/new` for the same concept)
- [ ] File names match their primary export

### 10. Architecture & Boundaries
> Are module boundaries clean and dependency direction enforced?

- [ ] Package dependency graph is acyclic
- [ ] No reaching into another package's internals (`../../other-pkg/src/`)
- [ ] Public API surface is explicit (barrel `index.ts` controls visibility)
- [ ] Runtime code doesn't import from test code
- [ ] No leaking of infrastructure types into domain logic
- [ ] Layer violations are flagged (presentation importing persistence directly)
- [ ] Cross-package contracts are versioned/stable

### 11. Performance & Resource Management
> Are resources acquired late, released early, and operations bounded?

- [ ] No unbounded collections (arrays/maps that grow without limit)
- [ ] Async operations are parallelized where independent (`Promise.all`)
- [ ] No unnecessary synchronous blocking
- [ ] Subscriptions/listeners are cleaned up (no memory leaks)
- [ ] No N+1 query patterns in data access
- [ ] Heavy computation is lazy/deferred where possible
- [ ] Object allocations in hot paths are minimized

### 12. Documentation & Contracts
> Are invariants, assumptions, and contracts explicitly stated?

- [ ] Public API has TSDoc with `@param`, `@returns`, `@throws`, `@example`
- [ ] Non-obvious algorithms have a comment explaining the _why_
- [ ] Module-level doc comment explains the responsibility boundary
- [ ] Breaking changes are documented in CHANGELOG
- [ ] README covers: install, quick start, API overview, contributing
- [ ] Type-level documentation (generics have descriptive names: `TState` not `T`)
- [ ] Invariants that can't be expressed in types are documented as comments

---

## Scoring Guide

| Score | Meaning |
|-------|---------|
| 5 | Exemplary — could be used as a teaching reference |
| 4 | Good — minor issues, no systemic problems |
| 3 | Adequate — some patterns need attention, nothing blocking |
| 2 | Concerning — systematic issues that will cause maintenance pain |
| 1 | Critical — bugs, security issues, or architectural debt requiring immediate action |

## Usage

```
Audit [package/file/PR] against the 12-dimension quality framework.
For each dimension, provide:
- Score (1-5)
- Evidence (file:line references for violations)
- Top recommendation (one actionable fix)
```
