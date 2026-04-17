# Phase 4 — MCP + Proxy Allowlist Wiring from Reconciler

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After each reconcile, apply the reconciler's `desired` output to live state:
- Register/unregister MCP servers on `McpConnectionManager` so only enabled skills' servers are reachable.
- Replace the per-agent proxy allowlist contribution with the union of enabled skills' domains (intersected with approved domains).

**Architecture:** `reconcile-orchestrator` (phase 2) gains two new deps — `mcpManager` and `proxyDomainList` — and applies diffs between prior and new desired state. Reference counting lives naturally in the reconciler's set math; applier just diffs the output maps/sets against the currently-registered set.

---

## Constraints
- **Pending skills' resources never land on the live surface.** This is the security gate — see SC-SEC-002 invariants.
- No dynamic imports. No new provider types unless strictly required.
- TDD, Zod `.strict()`, journal/lessons before commit.

---

## Tasks (high-level)

1. **MCP applier:** new module `src/host/skills/mcp-applier.ts` — `applyMcpDesired(desired, mcpManager)` computes diffs and calls `mcpManager.register({name,url,bearerCredential})` / `mcpManager.unregister(name)`.
2. **Proxy applier:** new module `src/host/skills/proxy-applier.ts` — `applyProxyDesired(agentId, desired, proxyDomainList)` calls `proxyDomainList.setSkillDomains(agentId, enabledDomains)` (rename or augment `addSkillDomains` for idempotent replace semantics).
3. **Wire appliers into orchestrator:** phase 2's orchestrator just threaded `desired.*` into placeholder — now it invokes the appliers. Update tests to confirm live state changes.
4. **Startup rehydration:** on host start, loop agents in `skill_states`, load approvals+credentials, re-run applier for all enabled skills so live state matches DB after restart. Pending state is also rebuilt from DB (no re-snapshot needed).
5. **Audit events:** every register/unregister and allowlist add/remove emits an audit entry (`mcp.registered`, `mcp.unregistered`, `proxy.allowlist_updated`).

**Files touched:** `src/host/skills/reconcile-orchestrator.ts`, `src/host/plugins/mcp-manager.ts` (interface only — implementation unchanged), `src/host/proxy-domain-list.ts`, `src/host/server.ts` (startup wiring), tests under `tests/host/skills/`.

**Commit hints:** `feat(skills): apply desired MCP state after reconcile`, `feat(skills): replace-style proxy allowlist per agent`, `feat(skills): rehydrate live state from DB on startup`.
