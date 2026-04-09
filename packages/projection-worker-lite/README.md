# @redemeine/projection-worker-lite

Lightweight projection worker contract for browser and in-memory runtimes.

## Guarantees and intent

`@redemeine/projection-worker-lite` is intentionally **best-effort**.

- No durable dedupe guarantees
- No transactional/atomic persistence guarantees
- No strong ordering guarantees across process boundaries

This package is for local/browser workflows where simplicity is preferred over durability.
Use `@redemeine/projection-worker-core` for stronger runtime guarantees.

## API shape

- `createProjectionWorkerLite(processor)`
- `push(message)` -> per-item decision with `guarantee: 'best_effort'`
- `pushMany(messages)` -> per-item decisions with `guarantee: 'best_effort'`

Decisions are explicit:

- `{ status: 'processed' }`
- `{ status: 'dropped', reason }`

## Boundary rule

This package must stay decoupled from concrete runtime/store implementations and from `projection-worker-core`.
It is a separate path with explicitly weaker semantics.
