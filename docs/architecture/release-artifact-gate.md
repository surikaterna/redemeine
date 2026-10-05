# Nonpublishing artifact gate boundary

Bead **redemeine-cwxu.1**, under unresolved incident **redemeine-cwxu**, implements
only static diagnosis of built distributions. It does not repair old npm versions.
**`.github/workflows/publish.yml` is unchanged and is not protected by this gate.**
The new workflow is advisory: green offline fixture PR tests, plus an opt-in real
audit whose failures are retained, not suppressed. No sealed-artifact delivery is claimed.

## One owner per responsibility

* Node 24 hosts TypeScript/tsup, tests and the gate; pnpm's exact root pin owns
  workspace discovery, installs, lockfile and scripts-disabled packing.
* Changesets owns change intent and future reviewed version plans, not artifact
  validation. Turbo schedules builds/tests; it does not select release membership.
* Bun is not required or used to install/pack. Historical Bun test receipts in
  earlier architecture documents remain historical evidence, not current setup instructions.
* This gate uses anonymous registry GETs only. npm consumer installation and any
  exact-tarball publisher are separate, later responsibilities.

## Slice A contract

Six focused modules separate orchestration, workspace/evidence, archives/content,
portable specs, owned graph and read-only registry IO. pnpm, not a second YAML/glob
implementation, discovers workspaces. Private packages (including root/website)
are never packed. Public held packages are packed only for diagnosis; testing is
held for its two private runtime edges and cannot satisfy a candidate dependency.

All packed dependency fields get portable-spec hygiene checks. Production and
required-peer owned edges get normal prerelease-aware semver checks; optional
dependencies are required to resolve. Absent optional peers are recorded as
unqualified consumer behavior. Third-party closure is explicitly unvalidated.
Workspace-intent edges may use eligible local artifacts. Ordinary source pins
must use original registry tarballs, even when a local name/version is identical.
Encountered public/local overlap is audited from the original registry bytes.
Known-bad admitted versions are diagnosed and inspected, not filtered away.

Archives are bounded and inspected without extraction. Links, unsafe/colliding
paths and non-file/directory entries fail. Declared entrypoints must exist; bin
files need a shebang and execute bit. Single-star exports require matching files
and identical conditional expansion sets; unsupported shapes fail explicitly.
This is conservative static evidence, not JavaScript/TypeScript execution proof.

## Repeatable blueprint and later phases

Use the [recipe](../recipes/release-artifact-audit.md): pin tools, build fresh,
discover/filter, pack once without hooks, inspect bytes, audit owned originals,
retain manifest/diagnostics and review failures. Policy is scope/hold/known-bad
configuration, not a growing public-package allowlist or a release plan.

Parent `redemeine-cwxu` retains the full future design: isolated no-fallback
registry consumers (including Node 22/24), reviewed version plans, exact-byte
publisher rehearsal, then separately authorized repair versions and live release
verification. Quarantine, publisher, tags, OIDC, new versions, private-package
disposition and consumer proof are **not implemented here**. Do not extrapolate
this audit's success to release readiness or close the incident on gate delivery.
