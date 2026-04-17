# Phase 3 — Host-Authoritative Skill Index + Prompt Integration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add IPC action `skills_index` that returns the agent's current skill list (`{name, description, enabled|pending, pendingReasons}`) from host-stored state. Switch `SkillsModule` in the prompt builder to call it instead of reading from DocumentStore.

**Architecture:** Agent prompt-builder asks host over IPC. Host reads from the `skill_states` table populated in phase 2. Agent reads full SKILL.md on demand via its existing `Read` tool — `.ax/skills/<name>/SKILL.md` is in its workspace.

**Tech stack:** Zod schemas in `src/ipc-schemas.ts`, `.strict()`; existing IPC router in `src/host/ipc-handlers/`.

---

## Constraints
- `.js` imports, Zod `.strict()`, journal/lessons before commit, TDD per `superpowers:test-driven-development`.
- Agent trusts only the host's index — no filesystem globbing for skills in the prompt builder.

---

## Tasks (high-level — detailed TDD steps added when phase starts)

1. **IPC schema + handler:** add `skills_index` action. Request: `{agentId}`. Response: `{skills: Array<{name, description?, kind, pendingReasons?}>}`. Handler reads from `skill-state-store`.
2. **Prompt module switch:** rewrite `src/agent/prompt/modules/skills.ts` to call `ipcClient.request('skills_index', {agentId})` and format into the `## Available skills` section (matching the design doc's progressive-disclosure format).
3. **Remove old DocumentStore-backed skill read path** (reads only — writes are removed in phase 7).
4. **Contract test:** prompt rendering matches the design doc format with enabled + pending + invalid entries.
5. **Update `ax-agent` skill** and any related docs to reflect host-authoritative index.

**Files touched:** `src/ipc-schemas.ts`, `src/host/ipc-handlers/skills.ts`, `src/agent/prompt/modules/skills.ts`, tests under `tests/ipc/`, `tests/agent/prompt/`, `.claude/skills/ax/agent.md`.

**Commit hints:** `feat(ipc): add skills_index action`, `feat(prompt): host-authoritative skills index`, `refactor(prompt): drop DocumentStore skill read path`.
