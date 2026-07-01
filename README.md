# Redemeine

> Type-safe CQRS/ES aggregates library for TypeScript

[![Build](https://github.com/surikaterna/redemeine/actions/workflows/testing-benchmark.yml/badge.svg)](https://github.com/surikaterna/redemeine/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

---

## What is Redemeine?

Redemeine is a composable toolkit for building event-sourced systems in TypeScript. It provides type-safe builders for aggregates, projections, sagas, and testing — with sane defaults and zero infrastructure dependencies for business logic.

## Packages

| Package | Description |
|---------|-------------|
| [`@redemeine/kernel`](./packages/kernel) | Core primitives — events, commands, metadata, type utilities |
| [`@redemeine/aggregate`](./packages/aggregate) | Event-sourced aggregate builder with typed command handlers and state reducers |
| [`@redemeine/projection`](./packages/projection) | Projection builder for deriving read models from event streams |
| [`@redemeine/mirage`](./packages/mirage) | In-memory aggregate repository for testing |
| [`@redemeine/testing`](./packages/testing) | Test utilities and harnesses for event-sourced applications |

### Internal packages (not published)

| Package | Description |
|---------|-------------|
| `@redemeine/saga` | Process manager (saga) builder for long-running workflows |
| `@redemeine/saga-runtime` | Saga execution runtime with aggregate coordination |
| `@redemeine/projection-runtime-core` | Core projection runtime engine with pluggable storage |
| `@redemeine/projection-runtime` | High-level projection runtime orchestration |
| `@redemeine/projection-runtime-store-inmemory` | In-memory storage adapter for projection runtime |
| `@redemeine/projection-runtime-store-mongodb` | MongoDB storage adapter for projection runtime |
| `@redemeine/projection-router-core` | Event routing for projection dispatch |
| `@redemeine/projection-worker-core` | Worker orchestration for projection processing |
| `@redemeine/projection-worker-lite` | Lightweight standalone projection worker |

## Quick Start

```bash
npm install @redemeine/aggregate @redemeine/kernel
```

### Define an Aggregate

```typescript
import { createAggregate } from '@redemeine/aggregate';

const Counter = createAggregate('Counter', { count: 0 })
  .events({
    incremented: (state, event: { payload: { amount: number } }) => {
      state.count += event.payload.amount;
    },
  })
  .commands((emit) => ({
    increment: (state, amount: number) => emit.incremented({ amount }),
  }))
  .build();
```

### Test with Mirage

```typescript
import { createMirage } from '@redemeine/mirage';

const counter = createMirage(Counter, 'counter-1');
counter.increment(5);
// counter state is now { count: 5 }
```

### Compose with Entities

```typescript
const Order = createAggregate('Order', { status: 'draft', lines: [] })
  .entities({ orderLines: OrderLineEntity })
  .events({
    placed: (state, event) => { state.status = 'placed'; },
  })
  .commands((emit) => ({
    place: (state, customerId: string) => emit.placed({ customerId }),
  }))
  .build();

const order = createMirage(Order, 'order-123');
order.place('cust-99');
order.orderLines('line-1').cancel();
```

### Define a Projection

```typescript
import { createProjection } from '@redemeine/projection';

const OrderSummary = createProjection('order-summary', () => ({
  totalOrders: 0,
  lastOrderId: null as string | null,
}))
  .from(Order)
  .on('placed', (state, event) => {
    state.totalOrders += 1;
    state.lastOrderId = event.aggregateId;
  })
  .build();
```

### Test Fixtures

```typescript
import { testAggregate, testProjection, testSaga } from '@redemeine/testing';

// BDD-style aggregate testing
testAggregate(Counter)
  .given([/* prior events */])
  .when('increment', 5)
  .expectEvents([{ type: 'counter.incremented', payload: { amount: 5 } }]);
```

## Key Features

- **Immutable state transitions** — Immer-powered event application
- **Type-safe command dispatch** — Full TypeScript inference from builder to execution
- **Composable aggregates** — Entities, mixins, and inheritance
- **Plugin interceptors** — Hook into command dispatch, hydration, and commit
- **Infrastructure-free testing** — Test all business logic in memory, no mocks needed
- **Convention-based routing** — Automatic `aggregate.entity.action` path mapping

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm exec turbo run build

# Type check
pnpm exec turbo run typecheck

# Run tests
pnpm exec turbo run test
```

## Architecture

Built as a pnpm + Turbo monorepo with:
- **ESM-first** (`type: "module"`)
- **tsup** for bundled builds with DTS generation
- **Strict TypeScript** (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- **Changesets** for versioning and publishing

## License

[MIT](./LICENSE)

---

*Inspired by [demeine](https://github.com/surikaterna/demeine) and [Redux Toolkit](https://github.com/reduxjs/redux-toolkit). Redemeine is the type-safe, composition-focused evolution of demeine for modern TypeScript.*
