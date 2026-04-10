# Redemeine Documentation

Welcome to the official documentation for **Redemeine**.

Redemeine is a TypeScript-first, convention-over-configuration library designed to make building scalable CQRS and Event Sourcing (ES) aggregates in TypeScript simple, typesafe, and boilerplate-free.

This documentation is designed to help you get started quickly and then deep-dive into the core concepts, patterns, and API reference as you build your domain.

---

## 🚀 Start Here: Redemeine Essentials

Are you new to Redemeine? We recommend starting with our fast-paced tutorial that teaches you how to build your first full-stack, type-safe aggregate in just 10 minutes.

### [Build Your First Aggregate in 10 Minutes](/docs/tutorials/essentials)

### [Build Your First Saga in 10 Minutes](/docs/tutorials/sagas-starter)

---

## 📘 I want to learn the fundamentals

Deep-dive into the architectural decisions and core concepts that make Redemeine powerful. Understand the "why" behind the boilerplate reduction and unique features.

* [**Writing Logic with Immer**](/docs/concepts/immer-and-mutations) — Learn how to write safe, mutable-looking state projections that result in perfectly immutable data snapshots.
* [**Path-Aware Naming Conventions**](/docs/concepts/path-aware-routing) — Understand how Redemeine automatically maps your aggregate method calls into routed, typed event streams, reducing manual string-mapping by 90%.
* [**Immutable Hybrid Entity Collections**](/docs/concepts/path-aware-routing#the-magic-path-aware-routing--hybrid-collections) — Safely iterate nested entities as native read-only arrays and immediately map isolated commands securely behind proxy boundaries.

---

## 🛡️ I want to build robust, typesafe contracts

Redemeine's "Type-Transparent" architecture is designed around end-to-end safety. This guide ensures you use TypeScript to its fullest potential to build a self-documenting domain model.

* [**Usage with TypeScript**](/docs/usage-with-typescript/typescript-patterns) — Best practices for defining and exporting your State, Commands, and Events interfaces, and leveraging inferred types across your application stack.

---

## 🛠️ I need common patterns and guides

Once you've mastered the basics, explore task-oriented guides for solving common problems.

* [**Testing Aggregates**](/docs/recipes/testing-aggregates) — A "Given / When / Then" blueprint for testing pure business logic.
* [**Testing Projections**](/docs/recipes/testing-projections) — Practical patterns for `.from()`/`.join()`, identity routing, and pure handler tests.
* [**Projection Runtime v3 Runbook + Release Gates**](/docs/architecture/projection-runtime-vnext-runbook) — Operational guide for catch-up/cutover/live modes, validation matrix execution, worker-lite limitations, diagnostics triage, rollback expectations, and command-based release sign-off gates.
* [**Projection Runtime v3 Crash/Chaos Safety Matrix**](/docs/architecture/projection-runtime-v3-crash-chaos-safety-matrix) — Failure-mode matrix mapping crash/chaos scenarios to durable boundaries, guarantees, and runbook recovery playbooks aligned with B7Y safety contracts.
* [**Testing Pyramid (Typed-First)**](/docs/recipes/testing-pyramid) — Layered guidance for `testAggregate`/`testSaga`/`testProjection`, Mirage, and `createTestDepot` v1 with typed-first defaults.
* [**Saga Reference**](/docs/reference/sagas-reference) — API-focused reference for defining saga intent maps, projecting pending intents, and integrating dispatch helpers.
* [**Path Conventions Guide**](/docs/guides/path-conventions) — A quick cheat sheet for the default command and event naming paths.
* [**Zod Integration**](/docs/guides/zod-integration) — How to integrate third-party schema validation libraries (like Zod) for advanced runtime checks within your command handlers.
* [**Testing DX v1 Contracts**](/docs/architecture/testing-dx-v1-contracts) — Locked v1 implementation contract for `testAggregate`, `testSaga`, `testProjection`, and `createTestDepot`.
* [**Architecture Decision Log**](/docs/architecture/decision-log) — The historic record of why certain features and APIs exist in Redemeine.
* [**Monorepo Import Boundaries**](/docs/architecture/monorepo-import-boundaries) — Clean-break package import rules, dependency matrix, and kernel ownership scope for monorepo migration.

---

## 📖 Look up the API Reference

Our API reference is automatically generated directly from the source code, ensuring it is always accurate and up-to-date.

### [Browse the Redemeine API Reference](/docs/api/)
