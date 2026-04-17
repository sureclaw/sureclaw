# Phase 2 — Git Hook + Workspace Integration

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** On every `git push` to an agent's workspace, the host snapshots `.ax/skills/`, loads current state, runs the phase-1 reconciler, persists the new skill states, and emits events to the event bus. Effects on live MCP/proxy still stubbed (phase 4).

**Architecture:**
- `git-local`: bare repo's `hooks/post-receive` is a shell script that POSTs `{agentId, ref, sha}` to the host's new `/v1/internal/skills/reconcile` endpoint with a shared-secret HMAC header.
- `git-http` container: bare repos get the same `hooks/post-receive` script (installed at repo-create time in `/repos` handler); the script reaches the host via the existing `AX_HOST_URL` env var exposed by the Helm chart.
- Host endpoint builds the snapshot by walking `.ax/skills/**/SKILL.md` in the pushed ref (via `git show`/`git ls-tree`), loads current state from existing providers (`credentials.list`, `ProxyDomainList`, prior states from a new sqlite table), calls `reconcile()`, persists the new skill states, and emits events.

**Tech Stack:** Node.js, Zod, `node:child_process` (git subcommands), `node:crypto` (HMAC), vitest.

---

## Important constraints

- **Reconciler (phase 1) is pure and is NOT modified here.** Phase 2 only builds its inputs, invokes it, and applies side-effects for *persistence + events* — not for proxy/MCP (phase 4).
- **`.js` import extensions** in TS everywhere per project convention.
- **Zod `.strict()`** for the new HTTP schema.
- **safePath** for any constructed repo path.
- **No dynamic imports from config.** Provider map stays as-is.
- **Journal/lessons BEFORE commits.**
- **Follow `superpowers:test-driven-development`** for every task.

---

## Files overview (new unless marked)

- Create: `src/host/skills/snapshot.ts` — walk `.ax/skills/` in a given ref → `SkillSnapshotEntry[]`.
- Create: `src/host/skills/current-state.ts` — load `ReconcilerCurrentState` from existing providers + new `skill_states` sqlite table.
- Create: `src/host/skills/state-store.ts` — sqlite-backed persistence for prior skill states + setup queue rows.
- Create: `src/host/skills/reconcile-orchestrator.ts` — glue: `reconcileAgent(agentId, ref)` → runs snapshot + current-state + `reconcile()` + persists + emits events.
- Create: `src/host/skills/hook-endpoint.ts` — POST `/v1/internal/skills/reconcile` handler (HMAC-authenticated).
- Create: `src/providers/workspace/hooks/post-receive.sh` — shell script template.
- Create: `src/providers/workspace/install-hook.ts` — idempotent installer used by both git-local and git-http.
- Modify: `src/providers/workspace/git-local.ts` — install hook after `git init --bare`.
- Modify: `src/providers/workspace/git-http.ts` — pass a `hook-install` request to the git-server container (separate file on container side — see below).
- Modify: `container/git-server/http-server.js` — install hook in bare repos created by `/repos` (cross-language port of `install-hook.ts`).
- Modify: `src/host/server-request-handlers.ts` — mount `/v1/internal/skills/reconcile` route.
- Modify: `src/host/server.ts` — wire the reconcile orchestrator + state store into the request handler opts.
- Create: `tests/host/skills/snapshot.test.ts`
- Create: `tests/host/skills/current-state.test.ts`
- Create: `tests/host/skills/state-store.test.ts`
- Create: `tests/host/skills/reconcile-orchestrator.test.ts`
- Create: `tests/host/skills/hook-endpoint.test.ts`
- Create: `tests/providers/workspace/install-hook.test.ts`
- Modify: `tests/providers/workspace/git-local.test.ts` — assert hook is installed.

---

## Contracts

### HTTP endpoint (internal)

```
POST /v1/internal/skills/reconcile
Headers:
  X-AX-Hook-Signature: sha256=<HMAC-SHA256 of body using AX_HOOK_SECRET>
  Content-Type: application/json
Body:
  { "agentId": string, "ref": string, "oldSha": string, "newSha": string }
Response:
  200 { "ok": true, "skills": <count>, "events": <count> }
  401 if signature invalid
  400 if body invalid (Zod)
  500 if reconcile throws
```

The shared secret is `AX_HOOK_SECRET` — set at host startup (random if unset), exposed to git-local hook via env when the host writes it into the hook script, and to git-http via Helm values.

### Post-receive hook script (shell)

```bash
#!/bin/sh
# AX skills reconciliation hook — installed by the host.
# Reads refs from stdin (per git hook spec) and POSTs to the host.
set -eu

AGENT_ID="__AGENT_ID__"             # substituted at install time
HOST_URL="${AX_HOST_URL:-http://host.docker.internal:8080}"
SECRET="${AX_HOOK_SECRET:?missing}"

while read -r oldSha newSha ref; do
  # Only reconcile refs/heads/main — cheap filter to avoid churn on tags/PR refs.
  case "$ref" in
    refs/heads/main) ;;
    *) continue ;;
  esac
  body=$(printf '{"agentId":"%s","ref":"%s","oldSha":"%s","newSha":"%s"}' \
    "$AGENT_ID" "$ref" "$oldSha" "$newSha")
  sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -binary | xxd -p -c 256)"
  # Best-effort. Failure of the hook should NOT block the push.
  curl -fsS -m 10 \
    -H "Content-Type: application/json" \
    -H "X-AX-Hook-Signature: $sig" \
    -d "$body" \
    "$HOST_URL/v1/internal/skills/reconcile" >/dev/null || true
done
```

### Snapshot builder

```ts
// src/host/skills/snapshot.ts
export async function buildSnapshotFromBareRepo(
  bareRepoPath: string,
  ref: string,
): Promise<SkillSnapshotEntry[]>
```

Implementation notes:
- Runs `git ls-tree -r --name-only <ref> -- .ax/skills/` to list files.
- Filters to paths matching `^\.ax/skills/([^/]+)/SKILL\.md$`.
- For each, `git show <ref>:<path>` → content → `parseSkillFile(content)`.
- `ok:true` → `{ name, ok, frontmatter, body }`; `ok:false` → `{ name, ok:false, error }`.
- Uses `execFile` (not `exec`) with array args — no shell interpolation.

### Current-state loader

```ts
// src/host/skills/current-state.ts
export interface CurrentStateDeps {
  proxyDomainList: ProxyDomainList;
  credentials: CredentialProvider;
  mcpManager: { listRegistered(): Array<{ name: string; url: string }> };
  stateStore: SkillStateStore;
}

export async function loadCurrentState(
  agentId: string,
  deps: CurrentStateDeps,
): Promise<ReconcilerCurrentState>
```

Implementation notes:
- `approvedDomains`: `deps.proxyDomainList.getAllowedDomains()` — includes builtins + admin-approved.
- `storedCredentials`: `credentials.list('user:*')` + `credentials.list('agent:*')` → map to `${envName}@${scope}` keys. The credential scope format is owned by `credential-scopes.ts`; the loader uses its helpers rather than parsing keys itself.
- `registeredMcpServers`: `mcpManager.listRegistered()` → Map. **Stub in phase 2** — wire for real in phase 4. Return empty map if no manager.
- `priorSkillStates`: `stateStore.getPriorStates(agentId)`.

### State store (sqlite)

```ts
// src/host/skills/state-store.ts
export interface SkillStateStore {
  getPriorStates(agentId: string): Promise<Map<string, SkillStateKind>>;
  putStates(agentId: string, states: SkillState[]): Promise<void>;
  putSetupQueue(agentId: string, queue: SetupRequest[]): Promise<void>;
  getSetupQueue(agentId: string): Promise<SetupRequest[]>;
}

export function createSkillStateStore(db: Database): SkillStateStore
```

Schema (new migration file `src/providers/database/migrations/NNN-skill-states.ts`):

```sql
CREATE TABLE skill_states (
  agent_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('enabled','pending','invalid')),
  description TEXT,
  pending_reasons TEXT,  -- JSON array
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, skill_name)
);

CREATE TABLE skill_setup_queue (
  agent_id TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  payload TEXT NOT NULL,  -- full SetupRequest as JSON
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, skill_name)
);
```

### Reconcile orchestrator

```ts
// src/host/skills/reconcile-orchestrator.ts
export interface OrchestratorDeps extends CurrentStateDeps {
  eventBus: EventBus;
  getBareRepoPath(agentId: string): string;
}

export async function reconcileAgent(
  agentId: string,
  ref: string,
  deps: OrchestratorDeps,
): Promise<{ skills: number; events: number }>
```

Steps inside:
1. `buildSnapshotFromBareRepo(getBareRepoPath(agentId), ref)`.
2. `loadCurrentState(agentId, deps)`.
3. `reconcile({ snapshot, current })`.
4. `stateStore.putStates(agentId, output.skills)`.
5. `stateStore.putSetupQueue(agentId, output.setupQueue)`.
6. For each event in `output.events`: `eventBus.emit({ type, requestId: agentId, timestamp: Date.now(), data })`.
7. Return summary.

**No MCP/proxy wiring in phase 2.** The `output.desired.mcpServers` and `output.desired.proxyAllowlist` are computed but discarded here. Phase 4 wires them.

---

## Task breakdown

Each task is TDD: write failing test → run to verify fail → minimal implementation → run to verify pass → commit. Follow `superpowers:test-driven-development` exactly.

### Task 1: Snapshot builder (`src/host/skills/snapshot.ts`)

**Files:**
- Create: `src/host/skills/snapshot.ts`
- Create: `tests/host/skills/snapshot.test.ts`

**Step 1 — Failing test:** set up a bare repo in a temp dir, commit two `SKILL.md` files (one valid, one with invalid frontmatter), call `buildSnapshotFromBareRepo(repoPath, 'refs/heads/main')`, assert returned array has both names and the invalid one has `ok:false` with a descriptive error.

Use `execFileSync('git', ['init', '--bare', ...])` for the bare repo, then a sidecar work-tree to make the commit (mirror the pattern in `container/git-server/http-server.js:243-274`).

**Step 2 — Minimal impl:**
- Spawn `git -C <bareRepoPath> ls-tree -r --name-only <ref> -- .ax/skills/`.
- Regex `^\.ax/skills/([^/]+)/SKILL\.md$`.
- For each match, `git -C <bareRepoPath> show <ref>:<path>` → content → `parseSkillFile` (from phase 1).
- Return entries in deterministic order (sorted by name).

**Step 3 — Run + commit:** `npm test -- tests/host/skills/snapshot.test.ts`.

**Commit:** `feat(skills): walk SKILL.md files from bare repo ref`

---

### Task 2: State store (`src/host/skills/state-store.ts`)

**Files:**
- Create: `src/host/skills/state-store.ts`
- Create: `src/migrations/skills.ts` (new migration set file; mirror the shape of `src/migrations/jobs.ts`)
- Create: `tests/host/skills/state-store.test.ts`

**Step 1 — Failing test:** open an in-memory sqlite via the project's existing helper, run migrations, call `putStates` with two skills, then `getPriorStates` and assert the map matches. Same for setup queue: `putSetupQueue([{...}])` → `getSetupQueue` round-trip.

**Step 2 — Minimal impl:** straightforward INSERT OR REPLACE + SELECT. Use `JSON.stringify` for `pending_reasons` and the full `payload` blob. `putStates` should also clear skills not in the new list for that `agentId` (reconcile is authoritative per cycle).

**Step 3 — Run + commit.**

**Commit:** `feat(skills): sqlite persistence for skill states + setup queue`

---

### Task 3: Current-state loader (`src/host/skills/current-state.ts`)

**Files:**
- Create: `src/host/skills/current-state.ts`
- Create: `tests/host/skills/current-state.test.ts`

**Step 1 — Failing test:** stub `ProxyDomainList` (returns `{'api.linear.app'}`), stub `credentials.list('user')` (returns `['LINEAR_TOKEN']`) and `list('agent')` (returns `[]`), stub `mcpManager.listRegistered()` (returns `[{name:'linear',url:'...'}]`), stub `stateStore.getPriorStates` (returns `Map{linear:'enabled'}`). Assert the loaded `ReconcilerCurrentState` has the right shape.

**Step 2 — Minimal impl:** call each dep; build Sets/Maps. For `storedCredentials`, use `credentialScope`-aware helpers — defer to `credential-scopes.ts` for the key format; if the current helpers don't expose a listing API, add a thin `listWithScope(scope: 'user'|'agent'): Promise<string[]>` method on the credential provider (wire it through the existing `list` API).

**Step 3 — Run + commit.**

**Commit:** `feat(skills): load reconciler current-state from host providers`

---

### Task 4: Reconcile orchestrator (`src/host/skills/reconcile-orchestrator.ts`)

**Files:**
- Create: `src/host/skills/reconcile-orchestrator.ts`
- Create: `tests/host/skills/reconcile-orchestrator.test.ts`

**Step 1 — Failing test:** full wiring using the real snapshot builder against a temp bare repo + an in-memory state store + a fake event bus. Commit a valid `SKILL.md`, invoke `reconcileAgent('agent-1','refs/heads/main', deps)`, assert:
- `stateStore.getPriorStates('agent-1')` returns the new state.
- `eventBus.emit` was called with `skill.installed` and `skill.pending` (credentials are missing in the stubbed setup).
- Return value matches `{ skills: 1, events: 2 }`.

**Step 2 — Minimal impl:** wire per the contract above. Use a try/catch around `reconcile()` that logs and returns `{skills:0,events:0}` on failure — push-time hook must never 500 the push.

**Step 3 — Run + commit.**

**Commit:** `feat(skills): reconcile orchestrator wires snapshot → reconcile → persist/emit`

---

### Task 5: Hook endpoint handler (`src/host/skills/hook-endpoint.ts`)

**Files:**
- Create: `src/host/skills/hook-endpoint.ts`
- Create: `tests/host/skills/hook-endpoint.test.ts`

**Step 1 — Failing tests (three):**
1. Missing/invalid HMAC → 401, orchestrator NOT called.
2. Invalid body (fails Zod) → 400, orchestrator NOT called.
3. Valid signed request → 200, orchestrator called with `(agentId, ref)`.

**Step 2 — Minimal impl:**
- Zod schema: `z.object({ agentId: z.string().min(1), ref: z.string().min(1), oldSha: z.string(), newSha: z.string() }).strict()`.
- HMAC check: `crypto.createHmac('sha256', secret).update(rawBody).digest('hex')` vs signature after `sha256=` prefix. Use `crypto.timingSafeEqual`.
- On success: call `orchestrator(agentId, ref)` and return its counts.

**Step 3 — Run + commit.**

**Commit:** `feat(skills): HMAC-guarded reconcile HTTP endpoint`

---

### Task 6: Mount route in request handler

**Files:**
- Modify: `src/host/server-request-handlers.ts` — add handler dispatch.
- Modify: `src/host/server.ts` — construct deps (orchestrator, hook secret) and pass to `createRequestHandler`.
- Modify: `tests/host/server-request-handlers.test.ts` (existing; add or create if absent) — integration test: POST with valid signature hits orchestrator; invalid → 401.

**Step 1 — Failing test** through the whole `createRequestHandler` pipeline.

**Step 2 — Impl:**
- Add `reconcileHookHandler?: (req, res) => Promise<void>` to `RequestHandlerOpts`.
- In the dispatcher (before the generic 404): `if (url === '/v1/internal/skills/reconcile' && req.method === 'POST' && reconcileHookHandler) { await reconcileHookHandler(req,res); return; }`.
- In `server.ts createServer`, build the orchestrator deps once at startup and pass the wrapped handler.

**Step 3 — Commit:** `feat(skills): mount /v1/internal/skills/reconcile`

---

### Task 7: Hook installer (`src/providers/workspace/install-hook.ts`)

**Files:**
- Create: `src/providers/workspace/hooks/post-receive.sh` (raw template with `__AGENT_ID__` placeholder).
- Create: `src/providers/workspace/install-hook.ts` — `export function installPostReceiveHook(bareRepoPath, agentId)`.
- Create: `tests/providers/workspace/install-hook.test.ts`.

**Step 1 — Failing test:** given a temp bare repo, call `installPostReceiveHook`, assert:
- `hooks/post-receive` exists with 0o755 perms.
- Placeholder `__AGENT_ID__` replaced.
- Running it a second time overwrites (idempotent).

**Step 2 — Impl:**
- Read template once at module load (via `readFileSync` of the co-located `.sh` — use a `import.meta.url`-based path).
- `writeFileSync(hookPath, substituted, {mode: 0o755})`.
- `safePath(bareRepoPath, 'hooks', 'post-receive')` for the path.

**Step 3 — Commit:** `feat(workspace): reusable post-receive hook installer`

---

### Task 8: Wire git-local to install the hook

**Files:**
- Modify: `src/providers/workspace/git-local.ts` — call `installPostReceiveHook` after `git init --bare` succeeds.
- Modify: `tests/providers/workspace/git-local.test.ts` — assert hook file present.

**Step 1 — Failing test** against existing `create(config).getRepoUrl('agent-x')`.

**Step 2 — Impl:** one new call after the existing `execFileSync('git', ['init', '--bare', repoPath])`.

**Step 3 — Commit:** `feat(workspace): install reconcile hook in git-local bare repos`

---

### Task 9: git-http server installs the hook

**Files:**
- Modify: `container/git-server/http-server.js` — after `git init --bare` + initial commit succeed, write `hooks/post-receive` using an identical template. Keep the template inline in the JS file (container doesn't share source with host).
- Modify (optional): Helm values to expose `AX_HOST_URL` and `AX_HOOK_SECRET` to the git-server container.
- Create: `tests/container/git-server/hook-install.test.js` OR a unit test that shell-execs the script creation path — or if too integration-heavy, skip the unit test and rely on acceptance.

**Step 1 — Failing test (unit, if feasible):** mock the fs; otherwise run `http-server.js` in a child process with a temp `GIT_REPOS_PATH`, POST to `/repos`, assert the created bare repo has an executable `hooks/post-receive`.

**Step 2 — Impl:** Add template constant + post-init installer inside the `/repos` handler (after the `git push -u origin main` step; before the 201 response).

**Step 3 — Commit:** `feat(git-server): install reconcile hook on repo create`

---

### Task 10: End-to-end smoke test

**Files:**
- Create: `tests/host/skills/e2e-reconcile.test.ts`

**Step 1 — Failing test:** spin up the full orchestrator + hook endpoint in-process, create a bare repo via a mini git-local instance, install the hook pointed at the in-process host, clone into a temp work-tree, commit a valid `.ax/skills/demo/SKILL.md`, push, wait for the hook to fire, assert:
- Event bus received `skill.installed` + state kind matches.
- `stateStore.getPriorStates('agent-1')` has `demo`.

**Step 2 — Impl:** no new code — this validates the full wire. If it fails, fix the real code (not the test).

**Step 3 — Commit:** `test(skills): end-to-end hook → reconcile → state + event`

---

## Post-phase checklist

- [ ] Run full test suite: `npm test`
- [ ] Build: `npm run build`
- [ ] Journal entry under `.claude/journal/host/` (or a new `skills/` subdir if appropriate).
- [ ] Lessons entry if any non-obvious learnings (sqlite migration ordering, git hook perms on macOS, HMAC subtleties).
- [ ] Update `.claude/journal/docs/index.md` with a reference to this plan.
- [ ] Open PR stacked on phase 1 (or — if phase 1 is merged first — against `main`).

**Next plan:** `docs/plans/2026-04-16-phase3-skills-prompt-index.md` — new `skills_index` IPC action and prompt-module switch from DB to IPC.
