# External CDC qualification harness — prepared, not executed

Issue **redemeine-hpq1.1**, Unit B, `external-broker-live-v1`.
**Independent concrete-harness pre-audit is required before any Docker command.**
Unit A is independently code/artifact verified pending real-stack evidence at
source122 `30ea38ee31d2252563b8b353e208b83b2542f24c9b0e93475007d00573b1268c`.
Its readiness is operational; historical completeness remains unknown.

## Confirmed naming and ownership

The user-confirmed producer-owned durable headers exchange follows
**`tapeworm.<partition>.commits`**: **`tapeworm.master.commits`** for the shared
all-tenants `master` partition. The harness retains the consumer's fixed durable queue
**`rdm.projection.commits`**. The publisher owns the exchange, not a shared common
queue. Other consumers, including saga consumers, keep separate queues and are
not modified. This is **not a production exchange rename** or a default inferred
from the publisher: both `EXCHANGE` and `RABBITMQ_EXCHANGE` explicitly agree.

The vhost/database are `hpq1_<12hex runid>`. Container/network/volume names are
`hpq1-<runid>-<role>` with issue/run labels. Exchange/queue/scope stay stable across
all scenarios and restarts. The binding is empty routing key, `x-match:all`,
`collection:commits`, `partitionId:master`; no tenant header or stream UUID
filter is introduced. Producer `TENANT` and consumer `PROJECTION_TENANT` are omitted.
The generic ModelCounter fixture does not qualify application tenant authorization
or document isolation. The consumer bootstraps its own nonce-bearing quorum/SAC
queue and persisted generation. There is no predeclared/adopted projection queue.

## Execution gate (do not run before review)

After Auditor approves the exact current harness digest, the proposed command is:

```sh
HPQ1_ALLOW_DOCKER=external-broker-live-v1-reviewed \
HPQ1_RUN_ID=<unique12hex> HPQ1_PREAUDIT_SHA256=<approved_harness_digest> \
pnpm --filter @redemeine/projection-service run test:external-stack
```

The digest covers integration sources/Dockerfile/entry script, package/toolchain
wiring, lockfile, harness tests (including cancellation/uncertain-creation fixtures)
and this document, plus the revised service startup-diagnostic sources and sealed
artifact receipt. Thus this review also binds the legitimately changed runtime
bytes rather than silently reusing the old Unit A artifact approval. The confirmation is an operator
execution authorization assertion, **not a signature or service feed attestation**.
Without it the compiled runner exits78 before Docker. No Docker probe/version,
build, pull or run is part of preparation/offline tests. Remote Docker environment
overrides are refused; execution also verifies a local Unix daemon and required
Linux memory/swap/CPU/PID capabilities. Existing resources are never adopted.

## Concrete images, source and packaging

Planned base versions are Mongo **8.0.17**, Rabbit **4.1.4-management**, and Node
**24.20.0-bookworm-slim**. Execution resolves actual image IDs/repository digests,
runs containers by ID, and asserts server versions. The projection Dockerfile's
base uses the resolved repository digest, not a config-image ID as a FROM name.
The unchanged stock producer Dockerfile's Node26.9.0-alpine tag is pulled/resolved
and checked around its build; concurrent malicious daemon retagging is outside
this controlled operator contract. No digest is invented now.

The separate stock producer is built from clean read-only sibling
`/opt/project/tapeworm`, branch develop, exact commit
`c2b657cb00dde60271e235dec917a7fee28d92f0`. Its existing repository-root Dockerfile
is unchanged. A bounded curated root-context copy contains only required tracked
root manifests and the two source packages; symlinks/secret paths are refused.
Source revision/cleanliness are checked before/after staging and building. No
checkout, sibling install, mutation, SDK import, resume-store takeover or old
published npm dispatcher is used. Package version0.2.0 is metadata, not evidence
that the local source equals the historical tarball.

The qualification projection image copies only sealed `main.js`, receipt and lock
digest plus the reviewed entry script. Current artifact input bytes are checked
before staging. It is nonroot10001, with operator-provisioned fixed0700 state root,
util-linux flock and tini. A qualification-only socat relay is bound to worker
loopback15672 and forwards to the owned Rabbit management service. This permits
the audited loopback HTTP fixture configuration without changing Unit A, skipping
TLS checks, or selecting an arbitrary management endpoint. Relay listener readiness
is verified before Node starts; the relay starts before the lock FD exists.
Health remains loopback9464 and is observed by exact owned-container exec.

Producer and projection are separate containers with explicit consistent vhost,
exchange/collection/partition and absence of a static tenant filter. Feed ID/checkpoint key are fixed for the run;
stock changeStream recovery policy is not changed. Test-only management admin
credentials enable setup and labeled fault injection; this is not certification
of a production least-privilege/admin-hardening deployment. Publisher write rights
are restricted to its exchange; consumer binding needs queue-write rights, so
trusted-consumer/default-route prohibition remains an explicit operator assumption.

## Real append fixtures and observations

Fixtures use actual installed `tapeworm@0.6.0` EventStore/openStream/commit and
`tapeworm_persistence_store_mongodb@3.1.0`, not direct source inserts or sendToQueue.
A fixed fixture-only Db mapping directs that package's `tw_master_commits` to
`commits`; its actual append/index code still executes. A narrow append/query
partition forwarding bridge avoids incompatible legacy optional snapshot callback
declarations, without casts or changing either package. ModelCounter/Added events
have explicit ISO timestamps, target/amount and proper Tapeworm ID/version fields.

Prime primary source commits0–41 and256 inactive one-commit sources **before**
the producer's fresh boundary. The dataset is298 rows, not millions. Dataset
construction is separate from consumer measurement. Mongo profiling observes
the named projection client's bounded source ranges; startup must have no source
finds, and primary reads may never cross below41/first42. No application UUID list,
historical hydration, source inventory poller or rebuild is configured.

Producer checkpoint reads are harness observations of actual stock process state,
not input to consumer evidence. Initial boundary write alone is not called cursor
readiness: later route return and successful probe publication must be observed.
The pinned CLI uses the configured string checkpoint key and majority primary
reads/writes. Its fresh watcher persists a v1 BSON Timestamp boundary transition
before consuming live events; the harness must not drop that startup invariant.
Checkpoint diagnostics expose only shape/kind and version/feed/date validity plus
progress-presence booleans, never BSON tokens, source payloads or credentials.
Boundary and mandatory-return waits retain their budgets and now have distinct
deadline reasons, with checkpoint/process facts persisted on failure. Known exact
publisher lifecycle/fatal lines are classified through a closed allowlist; unknown
text stays omitted. A started marker is not cursor readiness or publication proof.
An inclusive boundary can retain an earlier ignored event; the route-failure case
does not falsely attribute a returned publication to a specific source ID.
RabbitMQ4.1.4 exposes top-level exchange publish-in/out totals, **not** a top-level
exchange return counter. The negative scenario now observes channel totals through
`/api/vhosts/<run-vhost>/channels`, selecting the publisher user and the exact owned
producer IPv4 peer. It requires no source bindings on the intended exchange, a
numeric baseline, then increased publish and return totals on the same channel
identity after the real append. Missing statistics are unknown, never zero; rates,
foreign channels, ambiguous identities, resets and replacement channels cannot pass.
Rabbit core creates publication fine metrics lazily on activity, not channel
creation/coarse-stat emission. If the first scoped sample is absent, one labeled
real Tapeworm ignored/no-target append initializes metrics; then the harness takes
a numeric baseline and performs the evidence append. This is not a fake queue,
direct transport publication, cursor-readiness claim or exact-source attribution.
Baseline sampling has the existing bounded scenario budget. H3 still requires
stop0 and an unchanged native checkpoint afterward. No destination queue is faked.

Contract sources: RabbitMQ tag `v4.1.4`, `rabbit_mgmt_db.erl`
(`list_exchange_stats`, `detail_exchange_stats`, `channel_stats`),
`rabbit_mgmt_metrics.hrl` (`stats_per_table`), `rabbit_mgmt_stats.erl` (`format_rate`)
and `rabbit_mgmt_dispatcher.erl` (vhost channels route), plus `rabbit_channel.erl`
(`emit_stats`) and `rabbit_core_metrics.erl` (`channel_created`, publication counters).
The pinned producer's
`confirmed-channel.ts` emits `Mandatory publication unroutable` from basic.return;
its exact CLI retry line is classified safely, not used to replace broker-counter proof.

State/inline markers/own-record progress/floors are checked in the persisted epoch
namespace, coupled with actual intended-queue ACK counters and an empty queue.
The native original-object ACK invariant is independently covered by Unit A;
broker counters are server observations, not JS-object introspection.

## Implemented initial scenario subset (all currently unrun)

| Scenario | Concrete assertion |
| --- | --- |
| Policy refusal before interval | Unsupported policy pauses503 with binding-stage `broker_policy_unproven`, no control row; unrelated generic refusal cannot pass; stop, remove only that owned policy before fresh interval |
| No destination | Actual mandatory return on the exchange, native checkpoint does not advance; no exact failed-source attribution claimed |
| First42 / complete commit | Real append → stock external publisher → headers binding → both definitions/markers/coverage → ACK; all events/no-target/ignored contribution |
| New source | Automatically routes first0 without a consumer UUID setting |
| Graceful backlog restart | Clean run marker, same container/config/epoch, durable queued43 applies on restart; unexpected quarantine fails, never resets marker |
| Producer native resume | Producer offline appends final-only44 and previously unseen source0; stock resume recovers both without later wakeup append |
| >20 redeliveries | Controlled transport consumer requeues original45 twenty-two times, actual delivery-count≥21 and retention; known-floor projection restart applies once |
| Malformed transport delivery | Explicitly non-append fault, observed unACKed pause/live200 and unchanged ACK count; no false end-to-end label |
| Unclean restart | Durable active marker causes observable reconciliation-required pause, no automatic clearing |

Alternate-destination confirm semantics, expiry pressure/fallback omissions,
deterministic save-beforeACK crash, delayed Mongo server writes, actual gap repair,
actual binding drift and million-source scale are **not implemented in this
initial runner**. Receipts enumerate these gaps; successful initial subset is
not full B1/B2/RC qualification. The active-run barrier is not proof of Mongo
cancellation. No scenario changes producer policy or resets durable control.

## Resource budgets, cleanup and receipts

At most16 recorded resources; one unique owned bridge and owned volumes only.
The reviewed qualification mode is **`owned_bridge_loopback_nat`**: explicit bridge
driver, `Internal:false`, and **`egressAllowed:true`**. Outbound NAT is intentionally
permitted; there is no zero-egress claim. This is not the shared default bridge,
host networking, a production ACL qualification, or permission to target arbitrary
services. Only pinned test code and generated disposable credentials are used.
Exact network name/ID/issue-run labels and driver/mode are checked; every started
container must attach to that single owned network ID. Mongo publishes27017 and
Rabbit5672/15672 only, each with one distinct active high host port1024–65535 bound
to127.0.0.1. Producer/projection/key-init publish nothing. Declared port specs are
checked before start; actual bindings after start and on endpoint discovery.
Image-exposed extra null ports are allowed, extra active publications are refused.
An empty configured HostPort is an allocation request, never an active fallback.
Container memory/CPU/PID/log caps are explicit and checked in inspect metadata.
Projection rootfs is read-only except its owned state volume. Mongo oplog64MiB
and cache0.25GiB, bounded1024 fixture commits, and observed data-directory budget
2GiB constrain the test; the disk check is a stop-on-observation bound, **not a
Docker volume quota**. No host network, privileged container or production mount.

Builds request2GiB/one CPU using the legacy bounded builder; unsupported caps or
builder capability fail rather than silently running uncapped. Each build has a
15-minute deadline, pulls5minutes, total runner40minutes, post-setup scenarios
4minutes and cleanup2minutes. Command output is bounded1MiB. CLI cancellation
cannot prove daemon build termination: uncertain build completion is recorded,
never called fully cleaned. Shared base images and build cache are not pruned.

Resource intents are recorded before creation, then exact IDs/labels verified.
Cleanup inspects each recorded ID/name, refuses foreign/replaced objects, stops
containers before removal, and removes only owned image tags/volumes/network.
Unknown partial creation is reconciled only through its pre-recorded unique name,
never a global matcher. No global prune/kill or deletion of common images.

Receipts are owner-only under `/tmp/opencode/hpq1-<runid>-<unique>/`, with source
base/full uncommitted snapshot digest, curated source/image/config identities,
scenario assertions/failures, commands, resources and cleanup outcomes. Command
output is hashed; raw container output is reduced to allowlisted observations,
with arbitrary text/URI/password/payload/stack omitted, not regex-only redacted.
Hashes bind observed bytes, not cryptographic signatures/immutability promises.
First unexpected run failure must be investigated; this runner contains no retry
of entire scenarios/stacks to green.

### Cancellation and uncertain completion (H1–H3 repair)

Outer work is raced against the absolute runner deadline/abort independently of
the awaited scenario, so a missing AMQP confirm cannot prevent entry into cleanup.
Acquisition, confirmation, cancellation and each raw transport close phase use
the existing absolute budgets. Late acquisitions are observed and closed; late
failures are consumed and recorded. A timed-out close is reported unjoined, not
converted into Unit A's native-closed proof. Cleanup has its own fixed deadline,
then an unref'd terminal process guard bounds residual handles and exits nonzero.
No successful receipt may contain unjoined operations.

Before cleanup awaits anything, command admission switches to cleanup-only mode.
Both operation labels and actual CLI verbs are checked. Late inspection/stack
completion cannot reserve/create/start new resources, and the final fence permits
no Docker operations. This is a harness cancellation boundary, not a change to
the application writer's native-close or Mongo quiescence contract.

Every remote creation intent records not-requested/in-flight/confirmed/uncertain
completion. Timeout/abort marks uncertainty for images, networks, volumes and
containers. Reconciliation inspects only the recorded names/IDs up to three
times within cleanup's budget. Missing inspection does **not** prove an uncertain
creation is forever absent. If a late owned object is found, exact owner/identity
checks permit its removal, but removal-observed remains distinct from proved
creation completion; uncertainty stays `removed:false` and the run fails.
Foreign objects are never removed. No global search/prune is used.

The no-destination scenario retains its early checkpoint observation, requires
producer stop exit0, then re-reads the checkpoint with the majority read concern
and compares the original boundary plus absence of UUID progress. A late advance
or stop124/unclear outcome fails rather than certifying no advancement.

### First attempt and renewed review

The one approved initial run `aeb37b16cbf2` failed during source-context curation
before component creation: a `.git` prefix guard rejected tracked `.gitignore`.
Its original failure receipt remains preserved; no scenarios ran and no images
were resolved. The repair allows `.gitignore`/`.gitattributes` data only through
the tracked whitelist and regular nonsymlink checks. Exact `.git` metadata,
other `.git*` paths, `.env*`, `.npmrc*`, key/certificate paths and traversal remain
refused; arbitrary dotfiles are not newly blanket-allowed.

**Next owner: Auditor renewed concrete-harness pre-audit.** The consumed approval
is invalid for this revised digest. After additional Round1 observed null active
Rabbit bindings, Round2's owned bridge allocated the expected loopback ports and
policy refusal passed; its no-destination wait timed out without enough phase
facts to identify the cause. Round3 proved boundary readiness and isolated the
return-observation deadline; the Rabbit metric-path repair is prepared for Round4.
Round4 observed scoped returns and passed post-stop checkpoint invariants, but its
positive projection start paused with generic `startup_refused`. That generic
reason also did not prove the earlier policy-negative cause. Service health/logs
now expose closed startup stage/code plus route/status/JSON facts (no raw vendor
message, URI, token or stack). Known management HTTP refusals retain their code;
unknown diagnostics grant no readiness. The harness captures bounded source-index
catalog metadata, not a source UUID inventory, and requires the exact policy cause.
The sealed service artifact legitimately changes for these additive diagnostics;
protected runtime24 and producer source remain untouched.

Round5 passed strict policy refusal and the post-stop no-destination checkpoint
invariant, then refused positive startup at the queue policy guard (HTTP200 JSON).
Actual queue policy field values were not retained; omission is **not** a proven
retrospective explanation. Round6 candidate `ef730a9c12bd` remains unstarted.
The offline repair accepts only omitted, null or empty-string queue `policy` and
`operator_policy` fields, rejecting own undefined, names and non-string values.
It still requires an empty effective-policy object when present, empty global policy/operator
policy lists, exact owned nonce/quorum/no-drop arguments and complete bindings.
Fixtures now omit policy names and exercise bootstrap, admission and original ACK.

Pinned RabbitMQ v4.1.4 source evidence (not a live-response capture):
[`rabbit_quorum_queue.erl`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbit/src/rabbit_quorum_queue.erl)
`i(policy)`/`i(operator_policy)` map no named policy to Erlang `''`;
[`rabbit_mgmt_format.erl`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbitmq_management_agent/src/rabbit_mgmt_format.erl)
`format_queue_basic_stats({_, ''})` omits the entry and `format_nulls` converts
retained `''` to JSON null. Empty effective definitions become an empty map.
[`rabbit_mgmt_metrics_collector.erl`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbitmq_management_agent/src/rabbit_mgmt_metrics_collector.erl)
stores both basic/full queue stats;
[`rabbit_mgmt_wm_queue.erl`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbitmq_management/src/rabbit_mgmt_wm_queue.erl)
`ensure_defaults` fills garbage-collection metadata, not absent policy names.
This schema repair changes the sealed service bytes legitimately; it neither
proves positive live consumption nor authorizes execution with the old digest.

Round6 passed both strict negatives but positive bootstrap refused queue schema
before producer restart/F42 append. Its queue body was not retained. The next
offline repair addresses a **source-proven cold quorum representation**:
`effective_policy_definition` may be omitted before statistics are populated.
No named-policy absence or effective-policy absence is inferred from that omission:
`inspect` first proves both global policy lists empty, then exact queue arguments
and empty/absent queue policy names. Only after those checks may an omitted
effective definition be accepted. A present definition must be exactly an empty
object; null, arrays (including `[]`), own undefined and nonempty objects refuse.

Exact v4.1.4 pipeline:
[`rabbit_mgmt_format:queue/2`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbitmq_management_agent/src/rabbit_mgmt_format.erl)
emits durable queue identity/arguments plus quorum type/state, not policy stats.
[`rabbit_quorum_queue:handle_tick/3`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbit/src/rabbit_quorum_queue.erl)
emits `effective_policy_definition` among statistics on its5000ms tick.
[`rabbit_mgmt_data:detail_queue_data/2`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbitmq_management_agent/src/rabbit_mgmt_data.erl)
looks up `queue_stats` with default `[]` before any metrics exist.
[`rabbit_mgmt_db:detail_queue_stats/3`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbitmq_management/src/rabbit_mgmt_db.erl)
merges those props with queue identity and **always** appends `consumer_details`
from the queue-scoped consumer statistics. The individual queue handler requests
`full` stats by default; `ensure_defaults` does not restore missing policies.
`format_queue_stats` converts an emitted empty effective list to an empty map,
so JSON `[]` is not a supported populated effective definition.
[`rabbit_mgmt_util:disable_stats/1`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbitmq_management/src/rabbit_mgmt_util.erl)
defaults to stats enabled, unless query/config/features disable it. The client
requests no filtering/disable-stats query. Missing `consumer_details` remains a
hard refusal, never zero consumers; no extra consumer endpoint or fallback added.

Closed refusal codes identify queue response, arguments, effective definition or
consumer-details schema failures without echoing any values. They pass through
existing health/log/receipt allowlists and cannot satisfy the policy-negative
assertion or grant readiness. Fresh fixtures omit cold effective policy stats,
while complete idle/active consumer details and owned identity remain mandatory.
Round7 candidate `a93e470bd162` is unstarted; six rounds used/four remain. New
artifact/digest requires independent preaudit. No positive live qualification.

Round7 subsequently reached `consumer_start` but paused `live_start_unproven`
before positive producer restart/F42 append. Its underlying activation cause was
masked by the protected worker's generic begin-failure mapping, not retained;
do not claim a retrospective zero-consumer observation or statistics-lag cause.

Round8 offline activation repair keeps the worker's existing staged maximum of
one original delivery: no floor/fold/ACK or readiness before verified active
consumer identity. Pinned v4.1.4
[`rabbit_quorum_queue:consume/3`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbit/src/rabbit_quorum_queue.erl)
sends consume-ok **before** checkout, single-active-consumer query and consumer
metric creation. [`rabbit_core_metrics:consumer_created/9`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbit_common/src/rabbit_core_metrics.erl)
writes the core ETS table; the management
[`rabbit_mgmt_metrics_collector`](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbitmq_management_agent/src/rabbit_mgmt_metrics_collector.erl)
only populates `consumer_stats` on periodic `collect_metrics`. Queue count and
consumer details are independently collected. Thus consume-ok is not an atomic
management-active-consumer proof, and an explicit zero count with empty details
can be a supported staged observation, not successful admission.

Only **initial activation**, with the exact consume-ok tag and current owned
channel, may poll `broker_consumer_count_pending`: all existing topology/policy
checks must pass, `consumer_details` must be an actual empty list and `consumers`
must be an own field exactly numeric0. Missing/malformed/count-conflicting
metadata, multiple consumers, foreign tag, inactive consumer or tuple/identity
mismatch fail immediately. Missing fields never become zero or active. Existing
periodic topology loss remains a permanent fault, never renewed staging.

The activation deadline is one absolute10000ms monotonic budget, raced against
stuck checks and shutdown; polling at most every100ms cannot extend it. The host's
existing startup/shutdown deadlines remain authoritative and may win earlier.
Late inspection success cannot activate; outstanding inspection is observed and
joined during owned cleanup. No polling timer survives stop/timeout/success.
No source inventory polling, queue adoption/reset, control-marker clearing,
permission widening, or producer change is introduced.

Service-owned evidence captures the original activation failure before the
protected worker masks it. Health/log/receipts retain only closed failure codes,
bounded detail/count metadata, count shape, active flag and tag-match boolean;
no tag/connection/socket/source/token/payload values are emitted. This observer
uses the R5.1 non-authoritative isolation boundary, including asynchronous
rejection containment. Runtime worker failure/cleanup behavior is not bypassed.
Round8 candidate `18bd5c96f4a0` is unstarted: seven used/three remain. Any new
artifact/digest requires independent preaudit; no positive live claim.

Round8 subsequently retained a **definitive** initial snapshot: actual
`consumer_details:[]` but own `consumers` field **absent**, followed by
`broker_consumer_count_inconsistent`. The explicit-zero-only predicate refused
immediately; this was not exhaustion of the activation deadline. No positive
producer restart/F42 append occurred. Round9 repairs that precise incompatibility.

During initial staged activation only, after full policy/identity/nonce/argument/
binding validation and exact owned consume-ok/current-channel checks, actual
bounded empty consumer details may remain retryable **unproven** when the counter
is absent, numeric0 or numeric1. Absence stays **UNKNOWN**, never becomes zero
or proof of no other consumer. Numeric1 is a counter observation, not actor
identity or active readiness. Own undefined/null/noninteger/negative/string or
other malformed counters refuse immediately; integers>1 conflict. Missing or
malformed `consumer_details` still refuses, never defaults to an empty list.

Pinned v4.1.4 source supports both incomplete snapshots: the immutable formatter
omits `consumers` and missing queue stats default to `[]` (same pipeline as cold
effective policies). `rabbit_quorum_queue:handle_tick/3` emits
`{consumers, NumConsumers}` to `rabbit_core_metrics:queue_stats/2`;
`rabbit_mgmt_metrics_collector` collects `queue_metrics` independently of
`consumer_created`, whose formatted tuples populate `consumer_stats`.
`rabbit_mgmt_data:detail_queue_data/2` reads those separate tables and
`rabbit_mgmt_db:detail_queue_stats/3` merges them without an atomic consistency
barrier. Thus a counter may precede its consumer details. Sources:
[quorum tick](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbit/src/rabbit_quorum_queue.erl),
[collector](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbitmq_management_agent/src/rabbit_mgmt_metrics_collector.erl),
[data](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbitmq_management_agent/src/rabbit_mgmt_data.erl),
[merge](https://github.com/rabbitmq/rabbitmq-server/blob/v4.1.4/deps/rabbitmq_management/src/rabbit_mgmt_db.erl).
No bounded convergence guarantee is claimed.

The unchanged absolute10000ms deadline then pauses if uncertainty persists;
original late inspections remain joined. No active flag or counter grants
admission: a single detail tuple must match the exact queue/tag/active/prefetch/
ACK/exclusive/channel/connection/user/label/socket identity. The one original
delivery stays staged with no floor/fold/ACK until this check succeeds. After
activation, empty details always permanently fault regardless of absent/0/1
counter. Existing diagnostic shape remains `absent` with no invented count.
The modeled absent→0→1(empty details)→exact actor regression verifies both
definition states and original ACK only after qualification. Unknown-forever,
foreign-actor, malformed-count, shutdown and late-join paths remain failclosed.
No other runtime change, deadline expansion or advisory cleanup is included.
Round9 candidate `6ad812fc9b30` is unstarted: eight used/two remain. New digest
requires independent preaudit; positive live/RC/history/tenant qualification
remains outstanding.

Round9 actually passed the first seven scenarios: F42 both definitions5, new
source12, backlog16, native resume33 and retained >20-redelivery34, with exact
markers/floors and queue ACK metrics. It failed the malformed transport wait and
Mongo log collection. These receipts remain preserved; neither failure is waived.

### Round10 retained-obligation and bounded log evidence

The old malformed predicate required `messages_unacknowledged===1` throughout
pause. That is not the runtime's stable obligation location: `host.ts75-78,96-106`
fences and joins failed attempts; `hostAttempt.ts61-79` stops the worker;
`liveRabbitWorker.ts198-218` closes the channel; the locked amqplib2.0.1
`lib/channel_model.js68-71` implements native close. RabbitMQ4.1
[automatic requeueing](https://www.rabbitmq.com/docs/4.1/confirms#automatic-requeueing)
returns manual-ACK deliveries to ready state when that channel closes.
This is protocol/source proof of an invalid unACKed-only invariant, not a captured
Round9 final queue state (that state was not retained).

The repaired fault establishes an **empty queue before one mandatory confirmed
malformed publication**, records hashed message/source identity and fixed invalid
JSON semantics, then requires ready503/worker-paused/unready and exactly one
obligation: either ready1/unACKed0 or ready0/unACKed1. ACK equals the baseline at
every sampled post-publication check, after pause, and after stop. Extra messages,
ACK changes, dropped/never-observed obligations, bad schemas, non-live paused
host, stop!=0 or non-ACTIVE control refuse. /live remains200. After stop0 it waits
within the **same existing30-second budget** for ready1/unACKed0 and actual empty
consumer metadata, so the next unclean restart checks quarantine rather than stale
consumer metrics. No operator ACK/NACK/peek, message deletion or marker reset.
Aggregate ACK/single-obligation evidence is explicitly not a per-message peek.
Last safe health reason/status, queue-field shapes/counts/ACKs and startup codes
are saved before predicate validation, plus separate baseline/publication facts.
The seven positive assertions and final ACTIVE-marker restart requirement remain.

Old `executeCommand` retained stdout+stderr up to1MiB, then killed/refused the
command. A real offline Node child reproduces that capacity failure; Round9's
Mongo-specific underlying exception remains unknown. Only exact owned
`container logs --tail 200 <id>` uses the new streaming path. Ordinary commands
retain their1MiB cap. Log capture drains both pipes, hashes all selected raw bytes
without persisting them, and parses lines with a16KiB bound; oversized lines are
discarded whole, never interpreted via their suffix. At most200 allowlisted
observations and a closed publisher-lifecycle set are retained. The raw input
budget is32MiB (separate from retained-memory/output capacity); crossing it fails,
not successful truncation. Sanitized output remains<=1MiB. Original command20s,
cleanup2min and2s TERM→KILL grace remain unchanged; abort/error/exit must join the
child, and wrapper unjoined outcomes still fail overall qualification.

Log artifacts explicitly report tail selection/not-full-history, raw stdout and
stderr hashes, received-chunk-order combined hash, bytes, oversized-line and
omitted-record counts, and truncation. They never include URI/payload/stack/raw
text or credentials. Nonzero native exit, stream/spawn/capacity/deadline/file
errors still produce `log_collection_failed`, with bounded resource/reason
diagnostics; missing log evidence is never removed from success criteria. No
container log cap, resource ownership/fence, source/protected runtime, SDK,
publisher, profile fixture or physical storage constraint is changed.
Round10 `5c2ea80b79d4` is unstarted: nine used/one remaining. New harness digest
requires independent preaudit; no all-nine/fullRC claim from these offline fixes.

### Round10 safety re-audit blockers R10.1/R10.2

The first Round10 preaudit was **blocked**, despite green gates. Its independent
retention probe succeeded at60000ms against a30000ms case budget; its kill-EPERM
probe classified a live child error as spawn failure before close. That digest
is not executable approval, and the remaining round has not been consumed.

R10.1 now owns one case-local `RetentionBudget`: original monotonic30s deadline,
one independent timer, and a child signal linked to parent cancellation (never
mutating the parent). Every queue/health/control/publication/stop/observation await
is raced against that same interruption and checked before and after completion,
including successful predicates and final readbacks. Poll delays do not rebase
the clock; the final result gets another deadline check. Signal overrides are
limited to these harness I/O calls; existing HTTP5s/health3s/CLI20s caps remain.
Pending original operations stay observed, receive case cancellation, and are
reported unjoined if still pending when interrupted. Late success cannot continue
the case; late rejection is consumed. No invisible indefinite wait blocks outer
cleanup or its finite residual-handle guard. Synchronously blocking JavaScript
cannot be preempted, but a late returned value cannot qualify the case.

R10.2 uses a dedicated child lifecycle with **persistent** error observation.
Spawn events and PID presence distinguish live-child errors from known no-child
spawn errors; neither error category settles before close. The first closed safe
cause remains latched. Termination is latched before calling `kill`, so synchronous
EPERM errors cannot recurse or reset its deadline. Repeated errors remain observed.
Deadline/abort supervision remains until close or the existing2s termination-grace
boundary. At that boundary SIGKILL is attempted; if close still is not observed,
the promise fails explicitly child-unjoined, retaining its first cause and marking
the command receipt unjoined. Signal delivery is **not** close proof. Late close
and errors remain observed, but cannot convert this failure to joined success.
Native close also checks monotonic elapsed time if timer delivery was delayed.
Pipes continue draining after refusal without accumulating raw logs. Native
spawn failure, nonzero exit and all previously enforced capture caps still fail.

The exact cumulative retention probe now refuses at31000ms, not success at60000ms.
The exact never-closing kill-EPERM probe now returns bounded explicit unjoined
failure, not spawn-failed/clean; delayed-close and repeated-error regressions prove
settlement only after actual close when it occurs within the existing bounds.
No deadline/grace increase, runtime/SDK/protected source edit, assertion weakening,
profile/publisher mutation or Docker call is part of this safety repair. The same
Round10 candidate `5c2ea80b79d4` remains pending fresh independent re-audit.
Startup notifications are non-authoritative: a shared synchronous boundary contains
sink/classifier exceptions and observes unexpected asynchronous rejection without
awaiting it or extending acquisition/cleanup deadlines. Original failure mappings
and owned native-close joins remain in force even when diagnostics fail.
Proposed fresh Round5 ID: `d94fe6120ba7`, only
after new approval. No Unit B/overall verification or deployment is implied.
