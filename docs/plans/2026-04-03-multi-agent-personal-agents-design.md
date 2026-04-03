# Multi-Agent AX: Personal Agents for Everyone — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the hardcoded single "main" agent with user-scoped personal agents, a shared company catalog, and layered identity/memory/credentials.

**Architecture:** Any user can create any number of agents, each with its own OAuth tokens, skills, and memory. Admins are stored in the DB registry (not filesystem). An `AgentProvisioner` auto-creates a personal agent on first contact. A company layer provides shared catalog, base identity, default credentials, and a shared memory pool underneath.

**Tech Stack:** TypeScript, Zod, Kysely (PostgreSQL/SQLite), vitest, existing provider contract pattern.

---

## Design Feedback

> These are issues, gaps, and suggestions identified during plan review. Address before or during implementation.

### Critical Issues

**1. `ensureAgent()` returning "first active" is ambiguous.**
A user with 3 agents gets... which one? Need a **default agent** concept. Suggest: `AgentRegistryEntry` gets a `isDefault?: boolean` field, or the provisioner always names the auto-created agent deterministically (e.g., `personal-{userId}`) so it can be found by convention.

**2. Company admin stored in filesystem (`~/.ax/company-admins`) breaks k8s.**
Multi-pod deployments share a database, not a filesystem. Store company admins in DocumentStore (`company/admins` in a `config` collection) or in a dedicated `company_admins` DB table. The existing `claimBootstrapAdmin` O_EXCL pattern doesn't work across pods.

**3. Keep per-user credential scope for shared agents.**
Shared agents (e.g., `backend-team` with admins bob/carol) need per-user credential overrides. **Keep the user scope** — the new chain should be: `user:{agentId}:{userId}` → `agent:{agentId}` → `company` → global.

**4. DocumentStore.list() can't filter for catalog queries.**
`CatalogStore.list({ tags?, type?, query? })` requires filtering, but `DocumentStore.list()` only returns `string[]` keys. Either:
- (a) Load all entries and filter client-side (fine for <100 entries)
- (b) Use a dedicated `catalog` DB table with indexed columns

Recommend (a) initially since catalog sizes will be small, with a comment noting the scaling limit.

### Missing Concerns

**6. Additional hardcoded `'main'` references.** The plan only changes `server-init.ts` and `server-completions.ts`, but these also need updating:
- `src/providers/scheduler/plainjob.ts:68` — uses `config.agent_name` for job scoping
- `src/providers/workspace/gcs.ts:370` — uses `config.agent_name` for workspace paths
- `src/providers/workspace/local.ts:185` — same

**7. Channel routing is unaddressed.** When a Slack message arrives, which agent handles it? Current design: one agent (`main`) handles everything. Multi-agent needs routing logic:
- DM → user's default personal agent
- Channel → channel-assigned agent (new mapping table), or fall back to company default agent
- Thread → same agent that handled the parent message

**8. Session → agent mapping.** `setSessionCredentialContext()` in `credential-scopes.ts` maps sessions to `{ agentName, userId }`. Must update to use dynamic agent resolution, not static config.

**9. Audit scoping.** Current audit log captures `action` and `sessionId` but not `agentId`. Multi-agent audit needs `agentId` on every entry to answer "what did agent X do?"

**10. Identity files are more than AGENTS.md + IDENTITY.md.** The plan references "AGENTS.md and IDENTITY.md" for company base identity, but `server-init.ts:102-160` seeds 6 files: `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `USER_BOOTSTRAP.md`. Decide which files are company-inheritable vs agent-only.

### Design Suggestions

**11. Phase ordering.** Phase 7 "Wire It Up" should be merged into Phase 2. Phases 3-6 need dynamic routing to be in place — they can't work if `agentName = 'main'` is still hardcoded. Suggested order:
1. Extend registry (data model)
2. Provisioner + dynamic routing (wire it up immediately)
3. Credential scoping
4. Company base identity
5. Shared memory pool
6. Shared catalog (most complex, least coupled)

**12. Required skill sync should be lazy, not eager.** "Iterates all registered agents and installs" on every `catalog_publish` is O(agents × required_skills). Better: sync required skills lazily when an agent starts a session (`provisioner.resolveAgent` calls `catalog.syncRequired(agentId)`). Mark last-sync timestamp per agent to avoid redundant work.

**13. Shared memory pool needs guardrails.** "Any user can contribute" without ACL means a compromised agent (or careless user) can poison the shared knowledge base. Suggestions:
- Taint-tag company memory writes with the contributing agent/user
- Consider an approval workflow for company memory writes, or at least an audit trail
- Allow company admins to purge/moderate the shared pool

---

## Implementation Plan

> Each task is structured as TDD: write failing test → verify failure → implement → verify pass → commit.

### Task 1: Extend AgentRegistryEntry with Admins Field

**Files:**
- Modify: `src/host/agent-registry.ts:26-47`
- Modify: `src/host/agent-registry-db.ts:18-55`
- Test: `tests/host/agent-registry.test.ts`

**Step 1: Write the failing test**

Add to `tests/host/agent-registry.test.ts`:

```typescript
describe('admins field', () => {
  test('register stores admins', async () => {
    const registry = new FileAgentRegistry(join(tmpDir, 'registry.json'));
    const entry = await registry.register({
      id: 'test-agent',
      name: 'Test Agent',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: [],
      createdBy: 'alice',
      admins: ['alice'],
    });
    expect(entry.admins).toEqual(['alice']);
  });

  test('findByAdmin returns agents where userId is an admin', async () => {
    const registry = new FileAgentRegistry(join(tmpDir, 'registry.json'));
    await registry.register({
      id: 'a1', name: 'A1', status: 'active', parentId: null,
      agentType: 'pi-coding-agent', capabilities: [], createdBy: 'alice',
      admins: ['alice'],
    });
    await registry.register({
      id: 'a2', name: 'A2', status: 'active', parentId: null,
      agentType: 'pi-coding-agent', capabilities: [], createdBy: 'bob',
      admins: ['bob', 'alice'],
    });
    await registry.register({
      id: 'a3', name: 'A3', status: 'active', parentId: null,
      agentType: 'pi-coding-agent', capabilities: [], createdBy: 'carol',
      admins: ['carol'],
    });

    const aliceAgents = await registry.findByAdmin('alice');
    expect(aliceAgents.map(a => a.id).sort()).toEqual(['a1', 'a2']);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/agent-registry.test.ts`
Expected: FAIL — `admins` not in type, `findByAdmin` not a function.

**Step 3: Implement — extend types and FileAgentRegistry**

In `src/host/agent-registry.ts`, add to `AgentRegistryEntry` (after line 46):

```typescript
/** UserIds who can administer this agent. Creator is always first admin. */
admins: string[];
```

Add to `AgentRegistry` interface (after line 61):

```typescript
findByAdmin(userId: string): Promise<AgentRegistryEntry[]>;
```

Remove `ensureDefault()` from the interface.

Add `findByAdmin` to `FileAgentRegistry`:

```typescript
async findByAdmin(userId: string): Promise<AgentRegistryEntry[]> {
  const data = this.load();
  return data.agents.filter(a => a.status === 'active' && a.admins.includes(userId));
}
```

Update `register()` to accept and store `admins` in the Omit type.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/agent-registry.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/agent-registry.ts tests/host/agent-registry.test.ts
git commit -m "feat(registry): add admins and findByAdmin to AgentRegistryEntry"
```

---

### Task 2: Database Registry Migration for Admins

**Files:**
- Modify: `src/host/agent-registry-db.ts:18-86`
- Test: `tests/host/agent-registry-db.test.ts` (new if not exists, or add to existing)

**Step 1: Write the failing test**

```typescript
test('DatabaseAgentRegistry stores admins', async () => {
  const entry = await dbRegistry.register({
    id: 'owned-agent', name: 'Owned', status: 'active', parentId: null,
    agentType: 'pi-coding-agent', capabilities: [], createdBy: 'alice',
    admins: ['alice'],
  });
  expect(entry.admins).toEqual(['alice']);

  const found = await dbRegistry.findByAdmin('alice');
  expect(found.some(a => a.id === 'owned-agent')).toBe(true);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/agent-registry-db.test.ts`
Expected: FAIL

**Step 3: Implement — add migration and update row mapping**

Add `registry_002_agent_admins` migration in `registryMigrations()`:

```typescript
registry_002_agent_admins: {
  async up(db: Kysely<any>) {
    await db.schema.alterTable('agent_registry')
      .addColumn('admins', 'text', col => col.notNull().defaultTo('[]'))
      .execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.alterTable('agent_registry')
      .dropColumn('admins')
      .execute();
  },
},
```

Update `AgentRow` interface to add `admins: string;`.

Update `rowToEntry` to parse:

```typescript
admins: JSON.parse(row.admins) as string[],
```

Update `register()` to store: `admins: JSON.stringify(entry.admins)`.

Add `findByAdmin()` to `DatabaseAgentRegistry`:

```typescript
async findByAdmin(userId: string): Promise<AgentRegistryEntry[]> {
  const rows = await this.db.selectFrom('agent_registry')
    .selectAll()
    .where('status', '=', 'active')
    .where('admins', 'like', `%"${userId}"%`)
    .execute() as AgentRow[];
  return rows.map(rowToEntry);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/agent-registry-db.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/agent-registry-db.ts tests/host/agent-registry-db.test.ts
git commit -m "feat(registry): add admins migration and findByAdmin for database registry"
```

---

### Task 3: Agent Provisioner

**Files:**
- Create: `src/host/agent-provisioner.ts`
- Test: `tests/host/agent-provisioner.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { AgentRegistry, AgentRegistryEntry } from '../../src/host/agent-registry.js';

// Uses same createMockRegistry() pattern from agent-registry tests

describe('AgentProvisioner', () => {
  let registry: ReturnType<typeof createMockRegistry>;
  let documents: ReturnType<typeof createMockDocStore>;
  let provisioner: AgentProvisioner;

  beforeEach(() => {
    registry = createMockRegistry();
    documents = createMockDocStore();
    provisioner = new AgentProvisioner(registry, documents);
  });

  test('ensureAgent creates personal agent on first call', async () => {
    const agent = await provisioner.ensureAgent('alice');
    expect(agent.admins).toEqual(['alice']);
    expect(agent.name).toContain('alice');
    expect(agent.status).toBe('active');
  });

  test('ensureAgent returns existing agent on second call', async () => {
    const first = await provisioner.ensureAgent('alice');
    const second = await provisioner.ensureAgent('alice');
    expect(first.id).toBe(second.id);
  });

  test('resolveAgent returns specified agent if user is admin', async () => {
    const created = await provisioner.ensureAgent('alice');
    const resolved = await provisioner.resolveAgent('alice', created.id);
    expect(resolved.id).toBe(created.id);
  });

  test('resolveAgent falls back to ensureAgent when agentId not found', async () => {
    const resolved = await provisioner.resolveAgent('alice', 'nonexistent');
    expect(resolved.admins).toEqual(['alice']);
  });

  test('resolveAgent rejects when user is not admin of specified agent', async () => {
    const aliceAgent = await provisioner.ensureAgent('alice');
    await expect(provisioner.resolveAgent('bob', aliceAgent.id)).rejects.toThrow(/not authorized/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/agent-provisioner.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement provisioner**

Create `src/host/agent-provisioner.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import type { AgentRegistry, AgentRegistryEntry } from './agent-registry.js';
import type { DocumentStore } from '../providers/storage/types.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'agent-provisioner' });

export class AgentProvisioner {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly documents: DocumentStore,
  ) {}

  /** Ensure a personal agent exists for this user. Returns existing or newly created. */
  async ensureAgent(userId: string): Promise<AgentRegistryEntry> {
    const existing = await this.registry.findByAdmin(userId);
    if (existing.length > 0) return existing[0];

    const agentId = `personal-${userId.slice(0, 20)}-${randomUUID().slice(0, 8)}`;
    const agent = await this.registry.register({
      id: agentId,
      name: `${userId}'s Agent`,
      description: `Auto-provisioned personal agent for ${userId}`,
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: ['general', 'memory', 'web', 'scheduling'],
      createdBy: userId,
      admins: [userId],
    });

    logger.info('agent_provisioned', { agentId: agent.id, userId });
    return agent;
  }

  /** Resolve which agent handles a request. Validates access. Falls back to ensureAgent. */
  async resolveAgent(userId: string, agentId?: string): Promise<AgentRegistryEntry> {
    if (agentId) {
      const agent = await this.registry.get(agentId);
      if (agent) {
        if (!agent.admins.includes(userId)) {
          throw new Error(`User "${userId}" is not authorized for agent "${agentId}"`);
        }
        return agent;
      }
      logger.warn('agent_not_found_fallback', { agentId, userId });
    }
    return this.ensureAgent(userId);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/agent-provisioner.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/agent-provisioner.ts tests/host/agent-provisioner.test.ts
git commit -m "feat(host): add AgentProvisioner for auto-provisioning personal agents"
```

---

### Task 4: Wire Up Dynamic Agent Routing in server-init.ts

**Files:**
- Modify: `src/host/server-init.ts:40-91,269-270`
- Modify: `src/types.ts:72`
- Test: integration test (modify existing smoke test)

**Step 1: Write the failing test**

Add to `tests/host/server-init.test.ts` (or integration test):

```typescript
test('HostCore exposes provisioner instead of hardcoded agentName', async () => {
  // After initHostCore, the returned object should have a provisioner
  // and no longer have a static agentName of 'main'
  expect(hostCore.provisioner).toBeDefined();
  expect(typeof hostCore.provisioner.resolveAgent).toBe('function');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/server-init.test.ts`
Expected: FAIL — `provisioner` not on HostCore.

**Step 3: Implement — replace hardcoded agentName with provisioner**

In `src/host/server-init.ts`:

1. Add import: `import { AgentProvisioner } from './agent-provisioner.js';`
2. Add `provisioner: AgentProvisioner;` to `HostCore` interface (line ~58), keep `agentName` temporarily for backward compat during migration
3. After agent registry creation (line 270):
   - Remove `await agentRegistry.ensureDefault();`
   - Add: `const provisioner = new AgentProvisioner(agentRegistry, providers.storage.documents);`
4. Add `provisioner` to the returned HostCore object

**Important:** Keep `agentName = 'main'` for now — the completions path uses it. Task 5 updates completions to use the provisioner. This avoids a broken intermediate state.

In `src/types.ts`:
- Keep `agent_name?: string` for now (deprecated, removed in Task 14).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/server-init.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-init.ts src/host/agent-provisioner.ts
git commit -m "feat(host): add provisioner to HostCore, prepare for dynamic routing"
```

---

### Task 5: Dynamic Agent Resolution in server-completions.ts

**Files:**
- Modify: `src/host/server-completions.ts:396,466-471,828,867`
- Test: `tests/host/server-completions-dynamic.test.ts` (new)

**Step 1: Write the failing test**

```typescript
test('processCompletion resolves agent via provisioner instead of config', async () => {
  // Set up a provisioner with a mock registry containing alice's agent
  // Call processCompletion with userId='alice'
  // Verify the identity is loaded for alice's agent, not 'main'
  const identityKeys: string[] = [];
  const mockDocs = createMockDocStore({
    onGet: (collection, key) => { identityKeys.push(key); },
  });
  // ... setup and call processCompletion
  // Verify identityKeys contain alice's agent prefix, not 'main/'
  expect(identityKeys.some(k => k.startsWith('personal-alice'))).toBe(true);
  expect(identityKeys.some(k => k.startsWith('main/'))).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/server-completions-dynamic.test.ts`
Expected: FAIL

**Step 3: Implement — use provisioner in completions path**

In `src/host/server-completions.ts`:

1. Add `provisioner?: AgentProvisioner` to `CompletionDeps`
2. Replace both `const agentName = config.agent_name ?? 'main';` (lines 396 and 466) with:
   ```typescript
   const resolvedAgent = deps.provisioner
     ? await deps.provisioner.resolveAgent(currentUserId)
     : undefined;
   const agentName = resolvedAgent?.id ?? config.agent_name ?? 'main';
   ```
3. Update `setSessionCredentialContext` call to use the resolved agent name

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/server-completions-dynamic.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-completions.ts tests/host/server-completions-dynamic.test.ts
git commit -m "feat(completions): resolve agent dynamically via provisioner"
```

---

### Task 6: Credential Scope Chain — Add Company Layer

**Files:**
- Modify: `src/host/credential-scopes.ts:11-14,48-70`
- Modify: `tests/host/credential-scopes.test.ts`

**Step 1: Write the failing test**

Add to `tests/host/credential-scopes.test.ts`:

```typescript
test('resolveCredential checks company scope between agent and global', async () => {
  const provider = createMockCredentialProvider({
    'API_KEY': { 'company': 'company-key' },
  });
  const result = await resolveCredential(provider, 'API_KEY', 'some-agent', 'alice');
  expect(result).toBe('company-key');
});

test('agent scope takes precedence over company scope', async () => {
  const provider = createMockCredentialProvider({
    'API_KEY': {
      'agent:my-agent': 'agent-key',
      'company': 'company-key',
    },
  });
  const result = await resolveCredential(provider, 'API_KEY', 'my-agent');
  expect(result).toBe('agent-key');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/credential-scopes.test.ts`
Expected: FAIL — company scope not checked.

**Step 3: Implement — add company scope to resolution chain**

In `src/host/credential-scopes.ts`, update `resolveCredential`:

```typescript
export async function resolveCredential(
  provider: CredentialProvider,
  envName: string,
  agentName: string,
  userId?: string,
): Promise<string | null> {
  // 1. User scope (per-user within agent)
  if (userId) {
    const userVal = await provider.get(envName, credentialScope(agentName, userId));
    if (userVal !== null) return userVal;
  }

  // 2. Agent scope
  const agentVal = await provider.get(envName, credentialScope(agentName));
  if (agentVal !== null) return agentVal;

  // 3. Company scope — shared default OAuth apps
  const companyVal = await provider.get(envName, 'company');
  if (companyVal !== null) return companyVal;

  // 4. Global (unscoped) fallback
  const globalVal = await provider.get(envName);
  if (globalVal !== null) return globalVal;

  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/credential-scopes.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/credential-scopes.ts tests/host/credential-scopes.test.ts
git commit -m "feat(credentials): add company scope to resolution chain"
```

---

### Task 7: Shared Company Memory Pool

**Files:**
- Modify: `src/host/ipc-handlers/memory.ts`
- Modify: `src/ipc-schemas.ts` (add `pool` field)
- Modify: `tests/host/ipc-handlers/memory.test.ts`

**Step 1: Write the failing test**

Add to `tests/host/ipc-handlers/memory.test.ts`:

```typescript
test('memory_query with pool=both searches both agent and company scopes', async () => {
  const handlers = createMemoryHandlers(stubProviders(memory));
  const ctx: IPCContext = { sessionId: 's1', agentId: 'my-agent', userId: 'alice', sessionScope: 'dm' };

  await handlers.memory_query({ scope: 'knowledge', query: 'test', pool: 'both' }, ctx);

  // Should have been called twice: once for agent scope (with userId), once for company
  expect(queryCalls).toHaveLength(2);
  expect(queryCalls[0].userId).toBe('alice');
  expect(queryCalls[1].scope).toBe('company');
});

test('memory_write with pool=company writes to company scope', async () => {
  const handlers = createMemoryHandlers(stubProviders(memory));
  const ctx: IPCContext = { sessionId: 's1', agentId: 'my-agent', userId: 'alice', sessionScope: 'dm' };

  await handlers.memory_write({ scope: 'knowledge', content: 'shared fact', pool: 'company' }, ctx);

  expect(writeCalls[0].scope).toBe('company');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/ipc-handlers/memory.test.ts`
Expected: FAIL — `pool` field not recognized.

**Step 3: Implement**

Update `MemoryWriteSchema` in `src/ipc-schemas.ts`:
```typescript
pool: z.enum(['agent', 'company']).optional(), // default: 'agent'
```

Update `MemoryQuerySchema`:
```typescript
pool: z.enum(['agent', 'company', 'both']).optional(), // default: 'both'
```

Update `src/host/ipc-handlers/memory.ts`:

```typescript
memory_write: async (req: any, ctx: IPCContext) => {
  const userId = isDmScope(ctx) ? ctx.userId : undefined;
  const scope = req.pool === 'company' ? 'company' : req.scope;
  const entry = { ...req, scope, userId: req.pool === 'company' ? undefined : userId };
  await providers.audit.log({ action: 'memory_write', args: { scope, pool: req.pool } });
  return { id: await providers.memory.write(entry) };
},

memory_query: async (req: any, ctx: IPCContext) => {
  const userId = isDmScope(ctx) ? ctx.userId : undefined;
  const pool = req.pool ?? 'both';

  if (pool === 'company') {
    const query = { ...req, scope: 'company', userId: undefined };
    return { results: await providers.memory.query(query) };
  }

  const agentResults = await providers.memory.query({ ...req, userId });

  if (pool === 'both') {
    const companyResults = await providers.memory.query({ ...req, scope: 'company', userId: undefined });
    // Merge and dedup by id
    const seen = new Set(agentResults.map((r: any) => r.id));
    const merged = [...agentResults];
    for (const r of companyResults) {
      if (!seen.has(r.id)) merged.push(r);
    }
    const limit = req.limit ?? 20;
    return { results: merged.slice(0, limit) };
  }

  return { results: agentResults };
},
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/ipc-handlers/memory.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/ipc-handlers/memory.ts src/ipc-schemas.ts tests/host/ipc-handlers/memory.test.ts
git commit -m "feat(memory): add shared company memory pool with pool field"
```

---

### Task 8: Company Base Identity

**Files:**
- Modify: `src/host/server-completions.ts:159-206` (loadIdentityFromDB)
- Create: `src/host/company-admin.ts`
- Test: `tests/host/company-admin.test.ts`
- Test: `tests/host/server-completions-identity.test.ts`

**Step 1: Write the failing test**

```typescript
describe('company base identity', () => {
  test('loadIdentityFromDB layers company identity before agent identity', async () => {
    const docs = createMockDocStore();
    await docs.put('identity', 'company/AGENTS.md', '# Company Agents');
    await docs.put('identity', 'company/IDENTITY.md', '# Company Identity');
    await docs.put('identity', 'my-agent/AGENTS.md', '# My Agents');
    await docs.put('identity', 'my-agent/IDENTITY.md', '# My Identity');

    const payload = await loadIdentityFromDB(docs, 'my-agent', 'alice', logger);
    // Company base comes first, agent-specific appended
    expect(payload.agents).toContain('# Company Agents');
    expect(payload.agents).toContain('# My Agents');
    expect(payload.agents!.indexOf('Company')).toBeLessThan(payload.agents!.indexOf('My'));
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/server-completions-identity.test.ts`
Expected: FAIL — company prefix not loaded.

**Step 3: Implement — update loadIdentityFromDB**

In `src/host/server-completions.ts`, update `loadIdentityFromDB`:

```typescript
async function loadIdentityFromDB(
  documents: DocumentStore,
  agentName: string,
  userId: string,
  logger: Logger,
): Promise<IdentityPayload> {
  const identity: IdentityPayload = {};

  try {
    const allKeys = await documents.list('identity');

    // 1. Load company base identity first
    const companyPrefix = 'company/';
    for (const key of allKeys) {
      if (!key.startsWith(companyPrefix)) continue;
      if (key.includes('/users/')) continue;
      const filename = key.slice(companyPrefix.length);
      const field = IDENTITY_FILE_MAP[filename];
      if (field) {
        const content = await documents.get('identity', key);
        if (content) identity[field] = content;
      }
    }

    // 2. Load agent-level identity files (appended to company base)
    const agentPrefix = `${agentName}/`;
    for (const key of allKeys) {
      if (!key.startsWith(agentPrefix)) continue;
      if (key.includes('/users/')) continue;
      const filename = key.slice(agentPrefix.length);
      const field = IDENTITY_FILE_MAP[filename];
      if (field) {
        const content = await documents.get('identity', key);
        if (content) {
          identity[field] = identity[field] ? `${identity[field]}\n\n---\n\n${content}` : content;
        }
      }
    }

    // 3. Load user-level identity files
    const userPrefix = `${agentName}/users/${userId}/`;
    for (const key of allKeys) {
      if (!key.startsWith(userPrefix)) continue;
      const filename = key.slice(userPrefix.length);
      const field = IDENTITY_FILE_MAP[filename];
      if (field) {
        const content = await documents.get('identity', key);
        if (content) identity[field] = content;
      }
    }
  } catch (err) {
    logger.warn('identity_load_failed', { error: (err as Error).message });
  }

  return identity;
}
```

Create `src/host/company-admin.ts` for company admin helpers:

```typescript
import type { DocumentStore } from '../providers/storage/types.js';

const COMPANY_ADMINS_KEY = 'company/admins';
const COLLECTION = 'config';

export async function isCompanyAdmin(documents: DocumentStore, userId: string): Promise<boolean> {
  const raw = await documents.get(COLLECTION, COMPANY_ADMINS_KEY);
  if (!raw) return false;
  const admins: string[] = JSON.parse(raw);
  return admins.includes(userId);
}

export async function claimCompanyAdmin(documents: DocumentStore, userId: string): Promise<boolean> {
  const raw = await documents.get(COLLECTION, COMPANY_ADMINS_KEY);
  if (raw) {
    const admins: string[] = JSON.parse(raw);
    if (admins.length > 0) return false; // already claimed
  }
  await documents.put(COLLECTION, COMPANY_ADMINS_KEY, JSON.stringify([userId]));
  return true;
}

export async function addCompanyAdmin(documents: DocumentStore, userId: string): Promise<void> {
  const raw = await documents.get(COLLECTION, COMPANY_ADMINS_KEY);
  const admins: string[] = raw ? JSON.parse(raw) : [];
  if (!admins.includes(userId)) {
    admins.push(userId);
    await documents.put(COLLECTION, COMPANY_ADMINS_KEY, JSON.stringify(admins));
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/server-completions-identity.test.ts tests/host/company-admin.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-completions.ts src/host/company-admin.ts tests/host/server-completions-identity.test.ts tests/host/company-admin.test.ts
git commit -m "feat(identity): layer company base identity before agent identity"
```

---

### Task 9: Company Identity IPC Actions

**Files:**
- Modify: `src/ipc-schemas.ts`
- Create: `src/host/ipc-handlers/company.ts`
- Test: `tests/host/ipc-handlers/company.test.ts`

**Step 1: Write the failing test**

```typescript
test('company_identity_write requires company admin', async () => {
  const handlers = createCompanyHandlers(docs, audit);
  const ctx: IPCContext = { sessionId: 's1', agentId: 'system', userId: 'alice' };
  // alice is not a company admin
  await expect(
    handlers.company_identity_write({ file: 'AGENTS.md', content: '# New', reason: 'test' }, ctx)
  ).rejects.toThrow(/company admin/i);
});

test('company_identity_read returns stored content', async () => {
  await docs.put('identity', 'company/AGENTS.md', '# Company Agents');
  const handlers = createCompanyHandlers(docs, audit);
  const ctx: IPCContext = { sessionId: 's1', agentId: 'system', userId: 'alice' };
  const result = await handlers.company_identity_read({ file: 'AGENTS.md' }, ctx);
  expect(result.content).toBe('# Company Agents');
});
```

**Step 2–5: Standard TDD cycle**

Add `CompanyIdentityReadSchema` and `CompanyIdentityWriteSchema` to `ipc-schemas.ts`. Implement handler that checks `isCompanyAdmin()` before writes. Test, then commit.

```bash
git commit -m "feat(ipc): add company identity read/write handlers"
```

---

### Task 10: Shared Company Catalog — CatalogStore

**Files:**
- Create: `src/host/catalog-store.ts`
- Test: `tests/host/catalog-store.test.ts`

**Step 1: Write the failing test**

```typescript
describe('CatalogStore', () => {
  test('publish and get entry', async () => {
    const store = new CatalogStore(docs);
    const entry = await store.publish({
      slug: 'github-deploy',
      type: 'skill',
      name: 'GitHub Deploy',
      description: 'Deploy via GitHub Actions',
      author: 'alice',
      tags: ['github', 'ci'],
      version: '1.0.0',
      content: '# Deploy Skill\n...',
    });
    expect(entry.slug).toBe('github-deploy');

    const retrieved = await store.get('github-deploy');
    expect(retrieved?.name).toBe('GitHub Deploy');
  });

  test('list filters by type and tags', async () => {
    const store = new CatalogStore(docs);
    await store.publish({ slug: 's1', type: 'skill', name: 'S1', description: '', author: 'a', tags: ['ci'], version: '1', content: '' });
    await store.publish({ slug: 'c1', type: 'connector', name: 'C1', description: '', author: 'a', tags: ['slack'], version: '1', content: '' });

    const skills = await store.list({ type: 'skill' });
    expect(skills).toHaveLength(1);
    expect(skills[0].slug).toBe('s1');
  });

  test('setRequired marks entry and listRequired returns it', async () => {
    const store = new CatalogStore(docs);
    await store.publish({ slug: 'required-skill', type: 'skill', name: 'R', description: '', author: 'admin', tags: [], version: '1', content: '# Required' });
    await store.setRequired('required-skill', true);

    const required = await store.listRequired();
    expect(required).toHaveLength(1);
    expect(required[0].slug).toBe('required-skill');
  });

  test('unpublish removes entry', async () => {
    const store = new CatalogStore(docs);
    await store.publish({ slug: 'temp', type: 'skill', name: 'T', description: '', author: 'alice', tags: [], version: '1', content: '' });
    await store.unpublish('temp', 'alice');
    expect(await store.get('temp')).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/catalog-store.test.ts`
Expected: FAIL

**Step 3: Implement CatalogStore**

Create `src/host/catalog-store.ts`:

```typescript
import type { DocumentStore } from '../providers/storage/types.js';

export interface CatalogEntry {
  slug: string;
  type: 'skill' | 'connector';
  name: string;
  description: string;
  author: string;
  tags: string[];
  version: string;
  content: string;
  required: boolean;
  publishedAt: string;
  updatedAt: string;
}

export interface CatalogPublishInput {
  slug: string;
  type: 'skill' | 'connector';
  name: string;
  description: string;
  author: string;
  tags: string[];
  version: string;
  content: string;
}

const COLLECTION = 'catalog';

export class CatalogStore {
  constructor(private readonly documents: DocumentStore) {}

  async publish(input: CatalogPublishInput): Promise<CatalogEntry> {
    const now = new Date().toISOString();
    const existing = await this.get(input.slug);
    const entry: CatalogEntry = {
      ...input,
      required: existing?.required ?? false,
      publishedAt: existing?.publishedAt ?? now,
      updatedAt: now,
    };
    await this.documents.put(COLLECTION, input.slug, JSON.stringify(entry));
    return entry;
  }

  async get(slug: string): Promise<CatalogEntry | null> {
    const raw = await this.documents.get(COLLECTION, slug);
    if (!raw) return null;
    try { return JSON.parse(raw) as CatalogEntry; } catch { return null; }
  }

  async list(opts?: { tags?: string[]; type?: string; query?: string }): Promise<CatalogEntry[]> {
    const keys = await this.documents.list(COLLECTION);
    const entries: CatalogEntry[] = [];
    for (const key of keys) {
      const raw = await this.documents.get(COLLECTION, key);
      if (!raw) continue;
      try { entries.push(JSON.parse(raw) as CatalogEntry); } catch { /* skip */ }
    }
    return entries.filter(e => {
      if (opts?.type && e.type !== opts.type) return false;
      if (opts?.tags?.length && !opts.tags.some(t => e.tags.includes(t))) return false;
      if (opts?.query) {
        const q = opts.query.toLowerCase();
        if (!e.name.toLowerCase().includes(q) && !e.description.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  async unpublish(slug: string, requestingUserId: string): Promise<boolean> {
    const entry = await this.get(slug);
    if (!entry) return false;
    if (entry.required) throw new Error('Cannot unpublish required catalog entry');
    if (entry.author !== requestingUserId) throw new Error('Only the author can unpublish');
    return this.documents.delete(COLLECTION, slug);
  }

  async setRequired(slug: string, required: boolean): Promise<void> {
    const entry = await this.get(slug);
    if (!entry) throw new Error(`Catalog entry "${slug}" not found`);
    entry.required = required;
    entry.updatedAt = new Date().toISOString();
    await this.documents.put(COLLECTION, slug, JSON.stringify(entry));
  }

  async listRequired(): Promise<CatalogEntry[]> {
    const all = await this.list();
    return all.filter(e => e.required);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/catalog-store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/catalog-store.ts tests/host/catalog-store.test.ts
git commit -m "feat(catalog): add CatalogStore for shared company skill/connector catalog"
```

---

### Task 11: Catalog IPC Actions

**Files:**
- Modify: `src/ipc-schemas.ts`
- Create: `src/host/ipc-handlers/catalog.ts`
- Test: `tests/host/ipc-handlers/catalog.test.ts`

Standard TDD cycle. Add schemas for `catalog_publish`, `catalog_get`, `catalog_list`, `catalog_install`, `catalog_unpublish`, `catalog_set_required`. Handler checks `isCompanyAdmin()` for `catalog_set_required`. `catalog_install` delegates to existing skill upsert logic.

```bash
git commit -m "feat(ipc): add catalog management handlers"
```

---

### Task 12: Sync Required Catalog Entries in Provisioner

**Files:**
- Modify: `src/host/agent-provisioner.ts`
- Modify: `tests/host/agent-provisioner.test.ts`

**Step 1: Write the failing test**

```typescript
test('ensureAgent syncs required catalog entries to new agent', async () => {
  // Set up catalog with a required entry
  await catalog.publish({ slug: 'required-skill', type: 'skill', name: 'R', description: '', author: 'admin', tags: [], version: '1', content: '# Required' });
  await catalog.setRequired('required-skill', true);

  const provisioner = new AgentProvisioner(registry, documents, catalog);
  const agent = await provisioner.ensureAgent('alice');

  // Verify the required skill was installed for the new agent
  const skill = await getSkill(documents, agent.id, 'required-skill');
  expect(skill).not.toBeNull();
  expect(skill!.instructions).toBe('# Required');
});
```

**Step 2–5: Standard TDD cycle**

Update `AgentProvisioner` constructor to accept optional `CatalogStore`. In `ensureAgent`, after creating the agent, call `syncRequired()` which installs all required catalog entries as agent-scoped skills.

```bash
git commit -m "feat(provisioner): sync required catalog entries on agent creation"
```

---

### Task 13: Update Remaining agent_name References

**Files:**
- Modify: `src/providers/scheduler/plainjob.ts:68`
- Modify: `src/providers/workspace/gcs.ts:370`
- Modify: `src/providers/workspace/local.ts:185`
- Test: verify existing tests still pass

**Step 1–5: Standard TDD cycle**

Replace `config.agent_name` references with dynamic agent resolution. For scheduler jobs, the agent context needs to be passed through the job metadata. For workspace providers, the agent name comes from the session context.

```bash
git commit -m "fix: update remaining agent_name references in scheduler and workspace providers"
```

---

### Task 14: Remove ensureDefault() and Deprecate Config.agent_name

**Files:**
- Modify: `src/host/agent-registry.ts` (remove `ensureDefault` from interface and implementations)
- Modify: `src/host/agent-registry-db.ts` (remove `ensureDefault`)
- Modify: `src/types.ts` (mark `agent_name` as `@deprecated`)
- Modify: `tests/host/agent-registry.test.ts` (update `ensureDefault` tests)

**Step 1: Update tests**

Remove or update `ensureDefault` tests. Add a test verifying the interface no longer has the method.

**Step 2–5: Standard TDD cycle**

```bash
git commit -m "refactor(registry): remove ensureDefault, deprecate Config.agent_name"
```

---

### Task 15: Integration Smoke Test

**Files:**
- Modify: `tests/integration/smoke.test.ts`

Add an integration test that:
1. Starts the server
2. Sends a request as user "alice" — verifies an agent is auto-provisioned
3. Sends a request as user "bob" — verifies a separate agent is created
4. Verifies each user's identity is loaded from their own agent scope

```bash
git commit -m "test(integration): add multi-agent provisioning smoke test"
```

---

## Future Work (Not in This Plan)

These items are documented but intentionally deferred:

1. **Agent management in admin UI** — Create/update/delete agents, manage admins, via the admin dashboard (not IPC actions)
2. **Per-agent channel identity** — Slack username/icon overrides, Discord webhooks
3. **Channel message routing** — DM→personal agent, channel→assigned agent
4. **Catalog DB table** — Replace DocumentStore with indexed table when catalog exceeds ~100 entries
5. **Company memory moderation** — Approval workflow, taint tracking for shared writes
6. **Agent deletion cascade** — Clean up skills, memory, credentials, identity when agent is deleted
7. **Agent transfer** — Transfer ownership from one admin to another
8. **Agent templates** — Create new agents from pre-configured templates

---

Plan complete and saved to `docs/plans/2026-04-03-multi-agent-personal-agents-design.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?
