# Multi-Agent

## [2026-04-04 10:10] — Multi-agent Slack UX layer implementation

**Task:** Implement multi-agent Slack UX plan: shared agents, per-message routing, thread ownership, response prefixes, agent-scoped webhooks
**What I did:** Implemented all 11 tasks:
1. Added `displayName` and `agentKind` ('personal'/'shared') to AgentRegistryEntry + DB migration 003
2. Added `shared_agents` config section (SharedAgentConfig) to Config + Zod validation
3. Refactored Slack provider with `createWithTokens()` for injected token support
4. Implemented `resolveAgentForMessage()` for per-message agent routing (thread owner > bound > provisioner > fallback)
5. Created `ThreadOwnershipMap` for thread-to-agent binding
6. Added `maybeAddResponsePrefix()` — `[DisplayName]` prefix for personal agents in channels/threads
7. Wired shared agent startup in server-local.ts (registry, Slack provider, channel handler)
8. Added agent-scoped webhook routing `/webhooks/{agentId}/{name}` with x-ax-agent-id header injection
9. Updated ax-host, ax-provider-channel, ax-config skills
**Files touched:**
- Modified: `src/host/agent-registry.ts`, `src/host/agent-registry-db.ts`, `src/types.ts`, `src/config.ts`, `src/providers/channel/slack.ts`, `src/host/server-channels.ts`, `src/host/server-local.ts`, `src/host/server-request-handlers.ts`, `src/host/server-webhooks.ts`
- Tests: `tests/host/agent-registry.test.ts`, `tests/config.test.ts`, `tests/host/server-channels.test.ts`, `tests/host/server-webhooks.test.ts`
- Skills: `.claude/skills/ax-host/SKILL.md`, `.claude/skills/ax-provider-channel/SKILL.md`, `.claude/skills/ax-config/SKILL.md`
**Outcome:** Success — all tests pass
**Notes:** The Slack UX layer builds on existing multi-agent infrastructure (AgentProvisioner, AgentRegistry, credential scopes). Thread ownership is in-memory (not persisted) — acceptable for single-pod deployments; k8s would need a shared store.

# Multi-Agent Personal Agents

## [2026-04-04 09:55] — Multi-agent personal agents: all 11 tasks implemented

**Task:** Implement the multi-agent personal agents plan from `docs/plans/2026-04-03-multi-agent-personal-agents-design.md`
**What I did:** Implemented all 11 tasks from the plan using TDD:
1. Extended AgentRegistryEntry with admins field and findByAdmin method
2. Added DB migration (registry_002_agent_admins) for DatabaseAgentRegistry
3. Created AgentProvisioner for auto-provisioning personal agents
4. Wired provisioner into HostCore and CompletionDeps
5. Updated processCompletion to resolve agents dynamically via provisioner
6. Added company scope to credential resolution chain (user -> agent -> company -> global)
7. Added shared company memory pool with pool field on memory_write/memory_query
8. Layered company base identity before agent identity in loadIdentityFromDB
9. Created company identity read/write IPC handlers with admin gating
10. Created CatalogStore for shared company skill/connector catalog
11. Added catalog management IPC handlers (publish/get/list/unpublish/set_required)
**Files touched:**
- Modified: `src/host/agent-registry.ts`, `src/host/agent-registry-db.ts`, `src/host/server-init.ts`, `src/host/server-completions.ts`, `src/host/credential-scopes.ts`, `src/host/ipc-handlers/memory.ts`, `src/host/ipc-server.ts`, `src/ipc-schemas.ts`
- Created: `src/host/agent-provisioner.ts`, `src/host/company-admin.ts`, `src/host/catalog-store.ts`, `src/host/ipc-handlers/company.ts`, `src/host/ipc-handlers/catalog.ts`
- Tests: `tests/host/agent-registry.test.ts`, `tests/host/agent-provisioner.test.ts`, `tests/host/server-init-provisioner.test.ts`, `tests/host/server-completions-dynamic.test.ts`, `tests/host/credential-scopes.test.ts`, `tests/host/ipc-handlers/memory.test.ts`, `tests/host/server-completions-identity.test.ts`, `tests/host/company-admin.test.ts`, `tests/host/ipc-handlers/company.test.ts`, `tests/host/catalog-store.test.ts`, `tests/host/ipc-handlers/catalog.test.ts`, `tests/agent/tool-catalog-sync.test.ts`
**Outcome:** Success — all 2821 tests pass, clean tsc build
**Notes:** Worktrees share node_modules and dist/ with main tree. tsx module resolution can resolve from the main tree's src/, which means some tests pass before creating files in the worktree.
