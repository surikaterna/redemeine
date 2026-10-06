# Planned artifact handoff and local rehearsal

**redemeine-cwxu.3 (Slice C) is internal, nonpublishing tooling.** It does not
repair npm, activate versions, consume repository changesets, or authorize a release.
The incident **redemeine-cwxu remains open**. The legacy `publish.yml` is replaced
with a manual, deterministic failing refusal—not a dormant public publisher.
That operational change takes effect remotely only after the separately reviewed PR merges.

## Tool roles and current state

1. **Changesets 2.31.0** describes version intent. `release:plan` runs its real
   read-only `status --output` command, inventories every changeset and records
   proposed versus applied versions. It does not execute `version` in the repository.
2. **A** packs once with pinned pnpm, checks the archives and full owned closure.
   Default v1 still audits the entire workspace. Explicit v2 selection happens
   **before packing**, never by removing diagnostics from a red report.
3. **B** admits the entire A input, stages original bytes, and qualifies isolated
   consumers. A green subset B run is valid only for that scope, not for handoff.
4. **C handoff** requires every selected root on Node **22.23.3 and 24.20.0**,
   linux/amd64, npm **11.19.0**, all phase receipts, exact bytes, identities and cleanup.
   It copies evidence into a digest-bound envelope. The adapter revalidates private
   copies before publishing those tarballs to its **own ephemeral Verdaccio only**.

The reviewed proposal selects aggregate/mirage `0.2.0-pre.1` and saga
`0.1.1-pre.1`; it requires saga's exact aggregate repair pin. These are proposed
versions, not applied Changesets output. Current source does not match: the real
plan exits **2 (unapplied)** and cannot start packing selected candidates.
Kernel/projection are not force-released to conceal repacking conflicts. Required
unselected public dependencies retain original recursively audited registry bytes.
Private packages and testing remain held. CLI is separately held for its pending
minor/PR123 and incomplete generated-project coverage; its B exit 2 is not green.

The plan retains all 13 source changesets, distinguishes pre-consumed
`initial-release`, and records explicit dispositions. Mixed `tired-dodos-sleep`
intent cannot be discarded or implemented with a `.changeset` ignore workaround.
The separate whole-workspace diagnostic report must complete; its expected red
result is bound alongside, but never admitted as candidate qualification.

## Interfaces

Use Node 24.20.0, root-pinned pnpm 11.9.0 and a working Docker daemon. All output
directories must be fresh absolute paths outside source. Guard outer pnpm calls:

```bash
export pnpm_config_ignore_pnpmfile=true npm_config_ignore_pnpmfile=true
export pnpm_config_ignore_scripts=true npm_config_ignore_scripts=true
export pnpm_config_verify_deps_before_run=false
pnpm --config.ignore-pnpmfile=true --config.ignore-scripts=true install --frozen-lockfile --ignore-scripts

# Read-only; currently expected to exit 2 and retain the proposed plan.
node scripts/release/release-plan.mjs \
  --intent "$PWD/scripts/release/release-intent.json" --output /tmp/fresh-plan

# Only after separately authorized source application, build, and a fresh plan:
node scripts/release/check.mjs --release-plan /tmp/fresh-plan/plan.json \
  --release-plan-sha256 EXPECTED_PLAN_SHA256 --output /tmp/fresh-selected-a

node scripts/release/handoff.mjs \
  --plan /tmp/fresh-plan/plan.json --plan-sha256 EXPECTED_PLAN_SHA256 \
  --manifest /tmp/fresh-selected-a/manifest.json --manifest-sha256 EXPECTED_A_SHA256 \
  --consumer-result /tmp/fresh-b/result.json --consumer-sha256 EXPECTED_B_SHA256 \
  --global-manifest /tmp/fresh-global/manifest.json --global-sha256 EXPECTED_GLOBAL_SHA256 \
  --output /tmp/fresh-handoff

node scripts/release/publish-rehearsal.mjs \
  --envelope /tmp/fresh-handoff/envelope.json --envelope-sha256 EXPECTED_ENVELOPE_SHA256 \
  --output /tmp/fresh-local-replay
```

Obtain digests from the producer, not from an untrusted download claiming its own
expected hash. Root script aliases are `release:plan`, `release:handoff` and
`release:rehearse`. Unknown options fail; there is no registry URL, credential,
shell command, allow-red, allow-dirty production, or public-mode option.
Repository handoff requires a clean matching source snapshot. Generated fixtures
are explicitly labeled rehearsal-only, restricted to fixture identities and policy.

## Evidence and failure semantics

The envelope binds plan/A/B/global bytes, SHA and dirty snapshot, policy/input
hashes, original metadata, candidate versus registry origins, manifest hashes,
SHA256/SHA512 tarball digests, dependency order, and explicit staging/destination
tags. B receipts are checked against **independently derived** roots, tool pins,
phases and resource roles—not against B's own claimed matrix. B originals and
tarballs survive CI upload/download unchanged; the consumer job never packs.

Digests provide integrity, **not cryptographic runner attestation**. Trusted
same-run checkout/gate identity is required. A malicious trusted runner that
forges all evidence and its expected hashes is outside this boundary.

The local adapter uses the pinned official Verdaccio image, a run-owned internal
network and exact generated endpoint. It inherits no ambient npm config or token.
Ephemeral local authentication stays inside its bounded container lease; npm
arguments contain no secrets. Archive lifecycles and provenance are disabled.
Public endpoints and redirected reads fail closed. This is not an OIDC test;
npm 11.19.0 local receipts make no claim about newer public OIDC CLI floors.

Uploads use a plan-bound `rehearsal-*` staging tag. Only after **all** original
bytes reconcile are local destination tags moved: explicit `pre`, or `latest`
for an explicitly stable fixture. Promotion is not atomic across packages.
The fsynced/renamed ledger is advisory: every resumed worker reads registry bytes
again. Identical bytes are not rewritten; conflicting bytes stop; ambiguous reads
remain incomplete. A failed observation never triggers blind npm upload retries.
A second worker process can reconcile within the same bounded lease; this is not
a persistent registry service or public resume API. Cleanup only removes owned
containers/volumes/networks/image tags; cleanup failure makes the run incomplete.

Exit **0** means the requested local scope completed; **1** means deterministic
artifact/policy/conflict failure; **2** means invalid, unapplied, unsupported,
network/setup, or incomplete evidence. Expected-failure wrapper success is never
handoff authority. Failure evidence is retained without turning the gate green.

## CI, validation, and next decisions

`release-handoff-rehearsal.yml` is manual and read-only, with fixed healthy-fixture
and repository-plan modes. The fixture producer emits genuine A/B evidence. The
consumer downloads the same-run immutable artifact ID, receives the upload digest
and independent envelope digest, checks the source SHA and revalidates all bound
files before local writes. Repository-plan mode exposes current blockers as failure.
There are no public credentials, OIDC permissions, version PR writes or automatic PRs.
Local test receipts do not imply the hosted workflow has been dispatched.

`test:release:handoff:unit` covers planning, actual disposable Changesets
pre/stable versioning plus guarded lock refresh/frozen validation, and workflow
boundaries. `test:release:handoff` requires real Docker and exercises both Nodes,
both channels and the child's fixed 15 mutation/fault families using genuine
baseline evidence. Tests use explicit generated fixtures, never actual package
version/private/dependency edits. Run A/B suites and workspace lint/tests/docs too.

**Slice D (`redemeine-cwxu.4`) needs renewed owner approval** to reconcile the
pending changesets, apply exact unused repair versions/pins, and add real
aggregate/mirage/saga behavioral/declaration adapters. The future version sequence
is guarded Changesets `version` → lock refresh/frozen validation → clean reviewed
version commit → build → one A pack → full B → C handoff. C tests that sequence
only in disposable fixtures. Public publication, auth/provenance configuration,
tag policy and incident closure each remain separate decisions.
