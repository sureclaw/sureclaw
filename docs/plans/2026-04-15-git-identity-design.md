# Git-Based Identity & Skills Storage

**Date:** 2026-04-15
**Status:** Design complete, ready for implementation

## Overview

Move identity files and skills from database-backed storage (DocumentStore) to
**git-native storage** inside the agent's workspace repo. All identity files,
skills, and governance policies live under `.ax/` and are subject to the same
git workflow: write, stage, commit. Validation happens before commit — in
trusted host/sidecar code — ensuring unvalidated content never enters the LLM
context.

## Directory Layout

```
<workspace>/
  .ax/
    AGENTS.md                  # Company-wide agent instructions
    HEARTBEAT.md               # Recurring task instructions
    identity/
      SOUL.md                  # Core personality, values, behavioral patterns
      IDENTITY.md              # Factual self-description: name, role, capabilities
      BOOTSTRAP.md             # Initial instructions (shown when SOUL.md missing)
      USER_BOOTSTRAP.md        # Initial user discovery instructions
    policy/
      rules.yaml               # (Future) Governance rules
      overrides.yaml           # (Future) Per-file policy exceptions
    skills/
      <skill-name>.md          # Installed skills
```

- **USER.md is dropped** — no per-user state in identity.
- **Policy engine** — directory laid out now, implementation deferred.

## Write Flow

The agent writes files to `.ax/` using normal filesystem operations. It does
not interact with git directly — `.git/` is inaccessible in all sandbox modes.
The host or sidecar handles git operations and validates changes before
committing.

### Local Mode (Docker / Apple Container)

The host manages git externally via `GIT_DIR`/`GIT_WORK_TREE`. No pre-commit
hook is needed — the host validates inline before committing.

```
Agent writes .ax/identity/SOUL.md (file write)
  → Host detects .ax/ changes
  → Host runs: git diff --cached -- .ax/identity/ .ax/skills/ .ax/policy/ .ax/AGENTS.md .ax/HEARTBEAT.md
  → If diff is empty → normal commit, no validation needed
  → Host calls validateCommit(diff) directly (function call)
  → Pass → git commit
  → Fail → revert file, report error to agent
```

### K8s Mode

The git sidecar manages git. A pre-commit hook sends the scoped diff to the
host via HTTP IPC for validation.

```
Agent writes .ax/identity/SOUL.md (file write)
  → Sidecar detects .ax/ changes at commit time
  → Pre-commit hook runs: git diff --cached -- .ax/identity/ .ax/skills/ .ax/policy/ .ax/AGENTS.md .ax/HEARTBEAT.md
  → If diff is empty → exit 0, normal commit
  → Hook sends IPC: validate_commit { diff: "<scoped diff>" }
  → Host calls validateCommit(diff)
  → Pass → exit 0, commit succeeds
  → Fail → exit 1, commit rejected, sidecar reverts file
```

### Validation Logic (v1)

Same `validateCommit(diff)` function in both modes:

- **Content scanning:** Run `scanInput()` on new/modified content (injection
  patterns, prompt attacks)
- **Structural rules:** Only known filenames allowed under `.ax/identity/`,
  max file size (32KB for identity files, configurable for skills)
- **Audit logging:** Every validation (pass or fail) logged via audit provider

### Future Policy Engine

When implemented, `validateCommit()` reads `.ax/policy/rules.yaml` and applies:

- **File-level permissions:** ACLs per file/path (e.g., "AGENTS.md changes
  require admin approval")
- **Content-level rules:** Constraints on content (e.g., "no URLs in identity
  files", "skill files must contain a description field")
- `overrides.yaml` allows per-file exceptions to base rules
- Policy files are themselves governed by git — governance rules governed by git

## Read Flow

The host reads identity from committed git state. Only validated, committed
content enters the LLM prompt.

```
Host builds prompt:
  → git show HEAD:.ax/identity/SOUL.md
  → git show HEAD:.ax/identity/IDENTITY.md
  → git show HEAD:.ax/AGENTS.md
  → (etc.)
  → Assembles IdentityPayload (same shape as today)
  → Sends to agent via stdin payload (existing mechanism)
```

### What Changes

- `loadIdentityFromDB()` in `server-completions.ts` → `loadIdentityFromGit()`
- Uses `git show HEAD:<path>` for each identity file
- Same 65KB character cap per file
- Skills read from `git show HEAD:.ax/skills/<name>.md`

### What Doesn't Change

- `IdentityPayload` interface shape
- `IdentityModule` in `src/agent/prompt/modules/identity.ts`
- Bootstrap detection logic (SOUL.md missing → bootstrap mode)
- `IdentityFiles` type in `src/agent/prompt/types.ts`

## Security Model

### Agent Cannot Access .git/

In all sandbox modes, `.git/` is inaccessible to the agent:

| Mode | Mechanism |
|------|-----------|
| Docker | Host uses `--separate-git-dir` outside mounted workspace |
| Apple Container | Same as Docker |
| K8s | `.git` on separate volume (`gitdir`), only sidecar mounts it |

The agent can only write files. It cannot:
- Modify pre-commit hooks
- Run `git commit --no-verify`
- Manipulate `.gitattributes` diff filters
- Access or modify git metadata

### Validation Runs in Trusted Context

- **Local:** Host validates inline — same process that manages git
- **K8s:** Pre-commit hook runs in sidecar (trusted), calls host via IPC

No validation code runs inside the agent sandbox.

## What Gets Removed

### IPC Actions
- `identity_read` — agent reads files directly from `.ax/`
- `identity_write` — agent writes files, host/sidecar commits
- `user_write` — USER.md dropped entirely
- `company_identity_write` — AGENTS.md written via filesystem like everything else

### IPC Schemas (from `ipc-schemas.ts`)
- `IdentityReadSchema`
- `IdentityWriteSchema`
- `UserWriteSchema`
- `CompanyIdentityWriteSchema`
- `IDENTITY_FILES` constant
- `IDENTITY_ORIGINS` constant

### Host Handlers
- `src/host/ipc-handlers/identity.ts` — entire file

### Agent Code
- Identity tool (multi-op read/write/user_write) from agent tools
- `src/agent/identity-loader.ts` — preload/fallback logic removed; simplified
  to just unpack stdin payload

### Governance System
- `src/host/ipc-handlers/governance.ts` — proposal system replaced by git
  commit history + pre-commit validation
- Proposal files (`~/.ax/proposals/*.json`)

### Database
- `identity` collection in DocumentStore — no migration, just delete
- Any skill storage in DocumentStore moving to `.ax/skills/`

## New Code

### `validateCommit(diff: string): { ok: boolean; reason?: string }`
- Parses diff to extract changed files and content
- Runs `scanInput()` on new/modified content
- Checks structural rules (allowed filenames, size limits)
- Returns pass/fail with reason
- Located in host code (trusted)

### `loadIdentityFromGit(workspacePath: string, gitDir: string): IdentityPayload`
- Replaces `loadIdentityFromDB()`
- Reads each identity file via `git show HEAD:.ax/<path>`
- Returns same `IdentityPayload` shape
- Located in `src/host/server-completions.ts` or extracted to utility

### Pre-commit hook (k8s only)
- Shell script installed by sidecar
- Runs `git diff --cached` scoped to `.ax/` paths
- Sends diff to host via HTTP IPC (`validate_commit` action)
- Exits 0 or 1 based on response

### IPC Schema (k8s only)
- `ValidateCommitSchema` — `{ diff: string }` → `{ ok: boolean; reason?: string }`

## Non-Goals

- Per-user state (USER.md) — dropped
- Database migration — clean break, create new agents
- Policy engine implementation — deferred, directory laid out
- Validate-on-read — unnecessary, validation at commit time is sufficient
  given `.git/` is tamper-proof in all sandbox modes
