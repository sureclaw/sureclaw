# Phase 5 — Dashboard Setup Cards (API-Key Path Only) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Fresh implementer subagent per task + two-stage review (spec, then code quality).

**Goal:** Dashboard "Skills" page lists pending-skill setup cards (from phase 2's `skill_setup_queue`) and ad-hoc credential request cards. One-click atomic approval: approves all selected domains + stores all credentials + re-triggers reconcile so the skill transitions to enabled.

**Scope:** API-key path only. OAuth is phase 6. Keep existing `ConnectorsPage` (MCP admin) untouched — phase 7 cleanup removes it. Add a new `SkillsPage` alongside, wired into the sidebar as the primary credentials UX.

**Architecture:** React page ↔ 4 new admin endpoints under the existing `/admin/api/*` prefix (NOT `/v1/admin/*` as the high-level plan said — the host's admin handler lives under `/admin/api` and we follow the established convention):

- `GET /admin/api/skills/setup` — pending setup cards, grouped by agent.
- `POST /admin/api/skills/setup/approve` — atomic: validate → write credentials → approve domains → re-reconcile → return new skill state.
- `DELETE /admin/api/skills/setup/:agentId/:skillName` — dashboard-only dismissal; does not touch the repo or skill_states; if the skill is still pending on next reconcile, the card reappears.
- `GET /admin/api/credentials/requests` — snapshot of ad-hoc `request_credential` entries from a new in-memory queue (phase-2 request_credential keeps working; this exposes the queue to the dashboard).

---

## Architecture constraints (read once, apply everywhere)

- **No credentials in logs, URLs, SSE.** Always POST bodies over the authed admin channel. Never echo `value` back.
- **Atomic approve:** validate all inputs first; only then write any credential or approve any domain. If validation fails, nothing is applied.
- **Admin identity → userId:** The admin handler does not currently propagate a per-user identity. For credentials with `scope: 'user'`, the request body carries an explicit `userId`, defaulting server-side to `config.default_user_id` if present, else the literal string `'admin'`. When a better identity pipe lands, this becomes a plumbing change in one spot.
- **Re-reconcile:** use `refs/heads/main` — same convention `startup-rehydrate.ts` uses. The orchestrator already tolerates missing repos (logs + emits `skills.reconcile_failed`), so this is safe even for agents that haven't been pushed to.
- **Tests:** TDD strictly. Each endpoint gets a failing test, then implementation. Backend tests in `tests/host/server-admin-skills.test.ts` (new). UI tests in `ui/admin/tests/skills.spec.ts` (new, Playwright + route mocking).
- **Voice:** user-facing strings in the React page should match the "nervous crab behind competent claws" tone per CLAUDE.md. Short sentences.

---

## Task 1 — Extend `AdminDeps` + wire reconcile bridge

**Files:**
- Modify: `src/host/server-admin.ts` (AdminDeps interface)
- Modify: `src/host/server-webhook-admin.ts` (AdminSetupOpts + setupAdminHandler)
- Modify: `src/host/server.ts` (call site for setupAdminHandler)
- Test: `tests/host/server-admin.test.ts` (extend existing mock deps)

**Step 1: Write failing test** — add to `tests/host/server-admin.test.ts` a case that constructs `createAdminHandler` with `stateStore` + `reconcileAgent` optional deps present (using a stub), asserts the handler can be constructed and a basic status call still returns 200. This enforces back-compat.

**Step 2: Run test, expect FAIL** (new fields not yet in AdminDeps, TS error).

**Step 3: Implement**

In `src/host/server-admin.ts`:
```ts
export interface AdminDeps {
  // ... existing ...
  /** Phase 5: persisted skill setup queue. When absent, skills endpoints 503. */
  skillStateStore?: import('./skills/state-store.js').SkillStateStore;
  /** Phase 5: re-trigger reconcile after approve. When absent, skills endpoints 503. */
  reconcileAgent?: (agentId: string, ref: string) => Promise<{ skills: number; events: number }>;
  /** Default user ID for credentials with scope='user' when the request doesn't specify one. */
  defaultUserId?: string;
}
```

In `src/host/server-webhook-admin.ts`: mirror the three new optional fields into `AdminSetupOpts`, pass through in `setupAdminHandler`.

In `src/host/server.ts`: pass `skillStateStore: stateStore`, `reconcileAgent: stateStore ? (agentId, ref) => reconcileAgent(agentId, ref, orchestratorDeps) : undefined`, and `defaultUserId` into `setupAdminHandler`.

**Step 4: Run tests** — `npx vitest run tests/host/server-admin.test.ts` — expect PASS.

**Step 5: Commit** — `feat(admin): extend AdminDeps with skill state store + reconcile bridge`

---

## Task 2 — `GET /admin/api/skills/setup` endpoint

**Files:**
- Modify: `src/host/server-admin.ts` (route dispatch + handler)
- Test: `tests/host/server-admin-skills.test.ts` (new)

**Response shape:**
```json
{
  "agents": [
    {
      "agentId": "main",
      "agentName": "Main Agent",
      "cards": [ SetupRequest, ... ]
    }
  ]
}
```

**Step 1: Write failing test** — new file `tests/host/server-admin-skills.test.ts`. Set up deps with a stub `skillStateStore` whose `getSetupQueue(agentId)` returns a known SetupRequest. Register 2 agents. Hit `GET /admin/api/skills/setup` with the admin token. Expect 200 + correct grouping (one entry per agent, cards array matches).

Also test: when `skillStateStore` is absent, endpoint returns 503 with `{ error: 'Skills not configured' }`.

**Step 2: Run test, expect FAIL** (endpoint not yet routed).

**Step 3: Implement** — in `handleAdminAPI`, add:
```ts
if (pathname === '/admin/api/skills/setup' && method === 'GET') {
  if (!deps.skillStateStore) { sendError(res, 503, 'Skills not configured'); return; }
  const agents = await deps.agentRegistry.list('active');
  const out: Array<{ agentId: string; agentName: string; cards: SetupRequest[] }> = [];
  for (const a of agents) {
    const cards = await deps.skillStateStore.getSetupQueue(a.id);
    if (cards.length > 0) out.push({ agentId: a.id, agentName: a.name, cards });
  }
  sendJSON(res, { agents: out });
  return;
}
```

Skip agents with empty queues so the dashboard doesn't show noise.

**Step 4: Run test, expect PASS.**

**Step 5: Commit** — `feat(admin): GET /admin/api/skills/setup lists pending cards`

---

## Task 3 — `POST /admin/api/skills/setup/approve` endpoint (atomic)

**Files:**
- Create: `src/host/server-admin-skills-helpers.ts` (approveSkillSetup helper + Zod schemas)
- Modify: `src/host/server-admin.ts` (route)
- Test: `tests/host/server-admin-skills.test.ts` (extend)

**Body schema (Zod strict):**
```ts
const ApproveBodySchema = z.object({
  agentId: z.string().min(1),
  skillName: z.string().min(1),
  credentials: z.array(z.object({
    envName: z.string().min(1),
    value: z.string().min(1),
  })).default([]),
  approveDomains: z.array(z.string().min(1)).default([]),
  userId: z.string().optional(),
}).strict();
```

**Behavior — validate-all, then apply-all:**

1. Zod-parse body. Invalid → 400.
2. Look up the SetupRequest for `(agentId, skillName)` from `skillStateStore.getSetupQueue`. Not found → 404 `{ error: 'No pending setup for this skill' }`.
3. Cross-check: every `credentials[].envName` must appear in the card's `missingCredentials`; every `approveDomains[i]` must appear in the card's `unapprovedDomains`. Mismatch → 400 `{ error: 'Request does not match pending setup', details: '...' }`. Rejects clients trying to set arbitrary credentials through this endpoint.
4. Apply credentials: for each, find its entry in `card.missingCredentials`, use that entry's `scope` and `authType`. For `scope: 'user'`, compute `credentialScope(agentName, userId ?? deps.defaultUserId ?? 'admin')`. For `scope: 'agent'`, `credentialScope(agentName)`. Call `deps.providers.credentials.set(envName, value, scope)`.
5. Apply domains: `deps.domainList!.approvePending(domain)` for each. (ApproveSpending adds to adminApproved; works whether the domain was queued as pending or not.)
6. Re-reconcile: `await deps.reconcileAgent(agentId, 'refs/heads/main')`.
7. Audit: emit one audit entry with `action: 'skill_approved', args: { agentId, skillName, domains: approveDomains, envNames: credentials.map(c => c.envName) }`. Do NOT log credential values.
8. Read fresh state: `const states = await deps.skillStateStore.getStates(agentId); const state = states.find(s => s.name === skillName);`. Return `{ ok: true, state }`.

**When required deps missing (`!deps.skillStateStore || !deps.reconcileAgent || !deps.domainList`):** return 503 `{ error: 'Skills not configured' }`.

**Helper file** (`src/host/server-admin-skills-helpers.ts`): extract the non-HTTP logic into `approveSkillSetup(deps, body): Promise<{ ok: true; state: SkillState } | { ok: false; status: number; error: string; details?: string }>` so the route handler is thin and the logic is unit-testable in isolation.

**Step 1: Write failing tests** — add cases to `server-admin-skills.test.ts`:
- happy path: creates pending card with 1 missing cred + 1 unapproved domain; approve with both; assert cred stored at right scope (query credentials provider), domain in `domainList.getAllowedDomains()`, reconcile called, response `{ ok: true, state }` includes updated state.
- mismatch: card requires `LINEAR_TOKEN`; approve body sends `RANDOM_CRED`. Expect 400 + no credentials stored.
- domain mismatch: approve body includes a domain not in `unapprovedDomains`. Expect 400.
- skill not found: no setup row matches; expect 404.
- missing deps: `skillStateStore` undefined → 503.

**Step 2-4:** Implement `approveSkillSetup` helper + wire route. Run tests.

**Step 5: Commit** — `feat(admin): atomic skill setup approval endpoint`

---

## Task 4 — `DELETE /admin/api/skills/setup/:agentId/:skillName`

**Files:**
- Modify: `src/host/server-admin.ts` (route)
- Test: `tests/host/server-admin-skills.test.ts` (extend)

**Behavior:** reads setup queue for the agent, filters out the skill by name, writes back via `putSetupQueue`. Emits a `skill_dismissed` audit entry. Returns `{ ok: true, removed: boolean }`. `removed: false` when the skill wasn't in the queue (idempotent dismiss).

**Step 1: Write failing test** — assert that after DELETE the specific skill is gone from the queue but other skills remain. Assert 404 removed=false when the skill doesn't exist (we still return 200 for idempotency; use `{ ok: true, removed: false }`).

**Step 2-4:** Implement route with `pathname.match(/^\/admin\/api\/skills\/setup\/([^/]+)\/([^/]+)$/)` and method DELETE. Decode each segment.

**Step 5: Commit** — `feat(admin): dismiss-skill endpoint`

---

## Task 5 — Credential-request queue + `GET /admin/api/credentials/requests`

**Context:** `request_credential` today emits `credential.required` events but the host has no server-side queue. We create one — small in-memory Map keyed by `sessionId` — so the dashboard can show ad-hoc requests. Existing `POST /admin/api/credentials/provide` dequeues on success.

**Files:**
- Create: `src/host/credential-request-queue.ts` (new module)
- Modify: `src/host/server.ts` or wherever the event bus is set up — add a subscriber to `credential.required` that enqueues
- Modify: `src/host/server-admin.ts` (new GET endpoint + dequeue on provide)
- Test: `tests/host/credential-request-queue.test.ts` (new) + test GET endpoint in `server-admin-skills.test.ts`

**Queue API:**
```ts
export interface CredentialRequest {
  sessionId: string;
  envName: string;
  agentName: string;
  userId?: string;
  createdAt: number;
}

export interface CredentialRequestQueue {
  enqueue(req: CredentialRequest): void;
  /** Remove matching entries (same sessionId + envName). Returns number removed. */
  dequeue(sessionId: string, envName: string): number;
  snapshot(): CredentialRequest[];
}

export function createCredentialRequestQueue(): CredentialRequestQueue;
```

Keyed internally by `${sessionId}:${envName}` to dedup repeated requests.

**Wiring:**
- Subscribe to event bus for `credential.required` events; call `enqueue` with data from the event.
- `POST /admin/api/credentials/provide`: after `credentials.set` succeeds, call `dequeue(sessionId, envName)`.
- `GET /admin/api/credentials/requests`: returns `queue.snapshot()`.

**Tests:** unit test for the queue module (enqueue, dedup, dequeue, snapshot isolation). HTTP test verifying provide dequeues.

**Step 1-5:** Standard TDD loop + commit `feat(admin): ad-hoc credential request queue + GET endpoint`

---

## Task 6 — React `SkillsPage` component

**Files:**
- Create: `ui/admin/src/components/pages/skills-page.tsx`
- Modify: `ui/admin/src/lib/api.ts` (add `skillsSetup`, `approveSkill`, `dismissSkill`, `credentialRequests` functions)
- Modify: `ui/admin/src/lib/types.ts` (add `SkillSetupResponse`, `SetupCard`, `SkillStateView` types)
- Test: `ui/admin/tests/skills.spec.ts` (new, Playwright + route mocking)

**Layout:**
```
Skills (page header)
  > (short description: "Skills your agents have installed. Approve domains and credentials to turn them on.")
  > [Refresh button]

  ── Setup Required ──
    Group: Main Agent (agentId)
      ┌─ Linear ─────────────────────────────────────┐
      │ Description line…                            │
      │                                              │
      │ Network access                               │
      │ ☑ api.linear.app                             │
      │ ☑ mcp.linear.app                             │
      │                                              │
      │ Credentials                                  │
      │ LINEAR_TOKEN  (user-scoped)                  │
      │ [password input — "Paste your token here"]   │
      │                                              │
      │ MCP servers (read-only)                      │
      │ • linear → https://mcp.linear.app            │
      │                                              │
      │ [Dismiss]           [Approve & enable]       │
      └──────────────────────────────────────────────┘

  ── Credential Requests ── (only when queue non-empty)
    Session sess-abc  Agent: main
    ENV_NAME  [paste field]  [Save]
```

**Behavior:**
- On mount, fetch `GET /admin/api/skills/setup` + `GET /admin/api/credentials/requests`.
- Per-card state: domain checkboxes (all pre-checked), credential paste values (empty), submitting flag.
- Approve button disabled until all checked-domain/credential pairs have been provided (empty input = disabled for that cred). All checkboxes must be checked too — if the user unchecks a domain, show a warning "Unchecking removes it from this approval; the skill will stay pending" but still allow.
- On approve success: show inline "Enabled ✓" for 1.5s, then refresh the whole list (skill drops off the pending list).
- On approve error: show error banner inside the card with the server's error message.
- Dismiss: confirm-click (like ConnectorsPage's delete), then call DELETE.

**No OAuth UI in this phase.** If a credential in a card has `authType: 'oauth'`, show a disabled stub: "OAuth setup — coming in phase 6" and the card's Approve button disables. (This is the "API-key path only" scope.)

**Step 1: Write failing Playwright test** — mock the four endpoints, navigate to `/skills`, assert heading, assert one skill card rendered with expected fields, assert Approve click posts the right body, assert success UI.

**Step 2-4:** Implement. Hit the page in `npm run dev` and click through manually (per CLAUDE.md guidance: "For UI or frontend changes, start the dev server and use the feature in a browser"). Then run Playwright.

**Step 5: Commit** — `feat(admin-ui): SkillsPage with atomic approve flow`

---

## Task 7 — Sidebar wiring

**Files:**
- Modify: `ui/admin/src/App.tsx`

**Change:** add `{ id: 'skills', label: 'Skills', icon: Sparkles }` to `NAV_ITEMS` between Agents and Connectors. Import `Sparkles` from lucide-react. Render `<SkillsPage />` when `activePage === 'skills'`.

**Step 1: Playwright test in `ui/admin/tests/navigation.spec.ts`** — clicking Skills shows the Skills heading. Existing navigation test adds the new nav item visibility assertion.

**Step 2-4:** Implement. Verify by clicking through the dev server.

**Step 5: Commit** — `feat(admin-ui): wire Skills page into sidebar`

---

## Task 8 — End-to-end Playwright against kind-ax (verification)

**Context:** The user explicitly authorized using `kind-ax` + Playwright for verification. This is a manual verification task, not a test-suite addition. We run it once to confirm the whole flow works against a real host + postgres + git-http server.

**Files:** none — this is verification, but we write a short Journal entry documenting the walkthrough.

**Walkthrough:**

1. Port-forward the dashboard from `kind-ax`: `kubectl -n ax port-forward svc/ax-host 8080:8080`.
2. Confirm the host has the phase-5 code — the kind cluster is running the pre-phase-5 image, so either rebuild + redeploy (`docker buildx ... | kind load docker-image ...` into `kind-ax`, then `kubectl rollout restart`), OR skip the cluster leg and use a local `npm start` against a local postgres for the verification. Rebuild path is preferred but the fallback is noted because image rebuild on macOS Apple Silicon into kind can be flaky.
3. In the dashboard, navigate to Skills. Initially empty.
4. From a separate terminal, simulate a skill install:
   - Clone the agent's git-http repo locally (the host exposes an auth'd git endpoint via ax-git pod).
   - Write `.ax/skills/weather-demo/SKILL.md` with `domains: [api.open-meteo.com]` and `credentials: [{ envName: DEMO_TOKEN, authType: api_key, scope: user }]`.
   - Commit + push. Post-receive hook fires.
5. Refresh the Skills page. Expect a "weather-demo" card with domain checkbox + credential field.
6. Paste a fake token, click Approve.
7. Verify in the dashboard:
   - Card disappears from pending.
   - Domain is in the allowed list (Security → proxy domains OR via `/admin/api/proxy/domains`).
8. Verify in the backing DB (via `kubectl exec ax-postgresql-0 -- psql ...`):
   - `skill_states` shows `weather-demo` as `enabled`.
   - `skill_setup_queue` is empty for this agent.

**If kind rebuild is too heavy:** run locally with `npm start` pointed at a temporary SQLite path, simulate a push via a local bare repo + hook installer from phase 2, and verify the same end-state. Record which path was used in the journal entry.

**Step 5: Commit** — `docs(skills): phase 5 verification walkthrough`

---

## Task 9 — Documentation & housekeeping

**Files:**
- Modify: `.claude/skills/ax/host.md` (new Skills page endpoints + queue reference)
- Modify: `docs/plans/2026-04-16-git-native-skills-design.md` (rollout status — phase 5 shipped)
- Append: `.claude/journal/host/skills.md` with phase 5 landing entry
- Append: `.claude/lessons/host/entries.md` with any new lessons (e.g. the "atomic approve = validate-all-then-apply-all" pattern, or identity-plumbing short-circuit)
- Only if touched: `docs/web/` content

**Step 1-4:** Read current `host.md`, add a short "Skills admin endpoints" subsection. Add `{ 2026-04-17 ... }` journal entry. Update design doc rollout status.

**Step 5: Commit** — `docs(skills): phase 5 — dashboard setup cards`

---

## After all tasks

- Dispatch final code-reviewer subagent across the full branch.
- Use `superpowers:finishing-a-development-branch` to decide on PR → `main` vs merge path.

---

## Files touched (summary)

**Backend:**
- `src/host/server-admin.ts` (M)
- `src/host/server-admin-skills-helpers.ts` (N)
- `src/host/server-webhook-admin.ts` (M)
- `src/host/server.ts` (M)
- `src/host/credential-request-queue.ts` (N)
- `tests/host/server-admin.test.ts` (M)
- `tests/host/server-admin-skills.test.ts` (N)
- `tests/host/credential-request-queue.test.ts` (N)

**UI:**
- `ui/admin/src/App.tsx` (M)
- `ui/admin/src/components/pages/skills-page.tsx` (N)
- `ui/admin/src/lib/api.ts` (M)
- `ui/admin/src/lib/types.ts` (M)
- `ui/admin/tests/skills.spec.ts` (N)
- `ui/admin/tests/navigation.spec.ts` (M)
- `ui/admin/tests/fixtures.ts` (M — add MOCK_SKILL_SETUP + mock helpers)

**Docs:**
- `.claude/skills/ax/host.md` (M)
- `.claude/journal/host/skills.md` (append)
- `.claude/lessons/host/entries.md` (append if lessons emerge)
- `docs/plans/2026-04-16-git-native-skills-design.md` (M — rollout status)

**Not touched this phase** (phase 7 cleanup):
- `ui/admin/src/components/pages/connectors-page.tsx` (stays; used for global admin MCP)
- `src/plugins/` removal
- `src/cli/plugin.ts` / `src/cli/mcp.ts` removal

---

## Execution note

We're in a dedicated worktree (`.worktrees/skills-phase5`, branch `feat/skills-phase5-dashboard`). TDD strictly per CLAUDE.md. Frequent commits per task. Journal + lessons updates land in the same commit as the task that produced them.
