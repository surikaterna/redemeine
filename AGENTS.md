## Git branch structure
We use git flow with feature/* for all feature / tasks 

## Chain of Command

Flow:

Builder (Lead/Orchestrate) -> Architect (Plan) -> Engineer (Build) -> Auditor (Test) -> Diplomat (Deploy)

Supporting role:

Explorer (Research/Discovery) supports Builder and Architect with fast codebase investigation and evidence-backed handoff notes.

Explorer usage policy (conditional, not default):

- Use Explorer only when discovery is the bottleneck.
- Do not invoke Explorer by default for every build task.
- Invoke Explorer only if one or more are true:
  - Target files/owners are unclear after quick direct search.
  - The change likely spans multiple packages/domains.
  - Risk/dependency mapping is needed before implementation.
- If Architect already has high-confidence file targets and dependencies, skip Explorer.
- Engineer should not repeat broad discovery; only do minimal gap-filling searches required to implement.

Protocol:

- The Bead ID is the source of truth at every hand-off.
- Every stage transition must update the same Bead ID in bd before work is passed onward.
- Builder decomposes user requests, verifies team composition, and delegates each step to the correct subagent(s).
- Required hand-off statuses:
  - Engineer sets `implemented` when coding is complete and ready for audit.
  - Auditor sets `verified` on pass or `changes_requested` on fail.
  - Diplomat sets `in_review` for PR workflow, then closes the Bead on merge/deploy.
- Handoff artifacts must include the Bead ID in notes, PR descriptions, and release communication.

## Issue Tracking with bd (beads)

Run git fetch origin main to get latest from remote Create worktree for new feature: git worktree add worktrees/descriptive-name -b feature/descriptive-name Change to the new worktree: cd worktrees/descriptive-name Run mise trust && mise install to make tools available Run bun install to set up dependencies ONLY THEN start making changes in the isolated worktree Always use turbo to run tasks. Always use Bun instead of node or npm. PR titles must follow conventional commits Worktree Structure brownsauce/ <- Repo root (main branch checkout) ├── .beads/ <- Shared issue database ├── .git/ <- Git directory ├── worktrees/ <- All feature worktrees go here │ ├── feature-name-1/ <- Feature worktree │ └── feature-name-2/ <- Another feature worktree ├── packages/ <- Source code └── ... Worktree Benefits Each feature branch gets its own isolated working directory Never risk contaminating main branch with uncommitted changes Can work on multiple features simultaneously in parallel worktrees Clean separation between repo root and feature development Shared .beads/ database discoverable from all worktrees Before Starting Work ALWAYS use /start command to create proper worktree setup Choose a short worktree name based on the work description (worktrees live in worktrees/ subdirectory) NEVER work directly in repo root for feature development - always use a worktree Verify you're in correct worktree with pwd and git branch Each worktree is a complete working copy with its own node_modules and mise config Beads (bd) Issue Tracking We track work in Beads (bd) instead of Markdown. Beads is a lightweight, git-based issue tracker designed for AI coding agents with dependency-aware task management.

Critical Setup Notes ALWAYS use bd CLI commands via Bash tool - NEVER use MCP beads tools Daemon is disabled (BEADS_NO_DAEMON=1) for worktree safety - MCP won't work bd auto-discovers the shared .beads/ database from any worktree by walking up the tree The .beads/ directory lives at the repo root and is shared across all feature worktrees Works from repo root or any feature worktree - bd walks up to find the database The "Let's Continue" Protocol Start of every session:

Check for abandoned work: bd list --status in_progress If none, get ready work: bd ready --limit 5 Show top priority issue: bd show hp-X When user says "Let's continue", run these commands to resume work.

**IMPORTANT**: This project uses **bd (beads)** for ALL issue tracking. Do NOT use markdown TODOs, task lists, or other tracking methods.

### Why bd?

- Dependency-aware: Track blockers and relationships between issues
- Git-friendly: Dolt-powered version control with native sync
- Agent-optimized: JSON output, ready work detection, discovered-from links
- Prevents duplicate tracking systems and confusion

### Quick Start

**Check for ready work:**

```bash
bd ready --json
```

**Create new issues:**

```bash
bd create "Issue title" --description="Detailed context" -t bug|feature|task -p 0-4 --json
bd create "Issue title" --description="What this issue is about" -p 1 --deps discovered-from:bd-123 --json
```

**Claim and update:**

```bash
bd update <id> --claim --json
bd update bd-42 --priority 1 --json
```

**Complete work:**

```bash
bd close bd-42 --reason "Completed" --json
```

### Issue Types

- `bug` - Something broken
- `feature` - New functionality
- `task` - Work item (tests, docs, refactoring)
- `epic` - Large feature with subtasks
- `chore` - Maintenance (dependencies, tooling)

### Priorities

- `0` - Critical (security, data loss, broken builds)
- `1` - High (major features, important bugs)
- `2` - Medium (default, nice-to-have)
- `3` - Low (polish, optimization)
- `4` - Backlog (future ideas)

### Workflow for AI Agents

1. **Check ready work**: `bd ready` shows unblocked issues
2. **Claim your task atomically**: `bd update <id> --claim`
3. **Work on it**: Implement, test, document
4. **Discover new work?** Create linked issue:
   - `bd create "Found bug" --description="Details about what was found" -p 1 --deps discovered-from:<parent-id>`
5. **Complete**: `bd close <id> --reason "Done"`

### Quality
- Use `--acceptance` and `--design` fields when creating issues
- Use `--validate` to check description completeness

### Lifecycle
- `bd defer <id>` / `bd supersede <id>` for issue management
- `bd stale` / `bd orphans` / `bd lint` for hygiene
- `bd human <id>` to flag for human decisions
- `bd formula list` / `bd mol pour <name>` for structured workflows

### Auto-Sync

bd automatically syncs via Dolt:

- Each write auto-commits to Dolt history
- Use `bd dolt push`/`bd dolt pull` for remote sync
- No manual export/import needed!

### Important Rules

- ✅ Use bd for ALL task tracking
- ✅ Always use `--json` flag for programmatic use
- ✅ Link discovered work with `discovered-from` dependencies
- ✅ Check `bd ready` before asking "what should I work on?"
- ❌ Do NOT create markdown TODO lists
- ❌ Do NOT use external issue trackers
- ❌ Do NOT duplicate tracking systems

For more details, see README.md and docs/QUICKSTART.md.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

<!-- END BEADS INTEGRATION -->


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```ps
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
