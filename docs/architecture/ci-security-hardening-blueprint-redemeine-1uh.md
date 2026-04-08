# CI/Security Hardening Blueprint (Parent) - redemeine-1uh

## Scope and intent

This document is the consolidated Architect blueprint for **redemeine-1uh** (planning only, no workflow/policy implementation).

It aligns the already-planned/verified wave artifacts (**redemeine-1uh.1**, **redemeine-1uh.4**) with planned follow-up waves (**redemeine-1uh.2**, **redemeine-1uh.3**, **redemeine-1uh.5**) into a single repo-level execution contract.

## Inputs and baseline

Current repository workflows observed:

- `.github/workflows/documentation-audit.yml`
- `.github/workflows/testing-benchmark.yml`
- `.github/workflows/deploy-docs.yml`
- `.github/workflows/publish.yml`

Current characteristics relevant to hardening:

- PR checks are fragmented and path-filtered in places (risk: required-check deadlocks if skipped).
- Third-party actions are version-tag pinned (`@v*`) rather than immutable SHA pinned.
- Workflow permissions vary, with at least one workflow requesting write on PRs.
- Release publish already uses npm provenance (`--provenance`) and `id-token: write`.

## Consolidated wave plan (dependency-aware)

| Wave | Bead | Objective | Dependency contract |
|---|---|---|---|
| Wave 1A | redemeine-1uh.1 | Universal required PR gate with stable required check name | Foundation for branch protection and later security gates |
| Wave 1B | redemeine-1uh.4 | Least-privilege `permissions` + action SHA pinning policy/enforcement | Foundation for all downstream CI/security work |
| Wave 2A | redemeine-1uh.2 | Dependency automation + vulnerability scanning strategy | Blocked by 1A and 1B |
| Wave 2B | redemeine-1uh.3 | `SECURITY.md` + `CODEOWNERS` governance model | Blocked by 1B |
| Wave 3 | redemeine-1uh.5 | Branch protection enforcement + release integrity (attestation/SBOM controls) | Blocked by 1A, 1B, 2A, 2B |

## Workflow/files blueprint (add/update matrix)

### A) Files to add

1. **`.github/workflows/ci-required-pr-gate.yml`** (Wave 1A / redemeine-1uh.1)
   - Trigger: `pull_request` (main/master) + `merge_group`.
   - Policy: no path filters on required gate.
   - Stable required check: `ci-required-gate` (single aggregator result).

2. **`.github/dependabot.yml`** (Wave 2A / redemeine-1uh.2)
   - npm/bun ecosystem update cadence and grouping strategy.
   - GitHub Actions update coverage.

3. **`.github/workflows/dependency-vulnerability-scan.yml`** (Wave 2A / redemeine-1uh.2)
   - Scheduled + PR/manual scan flow.
   - Severity threshold and failure policy defined by wave-2 design.

4. **`SECURITY.md`** (Wave 2B / redemeine-1uh.3)
   - Reporting channel, SLA expectations, supported versions, disclosure process.

5. **`.github/CODEOWNERS`** (Wave 2B / redemeine-1uh.3)
   - Explicit owners for `.github/workflows/**`, release files, package manifests, runtime core.

6. **`.github/workflows/release-integrity.yml`** *(optional separate workflow; may be merged into publish workflow during implementation)* (Wave 3 / redemeine-1uh.5)
   - Attestation/SBOM generation, verification, and evidence retention touchpoints.

### B) Files to update

1. **`.github/workflows/documentation-audit.yml`**
   - Minimize default permissions and job-level grants.
   - Pin third-party actions to full SHA.
   - Re-evaluate write-on-PR behavior and constrain to least privilege.

2. **`.github/workflows/testing-benchmark.yml`**
   - Pin actions to SHA.
   - Keep non-blocking benchmark semantics (informational).

3. **`.github/workflows/deploy-docs.yml`**
   - Pin actions to SHA.
   - Keep only required permissions (`pages: write`, `id-token: write`, minimal contents scope).

4. **`.github/workflows/publish.yml`**
   - Pin actions to SHA.
   - Preserve release provenance path; integrate with wave-3 integrity evidence strategy.

## Branch protection recommendations (target state for Wave 3)

Apply to `main` (and `master` if still active):

1. Require pull request before merge.
2. Require approvals (minimum 1; increase to 2 for protected paths if org policy allows).
3. Require CODEOWNERS review.
4. Require status checks to pass before merge, with stable required checks:
   - `ci-required-gate` (mandatory)
   - Add wave-2 security scan check(s) once signal/noise baseline is stable.
5. Require branches to be up to date before merging (or merge queue + `merge_group` required gate).
6. Restrict force pushes and branch deletion.
7. Optional (recommended): require signed commits/tags for release-critical branches.

## Validation criteria (auditable)

### Parent acceptance mapping

Parent bead acceptance: **"Concrete blueprint with workflow files to add/update, branch protection recommendations, and validation criteria."**

- **AC-1 (Workflow inventory):** This blueprint names concrete files to add/update under `.github/workflows` plus governance files (`SECURITY.md`, `CODEOWNERS`, `dependabot.yml`).
- **AC-2 (Branch protection):** This blueprint defines explicit required-rule recommendations and required-check naming contract (`ci-required-gate`).
- **AC-3 (Validation):** This blueprint defines wave-gated auditable validation points (below).
- **AC-4 (Alignment):** This blueprint explicitly maps to redemeine-1uh.1/.4 and planned .2/.3/.5 dependency order.

### Wave-gated validation points

1. **Wave 1A validated** when a PR to main/master always emits `ci-required-gate` regardless of changed paths and does not deadlock required checks.
2. **Wave 1B validated** when all targeted workflows use least-privilege permissions and third-party actions are SHA pinned (with documented exceptions).
3. **Wave 2A validated** when dependency update automation and vulnerability scan checks run on defined cadence with documented severity/SLA handling.
4. **Wave 2B validated** when `SECURITY.md` and `CODEOWNERS` exist with required sections/path ownership and are integrated into review policy.
5. **Wave 3 validated** when branch protection settings are enforced and release integrity evidence (attestation/SBOM/provenance path) is retained per policy.

## Risks and rollout guardrails

- **Deadlock risk:** Avoid required checks tied to path-filtered workflows.
- **Noise risk:** Start vulnerability gates in monitor mode if needed; promote to blocking after baseline.
- **Delivery friction risk:** Phase branch protection tightening after stable check naming and ownership coverage.
- **Maintenance risk:** SHA pinning requires explicit update process (handled by wave 2 automation strategy).

## Handoff contract

- This parent blueprint is architecture-ready and dependency-aligned for Engineer/Auditor execution across child beads.
- Implementation remains in child beads only; this parent bead remains a consolidated design reference.
