# CI Hardening Wave 1 Blueprint: GitHub Actions Least Privilege & SHA Pinning

- **Bead**: `redemeine-1uh.4`
- **Owner Stage**: Architect
- **Scope**: Policy + rollout design only (no workflow implementation in this bead)
- **Non-goals**: Dependency automation (wave 2), branch protection/release integrity enforcement (wave 3)

## 1. Problem Statement

Current workflows include broad write permissions in at least one PR-triggered workflow and use mutable version tags for third-party actions (`@v4`, `@v2`, etc.). This creates two avoidable risks:

1. **Over-privileged `GITHUB_TOKEN`** can be abused if any action step is compromised.
2. **Mutable action refs** can change over time without explicit repository review.

Wave 1 introduces a constrained trust + enforcement model to reduce blast radius while preserving delivery speed.

## 2. Wave 1 Policy (Normative)

The following requirements are mandatory for all workflows in `.github/workflows` after wave 1 rollout.

### 2.1 Token Permissions (Least Privilege)

1. Every workflow **MUST** define top-level `permissions`.
2. Workflow-level `permissions` **MUST** be set to the minimum common baseline for all jobs, preferring:
   - `contents: read` for most read-only CI jobs, or
   - `{}` when checkout/repository read is not required.
3. Job-level `permissions` **MUST** be used to elevate only specific jobs requiring write scopes.
4. Write scopes (`*: write`) are **DENY by default** and require explicit rationale in workflow comments and PR description.
5. Pull request validation workflows **MUST NOT** request repository write scopes unless they intentionally mutate PR branches and are allowlisted (see trust exceptions).

### 2.2 Action Reference Immutability

1. All `uses:` references to third-party actions **MUST** pin to a full 40-character commit SHA.
2. Each SHA-pinned action **MUST** include a trailing comment indicating the upstream semver tag used for readability (example: `# v4.2.2`).
3. Local actions (`uses: ./.github/actions/...`) are exempt from SHA pinning.
4. Docker image actions **SHOULD** be digest-pinned (`@sha256:...`) where used (none currently in scope).

### 2.3 Approved Trust Exceptions

Wave 1 supports a narrowly-scoped exception model.

Allowed without additional approval:

- Official GitHub-authored actions under `actions/*` may remain tag-pinned (`@vN`) **only during transition**, but target state is still SHA pinning.
- First-party reusable workflows within this repository.

Requires explicit security exception entry:

- Any non-SHA-pinned third-party action after migration date.
- Any PR workflow requesting write permissions (`contents: write`, `pull-requests: write`, etc.).
- Any use of `pull_request_target` with write scopes.

Exception record fields (kept in policy file introduced in wave 1 implementation bead):

- workflow path
- job id
- scope/ref exception requested
- business reason
- expiry date (required, max 30 days)
- approver

Expired exceptions automatically fail enforcement.

## 3. Target Permission Matrix (Current Workflows)

This matrix defines intended post-wave-1 permissions for existing workflows.

| Workflow | Trigger | Current Risk | Target Workflow Permissions | Job-level Elevation | Notes |
|---|---|---|---|---|---|
| `testing-benchmark.yml` | `pull_request` | Mutable action refs | `contents: read` | none | Pure read-only benchmark job |
| `publish.yml` | `release` | Mutable refs | `contents: read` | `id-token: write` for publish job | OIDC provenance requires id-token write |
| `deploy-docs.yml` | `push main` | Mutable refs | `contents: read` | `pages: write`, `id-token: write` for deploy job | Keep write only for Pages deployment |
| `documentation-audit.yml` | `pull_request` | Broad write on PR + mutable refs | baseline `contents: read` | temporary exception if auto-commit remains; otherwise none | Prefer redesign to artifact/check mode in wave 2+ |

## 4. Maintenance & Update Model for SHA Pins

### 4.1 Update Cadence

- **Weekly** automated proposal PR (Dependabot/Renovate in wave 2) for action SHA bumps.
- **Out-of-band** patching within 24h for critical GHSA/CVE affecting an action dependency.

### 4.2 Update Process

1. Bot or maintainer opens PR updating SHAs and tag comments.
2. Validation job confirms all refs are immutable and no unauthorized permission expansion occurred.
3. CODEOWNERS/security reviewer approves if write scope or exception touched.
4. Merge once required checks pass.

### 4.3 Rollback Strategy

- Revert SHA bump commit(s) if regressions appear.
- If urgent, temporarily allowlisted exception with expiry <= 7 days.

## 5. Enforcement Checks (Auditor Pass/Fail Contract)

Wave 1 defines policy checks with deterministic outcomes.

### Check A: Action Pinning Compliance

**Pass when all are true:**

- Every external `uses:` in `.github/workflows/*.yml` is either:
  - full commit SHA pinned (`@` + 40 hex), or
  - explicitly listed in active exception allowlist.

**Fail when any are true:**

- Any external action uses mutable tag/branch ref not allowlisted.
- Any exception is expired or missing required metadata.

### Check B: Permission Baseline Compliance

**Pass when all are true:**

- Every workflow defines top-level `permissions`.
- No job grants write permission unless required by matrix/exception.
- PR-triggered workflows have no write scopes unless active exception exists.

**Fail when any are true:**

- Missing top-level `permissions`.
- Unjustified write scope added in workflow or job.
- PR workflow contains write scope without valid exception.

### Check C: Privilege Regression Guard

**Pass when all are true:**

- PR does not increase permission scope compared to main branch baseline, unless PR includes approved exception update.

**Fail when any are true:**

- Scope expansion is detected without linked/approved exception artifact.

## 6. Wave 1 Rollout Plan (Bounded)

1. **Document policy + matrix** (this bead).
2. **Implement enforcement in monitor mode** (non-blocking check for 1 week):
   - emit violations in job summary.
3. **Migrate workflows to policy target**:
   - convert refs to SHAs,
   - reduce top-level permissions,
   - move write scopes to minimal job scope.
4. **Enable blocking mode** for checks A+B; keep check C monitor-only for one additional week.
5. **Promote check C to blocking** once baseline stabilized.

## 7. Risks & Assumptions

### Assumptions

- Repository maintainers accept temporary exception handling for `documentation-audit.yml` PR writes.
- Upcoming wave 2 introduces automation for SHA refresh to avoid manual drift.

### Risks

- SHA pinning without update automation can cause stale dependencies.
- Tightening PR write permissions may require redesign of auto-commit behavior.

### Mitigations

- Time-box exceptions with expiry and explicit owner.
- Treat permission escalation as security-significant change requiring review.

## 8. Handoff to Engineer/Auditor

Implementation bead(s) should include:

1. Policy artifact file(s) for exceptions and baseline matrix.
2. CI check script/workflow that enforces Checks A/B/C.
3. Migration commits per workflow with rationale.

Auditor verifies using section 5 pass/fail contract and records evidence per workflow file.
