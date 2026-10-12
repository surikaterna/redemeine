# Projection host: reference and external broker intervals

Current source contract: **redemeine-hpq1.1 / external-broker-live-v1, Unit A**.
The verified `.3` reference/lifecycle implementation is input provenance, not
proof of external connectivity or historical completeness. Unit A extends it
with a real consuming path. Unit B and its concrete runner require independent
pre-audit before Docker or real Mongo/Rabbit execution.

## Review and build boundary

Input98 source manifest:
`5a244fa53df9c6b412a9feb82f88c92dc3401754999ab637b195efd1803cb6a7`.
The native runtime's original input24 receipt remains historical provenance:
`3727a0b41f00b16d3392ffa97159b138c1200476dede152d797e4e5079782351`.
Auditor approved the exact six-file broker contract delta for seal promotion on
2026-09-30, with the other18 rows unchanged. The active protected24 manifest in
`scripts/protected-runtime.manifest` is now
`92a2b19da875987c819ff3283845839323a9652d522f8d00f0d62ebd5ca0da5e`.
The verifier still checks every protected file and the emitted artifact bytes.
Unit A subsequently received full code/artifact audit approval at source122
`30ea38ee31d2252563b8b353e208b83b2542f24c9b0e93475007d00573b1268c`,
pending real-stack evidence. This is not external-stack qualification. Earlier source tests using the old sealed reference identity
fixture are not receipts for the newly sealed external executable.

With that seal promotion authorized, the existing commands are:

```sh
pnpm --filter @redemeine/projection-service... run build
pnpm --filter @redemeine/projection-service run typecheck
pnpm --filter @redemeine/projection-service run lint
pnpm --filter @redemeine/projection-service run test
PROJECTION_MODE=reference pnpm --filter @redemeine/projection-service start
```

The CLI accepts no arguments. Missing/invalid configuration exits78 before any
connection, with allowlisted variable/reason output only. Reference mode remains
explicit, finite by default, offline, and `productionReady:false`. It rejects
external credentials. `PROJECTION_EXECUTION=serve` selects the supervised host.
External `once` exits78 with `external_requires_serve`; it does not launch a
consumer accidentally. No custom module loader, start-JSON override, source UUID
inventory, or caller-supplied trust flag exists.

## External configuration

With an operator-provisioned state root and all required variables set:

```sh
PROJECTION_MODE=external PROJECTION_EXECUTION=serve pnpm --filter @redemeine/projection-service start
```

| Setting | Meaning / bounds |
| --- | --- |
| `MONGODB_URI` | Source/control/store Mongo endpoint; credentials remain in environment |
| `MONGODB_DATABASE` | Explicit database, ASCII name1–63 characters |
| `MONGODB_COMMITS_COLLECTION` | Complete source commit collection |
| `RABBITMQ_URI` | AMQP/AMQPS consumer endpoint |
| `RABBITMQ_VHOST` | Exact vhost, must agree with URI |
| `RABBITMQ_EXCHANGE` | Required existing durable headers exchange; service does not create it |
| `RABBITMQ_MANAGEMENT_URL` | HTTPS origin, or explicitly loopback HTTP for local fixtures; no embedded credentials/query/path |
| `RABBITMQ_MANAGEMENT_USERNAME`, `RABBITMQ_MANAGEMENT_PASSWORD` | Required HTTP API credentials; never logged/persisted |
| `PROJECTION_PARTITION_ID` | Exact source partition/header scope |
| `PROJECTION_TENANT` | Optional exact tenant/header scope |
| `HEALTH_PORT` | 9464;1024–65535, bound to127.0.0.1 only |
| `CONNECT_TIMEOUT_MS` | 5000;1–60000, bounded startup/driver/HTTP operations |
| `SHUTDOWN_TIMEOUT_MS` | 10000;1–60000, one absolute monotonic deadline |
| `RECONNECT_ATTEMPTS` | 5;1–10 total attempt budget |
| `PROJECTION_CONTINUATION_DELAY_MS` | 10;1–60000 |
| `PROJECTION_MAX_COMMITS` | 16;1–256 |
| `PROJECTION_MAX_BYTES` | 1048576;1–16777216 |
| `PROJECTION_MAX_MILLISECONDS` | 100;1–60000 |
| `PROJECTION_MAX_EVENTS_PER_COMMIT` | 1000;1–10000 |

The queue is always **`rdm.projection.commits`**. Unknown projection/Mongo/Rabbit
settings are rejected. No insecure TLS-verification override is provided.
Mongo uses primary/majority reads (including pre-transaction dedupe snapshots)
and majority control/floor operations, rather than allowing stale secondary
absence or uncommitted local progress to masquerade as admission/completion.

## Owned broker topology and evidence

The service owns a durable, nonexclusive, non-auto-delete **quorum** queue with
`x-single-active-consumer:true`, `x-delivery-limit:-1`, and a persisted custom
bootstrap nonce. Consumption is manual ACK, prefetch1/globalfalse,
**exclusivefalse**, no priority. Quorum/SAC is not presented as exclusive consume.

The headers binding has empty routing key and exactly `x-match:all`, collection,
partitionId and optional tenant. It has **no stream filter**. Before activation
and every five seconds, bounded authenticated management requests inspect:

- The exact queue, all its incoming bindings (`/api/queues/{v}/{q}/bindings`),
  the existing exchange, and its incoming exchange-to-exchange bindings.
- Exactly one application binding matching that scope. The unavoidable automatic
  default-exchange binding is accounted for separately, not mistaken for an
  application route. Observed default-exchange deliveries are refused.
- Queue arguments and policy metadata. This conservative implementation requires
  a **dedicated policy-free vhost**, rejecting nonempty policy/operator-policy
  listings rather than guessing regex applicability or precedence. TTL/expiry,
  length limits, DLX, priority and alternative routes are refused.
- The exact active consumer tag, manual ACK/prefetch/SAC settings, queue identity,
  native channel number, and native connection. Connection proof includes the
  actual socket endpoint tuple and authenticated user, plus a fresh client label
  checked through the scoped connection endpoint—not that label alone.

Each path segment is URL encoded. Responses are JSON/schema checked, limited to
256KiB and the configured timeout; redirects are not followed. Wrong/ambiguous
responses fail closed. Checks older than ten seconds invalidate the session even
if the refresh timer has not run. Failed refreshes latch unready.

Snapshots are conditional on controlled administration. Restricted publisher and
consumer credentials must prohibit competing actors, `basic.get`, delete/purge,
unauthorized routes, and default-exchange publishing. The consumer cannot prove
all actors' absence or detect an identical malicious recreation between snapshots.
The nonce is correlation under that contract, **not cryptographic incarnation
proof**. Generic mandatory confirms do not prove delivery to this target queue.

## Durable bootstrap and crash boundaries

One versioned row in `rdm_projection_live_control` has a stable key derived from
broker/vhost/exact queue, independent of artifact. It binds artifact/registry,
nonsecret configuration/scope fingerprints, epoch, generation and queue nonce.

Under the fixed local writer lock, a fresh start requires absent control **and**
absent queue. It majority-inserts `prepared` before declaring the nonce queue,
binds it, inspects actual topology, then majority-CASes to `bound`. Unknown writes
require exact majority readback. No consumer starts before `bound` and every
definition's store initialization/transaction check completes.

On restart, a matching `prepared` row may finish only if the existing nonce queue
and binding already match. Missing/uncertain resources never trigger automatic
recreation or rebinding. Bound restart only inspects existing identity. An
unregistered preexisting queue is never adopted; changed artifact/configuration
requires separately approved generation transition, not a new silent namespace.
Cross-system bootstrap is **not atomic** and some failure points deliberately
require operator repair.

Control/schema initialization is permitted under owner/config before business
readiness. Source index initialization only verifies the existing unique compound
index; it never creates an upstream index or enumerates sources. Actual
`MongoProjectionStore` instances are separately namespaced per definition and
persisted epoch. A strict name/generation facade refuses unknown definitions.
The fixture registry keeps inline dedupe by default and explicit `own_record`.

### Conservative unclean-restart quarantine

Before consumption a durable run marker becomes `active`. Only an initialized,
healthy, **quiet** consumer with all work/resources joined and no observed
topology fault can mark it `clean`. A new process encountering an active prior
run pauses with `restart_reconciliation_required`. Same-process reconnect after
joined cleanup retains its run identity; it does not pretend to acquire a lease.
Shutdown during an active delivery may conservatively leave quarantine even if
the turn subsequently drains.

There is no automated clearing flag or restart override. Operator quiescence and
reconciliation need separate evidence/authorization. This intentionally avoids
claiming that flock or process death aborts Mongo server-side writes. Unit B must
qualify late-write cases before any broader automatic-restart claim.

## Two-phase consumer activation

The private start record is discriminated `LIVE_FROM_QUEUE_BINDING`; it has
binding/provisioning identity and an external publisher-contract descriptor,
**no nativeStartRef or invented confirm/checkpoint history**. The old
`LIVE_FROM_BOUNDARY` variant and exclusive/reference behavior remain separate.

Broker session opening returns **staged**, not qualified-active. The adapter and
worker synchronously hold at most one original callback. They register the SAC
consumer, join consume-ok, verify that actual consumer/channel/connection and
fresh topology, activate the evidence session, then release the held delivery.
An empty queue can become ready without any message. Cancellation, shutdown,
failed/stale verification and late consume-ok cannot resurrect readiness or
release held work. ACK maps to the exact original AMQP object once.

A broker-first witness means the conditional earliest retained delivery in this
owned binding interval under one externally ordered/no-skip live publisher. It
does not mean source birth or a native cursor position. Unknown-source redelivery
without a durable floor pauses. Known-floor duplicates reconcile through existing
markers; below-F publication pauses before reading the excluded source history.
First42 applies42 without reading0–41. Authoritative whole-commit validation,
multi-event folds, all-definition completion, contiguous coverage and exact
manual ACK remain the existing runtime pipeline. No source census, tip probe,
steady source polling or hidden historical reconstruction is introduced.

The fixed ModelCounter/Added fixtures are qualification examples, not application
embedding. Amounts/sums are nonnegative safe integers. Same-target multi-event,
fan-in, permanent no-target and unhandled cases remain suffix contributions.

## Lifecycle, health and honesty

`/live` indicates responsiveness, including paused. External `/ready` is200 only
for ownership, initialized stores, accepting worker and current active verified
consumer/session/topology. Reference `/ready` stays503; `/reference-ready` is a
separate modeled-only indication. JSON reports `liveConsumerReady`,
`sourceHistoricalCompleteness:unknown`, and
`publisherRecoveryPolicy:external_best_effort_on_expiry` separately.

The consumer does not own or inspect the producer's native cursor/resume store.
It cannot detect wholly unseen or final omitted commits. Producer expiry/replay
can omit or reorder data; this contract is deliberately weaker than native-T
strict completeness. Readiness is not historical completeness or RC approval.

The fixed `/var/lib/redemeine-projection` root must be operator-provisioned0700
for the service UID, with trusted non-writable ancestors and no symlinks. Stable
owner.lock is0600/regular/nlink1, never unlinked. Parent-held inherited-FD flock
is local Linux/cooperating-host ownership, not distributed fencing. No state-path
override exists in production; private test launchers use isolated temporary roots.

Existing one-loop reconnect, joined acquisition/start/drain/close, bounded jitter,
latched failures and absolute SIGINT/SIGTERM deadline are retained. Expired work
cannot release ownership early; deadline exits124, success0, contention73,
configuration78. Process-owned inert signal guards preserve the intended exit
while host callbacks detach. No cancellation claim is made for server-side writes.
Logs contain allowlisted reasons/counters only, not URI/password/token/payload,
source IDs, arbitrary errors or stacks.

## Evidence and next handoff

Unit A source tests use injected Mongo/AMQP I/O, the real runtime/store code,
management DTO models and owned loopback HTTP. Existing local OS lock/signal
tests are separate actual-process evidence. None are real CDC or server receipts.
The protected delta and whole Unit A code/artifact were independently reviewed;
the latter remains verified pending real-stack evidence. Do not infer server/CDC
qualification from those reviews or the previous98-file reference artifact.

The concrete Unit B preparation and naming proposal are documented in
[projection-external-stack.md](projection-external-stack.md). Its new runner must
receive independent pre-audit before any Docker invocation.

The external publisher is the **clean read-only sibling develop commit
`c2b657cb00dde60271e235dec917a7fee28d92f0`**, not the old published npm tarball
inferred from its still0.2.0 package metadata. It publishes persistent complete
JSON commits to its required durable headers exchange with mandatory confirms
before checkpointing. The service imports/launches no dispatcher SDK, changes no
publisher policy, and owns no producer resume/checkpoint store. The prior guarded
SDK requirement is superseded for this consumer contract.

Unit B plan remains under this same Bead: independently pre-audit a concrete
runner with uniquely owned disposable Mongo8 replica-set and Rabbit4.1 management
resources, network/volume/container IDs, loopback ports, quotas, deadlines and
cleanup. Build the sibling Dockerfile from its pinned clean repository-root
context without sibling edits/install; capture source/image/config identities.
Use real Tapeworm append through the stock separate publisher—not sendToQueue as
end-to-end proof. Qualify resume/backlog/new sources, >20 redeliveries, bad routes,
missing destinations/other destinations, expiry evidence where feasible and
late server writes. No Docker/real-stack execution is part of Unit A.

Application embedding `redemeine-ryb5`, historical rebuild `redemeine-awq1`, HA,
release/publication and deployment remain outside this scope.
