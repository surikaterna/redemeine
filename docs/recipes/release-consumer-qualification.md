# Qualify exact artifacts in local npm consumers

This internal tool belongs to **redemeine-cwxu.2**, Slice B of
**redemeine-cwxu**. It is not a publisher or release authorization. The live
publisher, versions, private flags and source dependency declarations are unchanged.
No changeset is needed for this internal tooling.

## A before B

First build trusted source, then run the [static artifact audit](release-artifact-audit.md).
Keep the entire A evidence directory. B never builds, packs, repairs or changes
versions. It accepts only the actual v1 schema and checked-in policy bytes.

```bash
export pnpm_config_ignore_pnpmfile=true npm_config_ignore_pnpmfile=true
export pnpm_config_ignore_scripts=true npm_config_ignore_scripts=true
export pnpm_config_verify_deps_before_run=false
pnpm --config.ignore-pnpmfile=true --config.ignore-scripts=true install --frozen-lockfile --ignore-scripts
pnpm --config.ignore-pnpmfile=true --config.ignore-scripts=true run test:release:consumer
# Obtain the independently expected SHA256 of the complete A manifest.
node scripts/release/consumer.mjs \
  --manifest /absolute/a/manifest.json \
  --manifest-sha256 EXPECTED_SHA256 \
  --output /absolute/fresh-b
```

Complete red A input exits **1**, preserves its diagnostics, and starts no Docker
registry, stager or consumer. Incomplete, unsupported or contradictory input exits
**2**. Selecting `--root name@exact-version` narrows consumer coverage only **after
the entire input passes**; it cannot hide red diagnostics. The unchanged repository
is expected to remain complete exit **1**, not infrastructure exit 2.

Green admission uses pinned `jsonc-parser` to reject duplicate decoded JSON keys,
comments/trailing commas, invalid UTF-8 and excessive JSON structure. It reinspects
copied archives, packed identity, inventory, digests,
registry metadata and graph bindings. Same name/version with different bytes fails
before staging. Identical bytes retain their origins and stage once. Ambiguous v1
edge-source bindings fail rather than guessing. Hashes bind evidence, but do not
authenticate source, establish provenance or grant release permission.

## Isolation and supported tools

Linux **amd64** only. `scripts/release/consumer-tools.json` records immutable official
Node **22.23.3**, Node **24.20.0** and Verdaccio **6.10.5** images. Both derived Node
images provision npm **11.19.0**, verifying the npm archive's pinned SHA512 before
installation. TypeScript **5.9.3** and `@types/node` **24.13.2** are exact test-tool
pins under `/opt/consumer-tools`, not application dependencies. Node typings supply
platform globals (including URL); they are explicit `typeRoots`, not `NODE_PATH`.
No application runtime imports are satisfied by this tools directory.

Provisioning performs anonymous official npm reads and may reuse Docker build
layers. Each receipt records derived image IDs and actual versions. Registry storage,
consumer HOME/config/cache and application trees are fresh regardless of layer reuse.
No workspace, host HOME, host cache, host networking or Docker socket is mounted.
The official registry image's fresh anonymous storage volume is deleted with its
container. Host ports are not exposed.

Teardown removes this run's derived image **tags**, retaining tags/IDs in the receipt.
It never force-removes shared image IDs or prunes another run's tags, base images or
build cache. Removal failures make cleanup incomplete (exit **2**); retained shared
layers are not evidence of leaked registry storage or consumer caches.

Consumers and stagers join only an internal Docker network. By default the registry
has no uplink. Explicit `--external-proxy npmjs` adds anonymous external reads through
Verdaccio; only that registry joins a separate egress network. Exact workspace names
(including private, held and unscoped names), owned seeds, and the union of all
workspace/policy scopes have ordered **no-proxy** rules before the external catchall.
There is no arbitrary registry URL or command option. The official-upstream ghost
test includes a positive proxy control and checks zero owned ghost requests.

Only a dedicated stager receives a disposable local authentication token. It publishes
original copied `.tgz` bytes with scripts off, provenance off and a local qualification
tag. After every write, metadata and downloaded tarballs must match the original
SHA256/SHA512. No public registry writes or public tag operations occur. Consumers
receive no token. Child npm environments use an allowlist, empty user/global config,
and fresh caches; ambient credentials, scope registries, proxies and preloads are
not forwarded. Explicit reviewed smokes run only after lifecycle-disabled installs.

This is **trusted source and trusted tool execution**, not an arbitrary-code sandbox
or a general egress firewall. There is no Bun qualification. Force-killing the host
process/daemon cannot guarantee cleanup. Graceful SIGTERM cancels child Docker commands,
retains an incomplete receipt, and reconciles run labels before deleting resources,
including creates whose IDs may not have reached the interrupted client.

## Scope of consumer proof

Each selected root installs by `name@exact-version`, never source paths or direct
sibling tarballs. npm resolves dependencies from the quarantined registry. `npm ls
--all`, lock URLs/integrities, realized owned edges, cache tarball hashes and realpaths
are checked. Required optional dependencies may not silently disappear. No legacy
peer mode, override, resolution or package extension is used.

Reviewed adapters currently target the synthetic `@fixture/*` test packages, kernel,
and CLI. Advertised supported import/require subpaths are exercised; unknown export
conditions/wildcards, missing adapters and optional-peer behavioral coverage are
incomplete **2**, not passes. Kernel smokes check command/event payload, type and
identity behavior. Runtime resolution follows Node condition order and checks the
actual resolved target. A nested explicit `null` is terminal, distinct from a branch
with no matching condition; actual Node probes also assert that blocked modes reject
with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Conditional arrays remain unsupported **2**.
Strict declarations use `skipLibCheck:false`, `.mts` with
NodeNext/Bundler and `.cts` with NodeNext for advertised require branches. Bundler
does not implicitly enable the `node` condition; its declaration fallback is checked
independently rather than assumed to match NodeNext.
CLI checks installed-bin help, both API exports, contract description and API declarations.
Generated-project qualification first checks its documented prerequisite. A missing
aggregate host is **coverage-incomplete 2**: preserve the successful earlier phases and
mark generation blocked/extraction not-run, without installing an undeclared sibling.
If the prerequisite is available, input type errors remain artifact failure **1**.
Only validated input reaches extraction. The actual generated file and an expected-export
type probe are compiled strictly, then emitted command/event/state schemas must accept
representative valid data and reject missing/wrong-shape data; token/substring presence
is not qualification. Deterministic artifact failures and explicit coverage blockers
do not prevent collecting the other selected runtime/root outcomes. Setup,
network or interruption failures stop execution with incomplete **2**, without retrying
ambiguous uploads. npm publish's transport retries are explicitly disabled.

Exit **0** means the *requested consumer scope* completed, never “full release
qualified.” Exit **1** means deterministic artifact/install/runtime/type failure;
exit **2** means invalid input, unsupported coverage, tool/network/setup failure or
interruption. A passing negative test does not make its failure receipt green.

## Controls and receipts

`test:release:consumer:unit` runs fast input fixtures. `test:release:consumer` also
runs the actual Docker matrix, ghost controls and lower-level fault tests, sequentially;
Docker failures are not silently skipped. The new read-only workflow runs input tests
on PRs, with the bounded expensive Docker job on manual dispatch. Moving that job to
every PR needs Architect/Auditor review. It has no secrets, OIDC or publishing permission.

The following explicit controls perform real npm reads:

```bash
node scripts/release/consumer-test/real-kernel.mjs
# Requires a prior trusted source build; copies unchanged CLI dist before A.
node scripts/release/consumer-test/real-controls.mjs
```

The kernel control uses an isolated synthetic A workspace to audit the **original**
official `@redemeine/kernel@0.2.0-pre.0`. Its packed manifest has dependencies on
zod and immer and **no peer dependencies**; current source is not its metadata truth.
The selected kernel-only receipt cannot qualify the synthetic root or current release.
The separate CLI control copies its unchanged manifest/built distribution before A
and records partial coverage without repair. The root-only install does not
include the separately documented `@redemeine/aggregate` prerequisite (nor a packed peer
declaration requiring it). The current expected CLI result is **2 on both Nodes**, with
successful install/API/declaration phases retained and generated-project coverage blocked.
The control script accepts only that specific documented coverage outcome with successful
cleanup and non-empty, healthy resource outcomes. Every other result fails the control,
including artifact failures before staging; the qualification report keeps its original exit.
Earlier investigative invalid-input extraction receipts belong
to `redemeine-a05s`, a separate product diagnostic/precondition investigation, **not proof
of a CLI artifact defect**. The qualifying path no longer invokes extraction on that
unsupported setup or injects siblings to make it green. The full-repository control requires A=1, B=1,
and zero staging. None authorizes public publishing, merging or incident closure.

Preserve `result.json`, `input-manifest.json`, snapshot byte files, generated config,
staging readbacks, per-consumer receipts and lockfiles. They bind policy, source
snapshot, image IDs, selected/unselected roots, graph, commands, logs and hashes.
Partial receipts and `notValidated` are authoritative. Tests include actual poisoned
warm-cache/workspace controls, an external transitive tarball URL blocked from reaching
a second official registry, and redirect transport failures with zero forwarded writes.
Expected negative controls never turn their qualification reports green. Auditor
verification remains separate from implementation and from actual release qualification.

The generated-output regression fixture installs a test-only CLI facade by exact name
through Verdaccio. Its packed manifest declares the aggregate fixture as a required peer;
npm supplies it from the admitted graph, not a direct sibling install. Its valid typed
input imports that host. The schema library is the frozen root dev Zod code packaged
before A as the distinct fixture-only `@fixture/schema` alias, not a claimed original
public Zod tarball. Actual compiler and Node executions cover healthy output, invalid
syntax/types, comment-only empty maps and over-permissive schemas on both runtimes.
This proves the checker branch, **not the real CLI's generated-project qualification**.
