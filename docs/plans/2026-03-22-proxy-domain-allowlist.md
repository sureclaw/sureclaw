# Proxy Domain Allowlist + Host-Controlled Skill Install

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** (1) Replace the brittle pre-approval/event-bus domain approval system with a synchronous allowlist built from skill manifests, eliminating proxy deadlocks. (2) Move skill installation from agent to host, making skills/ read-only to the agent. (3) Simplify the skill tool to a single `install` action instead of multi-step search/download/write.

**Architecture:** The host controls skill installation end-to-end: download, screen, generate manifest, write files, add domains to proxy allowlist. The agent gets a single `skill({ type: "install", query: "..." })` tool. The proxy checks the allowlist synchronously — allowed domains proceed, unknown domains are denied immediately and queued for admin review. Skills/ directories are mounted read-only; install commands (npm/pip) still run in the sandbox, writing binaries to `bin/` (not `skills/`).

**Tech Stack:** TypeScript, Node.js net/tls, vitest

---

## Summary of Changes

### What Gets Removed

| File | What | Why |
|------|------|-----|
| `src/host/web-proxy-approvals.ts` | Entire file | Event bus approval replaced by synchronous allowlist |
| `tests/host/web-proxy-approvals.test.ts` | Entire file | Tests for removed module |
| `src/agent/local-sandbox.ts` | `extractNetworkDomains()`, `extractDomainsFromScript()`, `extractDomainsFromContent()`, related constants | Proxy handles domain gating, no pre-extraction needed |
| `src/host/ipc-handlers/sandbox-tools.ts` | Domain extraction + `preApproveDomain()` in `sandbox_approve`; entire `web_proxy_approve` handler | Removed — no agent-side domain approval |
| `src/host/server-completions.ts` | `webProxyApprove` callback, `requestApproval` import, `cleanupSession` call | Replaced by allowlist |
| `src/host/server-k8s.ts` | `onApprove` callback, `requestApproval` import | Replaced by allowlist |
| `src/host/server-admin.ts` | `POST /admin/api/proxy/approve` endpoint | Replaced by new domain management endpoints |
| `src/ipc-schemas.ts` | `WebProxyApproveSchema` | IPC action removed |
| `src/agent/prompt/modules/skills.ts` | ClawHub install instructions (lines 90-113), "Creating Skills" section | Moved to host; agent prompt only shows available skills |

### What Gets Added

| File | What |
|------|------|
| `src/host/proxy-domain-list.ts` | `ProxyDomainList` class — in-memory allowlist + pending queue |
| `tests/host/proxy-domain-list.test.ts` | Tests for domain list |

### What Gets Modified

| File | What |
|------|------|
| `src/host/ipc-handlers/skills.ts` | Replace `skill_download` with `skill_install` — host downloads, screens, generates manifest, writes files, adds domains, returns result |
| `src/host/web-proxy.ts` | Add `onDenied` callback option; deny unknown domains when `allowedDomains` provided |
| `src/agent/mcp-server.ts` | Simplify skill tool: `install` (replaces search+download), `request_credential` (kept) |
| `src/agent/tool-catalog.ts` | Same simplification |
| `src/agent/prompt/modules/skills.ts` | Remove install instructions; add single-line install guidance |
| `src/agent/local-sandbox.ts` | Remove domain extraction code |

---

## Built-in Domains (Always Allowed)

Package manager registries that skills commonly need:

```typescript
const BUILTIN_DOMAINS = new Set([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org', 'files.pythonhosted.org',
  'rubygems.org',
  'crates.io', 'static.crates.io',
  'proxy.golang.org', 'sum.golang.org',
  'github.com', 'raw.githubusercontent.com',
  'objects.githubusercontent.com',
]);
```

---

### Task 1: Create ProxyDomainList

**Files:**
- Create: `src/host/proxy-domain-list.ts`
- Create: `tests/host/proxy-domain-list.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/host/proxy-domain-list.test.ts
import { describe, test, expect } from 'vitest';
import { ProxyDomainList } from '../../src/host/proxy-domain-list.js';

describe('ProxyDomainList', () => {
  test('built-in domains are always allowed', () => {
    const list = new ProxyDomainList();
    expect(list.isAllowed('registry.npmjs.org')).toBe(true);
    expect(list.isAllowed('pypi.org')).toBe(true);
  });

  test('unknown domains are not allowed', () => {
    const list = new ProxyDomainList();
    expect(list.isAllowed('evil.com')).toBe(false);
  });

  test('addSkillDomains adds domains to allowlist', () => {
    const list = new ProxyDomainList();
    list.addSkillDomains('my-skill', ['api.linear.app', 'api.github.com']);
    expect(list.isAllowed('api.linear.app')).toBe(true);
    expect(list.isAllowed('api.github.com')).toBe(true);
  });

  test('removeSkillDomains removes only that skill domains', () => {
    const list = new ProxyDomainList();
    list.addSkillDomains('skill-a', ['api.example.com']);
    list.addSkillDomains('skill-b', ['api.example.com', 'api.other.com']);
    list.removeSkillDomains('skill-a');
    expect(list.isAllowed('api.example.com')).toBe(true); // skill-b still has it
    expect(list.isAllowed('api.other.com')).toBe(true);
    list.removeSkillDomains('skill-b');
    expect(list.isAllowed('api.example.com')).toBe(false);
  });

  test('addPending queues a denied domain', () => {
    const list = new ProxyDomainList();
    list.addPending('api.evil.com', 'session-1');
    const pending = list.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ domain: 'api.evil.com', sessionId: 'session-1' });
  });

  test('approvePending moves domain to allowlist', () => {
    const list = new ProxyDomainList();
    list.addPending('api.newservice.com', 'session-1');
    expect(list.isAllowed('api.newservice.com')).toBe(false);
    list.approvePending('api.newservice.com');
    expect(list.isAllowed('api.newservice.com')).toBe(true);
    expect(list.getPending()).toHaveLength(0);
  });

  test('denyPending removes from pending without allowing', () => {
    const list = new ProxyDomainList();
    list.addPending('api.evil.com', 'session-1');
    list.denyPending('api.evil.com');
    expect(list.isAllowed('api.evil.com')).toBe(false);
    expect(list.getPending()).toHaveLength(0);
  });

  test('addPending deduplicates same domain', () => {
    const list = new ProxyDomainList();
    list.addPending('api.evil.com', 'session-1');
    list.addPending('api.evil.com', 'session-2');
    expect(list.getPending()).toHaveLength(1);
  });

  test('allowed domains are not added to pending', () => {
    const list = new ProxyDomainList();
    list.addSkillDomains('my-skill', ['api.linear.app']);
    list.addPending('api.linear.app', 'session-1');
    expect(list.getPending()).toHaveLength(0);
  });

  test('getAllowedDomains returns full set for proxy', () => {
    const list = new ProxyDomainList();
    list.addSkillDomains('my-skill', ['api.linear.app']);
    const allowed = list.getAllowedDomains();
    expect(allowed.has('api.linear.app')).toBe(true);
    expect(allowed.has('registry.npmjs.org')).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/host/proxy-domain-list.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/host/proxy-domain-list.ts
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'proxy-domain-list' });

/** Package manager and common development domains — always allowed. */
const BUILTIN_DOMAINS = new Set([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org', 'files.pythonhosted.org',
  'rubygems.org',
  'crates.io', 'static.crates.io',
  'proxy.golang.org', 'sum.golang.org',
  'github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com',
]);

interface PendingDomain {
  domain: string;
  sessionId: string;
  timestamp: number;
}

/**
 * Maintains the proxy domain allowlist from installed skill manifests.
 *
 * Domains are allowed if they appear in:
 * 1. BUILTIN_DOMAINS (package managers, GitHub)
 * 2. Skill-declared domains (from manifest capabilities.domains)
 * 3. Admin-approved domains (via approvePending)
 *
 * Unknown domains are denied immediately and added to a pending queue
 * for admin review on the dashboard.
 */
export class ProxyDomainList {
  /** skill name → Set<domain> */
  private skillDomains = new Map<string, Set<string>>();
  /** Domains approved by admin (not from skills). */
  private adminApproved = new Set<string>();
  /** Domains pending admin review. Keyed by domain for dedup. */
  private pending = new Map<string, PendingDomain>();

  isAllowed(domain: string): boolean {
    if (BUILTIN_DOMAINS.has(domain)) return true;
    if (this.adminApproved.has(domain)) return true;
    for (const domains of this.skillDomains.values()) {
      if (domains.has(domain)) return true;
    }
    return false;
  }

  /** Get a Set snapshot of all currently allowed domains (for passing to proxy). */
  getAllowedDomains(): Set<string> {
    const all = new Set(BUILTIN_DOMAINS);
    for (const domains of this.skillDomains.values()) {
      for (const d of domains) all.add(d);
    }
    for (const d of this.adminApproved) all.add(d);
    return all;
  }

  addSkillDomains(skillName: string, domains: string[]): void {
    if (domains.length === 0) return;
    this.skillDomains.set(skillName, new Set(domains));
    logger.info('skill_domains_added', { skillName, domains });
  }

  removeSkillDomains(skillName: string): void {
    this.skillDomains.delete(skillName);
  }

  /** Queue a denied domain for admin review. No-op if already allowed or pending. */
  addPending(domain: string, sessionId: string): void {
    if (this.isAllowed(domain)) return;
    if (this.pending.has(domain)) return;
    this.pending.set(domain, { domain, sessionId, timestamp: Date.now() });
    logger.info('domain_pending_approval', { domain, sessionId });
  }

  /** Admin approves a pending domain — moves to allowlist. */
  approvePending(domain: string): void {
    this.pending.delete(domain);
    this.adminApproved.add(domain);
    logger.info('domain_approved_by_admin', { domain });
  }

  /** Admin denies a pending domain — removes from queue. */
  denyPending(domain: string): void {
    this.pending.delete(domain);
    logger.info('domain_denied_by_admin', { domain });
  }

  getPending(): PendingDomain[] {
    return [...this.pending.values()];
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/host/proxy-domain-list.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(proxy): add ProxyDomainList for skill-based domain allowlist
```

---

### Task 2: Host-controlled skill install IPC handler

Replace `skill_download` (which returns files for the agent to write) with `skill_install` (which downloads, screens, generates manifest, writes files, and adds domains — all on the host).

**Files:**
- Modify: `src/host/ipc-handlers/skills.ts` — replace `skill_download` with `skill_install`
- Modify: `src/ipc-schemas.ts` — replace `SkillDownloadSchema` with `SkillInstallSchema`
- Create: `tests/host/skill-install.test.ts`

**Step 1: Write the failing tests**

```typescript
// tests/host/skill-install.test.ts
import { describe, test, expect, vi } from 'vitest';

describe('skill_install IPC handler', () => {
  test('downloads skill, writes files, generates manifest, returns result', async () => {
    // Mock ClawHub to return a skill package
    // Mock filesystem writes
    // Call skill_install handler
    // Assert: files written to skills/ directory
    // Assert: manifest generated with domains
    // Assert: domainList.addSkillDomains called
    // Assert: returns { installed: true, name, requiresEnv, domains, missingBins }
  });

  test('screens skill before writing — rejects bad skills', async () => {
    // Mock screener to return REJECT
    // Call skill_install handler
    // Assert: returns { installed: false, reason: "..." }
    // Assert: no files written
  });

  test('search-and-install: query searches ClawHub, picks best match, installs', async () => {
    // Call skill_install with query (not slug)
    // Assert: searches ClawHub first, then downloads best match
  });
});
```

**Step 2: Write the implementation**

The new `skill_install` handler:

```typescript
skill_install: async (req: any, ctx: IPCContext) => {
  // 1. If query provided (not slug), search ClawHub first
  let slug = req.slug;
  if (!slug && req.query) {
    const results = await clawhub.search(req.query, 5);
    if (results.length === 0) return { installed: false, reason: 'No matching skills found' };
    slug = results[0].slug;
  }
  if (!slug) return { installed: false, reason: 'Provide query or slug' };

  // 2. Download from ClawHub
  const pkg = await clawhub.fetchSkillPackage(slug);

  // 3. Parse and screen the SKILL.md
  const skillMd = pkg.files.find(f => f.path.endsWith('SKILL.md') || f.path.endsWith('.md'));
  if (!skillMd) return { installed: false, reason: 'No SKILL.md found in package' };
  const parsed = parseAgentSkill(skillMd.content);
  // Screen via screener provider if available
  if (providers.screener) {
    const verdict = await providers.screener.screenExtended(parsed);
    if (verdict.verdict === 'REJECT') {
      return { installed: false, reason: `Skill rejected: ${verdict.reasons.map(r => r.message).join(', ')}` };
    }
  }

  // 4. Generate manifest (extracts domains, bins, etc.)
  const manifest = generateManifest(parsed);

  // 5. Write files to skills directory (host-controlled, read-only to agent)
  const skillDir = join(userSkillsDir(agentName, ctx.userId), slug);
  mkdirSync(skillDir, { recursive: true });
  for (const file of pkg.files) {
    const filePath = join(skillDir, file.path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.content, 'utf-8');
  }

  // 6. Add domains to proxy allowlist
  if (opts.domainList && manifest.capabilities.domains.length > 0) {
    opts.domainList.addSkillDomains(slug, manifest.capabilities.domains);
  }

  // 7. Check which required binaries exist
  const missingBins = [];
  for (const bin of manifest.requires.bins) {
    if (!await binExists(bin)) missingBins.push(bin);
  }

  await providers.audit.log({
    action: 'skill_install',
    sessionId: ctx.sessionId,
    args: { slug, domains: manifest.capabilities.domains, missingBins },
    result: 'success',
  });

  return {
    installed: true,
    name: parsed.name || slug,
    slug,
    requiresEnv: pkg.requiresEnv,
    domains: manifest.capabilities.domains,
    missingBins,
    installSteps: parsed.install.length,
  };
},
```

**Key difference from old `skill_download`:** Host writes files + generates manifest + adds domains. Agent receives a result summary, not raw files.

**Step 3: Update IPC schema**

In `src/ipc-schemas.ts`, replace `SkillDownloadSchema` with:

```typescript
SkillInstallSchema: z.object({
  query: safeString(500).optional(),
  slug: safeString(200).optional(),
}).strict().refine(d => d.query || d.slug, 'Provide query or slug'),
```

**Step 4: Run tests**

Run: `npx vitest run tests/host/skill-install.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat(skills): host-controlled skill install — download, screen, manifest, write, domains
```

---

### Task 3: Simplify agent skill tool and prompt

The agent no longer needs search/download/write steps. Collapse to a single `install` action.

**Files:**
- Modify: `src/agent/mcp-server.ts:188-211` — simplify skill tool
- Modify: `src/agent/tool-catalog.ts:220-232` — same
- Modify: `src/agent/prompt/modules/skills.ts` — remove install instructions, add one-liner

**Step 1: Simplify the skill tool**

The MCP tool becomes:

```typescript
tool('skill',
  'Manage skills: install from ClawHub or request credentials.\n' +
  'Use type: "install" with a query or slug to install a new skill. The host handles everything.\n' +
  'Use type: "request_credential" to request an API key that a skill needs.',
  {
    type: z.enum(['install', 'request_credential']),
    query: z.string().optional().describe('Search query (for type: "install")'),
    slug: z.string().optional().describe('ClawHub skill slug (for type: "install")'),
    envName: z.string().optional().describe('Environment variable name (for type: "request_credential")'),
  },
  (args) => {
    const { type, ...rest } = args;
    const SKILL_ACTIONS: Record<string, string> = {
      install: 'skill_install',
      request_credential: 'credential_request',
    };
    const params = Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined));
    return ipcCall(SKILL_ACTIONS[type], params);
  },
),
```

**Step 2: Simplify the skills prompt module**

Replace the "Installing NEW Skills from ClawHub" and "Credential Requirements" sections (lines 90-113) with:

```typescript
lines.push(
  '',
  '### Installing New Skills',
  '',
  'To install a skill from ClawHub: `skill({ type: "install", query: "what you need" })`',
  'The host downloads, validates, and installs the skill. You\'ll receive the result',
  'including any required credentials (`requiresEnv`) and missing binaries (`missingBins`).',
  'For each entry in `requiresEnv`, call `skill({ type: "request_credential", envName: "..." })`.',
);
```

Remove the "Creating Skills" section (lines 71-88) — skill creation should also go through a host IPC action. For now, replace with:

```typescript
if (ctx.userWorkspaceWritable) {
  lines.push(
    '',
    '### Creating Skills',
    '',
    'To create a custom skill, write a SKILL.md file and use',
    '`skill({ type: "install", slug: "my-skill" })` to register it.',
  );
}
```

**Step 3: Update `renderMinimal`**

```typescript
renderMinimal(ctx: PromptContext): string[] {
  return [
    '## Skills',
    ctx.skills.length > 0
      ? `${ctx.skills.length} skills available. Read skill files from ./user/skills/ or ./agent/skills/ as needed.`
      : 'No skills installed. Use `skill({ type: "install", query: "..." })` to install from ClawHub.',
  ];
}
```

**Step 4: Update `shouldInclude`**

Now that install instructions are minimal, skills module can skip when no skills and no writable workspace:

```typescript
shouldInclude(ctx: PromptContext): boolean {
  return ctx.skills.length > 0 || ctx.userWorkspaceWritable;
}
```

Actually, keep it always included — the agent always needs to know it can install skills.

**Step 5: Commit**

```
refactor(skills): simplify agent skill tool to single install action
```

---

### Task 4: Wire ProxyDomainList into proxy startup

Replace `onApprove` callbacks with `allowedDomains` from the domain list.

**Files:**
- Modify: `src/host/web-proxy.ts` — add `onDenied` callback option
- Modify: `src/host/server-completions.ts:575-617` — remove `webProxyApprove`, pass `allowedDomains` + `onDenied`
- Modify: `src/host/server-k8s.ts:118-156` — remove `onApprove`, pass `allowedDomains` + `onDenied`
- Modify: `src/host/server-completions.ts:1324-1328` — remove `cleanupSession` call

**Step 1: Add `onDenied` to WebProxyOptions**

```typescript
/** Called when a request to an unapproved domain is denied. Use to queue for admin review. */
onDenied?: (domain: string, sessionId: string) => void;
```

**Step 2: Update `checkDomainApproval()` in web-proxy.ts**

```typescript
async function checkDomainApproval(domain: string, method: string, url: string): Promise<string | null> {
  if (allowedDomains?.has(domain)) return null;
  if (domainDecisions.get(domain) === true) return null;
  if (!onApprove) {
    if (allowedDomains) {
      onDenied?.(domain, sessionId);
      return `Domain ${domain} is not in the approved domain list. Ask an admin to approve it.`;
    }
    return null; // No allowlist configured — auto-approve (backward compat)
  }
  // Existing onApprove path (kept for backward compat)
  const decision = await onApprove(domain, method, url);
  if (decision.approved) domainDecisions.set(domain, true);
  return decision.approved ? null : (decision.reason ?? `Network access to ${domain} was denied`);
}
```

**Step 3: Wire into server-completions.ts**

Replace the `webProxyApprove` callback and `requestApproval` import with:

```typescript
// Pass domain allowlist to proxy — no onApprove callback needed (no deadlock).
// Denied domains are queued for admin review via onDenied.
```

In `startWebProxy` calls, replace `onApprove: webProxyApprove` with:

```typescript
allowedDomains: deps.domainList?.getAllowedDomains(),
onDenied: (domain, sid) => deps.domainList?.addPending(domain, sid),
```

Remove `cleanupSession` import and call (lines 1324-1328).

**Step 4: Wire into server-k8s.ts**

Replace lines 120-144 with:

```typescript
allowedDomains: domainList.getAllowedDomains(),
onDenied: (domain, sid) => domainList.addPending(domain, sid),
```

**Step 5: Populate domain list from installed skills at startup**

At server startup (both `server.ts` and `server-k8s.ts`), scan installed skill directories, parse each SKILL.md, generate manifest, and call `domainList.addSkillDomains()`.

```typescript
// Populate domain allowlist from installed skills
const skillsDirs = [agentSkillsDir(agentName)];
// Add user skills dirs if applicable
for (const dir of skillsDirs) {
  for (const skill of loadAndParseSkills(dir)) {
    const manifest = generateManifest(skill);
    domainList.addSkillDomains(skill.name, manifest.capabilities.domains);
  }
}
```

**Step 6: Run tests**

Run: `npm test`

**Step 7: Commit**

```
refactor(proxy): replace onApprove with synchronous domain allowlist
```

---

### Task 5: Add admin domain management endpoints

**Files:**
- Modify: `src/host/server-admin.ts` — replace `POST /admin/api/proxy/approve` with new endpoints

**Step 1: Replace old endpoint with new ones**

```typescript
// GET /admin/api/proxy/domains — list allowed + pending domains
// POST /admin/api/proxy/domains/approve — { domain } → approve pending domain
// POST /admin/api/proxy/domains/deny — { domain } → deny pending domain
```

The GET endpoint returns:

```typescript
{
  allowed: string[],           // all currently allowed domains
  pending: PendingDomain[],    // domains awaiting admin review
}
```

**Step 2: Remove old `POST /admin/api/proxy/approve`**

Remove lines 388-408 and the `resolveApproval`/`preApproveDomain` imports.

**Step 3: Commit**

```
feat(admin): add domain management endpoints for proxy allowlist
```

---

### Task 6: Remove old approval system

**Files:**
- Delete: `src/host/web-proxy-approvals.ts`
- Delete: `tests/host/web-proxy-approvals.test.ts`
- Modify: `src/host/ipc-handlers/sandbox-tools.ts` — remove domain extraction from `sandbox_approve`, remove `web_proxy_approve` handler
- Modify: `src/agent/local-sandbox.ts` — remove `extractNetworkDomains()`, `extractDomainsFromContent()`, `extractDomainsFromScript()`, and related constants
- Modify: `src/ipc-schemas.ts` — remove `WebProxyApproveSchema` and `SkillDownloadSchema` / `SkillSearchSchema`
- Modify: `tests/agent/local-sandbox.test.ts` — remove domain extraction tests
- Update: `tests/host/web-proxy.test.ts` — update tests that use `onApprove`

**Step 1: Delete web-proxy-approvals.ts and its tests**

**Step 2: Clean up sandbox-tools.ts**

Remove from `sandbox_approve` handler:
- Lines 211-233: domain extraction + `preApproveDomain` calls
- Remove `extractNetworkDomains` import

Remove entire `web_proxy_approve` handler (lines 255-284).

**Step 3: Clean up local-sandbox.ts**

Remove:
- `NETWORK_COMMAND_DOMAINS` array
- `HAS_NETWORK_COMMAND` regex
- `ANY_URL_PATTERN` regex
- `extractNetworkDomains()` function
- `extractDomainsFromContent()` function
- `extractDomainsFromScript()` function
- Domain collection from `bash()` method (the `commandDomains`/`scriptDomains`/`allDomains` variables and the `domains` field in the approve call)

Keep:
- `createLocalSandbox()` and its `bash/readFile/writeFile/editFile` methods
- The `approve()` and `report()` helpers

**Step 4: Remove from IPC schemas**

Remove `WebProxyApproveSchema` from `src/ipc-schemas.ts`. Also remove `SkillSearchSchema` and rename/replace `SkillDownloadSchema` with `SkillInstallSchema` (if not already done in Task 2).

**Step 5: Update web-proxy.test.ts**

Tests using `onApprove` callback → update to use `allowedDomains` set instead.

**Step 6: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 7: Commit**

```
refactor(proxy): remove old approval event bus and domain pre-extraction
```

---

### Task 7: Make skills/ directory read-only to agent

Ensure the agent cannot write to the skills/ directory directly. The host writes skill files via the `skill_install` IPC handler.

**Files:**
- Modify: `src/providers/sandbox/docker.ts` — mount skills/ subdirectories as read-only
- Modify: `src/providers/sandbox/k8s.ts` — ensure provisioned skills are not writable
- Modify: `src/host/server-completions.ts` — set workspace writable flags correctly
- Modify: agent prompt — remove "write directly to ./user/skills/" guidance

**Step 1: Docker sandbox**

The Docker provider already supports `agentWorkspaceWritable` and `userWorkspaceWritable` flags. Skills live inside these workspaces (`agent/skills/`, `user/skills/`). Since we can't mount a subdirectory differently, we have two options:

a. Keep workspace writable but remove the agent's prompt instructions to write to skills/
b. Mount a separate read-only volume for skills/

Option (a) is simpler and sufficient — the security boundary is the host IPC handler, not filesystem permissions. The agent is sandboxed and can only interact via IPC. If the agent writes to skills/ directly, the host won't have generated a manifest or added domains, so the skill won't have proxy access.

**Step 2: Verify k8s path**

In k8s, workspace files are provisioned via HTTP from the host. The host controls what gets provisioned — the agent can't add files that aren't in the host's workspace directory. After a session, workspace release only accepts changes from scratch/ (unless admin). So skills written by the agent in-container don't persist.

**Step 3: Update prompt**

Already done in Task 3 — the "Creating Skills" section was updated to use the IPC tool instead of direct file writes.

**Step 4: Commit**

```
refactor(skills): enforce host-only skill writes via prompt and IPC
```

---

### Task 8: Update documentation and skills

**Files:**
- Modify: `.claude/skills/ax-web-proxy/SKILL.md` — update to reflect allowlist approach
- Modify: `.claude/journal/host/web-proxy.md` — add journal entry
- Modify: `.claude/lessons/host/entries.md` — add lessons learned

**Step 1: Update ax-web-proxy skill**

Remove sections about:
- `extractNetworkDomains()` and its pitfalls
- Domain approval deadlock problem
- `preApproveDomain()` / `requestApproval()` / `resolveApproval()`
- `web_proxy_approve` IPC action

Add sections about:
- `ProxyDomainList` and how it works
- Skill manifest `capabilities.domains` auto-detection
- Admin pending queue for unapproved domains
- Built-in domains (package managers)
- Host-controlled skill install flow

**Step 2: Add journal entry and lessons**

**Step 3: Commit**

```
docs: update web proxy skill and journal for domain allowlist + host-controlled install
```
