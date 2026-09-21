# Saga production architecture and distributed evolution

## Metadata and decision status

- Issue: **redemeine-qddj**; stage: **repository review**. The standalone content and focused amendments were independently audited; this repository copy is awaiting its own Auditor verification and is not runtime certification.
- Amendment 2026-09-17: **redemeine-ihn0 — policy_amendment_verified**. Independent Auditor approved the availability-policy amendment. Its implementation later merged into Tapeworm `develop`; no release or deployment is claimed.
- Prepared: 2026-09-16; baseline: `27df603cfbb7ad4cfac507646faeeb21c3b65139`.
- Repository: https://github.com/surikaterna/redemeine ; baseline HEAD was checked locally.
- Sibling source evidence: historical baseline `5deefee89b22fbfb6d79fe6be145b47ae756d396`; merged Tapeworm `develop` state `bc9ec5e41c0d9305365eb2d879add92de57a3539` (PRs 42, 43 and 44).
- Status: **proposed architecture, not implemented, benchmarked, or production-certified**.
- Artifact source: `/tmp/opencode/saga-production-plan.md`; the audited standalone content is now placed at `docs/architecture/saga-production-plan.md` for repository review.
- **redemeine-70xi** verified the safe redirected worktree unblock; it remains `verified` for Diplomat closure rather than being treated as a runtime-delivery issue.
- This placement changes documentation only. It makes no runtime implementation, package release, deployment, publication or capacity claim.
- Evidence combines the supplied authoritative investigation, targeted source inspection, and live Beads history.
- Source permalinks below pin full SHAs; historical issue decisions are distinct from code present on main and merged sibling evidence.

## Table of contents

1. [Executive answers](#1-executive-answers)
2. [Evidence and historical authority](#2-evidence-and-historical-authority)
3. [Exact logical runtime inventory](#3-exact-logical-runtime-inventory)
4. [Simpler production-grade architecture](#4-simpler-production-grade-architecture)
5. [MongoDB, Tapeworm, and RabbitMQ capability gates](#5-mongodb-tapeworm-and-rabbitmq-capability-gates)
6. [Durable records and turn contract](#6-durable-records-and-turn-contract)
7. [CDC publication and failure windows](#7-cdc-publication-and-failure-windows)
8. [Real side effects and an invoice example](#8-real-side-effects-and-an-invoice-example)
9. [Callbacks, retries, timers, and terminal races](#9-callbacks-retries-timers-and-terminal-races)
10. [Capacity and qualification](#10-capacity-and-qualification)
11. [Distributed evolution](#11-distributed-evolution)
12. [SDK and developer experience](#12-sdk-and-developer-experience)
13. [Dependency-ordered delivery plan](#13-dependency-ordered-delivery-plan)
14. [Validation, rollout, and handoff](#14-validation-rollout-and-handoff)

## 1. Executive answers

### Availability-policy supersession — 2026-09-17, redemeine-ihn0

For the business-critical Tapeworm distributor, configured **enabled durable quarantine now defaults to continue** after capturing an eligible poison commit; `mode:"pause"` explicitly opts into stopping. No second acknowledgement flag is required; `acceptOrderingGaps:true` is deprecated compatibility syntax, and false is rejected with explicit-pause guidance. This supersedes the earlier unpublished pause-default/opt-in-continue policy from redemeine-1i0g, not the pinned historical source analysis below.

The production SDK caller must supply the durable store and assert immutable source retention. Absent/disabled quarantine and the CLI without such configuration remain fail-closed; neither storage nor retention is automatically provisioned. Store-write failure, broker/network failures and arbitrary hook/serializer failures still prevent checkpoint advancement; eligibility is limited to the optional configured encoded-message-size threshold. Continue emits `quarantined`, not false `dispatched`, and creates ordering gaps that redrive cannot restore; consumers need idempotency/reconciliation. Historical lower-UUID expiry risk is unchanged.

The linked quarantine, collation, availability-policy and CDC recovery work is merged in Tapeworm `develop` at `bc9ec5e41c0d9305365eb2d879add92de57a3539` through PRs 42, 43 and 44. **redemeine-4tud is closed** after an actual ephemeral Jenkins controller and Docker agent built and qualified that exact SHA. This verifies the Tapeworm transport stack, not the proposed durable saga engine or its Redemeine integration; no package release, publication, deployment or capacity certification occurred.

### Required two-stage contract

**Yes: decide and atomically record the work first; a second process executes committed intents and durably records their outcomes.** This is the proposed contract, not current runtime behavior.
1. **Process A — decide:** load a durable source trigger and authoritative saga state; evaluate a deterministic handler with captured time/random inputs and no external effects (Immer-style local mutation is fine).
2. **One authoritative atomic commit:** consumed-trigger marker/checkpoint + saga progress/event facts + full executable serializable intents + relevant timer mutations, conditional on expected version and commit-time ownership fence. A checkpoint cannot skip unconsumed triggers.
3. **ACK distinction:** the logical trigger ACK is that transactional consumed marker; RabbitMQ ACK is a separate transport operation after commit, never part of the Mongo transaction. Earlier ACK after durable inbox persistence is admission only, requires a guaranteed recovery loop, and does not mean the turn was evaluated/consumed.
4. **Process B — execute:** a separate recoverable worker/process discovers committed pending/due intents through a durable index and/or CDC notifications, acquires a durable versioned claim/lease by conditional write, and calls the real executor with the stable intent identity/idempotency key. Indexed admitted work and valid-resume delivery must recover; only expired-history CDC discovery has the narrow accepted omission risk in section 7. No Mongo transaction spans remote effects.
5. **Check off atomically:** conditionally commit the durable result and callback continuation/recoverable event record together with terminal completion, so completion can never precede recoverable continuation. Persist failures, retry budget and `nextAttemptAt`, or dead-letter disposition; reclaim abandoned work safely.
6. **Proposed execution vocabulary:** `pending`, `in_progress`, `succeeded`, retry-wait and dead-letter states describe future executor semantics, not an existing enum/API. Transport dispatch acceptance is not business completion for request-response work; persist its awaiting-outcome state until the business result arrives.
7. **Crash rule:** before A commits there is no committed turn/effect (the admitted trigger remains recoverable); after commit but before broker ACK, replay dedupes; after a remote effect but before completion, retry with the same key against an idempotent destination or reconcile the uncertain outcome. No exactly-once external-effect claim.

CDC is discovery/publication plumbing, not a replacement for Process B. **redemeine-1ps does not forbid a second durable intent executor**; it removed the old `outbox_primary`/dispatcher implementation, which this plan does not mandate restoring.
**Type safety is mandatory across all owned TypeScript, not optional DX polish:** zero explicit/implicit `any`, validated external boundaries and end-to-end inference; see [mandatory type-safety contract](#mandatory-type-safety-contract).

**What is saga-runtime today?** A useful execution/reference layer, not a durable workflow service.
It combines saga handler execution, lifecycle aggregate bookkeeping, in-memory reference adapters, a separate inbound router, scheduling policy evaluation, and audit/read contracts.
The declarative DSL is primarily in `@redemeine/saga`; storage durability, broker transport, and worker ownership are not supplied by the reference bridge.

**Can a simpler runtime become production-grade?** Yes, conditionally: start with one active owner, durable inboxes, an atomic authoritative turn, recoverable CDC publication, bounded workers, and idempotent effects.
Simplicity should reduce deployment and ownership complexity, not remove durability or recovery semantics.
The same owner can advance many independent saga keys concurrently while each key remains serialized.

**What volume can it handle?** Real durable throughput is **unmeasured**; no evidence supports a promised sagas/day number.
The existing scale report is a scheduling simulation, not elapsed handler/database/broker execution.
Qualification must count committed turns, durable effects, latency, backlog, and recovery under a defined workload.
**Recovery scale/risk decision (user-approved 2026-09-16):** with hundreds of millions of events/commits, use valid resume tokens normally and paginated indexed UUIDv7 fallback only after history expires; accept possible undiscovered late/lower-token records outside the fallback range, not a lossless historical-recovery promise.
This supersedes exhaustive-history completeness as a default; it does not weaken authoritative atomicity, already-admitted work recovery, no-false-completion rules, or normal valid-token delivery.

**What changes for distribution?** Add partition ownership, commit-time fencing/OCC, rebalance recovery, shared timer/executor claims, and global quota coordination.
Launching multiple Rabbit consumers around local Maps does not provide those guarantees and does not scale a single hot saga key.

**Is MongoDB/Tapeworm/Rabbit wired now?** Redemeine's saga bridge is not wired to a production store/broker; its real Mongo transaction implementation is projection-specific.
The sibling Tapeworm repository does implement Mongo commit persistence and Mongo-to-Rabbit CDC: an **implemented transport candidate, not a qualified saga integration**. One commit can carry a whole turn; multiple commits are not atomic. Transport remediation is merged and Jenkins-validated, while saga-specific atomicity, execution and capacity gates remain.

**Which intents/executors?** The current SDK has one `plugin-intent` envelope with two interaction modes, core command dispatch/timers, and registered plugin actions; its seven-variant reference-runtime union is different.
Use one shared durable worker with a typed command/plugin registry plus internal timer handling, not a process per action; see [intent taxonomy](#intent-taxonomy-current-sdk-versus-reference-runtime) and [minimal executor set](#minimal-executor-set-and-routing-contract).
**Can sagas be easy and reliable to test?** Yes as a mandatory delivery goal, not a current guarantee: retain fast typed state/intent fixtures and test the actual production engine with virtual time, then real adapters and packed declarations; see [four mandatory testing tiers](#four-mandatory-testing-tiers).

**Are effects real?** The default reference executor reports synthetic success for plugin dispatch/request-response intents; legacy `run-activity` does invoke its closure.
A custom executor can perform real work, but its current seam alone does not supply durable execution identity, delivery, retries, or callback routing.

**Is the SDK best-in-class?** Not demonstrated: strong typed authoring ideas coexist with tutorial drift, typing gaps, and missing durable orchestration.
The target is a measured installed-consumer and operational experience, not parity claims based on DSL appearance.

## 2. Evidence and historical authority

### Source register

All links are file-level permalinks unless an inspected line range is useful; none relies on relative repository navigation.

| Ref | Baseline evidence | Relevance |
| --- | --- | --- |
| S1 | [runtime index](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga-runtime/src/index.ts) | Actual package exports and re-exports |
| S2 | [SagaAggregate](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga-runtime/src/SagaAggregate.ts) | Five lifecycle families, guards, windows, execution interfaces |
| S3 | [execution bridge](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga-runtime/src/sagaExecutionBridge.ts) | Handler matching, Maps, ordering, adapter invocation |
| S4 | [reference adapters](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga-runtime/src/referenceAdapters.ts) | Persistence, scheduler, effects, telemetry, flow |
| S5 | [inbound router](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga-runtime/src/inboundRouter.ts) | Local keyed promise chains and barriers |
| S6 | [scheduler evaluator](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga-runtime/src/schedulerPolicyEvaluator.ts) | Weighted selection/rate-limit policy, not a worker |
| S7 | [audit projections](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga-runtime/src/runtimeAuditProjections.ts) | Lifecycle history and query model |
| S8 | [saga DSL](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga/src/createSaga.ts) | Definition, plugin helpers, tokens, action chains |
| S9 | [handler execution](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga/src/execution/handlerExecution.ts) | Immer execution and response/error helpers |
| S10 | [reliability harness](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga-runtime/test/reliability-delivery-modes.integration.test.ts) | Harness-owned dedupe/retry/DLQ logic |
| S11 | [scale harness](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga-runtime/test/scheduler-scale-validation.harness.ts) | Simulated scheduling load |
| S12 | [scale report](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/docs/architecture/redemeine-b13-scale-validation-report.md) | 234,049 selected over simulated day |
| S13 | [testing ambient shim](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/testing/src/saga-ambient.d.ts) | `any` can mask consumer typing problems |
| S14 | [testSaga fixture](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/testing/src/testSaga.ts) | Async event/response/error fixture methods |
| S15 | [starter tutorial](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/docs/tutorials/sagas-starter.md) | API drift and overstrong durability wording |
| S16 | [Mirage Depot](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/mirage/src/Depot.ts) | Expected-version store seam and inline hooks |
| S17 | [Mongo projection transaction executor](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/projection-runtime-store-mongodb/src/store/transactionExecutor.ts) | Real `withTransaction` implementation, projection scope |
| S18 | [root scripts](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/package.json) / [runtime scripts](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/saga-runtime/package.json) | Verified commands; runtime package currently private |
| S19 | [fixture helpers](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/testing/src/sagaHelpers.ts) | Matching, JSON equality, FIFO paired callback queues and lost handler data |
| S20 | [aggregate command creators](https://github.com/surikaterna/redemeine/blob/27df603cfbb7ad4cfac507646faeeb21c3b65139/packages/aggregate/src/proxies/createCommandCreatorsProxy.ts) | Creator-produced command type honors naming strategy and explicit overrides |

### Tapeworm sibling evidence

T1–T11 pin the independently inspected **historical baseline** SHA, not Redemeine's baseline. They intentionally preserve the source state from which the original gaps were derived; implementation existence is not qualification evidence.
Checked-in manifests identify core **0.6.0**, Mongo store **3.1.0**, and dispatcher **0.2.0**; these are **not npm publication/version-availability claims**.

| Ref | Pinned Tapeworm source | Relevance |
| --- | --- | --- |
| T1 | [core types](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm/src/types.ts) | `ICommit.events[]`, persistence interfaces |
| T2 | [event-store partition](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm/src/event_store_partition.ts) | Sequential append array and inline dispatch |
| T3 | [Mongo partition](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm_persistence_store_mongodb/src/mongodb_partition.ts) | Unique indexes, single `insertOne`, pre-insert UUID token, unimplemented dispatch marking |
| T4 | [Mongo persistence](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm_persistence_store_mongodb/src/mongodb_persistence.ts) | Partition cached before index initialization completes |
| T5 | [CDC dispatcher](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm_dispatcher_mdb_rmq/src/dispatcher.ts) | Failed poison publication can be skipped before checkpoint |
| T6 | [change-stream watcher](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm_dispatcher_mdb_rmq/src/watcher.ts) | Retry cursor, fallback, token backfill/live cutover |
| T7 | [Rabbit publisher](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm_dispatcher_mdb_rmq/src/publisher.ts) | Headers exchange, whole-commit JSON, persistent messages and confirms |
| T8 | [Mongo checkpoint store](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm_dispatcher_mdb_rmq/src/resume/mongodb-store.ts) | Fixed checkpoint ID, majority write, no owner CAS |
| T9 | [oplog watcher](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm_dispatcher_mdb_rmq/src/oplog-watcher.ts) | Raw direct-insert tailing, not transaction/rollback qualification |
| T10 | [Mongo tests](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm_persistence_store_mongodb/test/persistence.spec.ts) / [dispatcher test config](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm_dispatcher_mdb_rmq/vitest.config.ts) | One-node replica-set tests; dispatcher permits no tests |
| T11 | [core manifest](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm/package.json) / [Mongo manifest](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm_persistence_store_mongodb/package.json) / [dispatcher manifest](https://github.com/surikaterna/tapeworm/blob/5deefee89b22fbfb6d79fe6be145b47ae756d396/packages/tapeworm_dispatcher_mdb_rmq/package.json) | Checked-in versions only |
| T12 | [merged dispatcher README](https://github.com/surikaterna/tapeworm/blob/bc9ec5e41c0d9305365eb2d879add92de57a3539/packages/tapeworm_dispatcher_mdb_rmq/README.md) | Final delivery, recovery and quarantine contract; merged but not released/deployed |
| T13 | [merged delivery failure port](https://github.com/surikaterna/tapeworm/blob/bc9ec5e41c0d9305365eb2d879add92de57a3539/packages/tapeworm_dispatcher_mdb_rmq/src/delivery/delivery-failure.ts) / [quarantine adapter](https://github.com/surikaterna/tapeworm/blob/bc9ec5e41c0d9305365eb2d879add92de57a3539/packages/tapeworm_dispatcher_mdb_rmq/src/quarantine/failure-handler.ts) | Core-owned checkpoint sequencing and optional transport-only durable handling |
| T14 | [merged publication encoding](https://github.com/surikaterna/tapeworm/blob/bc9ec5e41c0d9305365eb2d879add92de57a3539/packages/tapeworm_dispatcher_mdb_rmq/src/rabbitmq/encoding.ts) | Optional configured encoded-size threshold is the only quarantine eligibility gate |
| T15 | [healthy-path test](https://github.com/surikaterna/tapeworm/blob/bc9ec5e41c0d9305365eb2d879add92de57a3539/packages/tapeworm_dispatcher_mdb_rmq/test/quarantine/quarantine-hotpath.test.ts) / [replay test](https://github.com/surikaterna/tapeworm/blob/bc9ec5e41c0d9305365eb2d879add92de57a3539/packages/tapeworm_dispatcher_mdb_rmq/test/quarantine/quarantine-replay.integration.ts) | Healthy delivery avoids quarantine work; ordinary replay can publish without mutating historical receipts |

### Historical decisions override stale implementation suggestions

- **redemeine-1ps**, closed: removed `outbox_primary`, dispatcher, and outbox-specific hooks in the old hwj branch; direction is CDC → DB → relay → MQ → saga/aggregate/projection inbox.
- Its closure says merged into `feature/redemeine-hwj`; that is not evidence that the entire branch landed on current main.
- **redemeine-e47.1**, closed: user-approved audit dropped PR27 carry-over; only README deferred-followup pointers were retained, not wholesale code/docs replay.
- **redemeine-e47.5**, open: durable saga inbox, persist-before-ack, deterministic dedupe, replay-safe drains, restart resilience.
- **redemeine-e47.6**, open: OTel package/integration without stale outbox coupling; **e47.7**, open: trace-correlation continuity E2E.
- **redemeine-e47.8**, open: canonical inspection hook envelope parity; it is **not** a documentation-blueprint issue.
- **redemeine-qddj** owns this planning document; **redemeine-70xi** verified the redirected repository worktree used for placement.
- Open follow-ups: **redemeine-ras4** owns atomic-turn/ownership/reconciliation qualification and **redemeine-1tad** owns strongly typed executors and shared-engine test conformance. **redemeine-gqxm** retains CDC traceability; its transport work is now merged through the 4tud delivery stack, without implying saga integration or release.

S16's old outbox TODO is evidence of an unsafe inline-hook boundary, not authorization to restore a removed architecture.
This plan requires atomic complete intent capture and a CDC-aligned publication responsibility, not the old `outbox_primary` polling implementation.
Any reversal of that decision requires an explicitly reopened architecture decision and approval.

## 3. Exact logical runtime inventory

The table inventories logical responsibilities, not an assertion that each responsibility has its own durable service.

| Logical component | Current behavior | Missing production guarantee |
| --- | --- | --- |
| DSL execution re-exports (S1, S8–S9) | `createSagaDispatchContext`, `runSagaHandler`; execution collects intents using Immer drafts | Handler code can still perform nondeterministic I/O; no durable turn boundary |
| Lifecycle aggregate (S2) | `createSagaAggregate`, counters, lifecycle state and guards | Not a full persisted workflow/business-state engine |
| Intent execution models (S2) | Status/attempt/retry snapshot/response reference and projection interfaces | Models do not implement claims, retry scheduling, payload retention, or atomic completion |
| Execution bridge (S3) | Matches aggregate/event aliases; runs matched handlers sequentially within one `dispatch` call | Concurrent calls are not serialized per saga; no durable dedupe |
| Bridge state/identity (S3) | Business-state Map, lifecycle-state Map, per-saga intent counter; optional synchronous get/set callbacks | Local cache precedence, restart identity reuse risk, no awaited atomic storage protocol |
| Reference persistence (S4) | Maps for lifecycle projection and intent executions | Not an event store, transaction, or crash-safe inbox |
| Reference scheduling (S4) | Map, schedule/cancel/list/drain, restart/misfire metadata | Raw trigger ID collisions, destructive drain before acknowledgement, unbounded overdue enumeration |
| Reference effects (S4) | Synthetic plugin success/response references; custom `execute(intent)`; legacy activity closure execution | No execution-ID argument, durable claim, broker, automatic callback route, or business completion proof |
| Adapter flow (S4) | Records executions, applies timers, executes side effects with `Promise.all`, returns correlations | No atomic turn; records default to attempt 1 and null retry policy; full intent payload absent |
| Inbound router (S5) | Aggregate process/apply; keyed promise single-flight, independent keys, optional step barriers | Standalone, not wired around bridge; volatile queues/state, no bounded admission or ownership fence |
| Scheduler policy (S6) | Pure weighted fairness, priorities, tenant budgets and deferred reasons | Not timer storage, clock loop, shared quota enforcement, or a durable worker |
| Audit/read layer (S7, S1) | Lifecycle history queries, pagination, read/telemetry contract exports | Query limits do not bound retained in-memory history or make it durable |
| Reference telemetry (S4) | Counters and append-only event array | No bounded exporter, retention, or completed OTel delivery path |
| Reliability/scale tests (S10–S12) | Harness models delivery and policy behavior | Harness-owned dedupe/retry/DLQ and simulated selections are not production implementations |

### The five SagaAggregate lifecycle families

| Command | Event | Responsibility |
| --- | --- | --- |
| `createInstance` | `instanceCreated` | Identity/type, creation time, initial lifecycle state |
| `observeSourceEvent` | `sourceEventObserved` | Source envelope and observation history |
| `recordStateTransition` | `stateTransitioned` | Lifecycle transition and history |
| `recordIntentLifecycle` | `intentLifecycleRecorded` | Intent stage record, not executable payload storage |
| `recordActivityLifecycle` | `activityLifecycleRecorded` | Activity stage/attempt record |

Creation must precede recording; duplicate creation is rejected.
Transitions reject terminal-state departure, a mismatched `fromState`, and no-op transitions; do not infer validation beyond these guards.
State includes `id`, `sagaType`, lifecycle state, timestamps, `transitionVersion`, totals, and four recent windows defaulting to **50 each**.
Those windows bound only recent records per lifecycle instance, not saga count, business state, identity Maps, telemetry, or audit retention.

### Current ordering and misleading seams

The bridge records an observed event, awaits a handler, updates business state, records intent lifecycle entries, then invokes adapters.
An adapter failure therefore occurs after local state progression; synchronous setters do not make this an atomic awaited transaction.
Handlers are sequential per call, while effects within the adapter flow run concurrently; neither establishes ordering across concurrent bridge dispatches.
The bridge does not automatically use the separate router, infer all correlation routing, or dispatch returned response correlations into callback helpers.
S9 provides response/error execution helpers; production callback intake, durable correlation, retries, and terminal arbitration remain separate work.

### Intent taxonomy: current SDK versus reference runtime

In **`@redemeine/saga`**, `SagaIntent = SagaPluginIntent`: `type: 'plugin-intent'` and `interaction: 'fire_and_forget' | 'request_response'` (S8).
Do not document the reference adapter's broader compatibility union as the current authoring DSL's output.

| Surface | Actual envelope / operation | Production disposition |
| --- | --- | --- |
| SDK `core.dispatch` | Unified one-way intent; execution payload `{ command, payload, aggregateId }`; currently `command` is the creator **map key**, not its canonical envelope type; no `aggregateType` field | Approved: persist creator-produced `envelope.type`, e.g. `invoice.pay.command`, instead of local `pay`; implementation still pending |
| SDK `core.schedule` | Unified one-way intent with `{ id, delay }`, delay in milliseconds | Internal durable timer mutation, not a remote activity |
| SDK `core.cancelSchedule` | Unified one-way intent with `{ id }` | Cancel matching durable timer generation |
| SDK arbitrary plugin action | `defineOneWay`, `defineRequestResponse`, and custom helpers reduce to the same two interactions | Registered plugin/action/version handler using shared execution infrastructure |
| Reference `plugin-intent` | Unified-shaped reference variant | Validate against the selected canonical versioned DTO |
| Reference `schedule`, `cancel-schedule` | Legacy standalone timer variants | Compatibility requires explicit normalization approval; not a promise of current SDK emission |
| Reference `run-activity` | Closure is actually invoked by default executor | Not durably serializable; reject or explicitly migrate to a proposed named activity |
| Reference `plugin-one-way`, `plugin-request` | Legacy plugin variants | Explicit versioned migration or fail-closed rejection |
| Reference `dispatch` | Present in its seven-variant union but **skipped by adapter flow**, including when a custom executor is installed | Do not advertise working legacy dispatch compatibility |

The seven reference variants are `plugin-intent`, `schedule`, `cancel-schedule`, `run-activity`, `plugin-one-way`, `plugin-request`, and `dispatch` (S4).
Both packages export names such as `SagaPluginOneWayIntent`/`SagaPluginRequestIntent`, but the shapes differ; qualify imports and never treat the names as wire equivalence.
`ctx.commandsFor`, `ctx.dispatchTo`, and `ctx.actions.core.dispatch` participate in emission; standalone `createSagaCommandsFor` only constructs/returns intents and does not enqueue them itself.
A raw fire-and-forget descriptor without helper emission metadata returns its build value; it does not automatically emit merely because its interaction is one-way.
Request-response emission occurs at terminal `.onError()` after `.onResponse()` and optional `.onRetry()`; the fluent handles/functions must be removed before serializing the resulting DTO.
Retry/compensation policy, `.withData()` and response routing are metadata/semantics, not additional top-level intent categories; trigger definitions describe incoming activation, not outgoing intents.
Named durable activities are **proposed only**: choose an action name/version and serializable data, never promise closure persistence.

## 4. Simpler production-grade architecture

### Proposed topology: one active owner, durable boundaries

```text
Domain/source changes -- CDC --> authoritative durable DB/event history
                                      |
                            resumable CDC relay
                                      | confirmed publications, stable message IDs
                                      v
                              RabbitMQ durable queues
                                      |
                              durable inbound inbox <--- callbacks / timer occurrences
                                      |
                       single active owner / bounded keyed executor
                                      |
                  atomic turn: authoritative events + input disposition
                         + full intent facts + timer facts
                                      |
                          DB change feed --> relay --> MQ
                                                       |
                                   aggregate / effect / projection inboxes
                                                       |
                                      real effect worker --> durable outcome
```

For saga-created intents the committed authoritative DB history is the CDC source; external domain CDC can feed the same logical delivery path.
The relay is a logical durable-intent publication role and may initially run in the same deployment as the owner, with separate bounded loops.
Do not create a second independently authoritative CRUD saga-state database beside the aggregate/event stream.
Business state must be reconstructible from committed authoritative facts; snapshots and operational read models are derived.

Single-owner means one active writer authority for the relevant keyspace, not one promise for the entire application.
Use bounded per-key queues, a global concurrency cap, per-tenant budgets, bounded prefetch, and admission backpressure.
Do not hold a saga turn open while waiting for an external business response; persist an intent and process a later callback turn.
Use OCC even before horizontal scaling; deployment overlap and restart races can create competing writers.
If failover/leases exist, stale ownership must be rejected at commit by a conflicting conditional write, not merely by a prior lease read.
Fencing cannot revoke an external request already in flight; effect destinations still need idempotency or reconciliation.

The target guarantee is at-least-once delivery while a valid primary resume position is retained, plus replay-safe logical input processing within declared dedupe retention; expired-history UUID fallback carries the user-accepted discovery-omission exception in section 7.
Exactly-once external effects are not promised; effectively-once business behavior requires destination cooperation and stable identities.
One owner trades availability and peak aggregate throughput for fewer moving parts; state is durable even when processing pauses.

## 5. MongoDB, Tapeworm, and RabbitMQ capability gates

### Current versus proposed wiring

| Layer | Current evidence | Proposed integration |
| --- | --- | --- |
| MongoDB | Real transaction implementation in projection store (S17) | Verified durable authoritative append/inbox/claim boundary; projection code is a pattern, not a saga adapter |
| Mirage | `readStream`, `saveEvents(..., expectedVersion)`; append then inline hooks (S16) | Adapter must prove OCC, idempotent append, complete intent capture and restart-safe publication |
| Tapeworm | Sibling core/Mongo implementation exists (T1–T4); merged CDC transport is at T12–T15; neither is integrated into the saga bridge | Prefer one complete commit per turn, subject to ras4 qualification; do not assume shared sessions or array atomicity |
| RabbitMQ / AMQP | Redemeine reference adapter does not publish; sibling CDC publisher and merged remediation exist (T5–T9, T12–T15) | Integrate the qualified transport candidate with a saga inbox and typed committed-intent decoding; requalify in the actual saga stack |

Earlier absence findings applied to Redemeine's searched source, not the sibling; the sibling location and implemented APIs are now known.
Remaining uncertainty is integration correctness, ownership/durability and deployment qualification, not whether Tapeworm or Rabbit code exists.

### Tapeworm atomicity: one commit, not an append array

T1 defines one `ICommit` with `events[]`; T3 writes the complete commit with **one `insertOne`**. This is a real candidate single-document atomic boundary.
T2's `append(commit[])` uses sequential `Promise.each` calls: neither an atomic batch nor `insertMany`, and earlier commits remain if a later one fails.
The inspected API has no explicit expected-version argument, caller `ClientSession`, or shared transaction integration; the Mirage seam is not proof Tapeworm supplies those semantics.
Unique `(streamId, commitSequence)` can implement next-slot OCC **only** when all writers use the contiguous next sequence and the index is ready; direct append can otherwise create gaps.
The stream helper builds a next sequence, but that convention alone does not constrain every writer or validate saga ownership.
Unique commit `id` is scoped to the partition collection; duplicate rejection is not an idempotent-success or ambiguous-result reconciliation API.
Append mutates the commit's UUIDv7 token and timestamp before insertion; neither is a stable logical turn identity or guaranteed insertion-order watermark.
T4 caches a partition before its asynchronous index initialization completes, so concurrent opens can bypass the intended readiness barrier.
T2 can invoke inline dispatch after persistence and throw/reject even though data was stored; T3's `markAsDispatched`/`getUndispatched` throw “not implemented.”
Disable/avoid these inline effect hooks for saga durability: the independent CDC/executor path, not a post-append callback, owns recoverable execution.

### Preferred conditional integration: Option B

**Prefer one saga stream and ONE Tapeworm commit per turn**, containing consumed-trigger identity, progress/event facts, complete intents and timer facts in its `events[]`.
Derive inbox disposition, pending-intent/timer indexes and audit views idempotently; they are not additional business-state authorities or assumed atomic multi-collection writes.
Recheck authoritative consumed-trigger facts even if an inbox view lags; early transport ACK still requires the separate durable admission/recovery contract in e47.5.
Before accepting this option, **redemeine-ras4** must prove the following conditions:

1. Enforce contiguous next-slot writes across every saga writer and await an index-readiness barrier, including concurrent partition opens.
2. Persist stable turn/effect IDs; after ambiguous append or duplicate rejection, read and compare the existing commit's immutable logical content/identity before reporting success or retrying. Never blindly allocate a new turn.
3. Validate schema and size before append; bound the whole BSON document below Mongo's 16 MiB limit with overhead/headroom. Reject an oversized atomic turn rather than splitting it into non-atomic commits.
4. Define explicit write/read concern, journaling and reconciliation reads for the durability promise; do not infer safe settings from a driver's defaults.
5. Keep Process B claim, attempt, result and callback-ready facts in the same authoritative saga stream if choosing the stream-local ownership proposal below; no built-in durable executor claims exist today.
6. Prove known-key reconstruction, consumed-input dedupe and indexed/admitted work recovery after ambiguous commits and restarts; callback facts remain atomically durable, while initial discovery through expired CDC has only the section-7 exception. This does not mandate all-stream recovery enumeration.

**Stream-local fencing proposal, not implemented:** a claim/epoch transition appends the next sequence; a competing takeover advances that same stream, causing an append based on the stale observed sequence to conflict.
On reload/retry the old worker must validate the current claim/epoch and stop if ownership changed; blindly retrying at the new sequence defeats the fence.
Completion appends result plus callback-ready continuation atomically under that rule; Process A later consumes the callback as another turn.
This serializes claims/completions with saga progress and creates contention to measure; it does not cancel already-running external effects.
A separate global/partition lease read **does not** become an atomic fence through this API. If that stronger fence is required, shared-session/conditional-guard API support remains a capability blocker.
**Option A remains conditional**, only if a demonstrated API can atomically combine authoritative append and the required guard/other records in one Mongo session; it is not mandatory for Option B's single-document commit.
If stream-local ownership is insufficient and the stronger guard is unavailable, stop rather than claiming a safe multi-owner runtime.

Single-document atomic append alone does not require a replica-set transaction; the proposed replicated durability and CDC change-stream deployment does require a supported replicated Mongo topology.
Use authenticated TLS, backups/restores, verified write/read concern and journaling, indexes, failover behavior and explicit retry/size limits; qualify transaction limits only if Option A is selected.
Do not execute external network effects inside a database transaction callback that may be retried.

Rabbit prerequisites include durable exchanges/queues, persistent messages, publisher confirms, bounded in-flight publications, and manual consumer acknowledgements.
Handle unroutable publications using mandatory/return handling or an equivalent verified mechanism; a publisher confirm alone does not prove the required route exists.
Evaluate quorum queues for replicated durability against latency, disk, cluster size, and operational cost; document the chosen topology rather than assuming it.
Use TLS/credentials with least privilege, reconnect/topology recovery, bounded prefetch, bounded retries, poison-message quarantine, and monitored DLQ retention.
An ingress consumer may ACK after a durably stored inbox record **only if a guaranteed restart-safe inbox worker owns subsequent progress**.
Alternatively ACK after the committed turn; neither approach permits ACK after an in-memory enqueue.

## 6. Durable records and turn contract

These are **proposed logical records**, not current exported interfaces or required collection names.

| Record | Minimum contract |
| --- | --- |
| Input envelope / inbox | Tenant, saga type/version/id, stable message ID, source ID/sequence, kind, payload/schema version, received time, correlation/causation/trace, disposition |
| Authoritative turn | Turn ID, input identity, expected/new stream version, owner epoch, state-changing events, complete emitted intent/timer facts, committed input disposition |
| Durable intent | Intent/execution identity, originating turn and ordinal, named action/version, target, full serializable payload, interaction mode, callback tokens/data, policy snapshot |
| Execution tracking | Stable logical execution ID, attempt number/ID, claim epoch/deadline, retry due time, accepted/business outcome distinction, durable response/error |
| Timer fact / occurrence | Tenant+saga+timer ID, generation, schedule version, due time, recurrence policy, occurrence identity, cancellation and consumption facts |
| Relay checkpoint | Feed identity, recovery mode, last confirmed primary cursor, separate fallback scan progress, captured live boundary and cutover state; UUID progress is not an insertion watermark |
| Snapshot / audit view | Authoritative stream version and schema, reconstruction provenance, paginated history and retention policy |
| Ownership / claim | Partition or execution key, owner epoch, expiry, conditional-write version, heartbeat and takeover evidence |

Encode keys unambiguously and namespace by tenant, saga identity and definition version where needed; do not concatenate collision-prone raw strings casually.
Generate stable IDs from persisted source/turn identities and intent ordinals, or allocate once in the atomic commit; never rely on a resettable process counter.
Separate the logical execution identity from attempt identities; retries preserve the destination idempotency key for the same business operation.
Use named versioned DTOs; exclude closures, functions, prototypes, plugin runtime objects, and credentials from durable payloads.
Reject unsupported function-bearing intents rather than silently serializing away behavior; replace legacy closures with registered activity names and data.
Bound payloads and validate schemas at ingress and executor boundaries; use durable content references for large payloads with explicit retention guarantees.

### Proposed turn sequence

```text
receive --> validate --> persist inbox uniquely --> optional broker ACK
                           |
                    claim key / load authority
                           |
                 dedupe input / compute pure turn
                           |
             conditional atomic authoritative commit
        [events + disposition + full intents + timer facts]
                           |
             release key; ACK if not already acknowledged
                           |
                  independent CDC publication
```

All matching handlers for one input must belong to one defined turn or to explicitly persisted subturns; no accidental partial handler commit.
On OCC conflict, reload authority, recheck dedupe/ownership, and recompute without externally visible effects.
On ambiguous commit, resolve by stable turn/input identity before retrying; memory state is never proof of failure or success.
Unmatched/invalid inputs need an explicit ignored/quarantined disposition and audit reason; endless requeue is not a policy.
Derived caches update only from successful commits and must be bounded/evictable; restart reconstructs from authority, not a local Map.

## 7. CDC publication and failure windows

```text
committed intent facts --> resumable feed --> bounded publication batch
                                                |
                                  Rabbit publish + route validation
                                                |
                                      required publisher confirms
                                                |
                                   durable contiguous checkpoint
```

A primary checkpoint must never pass required unconfirmed publications; concurrent publishing needs a contiguous confirmed cursor, not the highest observed token. Fallback scan progress likewise cannot pass encountered work requiring delivery, but does not certify undiscovered historical records.
A separately durable accepted stage can own later publication only if its write and restart-safe drain are proven; a RAM buffer cannot substitute.
A crash after publish-confirm but before checkpoint deliberately causes duplicate publication with the same stable message IDs.
Downstream inboxes absorb duplicates; acknowledgements/confirmations prove transport stages, not external business completion.
Specify feed retention and alert on checkpoint age approaching the recoverable history window.
Recognized resume-token expiry activates an explicitly recorded degraded recovery mode with indexed, paginated UUIDv7 range traversal, not exhaustive historical reconciliation.
Initialize and capture a resumable live boundary before backfill, preserve changes from that boundary, and dedupe the overlap at cutover; this closes the avoidable handoff gap, not historical UUID omissions outside the chosen range.
Continue under the accepted historical risk with an observable warning; pause/alert on exhausted buffer or live-retention limits and never silently truncate captured work. Inability to rule out accepted historical omissions alone is not a reason to halt.

### Approved recovery order and pragmatic UUIDv7 risk

**Resume token FIRST; UUIDv7 history fallback only after confirmed resume-token retention expiry.** The merged Tapeworm transport implements this layered direction; the Redemeine saga integration must still qualify it in its selected deployment.
Transient connectivity, authentication or publication failures must retry/pause the primary path, not be misclassified as history expiration.
UUIDv7 is useful for locating an approximate indexed recovery range; it is not inherently unusable, but token order is not commit order or a historical completeness proof.
The missed-commit risk requires the combination of insertion reordering, an unprocessed lower UUID token, and loss of usable resume history; healthy valid-resume consumption would deliver the late insert.
Concrete ordering example (`100`/`110` denote relative UUID order, not literal UUID values):

| Time | Event |
| --- | --- |
| t0 | Writer A allocates token 100 but has not inserted its commit. |
| t1 | Writer B allocates token 110, inserts; relay publishes B successfully and checkpoints B. |
| t2 | Relay crashes before seeing A. |
| t3 | A inserts milliseconds later; no long-paused writer is necessary. |
| t4 | Relay remains offline until resume history expires; fallback querying only `token > 110` misses A. |

This is a concrete failure condition, not an empirical probability estimate; no measured frequency or quantified “rare” claim is available.
**Accepted risk posture, 2026-09-16:** a late/lower UUID record inserted before the captured live boundary and outside the chosen fallback range may remain undiscovered after expiry. The authoritative record still exists; its missing transport discovery is accepted, not data deletion or permission to mark it completed.
At 100-million-plus scale, fallback uses indexed token-range pagination, configurable batch limits and bounded memory; no full-history scan, enumeration of all streams, per-stream recovery ledger or exhaustive completeness proof is a default requirement.
Optional finite indexed lookback with an inclusive boundary-time bucket and stable-ID replay can retrieve in-range disorder, including within-millisecond reordering; configure its size/cost against volume and observed disorder, not a mandatory fixed or provably perfect window.
Out-of-range historical omissions remain accepted whether or not lookback is enabled. No finite window covers unbounded lateness/clock disorder; measured averages or clock-skew observations do not establish such a guarantee.
**gqxm recovery protocol:** first initialize a real resumable live boundary, then run the paginated backfill while preserving all changes from that boundary through a durable buffer with bounded backpressure, or demonstrated sufficient oplog retention for the entire recovery interval.
Do not use an unbounded heap buffer. If buffer/retention capacity is exhausted, record the condition, alert and pause for an operator-approved recovery action rather than silently dropping/truncating live work.
Persist feed identity and recovery mode, last confirmed primary cursor, fallback scan progress, captured live boundary and cutover progress separately so restart can resume the actual stage; a UUID scan position is never relabeled an insertion-order watermark.
Deduplicate overlap and validate the bounded live handoff; it prevents a new cutover gap but cannot repair pre-boundary historical omissions outside the fallback range. Emit degraded-recovery warnings and continue under that accepted risk, without mandatory exhaustive reconciliation.
Standard Mongo collections do not expose a generic immutable indexed global insert/commit ordinal: ObjectId, UUID, server-assigned wall-clock time and `$natural` are not substitutes for a durable CDC cursor. Keep the server's resumable cursor on the normal path.
Earlier mandatory full-history/completeness recommendations are superseded. A universal journal, all-stream ledger or stronger historical RPO would require a future explicit decision, not hidden prerequisite infrastructure.
Monitor fallback count, outage age, last good primary position, lag versus actual retained oplog history, live-capture lag, separate checkpoint/scan positions, scanned/published/deduped counts, allocation-to-insert latency proxies and clock-skew observations.
Those metrics reveal exposure and recovery progress, not unknown missing historical records; never report “zero missed” merely because fallback completed. Risk frequency is unmeasured, and no empirical “rare” rate is asserted.
The historical poison-publication skip/checkpoint defect below was independent of UUID recovery. Its merged transport remediation does not weaken the rule or qualify the saga integration.

### Existing Tapeworm CDC candidate: merged transport and remaining saga gates

The historical T7 candidate publishes the **whole JSON commit**, not individually routed saga intents, using persistent `deliveryMode: 2`, `messageId: commit.id`, publisher confirms and a durable **headers exchange**. The merged transport adds mandatory-return handling, but applications still provision and verify the required durable topology; transport success never proves business completion.
The saga integration must validate/decode the commit schema, select durable intent facts and preserve commit identity plus stable per-intent identity when fanning out.
**redemeine-gqxm** records the historical loss-prevention gates. PRs 42–44 merged their transport remediation at T12–T15; the table separates that result from remaining integration obligations.

| Historical baseline finding | Merged transport state / remaining qualification |
| --- | --- |
| T5 skips a repeatedly failed poison publication, then saves checkpoint and emits `dispatched` | Merged core never treats arbitrary failure as success. Optional quarantine can advance only after durable handling of a configured encoded-size rejection and emits `quarantined`; absent/disabled quarantine and systemic/store failures remain fail-closed. Requalify this policy in the saga route. |
| T6 retries from captured startup resume state; broad fallback catches errors beyond expired tokens | Merged recovery reloads durable progress and limits fallback to recognized expiry. Preserve fault-classification tests in the integrated deployment. |
| T3 generates UUIDv7 before insert; T6 fallback queries `token > lastToken` | Merged recovery uses bounded indexed traversal after expiry and retains the accepted out-of-range historical omission; it does not create a lossless-history claim. |
| T6 finishes backfill before opening a fresh live stream | Merged recovery captures a resumable live boundary before bounded scan/cutover. Oplog retention and cutover capacity remain deployment gates. |
| T8 uses fixed `dispatcher_resume` identity and unconditional upsert without owner CAS | Merged checkpoints are feed-scoped; the documented single-feed-owner requirement remains, and a distributed saga deployment still needs proven ownership/fencing. |
| T7 confirms without required-route evidence | Merged publication uses mandatory returns. Operators must still provision and verify headers bindings and durable queues in the selected topology. |
| T9 raw oplog filters direct inserts | The merged default is change streams; optional raw oplog mode remains weaker and must not be used as transaction/rollback qualification. |

Raw oplog tailing can expose rollback-prone entries; merged documentation makes change streams the default and raw oplog an explicit weaker-durability option.
Majority checkpoint writes and merged feed identity do not by themselves prove saga commit durability, multi-owner fencing or external-effect correctness.
The historical T10 baseline predates the merged dispatcher suites. redemeine-4tud later verified the exact merged SHA through Jenkins, including build/check, package tests, packed-consumer, real Mongo/Rabbit and image-smoke gates. Those transport results were not rerun for this document and are not saga-engine, release, deployment or capacity evidence.

| Failure window | Required recovery / invariant |
| --- | --- |
| Before inbox persistence | No ACK; broker redelivers |
| Inbox commit succeeds, ACK lost | Unique message key returns existing durable input; safe ACK, no extra business turn |
| ACK after inbox, worker dies before turn | Restart-safe worker finds pending input; no broker redelivery dependency |
| Handler fails before commit | No effects escape; bounded retry or durable quarantine |
| Turn commits, response/ACK lost | Authoritative input/turn identity proves completion; no new intents on replay |
| State commit without complete intents | Forbidden design: atomic capture must prevent this unrecoverable loss window |
| Relay dies before confirmed publish | Resume from durable checkpoint; republish required messages |
| Confirm arrives, checkpoint write is lost | Duplicate publish is expected and deduped downstream |
| Publish is unroutable | Do not checkpoint as successful delivery; retry/configuration quarantine and alert |
| Resume token expires | Recorded degraded mode, indexed UUID range traversal and preserved live handoff; accepted historical out-of-range omission, no false lossless claim or silent truncation |
| Effect accepted remotely, local result lost | Retry/query using stable idempotency key; reconcile ambiguous non-idempotent effects |
| Owner loses lease while work runs | Conditional commit fence rejects stale state writes; destination idempotency handles in-flight effects |
| Callback and timeout race | Atomic terminal arbitration plus recorded late/duplicate disposition |
| Timer worker dies after claim/publication | Claim recovery and stable occurrence ID; timer is not destructively forgotten |

## 8. Real side effects and an invoice example

S4's `execute(intent)` is an integration seam, not a complete execution protocol; the flow knows execution IDs but does not pass them as a separate executor argument.
The default `core.dispatch` path does not call Mirage or Rabbit; synthetic request references do not mean a provider completed work.
Legacy activity closures actually run, but cannot serve as restart-safe serializable work descriptions.
Production executors must fail closed on unknown action/version, schema mismatch, missing destination or unavailable adapter; never default to success.
Extend the proposed executor context with stable execution/attempt IDs, idempotency key, correlation, deadline, cancellation and fencing information.
Model at least durable acceptance versus business success/failure; do not retrofit transport acceptance into the current `succeeded` result without an explicit semantic decision.

### Minimal executor set and routing contract

Use **one shared durable worker engine** with registered handlers, bounded concurrency, claims, retries, deadlines and result/continuation recording; do not deploy a process for each action.

| Responsibility | Minimal implementation contract |
| --- | --- |
| Core aggregate-command executor | Decode typed command DTO, route to the aggregate/command inbox or application service, enforce destination idempotency, record acceptance/outcome accurately |
| Plugin/action/version executors | Register external I/O handlers such as payment, HTTP or notification; one-way and request-response share claims/retries, with mode-specific completion semantics |
| Internal durable timers | Interpret core schedule/cancel and retry due times as timer facts/occurrences; not arbitrary remote executor calls |
| Continuation intake | Route response/error/retry/timeout facts back to Process A through durable ID-correlated inputs; not a second bespoke saga evaluator |
| Persistence, CDC and telemetry | Supporting infrastructure, not extra business-intent categories or per-action executors |

**APPROVED command contract:** persist the fully qualified canonical command identity produced by the aggregate command creator, e.g. `invoice.pay.command`, not the local map key `pay`.
Use the returned **`envelope.type` verbatim**, including naming-strategy/custom naming overrides (S20); never reconstruct it from aggregate name plus a key or accept an arbitrary map key as the durable identity.
Under the approved contract, users call the typed command creator as usual without repeating a command-type string; the SDK must capture the produced type automatically.
**Current code is not fixed:** S8's `createSagaCommandsFor` passes `commandName` and copies the produced payload (lines 801–855), losing the creator-produced type at this boundary.
**1tad implementation gate:** preserve that canonical type through the intent DTO, serialization, executor lookup and typed fixtures; test default names and explicit overrides without caller strings/casts.
Canonical naming is decided. Registry uniqueness, version compatibility and migration of existing local-key records still need proof; an additional `aggregateType` field is optional and undecided, not required by this approval.
Link input, response, error and `handler_data` schemas to each action/version and carry those types through fixtures and installed consumers without duplicate registrations/caller casts.
Strip fluent helper methods while retaining the executable DTO, routing data and policies; validate serializability explicitly rather than relying on JSON to silently omit functions.
Default proposal is fail-closed rejection of unsupported legacy variants, especially closures and standalone `dispatch`; confirm the migration/compatibility policy before shipping.

### Worked example: invoice command, not a current SDK recipe

1. Receive `invoice.created` for tenant T, invoice I, source message M; durably dedupe M and route to the billing saga key.
2. The saga computes a transition to awaiting payment plus a command intent preserving the creator-produced `invoice.pay.command` type and a timeout timer fact; registry/schema versioning accompanies that identity.
3. Commit the state-changing events, consumed-M disposition, full charge payload, callback tokens/data, and timer generation in one authoritative turn.
4. Intent E receives a stable identity based on the committed turn/ordinal; a proposed payload carries invoice ID, amount in minor units, currency, and schema version.
5. CDC relay publishes E to the billing command route using E as stable message identity and waits for required routing/confirm evidence before advancing its checkpoint.
6. Billing's durable aggregate/command inbox dedupes E, validates business invariants and commits its own authoritative transition; provider work is separately durably captured if required.
7. A registered payment executor uses E (or a persistently derived provider-operation key) as the provider idempotency key, not a new key for every network retry.
8. Rabbit acceptance is recorded as delivery acceptance; the saga remains awaiting payment until a durable business outcome is delivered.
9. A success/error outcome has its own stable callback ID and references E; persist it in the saga inbox before acknowledging the callback transport.
10. The callback turn verifies execution/attempt eligibility, runs the named response/error handler, commits the terminal outcome, and cancels the matching timer generation.
11. A timeout racing with success is resolved by the declared terminal policy; late success after timeout is audited and may launch a separate reconciliation/compensation workflow.
12. An operator redrive retains the logical idempotency identity and records who/why; a deliberately new charge is a new authorized business operation, not a hidden retry.

For a direct HTTP activity, replace the billing command consumer with a registered HTTP executor but retain the same durable capture, claims, idempotency and outcome path.
For a destination without idempotency support, use query/reconcile where possible and document manual intervention risk; local dedupe cannot guarantee no double charge.
Compensation is another explicit durable business action with its own failures, not automatic rollback of an external system.
Commit the executor's outcome and complete callback-delivery fact together, or derive both from one authoritative result record through CDC.
Never mark an execution done and then rely on an unrecorded callback publish; result and continuation must remain atomically durable, with indexed/admitted callback recovery even when the provider must not be called again. If initial continuation discovery relies on CDC after history expiry, only the section-7 discovery exception applies—not permission for false saga/business completion.

## 9. Callbacks, retries, timers, and terminal races

Callbacks require a durable correlation registry keyed by execution identity, versioned handler token, expected response schema, and persisted handler data.
Preserve payload and handler data through execution and fixture APIs; do not assume the existing helper/bridge already propagates every typed value.
Route response, retry notification, terminal error, cancellation and timeout through the same serialized authoritative turn machinery.
Persist attempt budget, error classification, next due time, deadline and policy version; helper metadata and delay calculators are not a running retry service.
Use bounded exponential backoff/jitter and separate transient infrastructure failure from invalid input or terminal business rejection.
Terminal outcomes require a conditional transition; duplicates are no-ops with audit disposition, and stale attempts cannot overwrite a winning terminal outcome.
Define whether a late remote success causes reconciliation, compensation, or an allowed business transition; do not silently resurrect a terminal lifecycle.

Timer identity must include tenant/saga/timer name and generation; occurrence identity includes generation and due-time/ordinal.
Rescheduling creates a new generation, so a delayed cancellation or old occurrence cannot remove or fire the new schedule.
Claim due timers durably in bounded indexed batches; atomically mark an occurrence accepted into durable delivery or retain it until confirmed handoff.
Calculate missed occurrence counts arithmetically, then page only a bounded selected set; even `latest_only` must avoid materializing all missed times.
Declare `catch_up_all`, bounded catch-up, latest-only, and skip policies with an outage budget and operator override; catch-up-all still needs bounded batch processing.
Persist cancellation/occurrence races, handle clock skew, and export overdue age rather than trusting a polling loop's liveness.

## 10. Capacity and qualification

### What the available numbers mean

S12 reports **234,049 selected**, average **162.53/minute**, over a **1,440-minute simulated day**, with final backlog **1,042**.
S11 evaluates a seeded policy workload; these are not elapsed handler, Mongo transaction, Rabbit confirm, or business-completion measurements.
The projected 200k+/day claim must not be presented as certified runtime throughput.
Actual supported volume, resource requirements, p99 latency, and recovery rate remain unknown until measured on the selected stack.

### Workload model, not a capacity promise

Let `r` be workflow starts/second and `Te`, `Tc`, `Tt` the average event, callback, and timer turns per workflow.
Then `lambda_turn = r * (Te + Tc + Tt) + lambda_retry_turn`; avoid counting a retry callback in both terms.
Estimate effects/second separately as starts times effects/workflow plus effect retries; add broker hops, transaction writes, indexes, and derived views to write amplification.
Illustration only: `200,000 / 86,400 = 2.315` starts/s; at **9 turns/workflow**, average demand is **20.83 durable turns/s** before extra retries.
A **10× burst** is **208.3 turns/s**, not evidence that the implementation can sustain it.
One serialized hot key is bounded approximately by `1 / turn_latency_seconds`; more nodes do not remove that bound.
For backlog B, sustainable service rate mu and incoming rate lambda, ideal recovery time is `B / (mu - lambda)` only when `mu > lambda`.
Include recovery traffic and downstream quotas in mu; production contention often makes recovery slower than that ideal model.

Size active workflows from arrival rate and average lifetime; measure state bytes, stream growth, snapshot frequency, active timers, and retained inbox/execution IDs.
Record key skew, tenant skew, fan-out, payload distribution, callback delays, retry frequency, timer bursts and retention days, not just starts/day.
Bound resident caches, audit buffers, pending promises, broker prefetch and executor concurrency; durable backlog belongs on disk, not in unbounded Maps.

### Proposed qualification protocol

- First discover saturation at **10 / 50 / 100 / 250 durable turns/s**; these are test inputs, not promised rates or final acceptance targets.
- Use the real chosen Mongo/Tapeworm/Rabbit stack and one canonical invoice workflow with controlled idempotent external effects.
- Record hardware, versions, replica/queue topology, durability settings, indexes, payloads and handler cost for reproducibility.
- Provisionally run at least **60 minutes steady load** and a **24-hour soak** after warmup; owners must approve workload-specific SLOs before release.
- Include uniform keys, hot-key skew, mixed tenants, callback bursts, timer catch-up, retry storms and cold restarts.
- Measure committed turns/s, end-to-end business latency, p50/p95/p99 turn/transaction/confirm latency, inbox age, relay lag, timer lateness and DLQ growth.
- Also measure CPU, RSS/heap, GC, connection pools, storage/IO, OCC conflicts, duplicate suppression, downstream quotas and recovery completion time.
- Acceptance requires no loss of authoritative committed facts, no false completion or forbidden duplicate business effect, bounded memory/backlog and SLO-compliant recovery; no-loss delivery applies to valid-resume/indexed-admitted work, with only section 7's expired-history discovery omission accepted.
- Use the failure matrix in section 7, with process kills, network partitions, ambiguous commits, Mongo failover, broker outage and expired CDC tokens.
- Publish measured results and safe operating headroom; do not extrapolate simulation results or a short successful burst into an SLA.

## 11. Distributed evolution

| Concern | Durable single-owner MVP | Multi-owner evolution |
| --- | --- | --- |
| Routing | One active owner; bounded parallel independent keys | Stable keyed partitions and versioned routing map |
| Ownership | Exclusive operational authority plus OCC; fence any failover | Durable lease/epoch, conditional commit fence, takeover/rebalance protocol |
| State | Authoritative event history; bounded derived cache | Same authority; no node-local authoritative state |
| Inbound work | Durable inbox and restart-safe drain | Partition claims, recovery scans, ordering and dedupe across owners |
| Timers/effects | Bounded durable worker loops | Shared claim protocol, stale claimant protection, globally stable occurrence/execution IDs |
| Relay | Valid-resume recovery; explicit expired-history fallback risk | Feed/partition ownership, separate primary/scan/live-cutover progress and safe redistribution |
| Fairness | Local admission plus downstream limits | Shared quotas or allocated budgets; local evaluator alone cannot enforce a global cap |
| Deployment | One compatible definition set | Mixed-version routing, handler availability and state/DTO migrations |

Use a composite saga key to choose a partition; preserve per-key order while allowing bounded work on different keys.
During rebalance stop admission for moving partitions, drain or invalidate outstanding claims, advance epoch, and recover pending inbox/timer work.
OCC conflicts plus a commit-conflicting fence must prove stale owners cannot append; a lease heartbeat check before computation is not sufficient.
Test split brain, old-owner resumption, skewed partitions, live migration, rolling upgrades and shared scheduler/executor contention.
New claims cannot prevent already-running remote work; carry idempotency identities across ownership changes.
Introduce distribution only for measured throughput/availability needs that the simpler deployment cannot meet; repartitioning cannot fix one hot workflow.

## 12. SDK and developer experience

### Mandatory type-safety contract

These are **hard acceptance requirements for future implementation**, across **all owned TypeScript**: runtime, SDK, adapters, tests, examples and declarations, not just production files.
The baseline's explicit `any`, generic `any` defaults, ambient-any shim (S13), and type escapes are violations to remediate, not approved exceptions or changes made by this document.
The sibling also contains explicit `any`, unchecked assertions/double casts and generic erasure (T2–T9); these do not become acceptable through integration. Any scoped sibling remediation needs its own authorized handoff; until then, validate external boundaries without claiming that wrapping fixes CDC loss.

- **Zero `any`:** reject explicit and implicit `any`, unsafe generic defaults, ambient-any shims, and inferred/transitive leakage. `noImplicitAny` alone cannot detect all leakage.
- **Required compiler target:** `strict: true`, `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`, `useUnknownInCatchVariables`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns` and `noFallthroughCasesInSwitch`, all enabled. Current effective configuration coverage is unverified; these are required gates, not claims about existing settings.
- **Required type-aware lint:** `no-explicit-any`, `no-unsafe-assignment`, `no-unsafe-argument`, `no-unsafe-call`, `no-unsafe-member-access`, `no-unsafe-return` or proven equivalent enforcement. Existing Biome/compiler scripts are not assumed to cover them; tool selection/configuration is implementation work.
- **External boundaries:** inherited third-party `any` must immediately become `unknown` for validation/narrowing, or pass through an audited schema-backed typed wrapper into an owned DTO; it must never escape into owned logic or public types. No casting around validation.
- **No erasure shortcuts:** use `unknown` only at genuinely unknown external boundaries, narrowing before use; preserve known action shapes instead of replacing public response/payload/data types with `unknown` or catch-all records.
- **No escapes:** prohibit `as any`, blanket `as unknown as T`, `@ts-ignore`, `@ts-nocheck` and blanket lint suppressions. Scoped negative type tests may use `@ts-expect-error` with verified expected diagnostics and failure when the diagnostic disappears; it is not an implementation escape hatch.
- **Reviewed assertions remain possible:** a narrow justified assertion, such as a validated branded identifier, needs an explicit invariant and tests; this does not authorize unchecked DTO casts or a workaround for the zero-any rule.
- **End-to-end inference:** aggregate event/command payloads and plugin action input → response/error → handler-data/token associations must survive authoring, persistence DTOs, executor registry, callbacks and fixtures without caller casts or manually duplicated types/registrations.
- **Registry and serialization:** derive a discriminated intent union from a canonical versioned action registry tied to runtime schemas; decode wire data by discriminant/version before typed dispatch. Functions/closures are never serialized, and schema migrations preserve those associations.
- **Phase-safe API:** reject invalid interaction modes, handler phases, incomplete routing and missing required handler data at compile time; runtime validation enforces the same contract for untrusted input.
- **CI proof:** use no-any type assertion helpers or a type-testing framework to detect inferred `any` and inappropriate `unknown` erasure, not just compile success. Owned type-test helpers must themselves obey zero-any.
- **Consumer proof:** compile positive and negative fixtures against packed declarations in a clean strict consumer, with `skipLibCheck: false` or an equivalent dedicated full declaration check. Cover wrong commands/payloads, response/error types, handler phases, missing data and invalid interactions, plus correct inference without annotations/casts.
- **DX proof:** one canonical runnable workflow must drive docs, fixtures and real integration; measure time-to-first-working workflow in the installed consumer. Type safety cannot be traded away to make that example shorter.

### Strengths worth preserving

Aggregate-derived event/command inference, mutation-style Immer handlers and explicit emitted intents make process managers approachable.
Named response/error/retry tokens are a good serializable routing vocabulary, and fixtures allow deterministic domain-level scenarios.
Plugin helper descriptors separate authoring from execution; lifecycle history and scheduler policies provide useful inspection/test seams.

### Concrete gaps, not a blanket rejection

- S15 uses `createSaga({ name })`, while the current definition contract uses structured `identity`; choose one canonical current example.
- Its retry chain places `.onRetry()` before `.onResponse()`; current chain requires `.onResponse().onRetry().onError()`, with retry optional and `.onError()` terminal for emission.
- Its custom-action callback shape and `builderCtx.emitOneWay` do not match the object-based `defineCustomAction` contract and available builder primitives.
- It chains async `receiveEvent`/`invokeError`/`invokeResponse` as synchronous fixture calls; examples must actually compile and await operations.
- Named token persistence is necessary but not sufficient for restart safety; the tutorial's durability assertion outruns current storage/worker guarantees.
- S13's ambient `any` shim weakens evidence from workspace fixture typechecking; strict installed-consumer tests must not inherit it.
- Response payload/handler-data inference and propagation are incomplete; token phase safety is not proof of end-to-end payload safety.
- Definition plugins versus bridge runtime plugin registration can drift or require duplicate registration; validate a single versioned manifest/registry contract.
- Retry and compensation metadata describe policy, not durable execution; documentation must separate supported semantics from future workers.
- Definition/token/schema evolution needs migration and compatibility rules for long-lived workflows, not just renaming examples.
- Prior assessment reported installation/package problems; reproduce in a clean packed/published consumer before claiming fixed or diagnosing new causes.

### Best-in-class is an evidence target

Temporal, Restate and DBOS are conceptual comparison points, not measured competitors in this assessment.
Durable function/service execution and an event-sourced process-manager DSL are different programming models with different operational tradeoffs.
Redemeine can excel for typed CQRS/ES composition without claiming mature durable orchestration features it has not yet implemented.

| DX dimension | Target evidence, not current certification |
| --- | --- |
| First working workflow | Fresh installed consumer completes real invoice flow; measure time-to-first-working example and failures |
| Type safety | Mandatory zero-any and deep-inference gates above pass across all owned TS and packed-consumer declarations; no ambient shim or public erasure |
| Documentation | One canonical workflow drives tutorial, fixtures and integration tests; every documented chain executes |
| Operations | Given saga/execution ID, explain current state, pending work, retry reason and recovery/redrive path |
| Durability | Kill/restart demonstrations match documented guarantees; no synthetic success hidden in production mode |
| Upgrades | Versioned handlers/DTOs and old-workflow replay tests across a rolling deployment |
| Packaging | Clean install/export/declaration smoke checks for intended published packages; private runtime distribution decision explicit |

### Easy and reliable testing is a hard requirement

Keep the useful ergonomics of `testSaga(...).withState(...)`, awaited `receiveEvent`, awaited `invokeResponse`/`invokeError`, `expectState` and `expectIntents` (S14).
Today those assertions cover the latest turn's output, not an accumulated history; document that distinction and provide an explicit history view when requested.
S14/S19 pair FIFO response/error queues, drop `handler_data`, and dequeue before callback execution, so a throwing/failed handler can lose the fixture's pending request.
JSON-stringify equality can hide functions, and fixture handler matching differs from the bridge; passing these fixtures is not proof of production routing or serializability.
There is no current fixture API for a durable restart, virtual clock, full retry engine or trigger-start lifecycle; do not document proposed capabilities as available methods.
**redemeine-1tad** must preserve simple tests while fixing semantics: shared matching, retained typed data, ID-correlated out-of-order outcomes and input consumption only on a successful committed turn.

### Four mandatory testing tiers

**Tier 1 — fast typed decision tests, no network or sleeps.**
Run the real decision/handler path with given state, typed input and deterministic metadata; assert next state and exact intent names, payloads, routing data, schema versions and correlations.
Cover response/error handlers with preserved handler data, invalid token phases, concurrent requests resolved out of order by execution ID, and a thrown handler leaving input unconsumed.
Test latest-turn assertions separately from history assertions and validate the serializable DTO explicitly; function omission during JSON equality is not acceptable validation.
Domain users should need one small readable example and no casts, ambient shims, duplicated action types or infrastructure bootstrapping.

**Tier 2 — the ACTUAL production engine against a transactional-memory persistence adapter.**
Exercise the same Process A/B implementation, commit contract, callback routing, timer/retry policy and dedupe logic that production uses; never implement a second reliability engine inside tests as S10 does.
The memory adapter implements atomic one-commit turns, unique IDs/next-slot conflicts, durable-fact reads and injected ambiguous outcomes, using the same conformance contract as the real adapter.
Inject a virtual clock, deterministic IDs/jitter and scripted typed executors; advance time without wall-clock sleeps and expose deterministic pause/crash points.
Restart by discarding engine objects, caches and local queues and reconstructing from retained durable facts, not by reusing a live fixture Map as authoritative state.
Cover timer cancel/replace generations, retry delay/backoff/budget/deadlines, callback loss/duplicates, effect success before result persistence, paused stale owners and completion fencing.
Memory simulation proves engine behavior under the specified contract, not that Mongo/Rabbit satisfy the contract; tier 3 supplies that evidence.

**Tier 3 — shared conformance and fault scenarios on real Tapeworm/Mongo/Rabbit.**
Reuse the tier-2 scenario definitions and assertions, replacing adapters and adding process kills/network faults at append, broker ACK, publish-confirm, checkpoint, external effect, completion and callback boundaries.
Use the selected replicated Mongo topology and real durable Rabbit routes; test failover/rollback exposure, index-readiness races, duplicate/ambiguous append, OCC and stale claim epochs.
Prove that valid resume delivers a late lower-UUID insert and that only recognized history expiry triggers fallback—not authentication, network or publication failure.
Under expired fallback, deliberately place an unprocessed lower UUID outside the selected range and before the live boundary; demonstrate its omission as the accepted counterexample, not an assertion that recovery repaired or detected it.
With optional lookback, verify retrieval of in-range disorder and explicitly retain the out-of-range limitation; test paginated indexed query plans, configured batch bounds and bounded heap without a full-history scan or stream enumeration.
Inject inserts during paged scanning and crashes through live-boundary capture, buffer/scan checkpointing and cutover; prove restart-safe live preservation/dedupe and operator pause on exhausted buffer/retention limits.
Poison publication or an unroutable required message must not advance the required delivery checkpoint; retain independent stale-cursor, error-classification and checkpoint-owner contention tests.
Assert no lost authoritative turn/intent/continuation facts, no false completion, and no lost valid-resume or indexed-admitted delivery; the only accepted loss is expired-history transport discovery of the documented out-of-range records. Repeated attempts keep stable logical IDs and yield one business effect only under explicit destination idempotency.
For non-idempotent or unknown outcomes, assert reconciliation/quarantine rather than inventing universal exactly-once behavior; test operator redrive identity retention.

**Tier 4 — strict installed/packed SDK consumer and declaration tests.**
Compile the canonical scenario against built packed declarations with source aliases disabled, `skipLibCheck: false` or an equivalent dedicated full declaration check, and all section-12 strict/no-any gates.
Prove action input/response/error/handler-data schema associations survive serialization, executors and callbacks; positive tests require inference and negative tests reject wrong payloads/tokens/data/interactions.
No owned explicit/implicit `any`, blanket double casts or ambient declaration escape; type-aware lint and inferred-any/erasure assertions are required, not claimed as current tooling.
Compile and run the documentation example in this consumer, measuring time-to-first-working workflow and recording setup failures rather than hiding workspace-only success.

### Small canonical test flow: proposed scenario, not an existing DSL

**Given** invoice I in awaiting-payment state, durable trigger M, virtual time T, and a scripted idempotent provider keyed by intent E.
**When** Process A commits the charge intent and timeout, then crashes before Rabbit ACK, restart from durable facts and redeliver M.
**Then** one consumed-trigger fact and one logical E exist; no duplicate intent is created and the timer generation is unchanged.
**When** Process B charges successfully but crashes before recording the result, restart, reconcile/retry E with the same provider key, and deliver its outcome twice.
**Then** one accepted business result/continuation advances the saga, the correct timer is cancelled, and the provider's idempotency contract yields one charge.
**And** a separate throwing callback test leaves its input pending; a second concurrent request completed out of order receives its own handler data, not the first FIFO entry's data.
The same scenario must run on the memory adapter and real-stack conformance suite; the provider's idempotency condition must remain visible in the assertions and documentation.

## 13. Dependency-ordered delivery plan

These are design phases, **not a duplicate status tracker or implementation claims**; the actual follow-ups ras4/gqxm/1tad now cover the newly identified work.
Reuse existing issue ownership without silently expanding e47.5/.6/.7/.8; role ownership below is proposed, not a new assignee declaration.

| Actual follow-up | Planned dependency/scope boundary |
| --- | --- |
| redemeine-ras4 | P0/P1/P2 and Process B ownership: one-commit atomicity, next-slot OCC, readiness, reconciliation, stream-local fences and bounded BSON; sibling changes require scoped authorization |
| redemeine-gqxm | P3 and P8: user-accepted scale/risk posture; resume-token-first, expiry-only indexed UUID fallback with historical omission warning, bounded preserved live handoff, independent poison/routing/cursor/ownership fixes |
| redemeine-1tad | P7a/P1/P4/P7b: implement approved creator-produced canonical command type; prove overrides, uniqueness/version migration, typed executors/fixtures and all four testing tiers |
| redemeine-e47.5 | Existing durable admission/inbox/drain responsibility; integrate with ras4 atomic consumption, do not redefine as all persistence/executor work |
| redemeine-e47.6 / .7 / .8 | Existing OTel, trace continuity and inspection-envelope responsibilities unchanged |

| Phase / proposed owner | Depends on | Scope and exit evidence |
| --- | --- | --- |
| P0: design/capability gate — Architect + storage owner | qddj revision audit; ras4/gqxm evidence | Approve conditional single-commit Option B, stream-local versus stronger fencing, durability/retention and CDC remediation; sibling code exists but is not qualified |
| P7a: mandatory type-contract track — SDK/runtime Engineers | P0; 1tad; starts before contract freeze | Zero-any gates, canonical typed registry/routing and tier-1/tier-4 consumer fixtures; specify shared-engine conformance before P1/P2 freeze |
| P1: durable contracts — Architect + Engineer | P0 + P7a type-contract gate | Versioned envelopes/IDs/intent DTOs, schema validators, conditional append/fence design, state reconstruction and migration rules; mandatory section 12 type gates |
| P2: inbox and authoritative turn — Engineer; e47.5 + ras4 | P1 + P7a gate + qualified one-commit storage | Process A full atomic turn, distinct ACK, restart drain and bounded queues; tiers 2/3 prove readiness, OCC, dedupe, oversized rejection and ambiguous-result reconciliation |
| P3: CDC relay and Rabbit adapter — integration Engineer; gqxm traceability | P1 + P2 capture contract | Integrate and requalify merged normal-resume, scale-bounded indexed fallback, known omission counterexample, live cutover, quarantine/routing and checkpoint behavior without exhaustive history scans |
| P4: real effects and callback execution — integration/domain Engineers; 1tad + ras4 | P2; production delivery requires P3 | Shared typed executor registry, durable fenced claims, real invoice effect and atomic result/continuation; tiers 2/3 prove accepted-vs-done and uncertain-effect recovery |
| P5: timers/retries/terminal policy — runtime Engineer | P2 + P4 execution identities | Generation/occurrence IDs, bounded catch-up, persisted attempts/deadlines, terminal race tests and cancellation recovery |
| P6: inspection/observability — runtime/OTel Engineers | P1; integrate with P2–P5 | e47.8 envelope parity, e47.6 OTel facade/integration, e47.7 cross-boundary trace continuity; bounded retention/export |
| P7b: canonical DX/packaging — SDK/docs Engineer; 1tad | P7a + P1 + P4–P5 | Correct fixture semantics, virtual-time/restart scenarios on actual engine, canonical docs/packed consumer and measured first-working-flow DX; four-tier conformance shared, not cloned |
| P8: production qualification — Auditor + operators | P2–P6 + P7a/P7b; ras4/gqxm/1tad evidence | All four tiers pass; atomic facts/no-false-completion and normal delivery preserved; expired-history omission exception explicitly exercised/disclosed; measured capacity/soak and operating envelope, not universal lossless/exactly-once claims |
| P9: optional distributed ownership — Architect + runtime Engineer | P8 + measured need | Key partitions, shared claims/quotas, commit-time fences, safe rebalance/mixed versions; distribution fault suite |

Critical path is P0 → P7a type-contract gate → P1 → P2 → P3 → P4 → P5 → P8; P6 and P7b can progress alongside integration once their prerequisites hold.
Every implementation phase must preserve section 12's mandatory zero-any/deep-inference gates; P7a is required before P1/P2 freeze and P7b is required for release, not optional polish.
Storage/identity choices cannot be deferred until after broker adapter work: they determine dedupe, callback correlation and replay behavior.
Minimal production MVP includes one active owner, actual durable stack, one real workflow, inbox/turn/CDC/effects, required timers/retries, basic inspection, runbooks and measured qualification.
Defer elastic partition rebalancing, multi-region active-active, broad plugin catalogues, a rich operations UI and generic compensation automation until justified.
Do not defer bounded queues, complete intent capture, idempotency, terminal race policy, security, recovery or basic observability merely to call the MVP small.

## 14. Validation, rollout, and handoff

### Existing commands and repository-delivery scope

From the repository root, the current manifests define `pnpm run lint`, `pnpm run typecheck`, `pnpm run test`, and `pnpm run build`.
Package-targeted forms are `pnpm --filter @redemeine/saga-runtime run typecheck`, `pnpm --filter @redemeine/saga-runtime run lint`, and `pnpm --filter @redemeine/saga-runtime run test`.
The runtime lint script is `tsc --noEmit`, not a substitute for the root principles/Biome gates.
Future real-stack, chaos, installed-consumer and soak suites described here must be implemented and assigned commands later; no invented existing script is claimed.
Repository delivery uses documentation-focused formatting, link/path and structure checks. Runtime suites and throughput benchmarks are intentionally not substitutes for the future qualification tiers above.

### Release and operations gates

Release is blocked until the two-stage contract, all four testing tiers and section 12's compiler/type-aware lint/inference gates pass across all owned TypeScript, including tests/declarations; baseline violations and independent delivery defects are not waived. Section 7's user-accepted expired-history discovery risk is the sole stated recovery exception.
Define retention jointly for authoritative history, CDC resumability, inbox dedupe, execution outcomes, callbacks, timers, audit and DLQ payloads.
Retain dedupe identities across the maximum permitted replay/redrive window; expiry is an explicit behavioral boundary, not an invisible cleanup detail.
Plan legacy ID migration, timer namespacing, handler-token aliases and DTO upcasters before moving active workflows; never reinterpret old payloads silently.
Use dry-run/shadow evaluation without duplicate external effects, then canary traffic and staged rollout with backlog/conflict/error stop thresholds.
Rollback must preserve compatible readers/handlers for committed newer records; reverting code alone may be unsafe after schema or identity changes.
Operators need authenticated inspection, least-privilege redrive/cancel tools, immutable who/why audit, payload redaction, secret references and tenant isolation.
Exercise DLQ triage, ambiguous provider outcome reconciliation, CDC backfill, broker recovery, backup restore and owner replacement before launch.

### Repository artifact validation and limits

This repository document preserves the independently audited standalone artifact and applies only administrative/source-truth refreshes for placement and merged Tapeworm reality.
Baseline/remote and live issue records were inspected; pinned current Tapeworm paths at `bc9ec5e41c0d9305365eb2d879add92de57a3539` were checked after the semantic source layout change.
Full-SHA links identify source evidence. T1–T11 remain deliberately pinned historical-baseline references; T12–T15 identify merged behavior and do not imply package release or deployment.
Code-principles self-check: cohesive planning-only file; correctness evidence and uncertainty explicit; no production functions changed; source size/nesting rules are not applicable to this requested long-form document.
Checklist disposition: correctness/scope/cohesion and documentation-focused checks pass; code comments, function size and nesting are not applicable. The repository principles gate still reports pre-existing production-source violations outside this documentation scope.
Risk-based validation here is source/history reconciliation and artifact review; runtime risk-based test additions are specified in the plan, not implemented.
No approved code exception is introduced; section 7 records the user-approved recovery-risk exception, not relaxed atomicity/type safety. The long-form architecture document may exceed production-source size limits; no production source file does.

### Repository review handoff: redemeine-qddj

Independent audits passed the standalone content and its focused scale/recovery and availability amendments. That history is not a claim that this repository version has already passed Auditor review.
The 2026-09-16 accepted bounded indexed fallback and residual historical late/lower-UUID omission after expiry remain unchanged, including preserved live handoff, truthful metrics and test/release gates. Merged transport remediation does not implement the proposed saga engine.
Open decisions remain registry uniqueness/version migration, optional aggregate-type field, legacy rejection, fencing strength, fallback batch/lookback/live-preservation configuration, durability/retention/SLOs and real-stack qualification; canonical naming and the stated recovery-risk acceptance are not open.
Engineer placement sets qddj to **implemented** only after repository validation; Auditor then owns verification. redemeine-70xi is the verified worktree unblock and remains for Diplomat closure.
No main-branch edit, sibling code change, release, deployment, publication or runtime implementation is authorized or claimed here.
