# Skill Dependency Installation

**Date:** 2026-03-19
**Status:** Implemented

## Problem

Skills like [agent-browser-clawdbot](https://clawhub.ai/MaTriXy/agent-browser-clawdbot) declare npm/pip/brew/cargo/go dependencies that must be installed to provide required binaries. Currently, the parser extracts install specs and the prompt warns the agent about missing binaries, but nothing actually runs the install commands. Package managers also install to system-wide locations by default, not to the persistent workspace paths the agent can access across sessions.

## Design

### Approach

Install skill dependencies **agent-side**, in the runner, before the agent loop starts. Use package manager prefix env vars to redirect binary installation to workspace paths. Use the existing HTTP proxy for network access — no sandbox network changes needed.

### Install Prefix Selection

- **DM session** → `/workspace/user` (persists per-user across sessions)
- **Channel/group session** → `/workspace/agent` (shared across all users of this agent)

Determined by: `config.userWorkspace ?? config.agentWorkspace`. User workspace takes priority when both are set.

### Package Manager Redirection

| Manager | Env var | Value |
|---------|---------|-------|
| npm | `npm_config_prefix` | `<prefix>` → bins in `<prefix>/bin/` |
| pip | `PYTHONUSERBASE` + `--user` flag | `<prefix>` → bins in `<prefix>/bin/` |
| cargo | `CARGO_INSTALL_ROOT` | `<prefix>` → bins in `<prefix>/bin/` |
| go | `GOBIN` | `<prefix>/bin` |
| uv | `UV_TOOL_BIN_DIR` | `<prefix>/bin` |
| brew | N/A | Post-install copy to `<prefix>/bin/` |

### Flow

```
Runner starts
  → Load skills from stdin payload (already happens)
  → Parse install specs from each skill
  → Web proxy bridge starts (already happens)
  → For each skill with install steps:
      → Filter by OS constraint (step.os)
      → Check binExists(step.bin)
      → If missing: run step.run with prefix env vars set
  → Continue to agent loop
```

### Proxy

`HTTP_PROXY`/`HTTPS_PROXY` are already set in `process.env` by the runner's proxy bridge setup. All package managers respect these env vars natively. No additional proxy configuration needed.

### Approval

Install commands are declared in SKILL.md and screened at skill installation time. Auto-approved — no per-execution approval gate.

### Error Handling

- Log failures but don't crash the runner
- Missing binary warning still appears in agent prompt
- No retry — transient failures (registry down) won't be helped by retrying
- 2-minute timeout per install step

## File Changes

### New

- **`src/agent/skill-installer.ts`** — `installSkillDeps(skills, prefix)` function

### Modified

- **`src/agent/runners/pi-session.ts`** — Call `installSkillDeps()` after proxy bridge setup
- **`src/agent/runners/claude-code.ts`** — Same
- **`src/utils/skill-format-parser.ts`** — Fix pip KIND_TO_RUN: `pip install {pkg}` → `pip install --user {pkg}`

### Unchanged

- `canonical-paths.ts` — Already sets up PATH with user/agent bin dirs
- `bin-exists.ts` — Already works, just imported by skill-installer
- IPC schemas — No new actions
- Sandbox providers — No network changes
- Host process — Completely unaware of this

## Key Invariants

- Agent containers never get network access — installs go through the audited HTTP proxy
- Binaries persist in workspace dirs across sessions (no re-install on every turn)
- `binExists()` prevents redundant installs
- All install commands are declared in screened SKILL.md — no dynamic/runtime command generation
