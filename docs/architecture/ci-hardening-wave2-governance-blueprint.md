# CI Hardening Wave 2 Governance Blueprint (redemeine-1uh.3)

## Scope and Intent

This blueprint defines governance design for:

1. `SECURITY.md` policy content and maintenance contract.
2. `CODEOWNERS` ownership coverage for high-risk repository paths.
3. Branch-protection/ruleset integration so code owner review is enforced where risk is highest.

This is a planning artifact only. No enforcement implementation is included in this bead.

## Target File Paths

- `SECURITY.md` (repository root)
- `.github/CODEOWNERS` (authoritative location for GitHub)

### Path policy

- Keep a single authoritative CODEOWNERS file under `.github/CODEOWNERS`.
- If a root-level `CODEOWNERS` ever exists, it must be removed to avoid ambiguity.

## SECURITY.md Blueprint

## Required Sections

1. **Security Policy Overview**
   - Purpose and scope (what projects/packages are covered).
2. **Supported Versions**
   - Table listing maintained release lines and support status.
3. **How to Report a Vulnerability**
   - Private reporting channel (security email or GH private advisory path).
   - Explicit instruction to avoid public issues for suspected vulnerabilities.
4. **What to Include in Reports**
   - Affected version/commit, reproduction steps, impact hypothesis, proof-of-concept guidance.
5. **Response Expectations and SLA**
   - Acknowledgement target (e.g., 2 business days).
   - Triage target (e.g., 5 business days).
   - Status update cadence (e.g., weekly until resolution).
6. **Disclosure and Fix Process**
   - Coordinated disclosure model, embargo handling, release + advisory publication flow.
7. **Severity and Prioritization**
   - CVSS-informed severity banding and patch priority expectations.
8. **Safe Harbor / Good-Faith Research**
   - Statement protecting good-faith disclosure within policy boundaries.
9. **Security Updates and Credits**
   - Where advisories/changelog notes appear and how researchers are credited.

## SECURITY.md Content Requirements

- Must reference maintained branch/version policy used by release process.
- Must define who can receive reports when primary contact is unavailable.
- Must define communication fallback if email is unavailable.
- Must avoid promising timelines that cannot be staffed.

## CODEOWNERS Blueprint

## Ownership Model

Use team-based owners (preferred) plus individual fallback owners per critical area.

### Proposed owner groups (to provision/confirm)

- `@redemeine/core-maintainers` (runtime/package maintainers)
- `@redemeine/platform-security` (security + CI governance)
- `@redemeine/docs-maintainers` (documentation maintainers)
- Fallback individuals: at least two maintainers with admin/review access (to avoid single-point reviewer bottlenecks)

## Required CODEOWNERS Entries (minimum)

```text
# Global fallback
* @redemeine/core-maintainers

# Security policy itself
/SECURITY.md @redemeine/platform-security @redemeine/core-maintainers

# CI/workflow governance (high risk)
/.github/workflows/* @redemeine/platform-security @redemeine/core-maintainers
/.github/CODEOWNERS @redemeine/platform-security @redemeine/core-maintainers

# Release/publish pipeline controls (high risk)
/bin/* @redemeine/platform-security @redemeine/core-maintainers
/package.json @redemeine/core-maintainers @redemeine/platform-security
/bun.lock @redemeine/core-maintainers @redemeine/platform-security
/package-lock.json @redemeine/core-maintainers @redemeine/platform-security

# Runtime and packages
/src/** @redemeine/core-maintainers
/packages/aggregate/** @redemeine/core-maintainers
/packages/kernel/** @redemeine/core-maintainers
/packages/mirage/** @redemeine/core-maintainers
/packages/projection/** @redemeine/core-maintainers
/packages/saga/** @redemeine/core-maintainers
/packages/saga-runtime/** @redemeine/core-maintainers
/packages/testing/** @redemeine/core-maintainers
/packages/root-runner/** @redemeine/core-maintainers

# Documentation
/docs/** @redemeine/docs-maintainers @redemeine/core-maintainers
/website/** @redemeine/docs-maintainers @redemeine/core-maintainers
/README.md @redemeine/docs-maintainers @redemeine/core-maintainers
/CONTRIBUTING.md @redemeine/docs-maintainers @redemeine/core-maintainers
```

> If team handles are not yet available, temporary individual owners may be used, but must be replaced by team handles in the next governance maintenance cycle.

## Ownership Matrix by Directory/Risk

| Path scope | Risk level | Primary owners | Secondary/fallback | Rationale |
|---|---|---|---|---|
| `.github/workflows/*` | Critical | platform-security | core-maintainers | Prevent CI privilege or supply-chain drift |
| `bin/*`, `publish.yml`, manifests/locks | Critical | core-maintainers | platform-security | Release integrity and dependency trust |
| `SECURITY.md`, `.github/CODEOWNERS` | Critical | platform-security | core-maintainers | Governance controls must be tightly reviewed |
| `packages/**`, `src/**` | High | core-maintainers | platform-security (security-sensitive deltas) | Runtime integrity and API behavior |
| `docs/**`, `website/**`, top-level docs | Medium | docs-maintainers | core-maintainers | Documentation quality with technical correctness backstop |

## Review Load-Balancing Guidance

- Maintain at least 2 active reviewers per owner group.
- Rotate weekly primary reviewer for `platform-security` paths.
- Use fallback owners only when SLA would otherwise be missed.
- Reassess ownership quarterly (team membership and hot-path review volume).

## Branch Protection / Ruleset Integration Blueprint

## Required settings (main branch)

1. **Require pull request before merging**: enabled.
2. **Require approvals**:
   - Critical paths (workflow/release/security governance): minimum 2 approvals.
   - Other paths: minimum 1 approval.
3. **Require review from Code Owners**: enabled.
4. **Dismiss stale approvals on new commits**: enabled.
5. **Require conversation resolution before merge**: enabled.
6. **Require status checks to pass**: enabled, using stable check names defined in wave 1.
7. **Restrict force pushes/deletions**: enabled (admins exempt only if operationally required).

## Ruleset split recommendation

- **Ruleset A (global baseline)**: applies to `main` for all files.
- **Ruleset B (critical governance paths)**: applies to:
  - `.github/workflows/**`
  - `.github/CODEOWNERS`
  - `SECURITY.md`
  - `package.json`, `bun.lock`, `package-lock.json`
  - `bin/**`

Ruleset B enforces stricter approval count and mandatory code-owner review.

## Dependency and rollout alignment

- Depends on wave 1 CI hardening outputs (`redemeine-1uh.4`) for stable workflow/check naming.
- Must be completed before branch-protection hard enforcement wave (`redemeine-1uh.5`).
- Suggested rollout: monitor mode (1 sprint) -> enforce mode.

## Acceptance Mapping (for redemeine-1uh.3)

- **Target file paths defined**: `SECURITY.md`, `.github/CODEOWNERS`.
- **Required sections/entries defined**: SECURITY section checklist + minimum CODEOWNERS entries.
- **Ownership matrix by directory**: included with risk and fallback coverage.
- **Branch-protection integration**: explicit required settings + critical-path ruleset model.

## Assumptions and Risks

### Assumptions

- GitHub organization teams can be created/updated quickly.
- Branch protection/ruleset controls are available on the repository plan.
- At least two maintainers are available for fallback coverage.

### Risks

- Missing team provisioning can delay CODEOWNERS enforcement.
- Overly broad ownership may increase review latency.
- Tight rules without stable CI check names can block merges.

Mitigation: run monitor-first rollout and finalize check names in wave 1 before enforcement.
