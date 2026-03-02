# Architecture

### Prefer structural layout fixes over runtime workarounds
**Date:** 2026-03-01
**Context:** Skills dir was inside workspace, requiring a per-turn copy to avoid mount permission overlap. Moving skills to be a peer of workspace (`agentIdentityDir()/skills` instead of `agentWorkspaceDir()/skills`) eliminated the need entirely.
**Lesson:** When two directories need different mount permissions, fix the directory layout so they're peers — don't work around a bad layout with runtime copying. A one-line path change beats 15 lines of temp-dir management.
**Tags:** architecture, simplicity, sandbox, skills, workspace

### Provider contract pattern IS the plugin framework — packaging is the missing piece
**Date:** 2026-02-26
**Context:** Evaluating whether AX needs a plugin framework for extensibility
**Lesson:** AX's provider contract pattern (TypeScript interface + `create(config)` factory + static allowlist in provider-map.ts) is already 90% of a plugin framework. The gap is packaging and distribution, not architecture. A monorepo split into scoped npm packages (@ax/provider-{kind}-{name}) can shrink core to ~3K LOC while preserving the static allowlist security invariant. The allowlist entries just change from relative paths to package names. No new trust boundary needed for first-party packages.
**Tags:** architecture, plugins, providers, provider-map, monorepo, packaging

### Cross-provider imports should go through shared-types.ts, not sibling directories
**Date:** 2026-02-28
**Context:** Preparing provider extraction (Step 2b) — scheduler imported types directly from channel/, memory/, and audit/ directories
**Lesson:** When one provider category needs types from another (e.g., scheduler needs `SessionAddress` from channel), import from `src/providers/shared-types.ts` — never directly from `../channel/types.js`. This keeps the import graph clean for eventual package extraction. The shared-types file is purely re-exports; canonical definitions stay in their home provider's types.ts. A structural test in `tests/providers/shared-types.test.ts` enforces this by scanning source imports.
**Tags:** architecture, imports, providers, cross-provider, shared-types, extraction-prep

### Shared utilities between routers go in src/providers/router-utils.ts
**Date:** 2026-02-28
**Context:** image/router.ts was importing parseCompoundId from llm/router.ts — a cross-provider runtime dependency
**Lesson:** If multiple provider routers share utility functions (like `parseCompoundId`), extract them to `src/providers/router-utils.ts`. Don't have one router import from another — that creates a dependency between provider categories. When extracting the shared function, add a re-export from the original location for backwards compatibility, and mark it for removal in a future phase.
**Tags:** architecture, imports, router, shared-utils, parseCompoundId, extraction-prep

### EventBus should be optional and synchronous to avoid blocking the hot path
**Date:** 2026-02-28
**Context:** Implementing a streaming event bus for completion observability
**Lesson:** When adding cross-cutting observability to a request pipeline, make the bus synchronous (fire-and-forget) and optional (`eventBus?.emit()`). This way: (1) it never blocks the completion pipeline even if a listener is slow, (2) existing code paths work unchanged when no bus is wired in, (3) listener errors are isolated per-listener so one bad subscriber can't take down the pipeline. Use try/catch around each listener invocation, not around the emit loop.
**Tags:** event-bus, observability, architecture, performance, optional-dependency

### Extend the EventBus rather than replacing it for orchestration
**Date:** 2026-02-28
**Context:** Designing agent orchestration — needed to decide whether to build a new event system or reuse the existing EventBus
**Lesson:** The existing EventBus already emits llm.start, tool.call, llm.done events throughout the pipeline. Instead of creating a parallel event system, use auto-state inference: subscribe to the EventBus and map existing events to agent state transitions (llm.start → waiting_for_llm, tool.call → tool_calling, etc.). This avoids modifying existing IPC handlers while still getting rich agent state. The bridge pattern (listen → translate → update) is better than forking.
**Tags:** architecture, event-bus, orchestration, bridge-pattern, state-management

### Canonical path names should match their semantic role, not implementation
**Date:** 2026-03-01
**Context:** Renamed /workspace→/scratch, /agent-identity→/agent, etc. The old names were either too verbose or didn't convey the right mental model to the agent (e.g., /workspace didn't communicate "this is ephemeral").
**Lesson:** Short canonical names that describe purpose (/scratch, /agent, /shared, /user) are better than names that describe implementation (/workspace, /agent-identity, /agent-workspace, /user-workspace). The agent doesn't need to know it's a "workspace" — it needs to know it's ephemeral scratch space.
**Tags:** canonical-paths, naming, agent-ux

### Eliminate redundant mount points rather than documenting differences
**Date:** 2026-03-01
**Context:** Both /workspace (cwd) and /scratch were session-scoped ephemeral rw directories. The only difference was naming. Instead of explaining the subtle difference to agents, we removed one.
**Lesson:** If two mount points have the same lifecycle, permissions, and purpose, merge them. Agents don't benefit from subtle filesystem distinctions — they benefit from a small, clear set of canonical paths.
**Tags:** canonical-paths, simplification, mount-points

### AX has two workspace directories — session sandbox vs enterprise user
**Date:** 2026-02-26
**Context:** After migrating file storage from session workspace to enterprise user workspace
**Lesson:** AX has TWO distinct workspace directories:
1. **Session workspace** (`~/.ax/data/workspaces/<session-id-path>/`) — agent sandbox CWD, where agents can write files directly during execution. Ephemeral, tied to session ID.
2. **Enterprise user workspace** (`~/.ax/agents/<name>/users/<userId>/workspace/`) — durable per-user storage. Used for file uploads/downloads, generated image persistence, and `/v1/files/` API. Keyed by agent name + user ID.
After the migration, images are persisted to the **enterprise user workspace** and served via `?agent=<name>&user=<id>` query params. The session workspace remains as the sandbox CWD for agent execution.
**Tags:** workspaces, paths, session-id, images, file-api, enterprise

### Duplicate bootstrap files in both configDir and identity mount for agent visibility
**Date:** 2026-03-02
**Context:** Restructuring agent directory to isolate identity files in a mountable subdirectory. BOOTSTRAP.md and USER_BOOTSTRAP.md need to be readable by the sandboxed agent but also serve as authoritative state for host-side checks.
**Lesson:** When the host needs a file for server-side state checks AND the agent needs to read it from its sandbox mount, duplicate the file into both locations. The host copy in `agentConfigDir` is authoritative; the agent-readable copy in `identityFilesDir` is a convenience duplicate. On bootstrap completion, delete from both. This is simpler than adding stdin payload fields or symlinks.
**Tags:** architecture, bootstrap, identity, sandbox, file-layout

### OverlayFS for merging skill layers with fallback
**Date:** 2026-03-01
**Context:** Agent-level and user-level skills needed to appear as a single /skills directory. OverlayFS merges them with user skills shadowing agent skills. Falls back to agent-only when overlayfs is unavailable (macOS, unprivileged).
**Lesson:** Use overlayfs for merging read-only layers where user content should shadow shared content. Always implement a fallback for environments without overlayfs support (macOS, containers without CAP_SYS_ADMIN). The fallback can be degraded (agent-only) as long as the IPC layer still manages both via host-side operations.
**Tags:** overlayfs, skills, sandbox, fallback
