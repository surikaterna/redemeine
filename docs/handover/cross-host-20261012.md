# Cross-host handover — 2026-10-12

## NEXT AGENT PROMPT (copy this section)

Check the database source, source-preservation evidence, and current GitHub state
before resuming work. Read this whole document, the repository's `AGENTS.md` and
`docs/code-principles.md`. Restore and explicitly adopt the authoritative Beads
backup below; do not run `bd init` to invent a new authority. If the intended
snapshot ref is absent, STOP: source delivery does not prove database delivery.
Obtain the final handover's verified snapshot Git SHA, cutoff and equality result.
An older fallback is not the current projection handover.

Use existing `redemeine-hpq1` / `redemeine-olwl` and their latest parent audit notes;
do not infer completion from stale child statuses (including event 1105).
The projection checkpoint preserves work, not production readiness. Verify its
234 changed paths and 235-entry fingerprint before touching source. Review the
four active PRs below without merging or publishing. Keep standalone interop's
native-Promise contract and distinguish green ordinary CI from blocked legacy
qualification. Preserve authored PaymentAttempt behavior and the Mirage version
rules. Propose scoped next work through the existing Beads, not drive-by fixes.
Use isolated `feature/*` worktrees wired to the adopted shared database.

No authorization is conveyed for merge, rebase, PR creation, release/tag, registry
or image publication, deployment, or another projection test/Docker campaign.
The exhausted ten-run qualification budget must not be silently restarted.

## Delivery boundary and source identity

- Source checkpoint **pushed**: [`e73d27d637f02f683f135a9057cbddccff5f2006`](https://github.com/surikaterna/redemeine/commit/e73d27d637f02f683f135a9057cbddccff5f2006).
- Branch: [`feature/projection-live-inline-olwl2`](https://github.com/surikaterna/redemeine/tree/feature/projection-live-inline-olwl2).
- Parent: `6d2fbc37d0a06d528436e2f41a05dfd8fe767d4b`.
- Checkpoint tree: `98dda28497c789f97f2fe58fda859c38c93f5021`.
- Exactly **234** source paths: **229 additions / 5 modifications**, all regular
  files, Git mode `100644` / filesystem `0644`; total source bytes **1,532,455**.
- Historical **235-entry** fingerprint includes unchanged `tsup.config.base.ts`,
  blob `632725cf846b6ea89f9b7af135dbe7b9470ac5ed` (not a checkpoint change).
- Fingerprint SHA-256:
  `e76b772694a3d7b93ef149b471ce3d5a95d3452f417e28d8e52253e53f21eb72`.
- This document is intended for a **second, separate documentation commit** after
  Auditor review. It is not part of the pure source checkpoint above.
- Read-only GitHub checks at document preparation matched the source branch and
  `main` at `cae1187d4aa44c95a59ea77da35ce36543f909d9`, 44 commits beyond the
  projection base. Do not overwrite main or rebase away checkpoint provenance.

All valuable projection implementation is now in the pushed source checkpoint.
Old-host root metadata dirt and `redemeine-jdbn` Beads metadata are unrelated;
do not sweep them into this branch. Ignored qualification receipts are not in
GitHub; some historical projection raw receipts are unavailable. Beads records
and matching source fingerprints preserve historical claims, not new test runs.

### Retrieve without disturbing a live checkout

Run in a **fresh clone**, after restoring/adopting Beads as described below.
Do not apply these branch-creation instructions to an occupied worktree or dirty
clone. First inspect `git status`, `git worktree list`, and `bd context --json`.
The root must already resolve to the adopted database, not a newly initialized DB.

```sh
git fetch origin feature/projection-live-inline-olwl2
git merge-base --is-ancestor e73d27d637f02f683f135a9057cbddccff5f2006 \
  origin/feature/projection-live-inline-olwl2
git branch --track feature/projection-live-inline-olwl2 \
  origin/feature/projection-live-inline-olwl2
ls -ld .
mkdir -p worktrees
bd worktree create worktrees/projection-live-inline-olwl2 \
  --branch feature/projection-live-inline-olwl2
```

Stop on any error; never force/reset an existing branch to make this work.
Enter the returned worktree separately and run `bd context --json`. Require the
same adopted authority/project ID and `is_worktree=true`, `is_redirected=true`;
repair wiring before writing if not. Inspect the fetched documentation commit
against the final delivery SHA, rather than assuming the branch still ends at e73.

Portable checkpoint verification (Python 3 and Git; no old-host manifest needed):

```sh
python3 - <<'PY'
import hashlib, subprocess
def git(*args):
    return subprocess.check_output(["git", *args]).decode().strip()
sha = "e73d27d637f02f683f135a9057cbddccff5f2006"
assert git("rev-parse", sha + "^{tree}") == "98dda28497c789f97f2fe58fda859c38c93f5021"
assert git("rev-parse", sha + "^") == "6d2fbc37d0a06d528436e2f41a05dfd8fe767d4b"
entries = git("diff-tree", "--no-commit-id", "--name-status", "-r", sha).splitlines()
assert len(entries) == 234
assert sum(row.startswith("A\t") for row in entries) == 229
assert sum(row.startswith("M\t") for row in entries) == 5
paths = sorted([row.split("\t", 1)[1] for row in entries] + ["tsup.config.base.ts"])
rows = []
for path in paths:
    mode, kind, blob = git("ls-tree", sha, "--", path).split("\t", 1)[0].split()
    assert (mode, kind) == ("100644", "blob")
    rows.append(blob + "  " + path + "\n")
assert git("rev-parse", sha + ":tsup.config.base.ts") == "632725cf846b6ea89f9b7af135dbe7b9470ac5ed"
digest = hashlib.sha256("".join(rows).encode()).hexdigest()
assert digest == "e76b772694a3d7b93ef149b471ce3d5a95d3452f417e28d8e52253e53f21eb72"
print("PASS: checkpoint tree, inventory, modes and historical fingerprint", digest)
PY
```

This checks committed bytes. Separately require no source diff from the checkpoint
in the documentation delivery; only this handover file may be added.

## Beads: intended final snapshot, NOT yet published or verified

Permanent intended target (logically reserved, not a remote lock):

`refs/dolt/snapshots/20261012T093122Z-projection-handover-5002073e5b8b4f3a8facc07cbfbb5022`

At document preparation the exact remote lookup returned no match. Publication
and independent restore verification are to occur **after the documentation
commit and all Beads lifecycle notes**, with writers paused. Builder/Janitor must
recheck absence before upload and stop if occupied. Capture a consistent complete
native backup, qualify relations/schemas/content/roots/refs and privacy, upload
once to this exact ref, then obtain Auditor's independent restore/equality check.
Do not substitute an older helper's generated ref name or rewrite this target.

The final handover message must record the actual verified snapshot Git SHA,
capture cutoff, HEAD/WORKING/STAGED/native roots and full-manifest equality result,
plus source/document commit SHAs. This document does **not** assert that final
publication, verification or off-host completion has happened. Ref existence
alone, or `fsck` alone, is not that audit. If the ref is absent, STOP.

```sh
git ls-remote --exit-code https://github.com/surikaterna/redemeine.git \
  refs/dolt/snapshots/20261012T093122Z-projection-handover-5002073e5b8b4f3a8facc07cbfbb5022
```

### Full inline native restore

Prerequisites: **official Linux Dolt 2.3.5 binary at an absolute path**, Git on
`/usr/bin:/bin`, network and CA trust for public GitHub. Set `D` below to that
binary, **not a mise wrapper** needing inherited environment. No credentials,
existing database, SQL server or Beads installation are required for this public
restore. The temporary directory below is newly created on the destination;
there is no dependency on any old-host `/tmp` file or external helper script.

```sh
set -eu
D=/absolute/path/to/dolt-2.3.5
REF=refs/dolt/snapshots/20261012T093122Z-projection-handover-5002073e5b8b4f3a8facc07cbfbb5022
BASE=/tmp
case "$D" in /*) ;; *) exit 2 ;; esac
case "$REF" in refs/dolt/snapshots/*) ;; *) exit 2 ;; esac
git check-ref-format "$REF"
ls -ld "$BASE"
umask 077
RUN=$(mktemp -d "$BASE/projection-handover-restore.XXXXXXXX")
printf 'Private restore run: %s\n' "$RUN"
mkdir -p "$RUN/home/.config" "$RUN/cache" "$RUN/tmp" \
  "$RUN/dolt-root" "$RUN/databases/cache_context"
env -i PATH=/usr/bin:/bin LC_ALL=C \
  HOME="$RUN/home" XDG_CONFIG_HOME="$RUN/home/.config" \
  XDG_CACHE_HOME="$RUN/cache" TMPDIR="$RUN/tmp" \
  DOLT_ROOT_PATH="$RUN/dolt-root" DOLT_REMOTE_INFO_BRANCH='' \
  GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
  D="$D" REF="$REF" RUN="$RUN" /bin/sh -eu -c '
    VERSION=$("$D" version)
    printf "%s\n" "$VERSION" | { IFS= read -r first; test "$first" = "dolt version 2.3.5"; }
    git ls-remote --exit-code https://github.com/surikaterna/redemeine.git "$REF"
    "$D" config --global --add user.name "Restore verification"
    "$D" config --global --add user.email restore-verification@example.invalid
    "$D" -C "$RUN/databases/cache_context" init \
      --name "Restore verification" --email restore-verification@example.invalid
    "$D" --data-dir "$RUN/databases" --use-db cache_context \
      backup --ref "$REF" restore \
      git+https://github.com/surikaterna/redemeine.git verify-full
    "$D" -C "$RUN/databases/verify-full" fsck
  ' || exit "$?"
RESTORED_DB="$RUN/databases/verify-full"
printf 'RESTORED_DB=%s\n' "$RESTORED_DB"
```

Private `HOME`, `DOLT_ROOT_PATH`, XDG config/cache and temporary paths plus `env -i`
exclude inherited secrets. Identity configuration affects only the private Dolt
config (`$RUN/dolt-root/.dolt/config_global.json`), not the user's Git config.
The empty **plain Dolt** `cache_context` supplies 2.3.5's required `git_cache_root`;
it is not a Beads authority. Do not run `bd init` there. Retain failed runs and use
a fresh private target for retries; never restore over a live database.

Compare every captured relation, schema, typed content/count, ref and working
root with the final capture manifest. Native `backup --ref ... restore` preserves
ignored WORKING data; ordinary clone/default pull does not provide this recovery.
Then have the operator explicitly adopt the verified restored database into the
new host's persistent shared Beads location, configure a legitimate SQL server,
access/auth and repository redirects, and verify `bd context --json` and existing
issue records before enabling writers. Backups have empty remotes and do not
supply server/auth configuration. Do not blindly copy/source old credentials,
start a competing empty authority, or assume the old port/path is valid here.

### Provenance, fallback and remote traps

- Old-host authority: `/srv/redemeine-beads`, project
  `05b5b8a8-a657-4020-a84c-323da86ad773`, SQL `127.0.0.1:45965`.
  Live Dolt was 1.86; staged official 2.3.5 was used privately for backup, **not**
  a live upgrade. Full capture includes 26 tables/relations; ordinary clone's
  20-table result is insufficient.
- Normal `bd dolt push` still targets host-local
  `file:///srv/redemeine-dolt-remote`; it is not GitHub/off-host delivery.
- Default GitHub `refs/dolt/data` is the divergent September 24 state
  `9039e7afba18d7f17bfa980f61b8cdbc4219fe79`, with six remote-only commits.
  Snapshots preserve both histories; they do not reconcile them. Do not default-pull
  it as recovery or force-replace either history.
- Previously **verified fallback**, explicitly predating projection delivery:
  `refs/dolt/snapshots/20261012T085907Z-84fav1kqfl34-f4692912fba94d9f9c6277e23569c740`.
  Git SHA `fa132872e67ac0136e98ce42ef057600a5295495`; cutoff
  `2026-10-12T08:50:35.033943Z`; 26 relations, 567 issues, 354 comments,
  1,147 dependencies, 3,763 events. These are **fallback** counts, not promises
  about the future snapshot. For explicit fallback recovery use the same inline
  recipe with only `REF` changed; retain its stale-state warning.
- Backup delivery `.4` remains closed; parent `redemeine-z540` remains ongoing.
  Use existing issues; no new issue is needed for this preservation handover.

## Active GitHub work (read-only rechecked 2026-10-12)

| PR | Branch → base | Head | State / evidence |
| --- | --- | --- | --- |
| [R136](https://github.com/surikaterna/redemeine/pull/136) | `feature/interop-event-policy-ov0e5` → `main` | `dc6fca276bb5a9b59a6795053720485df4a7b2e0` | Open; ordinary CI passed |
| [R138](https://github.com/surikaterna/redemeine/pull/138) | `feature/standalone-interop-ov0e6` → `feature/interop-event-policy-ov0e5` | `f0489c2d1b22fef0554867dd188e67f1112ba407` | Draft; ordinary CI [38168898431](https://github.com/surikaterna/redemeine/actions/runs/38168898431) passed; custom legacy gate blocked |
| [R137](https://github.com/surikaterna/redemeine/pull/137) | `feature/mirage-event-version-ov0e7` → `main` | `4744e8d9266faccdc83c16776f57514e46fe4182` | Open; ordinary CI passed |
| [C4904](https://github.com/surikaterna/lynx3/pull/4904) | `feat/payment_attempt-redemeine` → `develop` | `ea405df9ba9978675a9ce4adf3319d917c77f1e9` | Draft; dependency CI blocked on unpublished interop `1.0.0-pre.2` |

PR state is time-sensitive; re-query GitHub before acting. None authorizes merge.

### Interop / consumer constraints and evidence

`redemeine-ov0e.6`: native Promise only; no direct `bluebird` or `@types/bluebird`
in runtime, tests or generated qualification fixtures. Legitimate legacy
transitives are not a reason to restore direct dependencies. Historical evidence:
150 native tests, own strict minimal types/browser gates passed, ordinary CI green.
Combined legacy runner exits 2: TS7016 in `demeine/lib/repository/Partition.interfaces.d.ts` for missing
Bluebird types; Demeine-only baseline is identical. Existing `redemeine-p169`
tracks legitimate upstream resolution. No shim, forbidden test dependency,
`skipLibCheck`, or dropped gate to manufacture green qualification.

Consumer: 38 native tests and normal types/build passed. Actual integration's full
strict check has **10 baseline errors, zero new**, not the older nine-error count.
Unpublished `.6` artifact SHA-256:
`719181c2c7fe508eaf79de5253fe110a3cf62a6e26650ff58154ca41e1234cac`.
Original temporary receipts are not portable. Maintained qualification helpers
are in Git; an authorized rebuild must record its new hash and gates, not assume
the old bytes/hash. Effective tooling was R Node 24.20 / pnpm 11.9, release npm
11.21; C Node 26.10 / npm 10.9 / TypeScript 7.0.2, including effective Nest tooling.

User goal: no direct Demeine in C. Generated bridge constructor is
`new(sink, eventHandler, commandHandler)`; defaults apply only when overrides are
absent, never as after-error fallback. Authored PaymentAttempt constructor stays
**sink-only**, with its four original methods/defaults. Preserve original author
commit `768c7979299e0c138d56b3e65f3b0feac63ea25e`, state, envelope, aggregate,
validators, projectors and generated metadata. Envelope callback is transport
metadata, not a handler to remove. CLI-generated Zod/JSON schema metadata does
not activate runtime validation. No Mirage behind the bridge or new production
reflection bootstrap. `redemeine-zdl1` retains registry-lock/private-job-queue/full
CI follow-up; author PR source is unpublished. No fake lock integrity/local paths.

`redemeine-ov0e.7`: historical Mirage 87 tests. Version increments per event;
zero events do not increment. Replay plus `initialVersion` establishes baseline
before the tail; Depot PRE-append OCC, safe-integer guards and prefix counts stay.
Old command-count versions need authoritative history or a verified baseline,
not automatic conversion. Concurrent dispatch/save is deferred to `redemeine-98zi`.
Last registry verification (October 8): kernel/aggregate `0.2.0-pre.2`, Mirage
`1.0.0-pre.2`, CLI `0.2.0-pre.1`, interop `0.1.0-pre.1` published; `.4` closed.
Standalone `1.0.0-pre.2` / Mirage `1.0.0-pre.3` remain pending. Derive fresh actual
Changesets versions and registry state; previous authorization is not a new release.

## Projection contract, limits and next review

Private `projection-service` `0.1.0`: single-node live Rabbit commits on
`rdm.projection.commits` → authoritative Mongo verification / bounded gaps →
definitions → Mongo per-document dedupe → ACK only after all obligations finish.
Automatic new sources, no fixed inventory or inactive-source polling. Startup is
a live-floor suffix, not historical backfill. The external publisher owns
checkpoints; expiry is best-effort / historical completeness unknown. Inline
`in_document` dedupe is default; `own_record` requires explicit selection.
Trusted self-contained ESM definition bundles use `PROJECTION_DEFINITIONS_MODULE`;
no production ModelCounter fallback. Local `flock`, non-root container, guarded
unclean restart with manual reconciliation; no HA claim.

Read `docs/architecture/projection-live-inline-runtime.md`,
`projection-runtime-image.md`, `projection-external-stack.md`,
`projection-reference-host.md` in the same directory, and
`docs/releases/projection-runtime.md`, alongside the latest hpq1 parent audit.
Historical evidence only: **659 service tests / 52 suites**, packaging/offline
checks and two configuration smokes; external **8 verified / 1 unqualified**.
Ten-run budget is exhausted. Actual main worker positive processing was **not
qualified**. The tested image was built then removed, not published; raw receipts
are missing. No functional tests were rerun for this source/document preservation.

Current-main integration still needs review: checkpoint
`.github/tests/projection-image-metadata.test.mjs` pins deleted `.github/workflows/publish.yml`;
docs' automatic npm-release claims differ from current explicit `release.yml`.
Reconcile lock/versions only **after** review. Do not restore the old publisher
just to pass a stale test. Existing image workflow is release/manual only, not
feature-push publication. No image PR/tag/publication/deployment is authorized.
hpq1/olwl parents remain ongoing; source preservation is not candidate signoff.

Auditor should verify docs-only scope, unchanged source bytes/modes/fingerprint,
the inline restore recipe and honest pending-snapshot wording. Diplomat then
handles the separate doc commit/push; finalize Beads notes before the later quiet
snapshot capture. No publishable surface changes here: no changeset is required.
