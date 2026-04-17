# Phase 3 — Host-Authoritative Skill Index + Prompt Integration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the agent's prompt builder a host-authoritative skill index (name, description, enabled|pending|invalid, pending reasons) via a new IPC action `skills_index`, and switch the `SkillsModule` from filesystem scan to IPC + the design-doc bullet format. The agent still reads full `SKILL.md` on demand via its existing `Read` tool — nothing new on the agent side.

**Architecture:** Agent runner calls `ipcClient.request({action: 'skills_index'})` right after connecting. Host handler reads from `skill_states` (populated in phase 2) via a new `getStates()` method on `SkillStateStore`. Runner passes the returned skill list to `buildSystemPrompt()` as `config.skills`. `SkillsModule` emits the bullet list format from the design doc (see `docs/plans/2026-04-16-git-native-skills-design.md:209-221`).

**Tech stack:** Zod `.strict()` schemas in `src/ipc-schemas.ts`, existing IPC handler factory in `src/host/ipc-handlers/skills.ts`, Kysely state store in `src/host/skills/state-store.ts`.

---

## Constraints

- `.js` extensions on all relative imports (ESM).
- Zod `.strict()` on request + response schemas.
- Journal + lessons updated **before** each commit per CLAUDE.md.
- TDD per `superpowers:test-driven-development` — failing test first, minimal impl, refactor.
- Leave the filesystem-scan path (`loadSkillsMultiDir`) as a fallback for legacy callers/tests; runners prefer IPC when `stateStore` exists. (Full removal lands in phase 7.)

---

## Tasks

### Task 1 — `getStates()` on SkillStateStore

**Files:**
- Modify: `src/host/skills/state-store.ts`
- Modify: `tests/host/skills/state-store.test.ts`

**Step 1: Failing test.** Add a test that calls `putStates(agentId, [{name: 'linear', kind: 'pending', description: 'Linear issues', pendingReasons: ['needs LINEAR_TOKEN']}, {name: 'bad', kind: 'invalid', error: 'yaml parse'}])`, then `const out = await store.getStates(agentId)` and asserts both rows round-trip with `description`, `pendingReasons`, and `error` preserved and sorted by name.

**Step 2: Run** `npx vitest run tests/host/skills/state-store.test.ts` — expect failure (`getStates is not a function`).

**Step 3: Implement.** Add `getStates(agentId: string): Promise<SkillState[]>` to the `SkillStateStore` interface. Implementation selects `skill_name`, `kind`, `description`, `pending_reasons`, `error` filtered by `agent_id`, ordered by `skill_name ASC`, and maps each row to a `SkillState` (parsing `pending_reasons` JSON; dropping null-valued optional fields).

**Step 4: Run tests again** — expect pass.

**Step 5: Commit.** `feat(host): add SkillStateStore.getStates for index reads`

---

### Task 2 — Zod schema for `skills_index` IPC action

**Files:**
- Modify: `src/ipc-schemas.ts`
- Test: `tests/ipc/skills-index-schema.test.ts` (new)

**Step 1: Failing test.** Import `IPC_SCHEMAS` and assert it has an entry for `skills_index`. Parse `{action: 'skills_index'}` → ok. Parse `{action: 'skills_index', extra: 1}` → throws (strict). No `agentId` field on the request (handler uses `ctx.agentId`).

**Step 2: Run** `npx vitest run tests/ipc/skills-index-schema.test.ts` — expect failure.

**Step 3: Implement.** Add next to the existing skill schemas:

```ts
export const SkillsIndexSchema = ipcAction('skills_index', {});
```

The `ipcAction` helper already registers into `IPC_SCHEMAS`. No response schema is required — the IPC envelope doesn't validate responses — but document the shape in the handler for reviewers:

```
{
  skills: Array<{
    name: string;
    description?: string;
    kind: 'enabled' | 'pending' | 'invalid';
    pendingReasons?: string[];
  }>
}
```

**Step 4: Run tests** — expect pass.

**Step 5: Commit.** `feat(ipc): add skills_index action schema`

---

### Task 3 — `skills_index` IPC handler

**Files:**
- Modify: `src/host/ipc-handlers/skills.ts`
- Test: `tests/host/ipc-handlers/skills-index.test.ts` (new)

**Step 1: Failing test.** Build an in-memory `SkillStateStore` stub (`getStates(agentId)` returns a fixed array for one agent, empty for another). Call the handler factory `createSkillsHandlers(providers, {stateStore})`; invoke `handlers.skills_index({action: 'skills_index'}, {agentId: 'alpha', sessionId: 'sess'})`; assert response equals `{skills: [...]}` with the fixed rows. Also assert that `description`, `pendingReasons`, and `error` that are unset don't appear on the returned entries (strict shape). Finally, stateStore-unset case → `skills_index` returns `{skills: []}` (no stateStore wired → empty index, not crash).

**Step 2: Run** `npx vitest run tests/host/ipc-handlers/skills-index.test.ts` — expect failure.

**Step 3: Implement.**
- Extend `SkillsHandlerOptions` with `stateStore?: SkillStateStore`.
- Add handler:
  ```ts
  skills_index: async (_req: unknown, ctx: IPCContext) => {
    if (!opts?.stateStore) return { skills: [] };
    const states = await opts.stateStore.getStates(ctx.agentId);
    return {
      skills: states.map(s => {
        const out: { name: string; kind: string; description?: string; pendingReasons?: string[] } = {
          name: s.name,
          kind: s.kind,
        };
        if (s.description) out.description = s.description;
        if (s.pendingReasons?.length) out.pendingReasons = s.pendingReasons;
        return out;
      }),
    };
  },
  ```
- Drop `error` from the response — the agent prompt doesn't need the raw parse error (invalid state is enough of a signal; full error stays in the DB for the dashboard).

**Step 4: Run tests** — expect pass.

**Step 5: Commit.** `feat(host): add skills_index IPC handler`

---

### Task 4 — Wire `stateStore` through IPC handler plumbing

**Files:**
- Modify: `src/host/ipc-server.ts`
- Modify: `src/host/server.ts`
- Modify: `tests/host/ipc-server.test.ts` (if exists — otherwise skip)

**Step 1: Failing test.** In `skills-index.test.ts` (from task 3), add a test that drives `createIPCHandler(providers, {stateStore, agentId: 'a', ...})` end-to-end: call `handler` with a JSON envelope `{action: 'skills_index', _msgId: 1}` and parse the response. Expect it to succeed and return a stateStore-sourced list.

**Step 2: Run** test — expect failure (`stateStore` not threaded).

**Step 3: Implement.** Extend `IPCHandlerOptions` with `stateStore?: SkillStateStore`. In `createSkillsHandlers` spread, pass `stateStore: opts?.stateStore`. In `src/host/server.ts`, after `const stateStore = createSkillStateStore(providers.database.db)`, make `stateStore` visible to the `createIPCHandler` construction (follow the pattern used for `domainList`/`eventBus` — usually a lexically-scoped `let` or adding to an options object). Verify both the non-k8s and k8s branches (if they both construct the IPC handler). No behavior change when `providers.database` is absent.

**Step 4: Run tests + `npm run build`** — expect pass.

**Step 5: Commit.** `feat(host): wire SkillStateStore into IPC handler`

---

### Task 5 — Extend `SkillSummary` shape

**Files:**
- Modify: `src/agent/prompt/types.ts`
- Modify: `tests/agent/prompt/modules/skills.test.ts` (keep existing tests green)

**Step 1: Failing test.** Add a test in `skills.test.ts` that constructs a `SkillSummary` literal with `{name, description, kind: 'pending', pendingReasons: ['needs X']}`. (No `path` required.) Compile-time only — the test body just asserts `typeof s.kind === 'string'`.

**Step 2: Run** — expect TS compile failure.

**Step 3: Implement.** Extend `SkillSummary`:

```ts
export interface SkillSummary {
  name: string;
  description: string;
  /** Relative path for legacy filesystem-backed skills. Optional — host-indexed skills synthesize `.ax/skills/<name>/SKILL.md` at render time. */
  path?: string;
  warnings?: string[];
  /** Host-authoritative enable state. Undefined for legacy filesystem-backed skills (treated as 'enabled'). */
  kind?: 'enabled' | 'pending' | 'invalid';
  /** Reasons the skill is pending. Only present when kind='pending'. */
  pendingReasons?: string[];
}
```

The existing `loadSkills` path continues to produce `{name, description, path}` (no `kind`) — rendered as "enabled" by the module.

**Step 4: Run build + tests** — expect pass.

**Step 5: Commit.** `feat(prompt): extend SkillSummary with kind + pendingReasons`

---

### Task 6 — Rewrite `SkillsModule.render` to design-doc bullet format

**Files:**
- Modify: `src/agent/prompt/modules/skills.ts`
- Modify: `tests/agent/prompt/modules/skills.test.ts`

**Step 1: Failing tests.** Add tests for the new format per the design doc (`docs/plans/2026-04-16-git-native-skills-design.md:209-221`):

```ts
test('renders bullet list with pending reasons', () => {
  const mod = new SkillsModule();
  const ctx = makeContext({
    skills: [
      { name: 'linear', description: 'When the user wants to query or update Linear issues.', kind: 'pending', pendingReasons: ['needs LINEAR_TOKEN', 'awaiting approval for mcp.linear.app'] },
      { name: 'weather', description: 'When the user asks about weather conditions or forecasts.', kind: 'enabled' },
    ],
  });
  const text = mod.render(ctx).join('\n');
  expect(text).toContain('## Available skills');
  expect(text).toMatch(/- \*\*linear\*\* — \(setup pending: needs LINEAR_TOKEN, awaiting approval for mcp.linear.app\) When the user wants/);
  expect(text).toMatch(/- \*\*weather\*\* — When the user asks/);
  expect(text).toContain('`.ax/skills/<name>/SKILL.md`');
});

test('renders invalid skills with marker', () => {
  const mod = new SkillsModule();
  const ctx = makeContext({ skills: [{ name: 'bad', description: 'broken', kind: 'invalid' }] });
  const text = mod.render(ctx).join('\n');
  expect(text).toMatch(/- \*\*bad\*\* — \(invalid\) broken/);
});

test('treats legacy SkillSummary (no kind) as enabled', () => {
  const mod = new SkillsModule();
  const ctx = makeContext({ skills: [{ name: 'legacy', description: 'old skill', path: 'legacy.md' }] });
  const text = mod.render(ctx).join('\n');
  expect(text).toContain('- **legacy** — old skill');
  expect(text).not.toContain('pending');
  expect(text).not.toContain('invalid');
});
```

Keep existing install-guidance and creation-guidance tests; update any that assert the old table format (`| Daily Standup | ...`) to assert the bullet format instead.

**Step 2: Run** `npx vitest run tests/agent/prompt/modules/skills.test.ts` — expect failure on the new tests + any updated tests.

**Step 3: Implement.** Rewrite the `render` body so the "skills present" branch emits:

```
## Available skills

- **<name>** — [(<pending/invalid reasons>) ]<description>
...

To use a skill, read `.ax/skills/<name>/SKILL.md` and follow its instructions.
```

Logic:
- `kind ?? 'enabled'` — legacy rows treated as enabled.
- For `pending` → prefix description with `(setup pending: <reasons joined by ", ">) ` (fall back to `(setup pending)` if reasons empty).
- For `invalid` → prefix description with `(invalid) `.
- Keep "Creating Skills" and "Installing New Skills" sections. Keep `renderMinimal`; update it to reference `.ax/skills/<name>/SKILL.md`.

**Step 4: Run tests** — expect pass.

**Step 5: Commit.** `feat(prompt): host-authoritative skills index format`

---

### Task 7 — Runner calls `skills_index` and populates `config.skills`

**Files:**
- Modify: `src/agent/runner.ts` (extend `AgentConfig` with `skills?: SkillSummary[]`)
- Modify: `src/agent/agent-setup.ts` (`buildSystemPrompt` prefers `config.skills` when set, falls back to filesystem scan)
- Modify: `src/agent/runners/pi-session.ts` (call `skills_index` after `client.connect()`, before `buildSystemPrompt`)
- Modify: `src/agent/runners/claude-code.ts` (same)
- Test: `tests/agent/agent-setup.test.ts`

**Step 1: Failing test.** In `tests/agent/agent-setup.test.ts`, add a test that calls `buildSystemPrompt(config)` with `config.skills` set to a fixed array containing one pending + one enabled skill, and asserts the rendered prompt contains the expected bullets. Separately: when `config.skills` is `undefined`, the function still falls back to the existing filesystem scan (existing behavior).

**Step 2: Run** — expect failure.

**Step 3: Implement.**
- `AgentConfig` (in `src/agent/runner.ts`): add `skills?: import('./prompt/types.js').SkillSummary[]`.
- `buildSystemPrompt`: `const skills = config.skills ?? loadSkillsMultiDir(skillDirs);`
- In both runners, after `await client.connect()` and before `buildSystemPrompt(config)`:
  ```ts
  try {
    const res = await client.call({ action: 'skills_index' }) as { skills?: SkillSummary[] };
    if (Array.isArray(res?.skills)) config.skills = res.skills;
  } catch (err) {
    logger.warn('skills_index_failed', { err: err instanceof Error ? err.message : String(err) });
  }
  ```
  On failure, `config.skills` stays undefined and the filesystem fallback kicks in — no regression.

**Step 4: Run full test suite** (`npm test -- --run tests/agent tests/host/skills tests/host/ipc-handlers`) — expect pass.

**Step 5: Commit.** `feat(agent): runner fetches skills_index from host before prompt build`

---

### Task 8 — Update `.claude/skills/ax/agent.md`

**Files:**
- Modify: `.claude/skills/ax/agent.md`

**Step 1.** Find the section describing how the prompt builder sources skills. Update it to note:
- Skills list is host-authoritative, sourced via IPC `skills_index`.
- Filesystem scan of `.ax/skills/` remains as a fallback for CLI / test paths.
- The `kind` field drives render style: `enabled` → plain, `pending` → setup reasons, `invalid` → marker.

**Step 2.** No tests — it's a skill doc. Just make sure the language matches the current code and design doc.

**Step 3: Commit.** `docs(ax-agent-skill): document host-authoritative skills_index`

---

### Final Review

After all 8 tasks commit, dispatch a code reviewer over the full diff. Targets:
- No dynamic imports from config values (SC-SEC-002 still holds).
- All Zod schemas `.strict()`.
- IPC response matches documented shape (description/pendingReasons omitted when empty).
- `buildSystemPrompt` remains synchronous — async work happens in runners.
- Journal + lessons up to date before every commit (CLAUDE.md §Journal & Lessons Protocol).

---

## Commit hints (summary)

1. `feat(host): add SkillStateStore.getStates for index reads`
2. `feat(ipc): add skills_index action schema`
3. `feat(host): add skills_index IPC handler`
4. `feat(host): wire SkillStateStore into IPC handler`
5. `feat(prompt): extend SkillSummary with kind + pendingReasons`
6. `feat(prompt): host-authoritative skills index format`
7. `feat(agent): runner fetches skills_index from host before prompt build`
8. `docs(ax-agent-skill): document host-authoritative skills_index`
