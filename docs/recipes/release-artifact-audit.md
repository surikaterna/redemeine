# Audit built artifacts without publishing

This is **redemeine-cwxu.1**, the first nonpublishing slice of **redemeine-cwxu**.
The existing live publisher is **unchanged and unprotected by this gate**.
Never use this recipe as permission to publish or change versions to make it green.

## Prerequisites and commands

Use Node **24.20.0** and pnpm **11.9.0**, including the integrity pin in root
`packageManager`. `corepack enable && corepack install` provisions that manager.
Bun is not required. No competing source lockfile or alternate installer is used.

```bash
pnpm install --frozen-lockfile --ignore-scripts
export TURBO_REMOTE_CACHE=0 TURBO_TELEMETRY_DISABLED=1
pnpm exec turbo run build --force
pnpm exec turbo run typecheck test --continue
pnpm run test:release
pnpm run lint
pnpm --dir website run build
# Choose a NEW absolute directory; the gate refuses to reuse one.
pnpm run release:check --output /tmp/redemeine-artifact-audit-unique
```

Start without local build outputs/Turbo cache. Do not provide Turbo credentials;
use `TURBO_CACHE=local:rw` as an additional remote-cache restriction. On constrained
machines set `TURBO_CONCURRENCY=1` and run expensive commands sequentially.
These local setup commands require trusted repository/pnpm configuration:
`--ignore-scripts` alone does not disable pnpmfiles. Installation disables
lifecycles; builds are explicit reviewed steps. Do not
globally enable scripts to fix a build. Any necessary esbuild lifecycle exception
must be narrow, recorded and reviewed (the workspace already allows esbuild).

The audit itself does not build, install consumers, execute packed code or publish.
Its registry reader does not load npm credentials/config. Its **pnpm subprocesses
do read configuration**, preserving authoritative workspace discovery. Every one
(including `--version`, `list` and `pack`) receives `--config.ignore-pnpmfile=true`
and `--config.ignore-scripts=true`. The child environment removes conflicting
case variants of the npm/pnpm `ignore_pnpmfile` and `ignore_scripts` settings and
forces their canonical lowercase values to `true`. This is necessary on pnpm
11.9: command-line flags alone do not suppress hooks for every configuration of
`--version`. Tests exercise default, custom and global pnpmfile paths with
adversarial workspace/global/environment settings and lifecycle marker traps.

This is a **bounded pnpmfile/lifecycle guard, not an arbitrary-code sandbox**.
Use a trusted Node/pnpm executable, PATH and process environment; arbitrary
`NODE_OPTIONS` preloads can execute before the audit begins. Other pnpm settings
are not isolated or declared safe for hostile configuration. In particular, an
outer `pnpm run release:check` starts pnpm **before** the guard exists; use the
direct entrypoint when testing configurations containing untrusted hooks:

```bash
node scripts/release/check.mjs --output /tmp/redemeine-artifact-audit-another-unique
```

The nonpublishing workflow applies both flags to **all six outer pnpm calls**
(install, run and exec), with canonical npm/pnpm guard environment values already
set before setup/install. Corepack provisions the root-pinned manager; provisioning
is not an audit subprocess or permission to select an untrusted executable.
`pnpm_config_verify_deps_before_run=false` prevents pnpm 11.9 run/exec from
spawning an implicit install without the outer command's guard flags; the workflow
already performs an explicit frozen install. Tests reproduce that hidden install
with harmless hooks when the setting is absent.
Tests deliberately enable harmless pnpmfile marker hooks in isolated positive
controls, separately from guarded calls. Explicit build/test code still executes:
this workflow is not a sandbox for arbitrary PR source or hostile tool/config
selection. No live publication credentials are needed or supplied.

Archive inspection performs no extraction or package execution. Source workspace
specs remain unchanged. URL fragment (`#`), query (`?`) and percent-encoded
entrypoint targets are conservatively unsupported: literal tar filenames are
not evidence that Node will resolve the same URL path.

Exit codes: **0** complete in-scope static clean; **1** known artifact/graph
violations; **2** tool/input/network/incomplete audit. A network failure is not
an acceptable replacement for the expected real-repository exit **1**.
Current testing must reveal its private core/in-memory edges in `held-audit`;
saga's exact aggregate pin must inspect original published `0.2.0-pre.0` bytes
and expose residual `workspace:` specs. Other blockers are reported, not waived.

## Evidence and fixture boundary

The fresh output contains `manifest.json`, `candidate/`, `held-audit/` and
`registry/` (original tarballs and metadata). Preserve the whole directory.
The manifest records SHA/dirty diff identity, untracked-file digests, exact tools,
input policy/lock/workspace hashes, invocations/statuses, selection reasons,
archive inventory/digests, graph origins, snapshots, diagnostics and explicit
not-validated surfaces. No ambient auth is collected. Keep outputs outside source.

`--registry-fixture /absolute/fixture` uses an `index.json` mapping canonical names
to relative metadata filenames. Metadata has `name` and `versions`; each version
has the real packed manifest plus `dist.tarball` (relative tgz path) and strong
`dist.integrity`. An empty `versions` explicitly models absence. Missing fixture
data fails, with **no network fallback**. Tests generate and inspect actual bytes,
including actual scripts-disabled pnpm packs and lifecycle marker traps.
The explicitly selected fixture root is trusted and must remain stable during
the audit. The root, index, metadata and tarball paths are resolved with `realpath`;
file/parent symlinks escaping that root fail **before reading or copying bytes**.
Contained symlinks (including a symlinked root) remain valid. This is filesystem
containment for offline replay, not protection against concurrent filesystem
mutation by another process.

An absent version or registry HTTP 404 cannot clear an explicitly known-bad
candidate: the deny-list check precedes the absent-version return (exit **1**).
Missing/unreadable fixture data instead makes the audit incomplete (exit **2**),
not clean. Original registry bytes are still inspected when available.

This is not full npm resolution, consumer installation, external transitive audit,
declaration compatibility, optional-peer runtime proof, provenance/channel proof
or exact-byte publisher binding. The existing CLI overridden packed smoke is
functional evidence, **not public dependency closure proof**.

## Actual Bun-free qualification

Use the disposable image definition at `scripts/release/test/NodeOnly.Dockerfile`:

```bash
docker build -t redemeine-node-only - < scripts/release/test/NodeOnly.Dockerfile
```

It pins `node:24.20.0-bookworm-slim` to digest
`sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`
and adds git only in that disposable qualification image, not production infra.
Record the resulting image ID and git/Corepack versions as well as the base digest.
The initial disposable image receipt used ID
`sha256:5443110626623ba9999549c17b9bd478b38f5e9952d059fa23eac0b7e24d3be5`,
Corepack **0.35.0**, git **2.39.5** and bundled npm **11.19.0**. The apt layer is
not a reproducible package snapshot: record your own image ID if rebuilding it.
Export the intended Git source snapshot plus SHA/diff/untracked digest receipt
into a new container, **not a bind mount of your working directory**. Do not copy
host `node_modules`, build outputs, `.turbo`, stores, `.env`, `.npmrc`, worktrees,
toolchains or credentials. For an uncommitted patch retain both base SHA and
source-file hashes; never mislabel it a clean committed build.

Use fresh HOME, pnpm store/config/cache and no `NODE_PATH` or Turbo credentials.
Before and after the commands above, prove both `command -v bun` fails and Node
`spawnSync('bun', ['--version']).error.code` is `ENOENT`. Run install, build,
typecheck/test, release fixtures and the live audit in the **same container**.
Retain each command, exit, log and source/image/tool identities. The helper
`test/node-only-proof.mjs` performs the two Bun absence checks and prints versions.
Baseline gate failures require linked issues and Auditor/Builder disposition;
they must not be repaired opportunistically or reported as passes.

This validates the Node 24 contributor pipeline only. Node 22 consumers, Bun
support and production runner changes are deferred; see the
[boundary and future phases](../architecture/release-artifact-gate.md).
