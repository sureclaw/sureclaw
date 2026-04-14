# Remove `agents/` and `cache/` Directories from `~/.ax/`

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the `~/.ax/agents/` and `~/.ax/cache/` directories by moving all state they contain into the database (DocumentStore / AgentRegistry).

**Architecture:** Admin state (admins list, bootstrap claim) moves into the AgentRegistry DB. Bootstrap detection and template seeding move to DocumentStore-only (drop filesystem copies). HEARTBEAT.md is read from DocumentStore. The MITM CA keypair moves under `~/.ax/data/ca/`. ClawHub cache uses in-memory-only caching (drop filesystem cache). The `agents/` path helpers and `agentDirVal` plumbing are removed from server-init, server-local, server-channels, and server-request-handlers.

**Tech Stack:** TypeScript, Vitest, Kysely (SQLite/PostgreSQL), Zod

---

### Task 1: Move admin helpers from filesystem to AgentRegistry

The admin helpers (`isAdmin`, `addAdmin`, `claimBootstrapAdmin`, `isAgentBootstrapMode`) currently use filesystem files. Move them to use the AgentRegistry (database-backed) and DocumentStore.

**Files:**
- Modify: `src/host/server-admin-helpers.ts`
- Test: `tests/host/admin-gate.test.ts`

**Step 1: Rewrite server-admin-helpers.ts to use AgentRegistry + DocumentStore**

The helpers need to become async and accept registry/document dependencies instead of filesystem paths.

```typescript
// src/host/server-admin-helpers.ts
import type { AgentRegistry } from './agent-registry.js';
import type { DocumentStore } from '../providers/storage/types.js';

export interface AdminContext {
  registry: AgentRegistry;
  documents: DocumentStore;
  agentId: string;
}

/** Returns true when the agent is still in bootstrap mode (missing SOUL.md or IDENTITY.md while BOOTSTRAP.md present). */
export async function isAgentBootstrapMode(ctx: AdminContext): Promise<boolean> {
  const { documents, agentId } = ctx;
  const bootstrap = await documents.get('identity', `${agentId}/BOOTSTRAP.md`);
  if (!bootstrap) return false;
  const soul = await documents.get('identity', `${agentId}/SOUL.md`);
  const identity = await documents.get('identity', `${agentId}/IDENTITY.md`);
  return !soul || !identity;
}

/** Returns true when the given userId is an admin for this agent. */
export async function isAdmin(ctx: AdminContext, userId: string): Promise<boolean> {
  const entry = await ctx.registry.get(ctx.agentId);
  if (!entry) return false;
  return entry.admins.includes(userId);
}

/** Adds a userId to the agent's admins list. */
export async function addAdmin(ctx: AdminContext, userId: string): Promise<void> {
  const entry = await ctx.registry.get(ctx.agentId);
  if (!entry) return;
  if (entry.admins.includes(userId)) return;
  await ctx.registry.update(ctx.agentId, {});
  // AgentRegistry doesn't have an addAdmin method yet — we need to add one
  // or use a direct DB update. For now, use the admins array on the entry.
}

/**
 * Atomically claims the bootstrap admin slot for the given userId.
 * Returns true if this user is the first to claim.
 */
export async function claimBootstrapAdmin(ctx: AdminContext, userId: string): Promise<boolean> {
  const entry = await ctx.registry.get(ctx.agentId);
  if (!entry) return false;

  // Check if bootstrap already claimed (any non-system admin exists)
  const nonSystemAdmins = entry.admins.filter(a => a !== 'system' && a !== (process.env.USER ?? 'default'));
  if (nonSystemAdmins.length > 0) return false;

  // Add this user as admin
  if (!entry.admins.includes(userId)) {
    const newAdmins = [...entry.admins, userId];
    // Need to update admins in registry — add updateAdmins method
  }
  return true;
}
```

Note: The AgentRegistry interface needs an `updateAdmins` method. This is handled in Task 2.

**Step 2: Run existing tests to establish baseline**

Run: `npm test -- --run tests/host/admin-gate.test.ts`
Expected: All tests PASS (current state)

**Step 3: Commit**

```bash
git add src/host/server-admin-helpers.ts
git commit -m "refactor: move admin helpers from filesystem to AgentRegistry + DocumentStore"
```

---

### Task 2: Add `updateAdmins` and `getBootstrapClaim` to AgentRegistry

The AgentRegistry needs methods to atomically manage admin lists and bootstrap claims.

**Files:**
- Modify: `src/host/agent-registry.ts` (interface)
- Modify: `src/host/agent-registry-db.ts` (implementation)
- Test: `tests/host/admin-gate.test.ts`

**Step 1: Add methods to AgentRegistry interface**

```typescript
// In agent-registry.ts, add to the AgentRegistry interface:
  /** Atomically add a userId to an agent's admins list. Returns false if already present. */
  addAdmin(agentId: string, userId: string): Promise<boolean>;

  /** Atomically claim bootstrap admin. Returns true if this is the first claim. */
  claimBootstrapAdmin(agentId: string, userId: string): Promise<boolean>;
```

**Step 2: Implement in agent-registry-db.ts**

Read `src/host/agent-registry-db.ts` to understand the DB implementation, then add:

- `addAdmin`: read current admins JSON array, check if userId exists, append if not, update row
- `claimBootstrapAdmin`: check if any non-default admin exists, if not add userId atomically

**Step 3: Update admin-gate tests to use the new interface**

Rewrite `tests/host/admin-gate.test.ts` unit tests for `isAdmin`, `addAdmin`, `claimBootstrapAdmin`, `isAgentBootstrapMode` to use in-memory SQLite-backed AgentRegistry + DocumentStore instead of filesystem temp dirs.

**Step 4: Run tests**

Run: `npm test -- --run tests/host/admin-gate.test.ts`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/host/agent-registry.ts src/host/agent-registry-db.ts src/host/server-admin-helpers.ts tests/host/admin-gate.test.ts
git commit -m "feat: add admin management methods to AgentRegistry, move admin state from filesystem to DB"
```

---

### Task 3: Remove filesystem template seeding from server-init.ts

Template seeding currently writes to both filesystem AND DocumentStore. Remove all filesystem writes and directory creation for `agents/`.

**Files:**
- Modify: `src/host/server-init.ts`
- Modify: `src/host/server-init.ts` (remove `agentDirVal`, `identityFilesDir` from HostCore)

**Step 1: Remove agent directory creation and filesystem template seeding**

In `server-init.ts`:
- Remove `mkdirSync(agentDirVal, ...)`, `mkdirSync(agentConfigDir, ...)`, `mkdirSync(identityFilesDir, ...)`
- Remove all `existsSync`/`copyFileSync` calls that write to `identityFilesDir` and `agentConfigDir`
- Keep the DocumentStore seeding (it's already there)
- Remove `config.scheduler.agent_dir = identityFilesDir` (handled in Task 5)
- Remove `persistentSkillsDir` mkdir and skill seeding to filesystem (skills are already in DocumentStore)
- Remove `adminsPath` / `writeFileSync(adminsPath, ...)` (moved to DB in Task 2)
- Remove `agentDirVal` and `identityFilesDir` from the `HostCore` return type
- Keep `agentId` in the return type

**Step 2: Create AdminContext in server-init and add to HostCore**

Add an `AdminContext` (from Task 1) to `HostCore` so callers can use the DB-backed admin helpers:

```typescript
// In HostCore interface, replace agentDirVal + identityFilesDir with:
adminCtx: AdminContext;
```

**Step 3: Run tests**

Run: `npm test -- --run tests/host/server.test.ts`
Expected: PASS (may need adjustments)

**Step 4: Commit**

```bash
git add src/host/server-init.ts
git commit -m "refactor: remove filesystem agent directory creation and template seeding from server-init"
```

---

### Task 4: Update server-local.ts, server-channels.ts, server-request-handlers.ts

These files pass `agentDirVal` around for admin checks. Update them to use `AdminContext`.

**Files:**
- Modify: `src/host/server-local.ts`
- Modify: `src/host/server-channels.ts`
- Modify: `src/host/server-request-handlers.ts`

**Step 1: Update server-local.ts**

- Remove the entire legacy migration block (lines 116-151 that move files between agent subdirectories)
- Remove `agentDirVal` and `identityFilesDir` destructuring from `initHostCore()` result
- Replace `isAdmin(agentDirVal, userId)` / `claimBootstrapAdmin(agentDirVal, userId)` calls with `await isAdmin(adminCtx, userId)` / `await claimBootstrapAdmin(adminCtx, userId)`
- Remove `agentDirVal` from `createRequestHandler()` call
- Remove `agentDir: agentDirVal` from `registerChannelHandler()` calls
- Remove the `USER_BOOTSTRAP.md` filesystem copy block

**Step 2: Update server-channels.ts**

- Remove `agentDir: string` from `ChannelHandlerDeps`
- Change `isAdmin` and `claimBootstrapAdmin` signatures to use `AdminContext`
- Update `registerChannelHandler` to use async admin calls

**Step 3: Update server-request-handlers.ts**

- Remove `agentDirVal` from `CompletionHandlerOpts` and `RequestHandlerOpts`
- Pass `AdminContext` instead for bootstrap/admin checks

**Step 4: Run tests**

Run: `npm test -- --run tests/host/`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-local.ts src/host/server-channels.ts src/host/server-request-handlers.ts
git commit -m "refactor: remove agentDirVal plumbing, use DB-backed AdminContext for admin checks"
```

---

### Task 5: Move HEARTBEAT.md reading to DocumentStore in scheduler

The plainjob scheduler reads `HEARTBEAT.md` from the filesystem via `config.scheduler.agent_dir`. Move this to read from DocumentStore.

**Files:**
- Modify: `src/providers/scheduler/plainjob.ts`
- Modify: `src/types.ts` (remove `agent_dir` from scheduler config)
- Modify: `src/config.ts` (remove `agent_dir` from schema)

**Step 1: Pass DocumentStore + agentId to scheduler instead of agent_dir**

In `plainjob.ts`, change the `emitHeartbeat()` function:

```typescript
// Before:
if (agentDir) {
  try {
    const md = readFileSync(join(agentDir, 'HEARTBEAT.md'), 'utf-8');
    if (md.trim()) content = md;
  } catch { /* no HEARTBEAT.md — use default */ }
}

// After:
if (documents) {
  try {
    const md = await documents.get('identity', `${agentName}/HEARTBEAT.md`);
    if (md?.trim()) content = md;
  } catch { /* no HEARTBEAT.md — use default */ }
}
```

Pass `documents` (DocumentStore) into the scheduler via its deps or config. Remove `agent_dir` from scheduler config type and Zod schema.

**Step 2: Remove `config.scheduler.agent_dir` assignment from server-init.ts**

The line `config.scheduler.agent_dir = identityFilesDir;` in server-init.ts should already be removed in Task 3. Verify it's gone.

**Step 3: Run tests**

Run: `npm test -- --run tests/providers/scheduler/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/providers/scheduler/plainjob.ts src/types.ts src/config.ts src/host/server-init.ts
git commit -m "refactor: read HEARTBEAT.md from DocumentStore instead of filesystem"
```

---

### Task 6: Move MITM CA from agents/ to data/

The CA keypair is stored at `~/.ax/agents/<agentId>/ca/`. Move it to `~/.ax/data/ca/`.

**Files:**
- Modify: `src/host/server-completions.ts` (line 820)

**Step 1: Change CA directory path**

```typescript
// Before:
const caDir = join(agentDir(agentId), 'ca');

// After:
const caDir = join(dataDir(), 'ca');
```

This is a one-line change. The CA is not per-agent (there's only one MITM proxy).

**Step 2: Run tests**

Run: `npm test -- --run tests/host/`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "refactor: move MITM CA from agents/ to data/ directory"
```

---

### Task 7: Update bootstrap CLI to use DocumentStore

The `ax bootstrap` command (`src/cli/bootstrap.ts`) currently deletes/writes filesystem identity files. Update it to operate on DocumentStore.

**Files:**
- Modify: `src/cli/bootstrap.ts`

**Step 1: Rewrite resetAgent to use DocumentStore**

The bootstrap CLI needs to:
- Delete identity documents from DocumentStore instead of filesystem
- Use AgentRegistry for bootstrap claim cleanup instead of filesystem
- Remove filesystem mkdir/copy calls

This requires the CLI to open a database connection. It can use the same pattern as the onboarding wizard (`openCredentialStore`): open a Kysely DB, run migrations, operate on DocumentStore.

**Step 2: Run tests**

Run: `npm test -- --run tests/cli/`
Expected: PASS (if bootstrap tests exist)

**Step 3: Commit**

```bash
git add src/cli/bootstrap.ts
git commit -m "refactor: bootstrap CLI uses DocumentStore instead of filesystem"
```

---

### Task 8: Update governance handler to stop writing filesystem copies

The governance handler (`src/host/ipc-handlers/governance.ts`) writes approved proposals to both DocumentStore and filesystem. Remove filesystem writes.

**Files:**
- Modify: `src/host/ipc-handlers/governance.ts`

**Step 1: Remove filesystem fallback writes**

In the `proposal_review` handler (around line 147):
- Remove `if (agentDir) { mkdirSync(...); writeFileSync(...) }` block
- Remove filesystem cleanup of BOOTSTRAP.md and `.bootstrap-admin-claimed`
- Keep DocumentStore writes (they're already the authoritative source)
- For bootstrap completion cleanup, use AgentRegistry instead of filesystem

**Step 2: Run tests**

Run: `npm test -- --run tests/host/ipc-handlers/governance.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/ipc-handlers/governance.ts
git commit -m "refactor: governance handler writes only to DocumentStore, not filesystem"
```

---

### Task 9: Remove ClawHub filesystem cache

Replace the filesystem cache in `clawhub/registry-client.ts` with in-memory caching.

**Files:**
- Modify: `src/clawhub/registry-client.ts`
- Test: `tests/clawhub/registry-client.test.ts`

**Step 1: Replace filesystem cache with in-memory Map**

```typescript
// Replace cacheDir(), ensureCacheDir(), readCached(), writeCache() with:
const memoryCache = new Map<string, { data: string; timestamp: number }>();

function readCached(key: string): string | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    memoryCache.delete(key);
    return null;
  }
  return entry.data;
}

function writeCache(key: string, data: string): void {
  memoryCache.set(key, { data, timestamp: Date.now() });
}
```

Remove the `mkdir`, `readFile`, `writeFile`, `readdir`, `stat` imports from `node:fs/promises`.
Remove the `safePath` import (no longer needed for cache paths).
Keep the `axHome` import only if used elsewhere (it won't be after this change — remove it).

**Step 2: Update `listCached()` to use memory cache**

```typescript
export function listCached(): string[] {
  return [...memoryCache.keys()]
    .filter(k => k.startsWith('skill-'))
    .map(k => k.slice('skill-'.length));
}
```

Change return type from `Promise<string[]>` to `string[]` (or keep async for compatibility).

**Step 3: Update tests**

Update `tests/clawhub/registry-client.test.ts`:
- Remove `AX_HOME` temp dir setup (no filesystem cache)
- Remove `afterAll` cleanup of `tmpHome`
- Tests should still pass since they mock `fetch` and the in-memory cache behaves the same

**Step 4: Run tests**

Run: `npm test -- --run tests/clawhub/registry-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/clawhub/registry-client.ts tests/clawhub/registry-client.test.ts
git commit -m "refactor: replace ClawHub filesystem cache with in-memory cache"
```

---

### Task 10: Clean up paths.ts — remove agents/ path helpers

Remove the now-unused path helpers for `agents/`.

**Files:**
- Modify: `src/paths.ts`

**Step 1: Remove deprecated path helpers**

Remove:
- `agentDir()` and `agentStateDir` alias
- `agentUserDir()`
- `agentIdentityDir()`
- `agentIdentityFilesDir()`
- `agentWorkspaceDir()`
- `agentSkillsDir()`
- `userSkillsDir()`
- `userWorkspaceDir()`

Keep:
- `axHome()`, `configPath()`, `envPath()`, `dataDir()`, `dataFile()`
- Session ID helpers
- `registryPath()`, `proposalsDir()`, `webhooksDir()`, `webhookTransformPath()`
- `validatePathSegment()` (used by remaining helpers)

Also update the layout comment at the top to remove the `agents/` section.

**Step 2: Fix any remaining imports**

Search for any remaining imports of removed functions and remove them.

Run: `grep -r "agentDir\|agentStateDir\|agentIdentityDir\|agentIdentityFilesDir\|agentWorkspaceDir\|agentSkillsDir\|userSkillsDir\|userWorkspaceDir" src/`

Fix all remaining references.

**Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/paths.ts
git commit -m "refactor: remove agents/ path helpers from paths.ts"
```

---

### Task 11: Update integration tests

The `admin-gate.test.ts` integration tests create full servers with `AX_HOME` temp dirs and check filesystem state. Update them to verify DB state instead.

**Files:**
- Modify: `tests/host/admin-gate.test.ts`
- Possibly modify: `tests/host/ipc-handlers/governance.test.ts`
- Possibly modify: `tests/host/ipc-handlers/identity.test.ts`

**Step 1: Update admin-gate integration tests**

- Remove filesystem checks like `existsSync(join(agentTopDir, '.bootstrap-admin-claimed'))`
- Remove filesystem writes like `writeFileSync(join(identityFilesDir, 'SOUL.md'), ...)`
- Instead, verify state via the server's exposed API or by querying the DB
- For bootstrap completion tests, use DocumentStore to write SOUL.md/IDENTITY.md

**Step 2: Run all affected tests**

Run: `npm test -- --run tests/host/`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/host/
git commit -m "test: update integration tests to verify DB state instead of filesystem"
```

---

### Task 12: Final cleanup and verification

**Step 1: Remove any remaining references to `agents/` directory**

Run: `grep -r "agents/" src/ tests/ --include="*.ts" | grep -v node_modules | grep -v ".test.ts"` and verify nothing references the old directory structure.

**Step 2: Run full test suite**

Run: `npm test`
Expected: ALL PASS

**Step 3: Run build**

Run: `npm run build`
Expected: PASS with no errors

**Step 4: Commit any remaining cleanups**

```bash
git add -A
git commit -m "chore: final cleanup of agents/ and cache/ directory references"
```
