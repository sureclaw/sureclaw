# Host: Lazy Sandbox + workspace_write

Design and planning for decoupling agent from sandbox, adding workspace_write IPC tool.

## [2026-03-14 12:00] — Write lazy sandbox + workspace_write implementation plan

**Task:** Design and plan the architecture for lazy sandbox spawning and restoring workspace_write as a sandbox-free file writing tool.
**What I did:** Brainstormed the design with the user, explored the current architecture (processCompletion, sandbox providers, workspace handlers, tool catalog, IPC schemas), compared current vs proposed architecture, and wrote a 6-task implementation plan.
**Files touched:** `docs/plans/2026-03-14-lazy-sandbox-workspace-write.md` (created)
**Outcome:** Success — plan written and saved.
**Notes:** Key insight: k8s mode already implements this pattern (agent as subprocess, sandbox tools via NATS dispatch). The plan unifies local mode with k8s's architecture. The workspace_write handler was removed in commit 0eed9ce when workspace mounts were wired into the sandbox pipeline. Bringing it back serves a different purpose: sandbox-free file writes for simple tasks.
