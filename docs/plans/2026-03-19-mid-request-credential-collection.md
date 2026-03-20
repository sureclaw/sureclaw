# Mid-Request Credential Collection — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow the agent to request credentials mid-request after installing a skill. The host collects them via SSE, then re-spawns the agent. Works across multiple stateless host replicas without session affinity.

**Architecture:** Replace in-memory credential promise map with event bus coordination (in-process for local/Docker, NATS for k8s). Add `credential_request` IPC action as a signal. Post-agent loop in processCompletion re-scans skills, collects credentials via eventBus, re-spawns agent.

**Tech Stack:** TypeScript, Zod (IPC schemas), TypeBox (tool catalog), vitest (tests)

**Design doc:** `docs/plans/2026-03-19-mid-request-credential-collection-design.md`

---

### Task 1: Add `CredentialRequestSchema` to IPC schemas

**Files:**
- Modify: `src/ipc-schemas.ts` (after SkillSearchSchema, line 156)
- Create: `tests/ipc-schemas-credential.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/ipc-schemas-credential.test.ts
import { describe, it, expect } from 'vitest';
import { IPC_SCHEMAS } from '../src/ipc-schemas.js';

describe('credential_request IPC schema', () => {
  it('is registered in IPC_SCHEMAS', () => {
    expect(IPC_SCHEMAS).toHaveProperty('credential_request');
  });

  it('accepts valid credential request', () => {
    const schema = IPC_SCHEMAS['credential_request'];
    const result = schema.safeParse({
      action: 'credential_request',
      envName: 'LINEAR_API_KEY',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing envName', () => {
    const schema = IPC_SCHEMAS['credential_request'];
    const result = schema.safeParse({ action: 'credential_request' });
    expect(result.success).toBe(false);
  });

  it('rejects extra fields (strict mode)', () => {
    const schema = IPC_SCHEMAS['credential_request'];
    const result = schema.safeParse({
      action: 'credential_request',
      envName: 'LINEAR_API_KEY',
      hackerField: 'surprise',
    });
    expect(result.success).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ipc-schemas-credential.test.ts`
Expected: FAIL — `credential_request` not in IPC_SCHEMAS

**Step 3: Add the schema**

In `src/ipc-schemas.ts`, after `SkillSearchSchema` (line 156), add:

```typescript
export const CredentialRequestSchema = ipcAction('credential_request', {
  envName: safeString(200),
});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ipc-schemas-credential.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/ipc-schemas-credential.test.ts src/ipc-schemas.ts
git commit -m "feat: add credential_request IPC schema"
```

---

### Task 2: Rewrite `credential-prompts.ts` to use event bus

Replace the in-memory promise map with event bus subscribe/emit pattern. This eliminates the session affinity requirement.

**Files:**
- Modify: `src/host/credential-prompts.ts`
- Create: `tests/host/credential-prompts.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/host/credential-prompts.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requestCredential } from '../../src/host/credential-prompts.js';
import { createEventBus } from '../../src/host/event-bus.js';

describe('requestCredential (event bus backed)', () => {
  it('resolves when credential.resolved event arrives with matching envName', async () => {
    const eventBus = createEventBus();
    const requestId = 'req-1';

    const promise = requestCredential('sess-1', 'MY_KEY', eventBus, requestId, 5000);

    // Simulate credential.resolved event (from POST /v1/credentials/provide)
    setTimeout(() => {
      eventBus.emit({
        type: 'credential.resolved',
        requestId,
        timestamp: Date.now(),
        data: { envName: 'MY_KEY', sessionId: 'sess-1', value: 'the_secret' },
      });
    }, 50);

    const result = await promise;
    expect(result).toBe('the_secret');
  });

  it('ignores credential.resolved events for different envName', async () => {
    const eventBus = createEventBus();
    const requestId = 'req-2';

    const promise = requestCredential('sess-1', 'MY_KEY', eventBus, requestId, 500);

    setTimeout(() => {
      eventBus.emit({
        type: 'credential.resolved',
        requestId,
        timestamp: Date.now(),
        data: { envName: 'OTHER_KEY', sessionId: 'sess-1', value: 'wrong' },
      });
    }, 50);

    const result = await promise;
    expect(result).toBeNull(); // timeout — wrong envName
  });

  it('returns null on timeout', async () => {
    const eventBus = createEventBus();
    const result = await requestCredential('sess-1', 'MY_KEY', eventBus, 'req-3', 100);
    expect(result).toBeNull();
  });

  it('unsubscribes from event bus after resolution', async () => {
    const eventBus = createEventBus();
    const requestId = 'req-4';

    const promise = requestCredential('sess-1', 'MY_KEY', eventBus, requestId, 5000);

    // Resolve it
    eventBus.emit({
      type: 'credential.resolved',
      requestId,
      timestamp: Date.now(),
      data: { envName: 'MY_KEY', sessionId: 'sess-1', value: 'val' },
    });

    await promise;
    // No way to directly check listener count per-request, but at least verify no error on subsequent emit
    eventBus.emit({
      type: 'credential.resolved',
      requestId,
      timestamp: Date.now(),
      data: { envName: 'MY_KEY', sessionId: 'sess-1', value: 'val2' },
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/credential-prompts.test.ts`
Expected: FAIL — signature mismatch (old signature doesn't take eventBus/requestId)

**Step 3: Rewrite credential-prompts.ts**

```typescript
/**
 * Credential prompt coordination via event bus.
 *
 * requestCredential() subscribes to the event bus for credential.resolved
 * events and returns a Promise that resolves with the credential value.
 * Works across stateless host replicas: in-process event bus for local/Docker,
 * NATS-backed event bus for k8s.
 *
 * Replaces the old in-memory promise map pattern that required session affinity.
 */

import type { EventBus } from './event-bus.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'credential-prompts' });

/** How long to wait for the user to provide a credential before giving up. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Wait for a credential to be provided via the event bus.
 *
 * Subscribes to events for the given requestId and resolves when a
 * credential.resolved event with matching envName arrives. Returns the
 * credential value, or null on timeout.
 */
export function requestCredential(
  sessionId: string,
  envName: string,
  eventBus: EventBus,
  requestId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;

    const unsubscribe = eventBus.subscribeRequest(requestId, (event) => {
      if (settled) return;
      if (event.type !== 'credential.resolved') return;
      if (event.data?.envName !== envName) return;

      settled = true;
      clearTimeout(timer);
      unsubscribe();
      logger.info('credential_resolved_via_event', { sessionId, envName, requestId });
      resolve((event.data.value as string) ?? null);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      logger.info('credential_prompt_timeout', { sessionId, envName, requestId });
      resolve(null);
    }, timeoutMs);

    // Don't prevent process exit
    if (timer.unref) timer.unref();

    logger.debug('credential_prompt_waiting', { sessionId, envName, requestId });
  });
}
```

Note: `resolveCredential()` and `cleanupSession()` are removed. Callers that used `resolveCredential()` now emit a `credential.resolved` event via the event bus. Callers that used `cleanupSession()` no longer need to — event bus subscriptions self-cleanup via unsubscribe or timeout.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/credential-prompts.test.ts`
Expected: PASS

**Step 5: Verify build (will break — callers still reference old API)**

Run: `npm run build`
Expected: FAIL — compile errors in server.ts, server-admin.ts, oauth-skills.ts, server-completions.ts (referencing removed exports). These are fixed in Tasks 3-5.

**Step 6: Commit**

```bash
git add src/host/credential-prompts.ts tests/host/credential-prompts.test.ts
git commit -m "feat: rewrite credential-prompts to use event bus (no session affinity)"
```

---

### Task 3: Update `POST /v1/credentials/provide` endpoints

Both `server.ts` and `server-admin.ts` need to emit `credential.resolved` via event bus instead of calling `resolveCredential()`.

**Files:**
- Modify: `src/host/server.ts` (lines 654-671)
- Modify: `src/host/server-admin.ts` (lines 389-404)

**Step 1: Update server.ts**

Replace the `/v1/credentials/provide` handler (lines 654-671):

```typescript
    // POST /v1/credentials/provide — resolve a pending credential prompt
    if (url === '/v1/credentials/provide' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const { sessionId, envName, value, requestId: credRequestId } = body;
        if (typeof sessionId !== 'string' || !sessionId ||
            typeof envName !== 'string' || !envName ||
            typeof value !== 'string' ||
            typeof credRequestId !== 'string' || !credRequestId) {
          sendError(res, 400, 'Missing required fields: sessionId, envName, value, requestId');
          return;
        }
        // Store credential for future requests
        await providers.credentials.set(envName, value);
        // Emit event so the waiting processCompletion unblocks (works across replicas via NATS)
        eventBus.emit({
          type: 'credential.resolved',
          requestId: credRequestId,
          timestamp: Date.now(),
          data: { envName, sessionId, value },
        });
        const responseBody = JSON.stringify({ ok: true });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(responseBody) });
        res.end(responseBody);
      } catch (err) {
        sendError(res, 400, `Invalid request: ${(err as Error).message}`);
      }
      return;
    }
```

**Step 2: Update server-admin.ts**

Same pattern for `/admin/api/credentials/provide`. The admin server also needs eventBus access — check how it receives deps and add eventBus if not already available.

```typescript
  // POST /admin/api/credentials/provide — resolve a pending credential prompt
  if (pathname === '/admin/api/credentials/provide' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { sessionId, envName, value, requestId: credRequestId } = body;
      if (typeof sessionId !== 'string' || !sessionId ||
          typeof envName !== 'string' || !envName ||
          typeof value !== 'string' ||
          typeof credRequestId !== 'string' || !credRequestId) {
        sendError(res, 400, 'Missing required fields: sessionId, envName, value, requestId');
        return;
      }
      await deps.providers.credentials.set(envName, value);
      deps.eventBus?.emit({
        type: 'credential.resolved',
        requestId: credRequestId,
        timestamp: Date.now(),
        data: { envName, sessionId, value },
      });
      sendJSON(res, { ok: true });
    } catch (err) {
      sendError(res, 400, `Invalid request: ${(err as Error).message}`);
    }
    return;
  }
```

**Step 3: Verify build compiles (may still have errors from other callers)**

Run: `npm run build`

**Step 4: Commit**

```bash
git add src/host/server.ts src/host/server-admin.ts
git commit -m "feat: credentials/provide endpoint emits via event bus instead of resolveCredential"
```

---

### Task 4: Update `oauth-skills.ts` to use event bus

Replace `resolveCredential()` calls with event bus emit. The `PendingOAuthFlow` needs to store `requestId` so the callback can emit to the right subject.

**Files:**
- Modify: `src/host/oauth-skills.ts`

**Step 1: Add requestId to PendingOAuthFlow and startOAuthFlow**

```typescript
interface PendingOAuthFlow {
  sessionId: string;
  requestId: string;     // NEW — needed for event bus emit
  requirement: OAuthRequirement;
  codeVerifier: string;
  redirectUri: string;
}
```

Update `startOAuthFlow` signature to accept `requestId`:

```typescript
export function startOAuthFlow(
  sessionId: string,
  requestId: string,      // NEW
  req: OAuthRequirement,
  redirectUri: string,
): string {
```

Store it in the pending flow:

```typescript
  pendingFlows.set(state, { sessionId, requestId, requirement: req, codeVerifier, redirectUri });
```

**Step 2: Replace resolveCredential calls in resolveOAuthCallback**

Remove the import of `resolveCredential`. Add `EventBus` parameter:

```typescript
export async function resolveOAuthCallback(
  provider: string,
  code: string,
  state: string,
  credentials: CredentialProvider,
  eventBus: EventBus,     // NEW
): Promise<boolean> {
```

Replace `resolveCredential(sessionId, req.name, blob.access_token)` (line 150) with:

```typescript
    eventBus.emit({
      type: 'credential.resolved',
      requestId: flow.requestId,
      timestamp: Date.now(),
      data: { envName: req.name, sessionId, value: blob.access_token },
    });
```

Replace the two error-path `resolveCredential(sessionId, req.name, '')` calls (lines 127, 154) with:

```typescript
    eventBus.emit({
      type: 'credential.resolved',
      requestId: flow.requestId,
      timestamp: Date.now(),
      data: { envName: req.name, sessionId, value: '' },
    });
```

**Step 3: Update callers of startOAuthFlow and resolveOAuthCallback**

In `server-completions.ts` (line 785), pass `requestId`:

```typescript
      const authorizeUrl = startOAuthFlow(sessionId, requestId, oauthReq, redirectUri);
```

In `server.ts` OAuth callback handler (around line 674), pass `eventBus`:

```typescript
      const result = await resolveOAuthCallback(provider, code, state, providers.credentials, eventBus);
```

**Step 4: Verify build**

Run: `npm run build`
Expected: PASS (or close — remaining errors fixed in Task 5)

**Step 5: Commit**

```bash
git add src/host/oauth-skills.ts src/host/server-completions.ts src/host/server.ts
git commit -m "feat: oauth-skills uses event bus instead of resolveCredential"
```

---

### Task 5: Update `server-completions.ts` — pass eventBus to requestCredential and remove cleanupSession

The pre-request credential collection in processCompletion already calls `requestCredential`. Update it to pass eventBus and requestId.

**Files:**
- Modify: `src/host/server-completions.ts`

**Step 1: Update requestCredential calls (lines 796-797 and 822-823)**

OAuth credential blocking (line 796-797):

```typescript
      const { requestCredential } = await import('./credential-prompts.js');
      const accessToken = await requestCredential(sessionId, oauthReq.name, eventBus!, requestId);
```

Plain env credential blocking (line 822-823):

```typescript
        const { requestCredential } = await import('./credential-prompts.js');
        const provided = await requestCredential(sessionId, envName, eventBus!, requestId);
```

**Step 2: Remove cleanupSession call in finally block**

Remove lines 1387-1389 (the `cleanupCredentialPrompts` call) — no longer needed since there's no in-memory state.

```typescript
    // REMOVE:
    // const { cleanupSession: cleanupCredentialPrompts } = await import('./credential-prompts.js');
    // cleanupCredentialPrompts(sessionId);
```

**Step 3: Verify build**

Run: `npm run build`
Expected: PASS

**Step 4: Run full test suite**

Run: `npm test`
Expected: PASS (or identify tests that reference old API — fix them)

**Step 5: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat: processCompletion passes eventBus to requestCredential"
```

---

### Task 6: Add `requestedCredentials` shared state and IPC handler

**Files:**
- Modify: `src/host/ipc-server.ts` (IPCHandlerOptions)
- Modify: `src/host/ipc-handlers/skills.ts` (add credential_request handler)
- Modify: `src/host/server.ts` (create + pass map)
- Modify: `src/host/host-process.ts` (create + pass map)
- Modify: `src/host/server-completions.ts` (CompletionDeps)

**Step 1: Add to IPCHandlerOptions**

In `src/host/ipc-server.ts`, add to `IPCHandlerOptions` (after `workspaceMap`):

```typescript
  /** Tracks credential_request IPC calls per session. Consumed by processCompletion post-agent loop. */
  requestedCredentials?: Map<string, Set<string>>;
```

**Step 2: Add credential_request handler to skills.ts**

```typescript
import type { EventBus } from '../event-bus.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'ipc-skills' });

interface SkillsHandlerOptions {
  requestedCredentials?: Map<string, Set<string>>;
}

export function createSkillsHandlers(providers: ProviderRegistry, opts?: SkillsHandlerOptions) {
  return {
    skill_search: async (req: any, ctx: IPCContext) => {
      // ... unchanged ...
    },

    audit_query: async (req: any) => {
      // ... unchanged ...
    },

    credential_request: async (req: any, ctx: IPCContext) => {
      const { envName } = req;
      if (opts?.requestedCredentials) {
        let envNames = opts.requestedCredentials.get(ctx.sessionId);
        if (!envNames) {
          envNames = new Set();
          opts.requestedCredentials.set(ctx.sessionId, envNames);
        }
        envNames.add(envName);
      }
      logger.info('credential_request_recorded', { envName, sessionId: ctx.sessionId });
      await providers.audit.log({
        action: 'credential_request',
        sessionId: ctx.sessionId,
        args: { envName },
      });
      return { ok: true };
    },
  };
}
```

**Step 3: Pass to createSkillsHandlers in createIPCHandler**

In `src/host/ipc-server.ts`:

```typescript
    ...createSkillsHandlers(providers, {
      requestedCredentials: opts?.requestedCredentials,
    }),
```

**Step 4: Create and wire in server.ts and host-process.ts**

In both files, after `const workspaceMap = ...`:

```typescript
  const requestedCredentials = new Map<string, Set<string>>();
```

Add to `completionDeps` and `createIPCHandler` calls.

**Step 5: Add to CompletionDeps in server-completions.ts**

```typescript
  /** Tracks credential_request IPC calls per session. */
  requestedCredentials?: Map<string, Set<string>>;
```

**Step 6: Verify build**

Run: `npm run build`
Expected: PASS

**Step 7: Commit**

```bash
git add src/host/ipc-server.ts src/host/ipc-handlers/skills.ts src/host/server.ts src/host/host-process.ts src/host/server-completions.ts
git commit -m "feat: add credential_request IPC handler with requestedCredentials shared state"
```

---

### Task 7: Post-agent credential collection loop in processCompletion

After the agent exits and workspace is committed, check if credentials were requested. If so, re-scan skills, collect credentials, and re-spawn the agent.

**Files:**
- Modify: `src/host/server-completions.ts` (after workspace.commit, around line 1196)

**Step 1: Add the post-agent credential loop**

After the `finalizeGitWorkspace` block (line 1207) and before `parseAgentResponse` (line 1210), insert:

```typescript
    // ── Post-agent credential collection ──
    // If the agent called credential_request during this turn, re-scan
    // skills from the now-committed workspace and collect any missing
    // credentials. Then re-spawn the agent with credentials available.
    const pendingCreds = deps.requestedCredentials?.get(sessionId);
    if (pendingCreds && pendingCreds.size > 0 && eventBus) {
      // Clean up the request set
      deps.requestedCredentials!.delete(sessionId);

      // Re-scan skills from the updated workspace
      const { env: newEnvReqs, oauth: newOAuthReqs } =
        collectSkillCredentialRequirements(
          agentWsPath ? join(agentWsPath, 'skills') : undefined,
          userWsPath ? join(userWsPath, 'skills') : undefined,
        );

      // Collect credentials for env vars that are actually required and missing
      const collectedEnvNames: string[] = [];
      for (const envName of newEnvReqs) {
        if (!credentialMap.toEnvMap()[envName]) {
          // Not already registered — check store or prompt user
          let realValue = await providers.credentials.get(envName);

          if (!realValue) {
            reqLogger.info('post_agent_credential_prompt', { envName });
            eventBus.emit({
              type: 'credential.required',
              requestId,
              timestamp: Date.now(),
              data: { envName, sessionId },
            });

            const { requestCredential } = await import('./credential-prompts.js');
            const provided = await requestCredential(sessionId, envName, eventBus, requestId);
            if (provided) {
              await providers.credentials.set(envName, provided).catch(() => {
                reqLogger.debug('credential_store_failed', { envName });
              });
              realValue = provided;
            }
          }

          if (realValue) {
            credentialMap.register(envName, realValue);
            collectedEnvNames.push(envName);
            reqLogger.debug('post_agent_credential_registered', { envName });
          }
        }
      }

      // TODO: handle newOAuthReqs similarly (same pattern as pre-request OAuth loop)

      // If any new credentials were collected, re-spawn the agent
      if (collectedEnvNames.length > 0) {
        reqLogger.info('post_agent_respawn', { credentials: collectedEnvNames });

        // Build a credential summary message for the agent
        const credSummary = collectedEnvNames
          .map(name => `${name}=${credentialMap.toEnvMap()[name]}`)
          .join(', ');

        // Update the sandbox config env with new credential placeholders
        const updatedEnv = {
          ...sandboxConfig.env,
          ...credentialMap.toEnvMap(),
        };
        const respawnConfig = { ...sandboxConfig, env: updatedEnv };

        // Build new stdin payload with credential notification
        const credMessage = `Credentials have been collected and are now available as environment variables: ${credSummary}. Confirm to the user that the skill is ready to use.`;
        const respawnPayload = JSON.stringify({
          history: [],
          message: credMessage,
          taintRatio: 0,
          taintThreshold: 1,
          profile: config.profile,
          sandboxType: config.providers.sandbox,
        });

        // Re-spawn agent
        const credProc = await agentSandbox.spawn(respawnConfig);

        // Write stdin payload
        credProc.stdin.write(respawnPayload);
        credProc.stdin.end();

        // Collect response
        let credResponse = '';
        for await (const chunk of credProc.stdout) {
          credResponse += chunk.toString();
        }
        // Drain stderr
        let credStderr = '';
        for await (const chunk of credProc.stderr) {
          credStderr += chunk.toString();
        }

        const credExitCode = await credProc.exitCode;
        if (credExitCode === 0 && credResponse.trim()) {
          response = credResponse;
          reqLogger.info('post_agent_respawn_done', { responseLength: credResponse.length });
        } else {
          reqLogger.warn('post_agent_respawn_failed', { exitCode: credExitCode, stderr: credStderr.slice(0, 500) });
          // Fall through with original response
        }
      }
    }
```

Note: The re-spawn is simplified here. In practice it should reuse the existing agent spawn infrastructure (stdin payload builder, IPC bridge setup, etc.). The implementer should refactor the spawn section into a reusable function if needed. At minimum, the `stdinPayload` needs to include `identity`, `skills`, and other fields the agent expects.

**Step 2: Verify build**

Run: `npm run build`
Expected: PASS

**Step 3: Run tests**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat: post-agent credential collection loop in processCompletion"
```

---

### Task 8: Add `request_credential` to agent tool catalog

**Files:**
- Modify: `src/agent/tool-catalog.ts` (skill tool entry, lines 195-210)
- Create: `tests/agent/tool-catalog-credential.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/agent/tool-catalog-credential.test.ts
import { describe, it, expect } from 'vitest';
import { TOOL_CATALOG } from '../../src/agent/tool-catalog.js';

describe('skill tool credential_request action', () => {
  const skillTool = TOOL_CATALOG.find(t => t.name === 'skill');

  it('has request_credential in actionMap', () => {
    expect(skillTool?.actionMap).toHaveProperty('request_credential', 'credential_request');
  });

  it('has search and request_credential types', () => {
    // Verify both action types exist in the actionMap
    expect(skillTool?.actionMap).toEqual({
      search: 'skill_search',
      request_credential: 'credential_request',
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/tool-catalog-credential.test.ts`
Expected: FAIL

**Step 3: Update the skill tool entry**

In `src/agent/tool-catalog.ts`, replace the skill tool entry (lines 195-210):

```typescript
  {
    name: 'skill',
    label: 'Skill',
    description:
      'Manage skills: search for skills or request credentials.\n\n' +
      'Use `type: "search"` to find skills by query.\n' +
      'Use `type: "request_credential"` to request a credential (e.g. API key) that a skill needs.\n' +
      'The host will prompt the user to provide it. This ends the current turn; you will be\n' +
      're-invoked with the credential available as an environment variable.',
    parameters: Type.Union([
      Type.Object({
        type: Type.Literal('search'),
        query: Type.String({ description: 'Search query' }),
        limit: Type.Optional(Type.Number({ description: 'Max results (1-50, default 20)' })),
      }),
      Type.Object({
        type: Type.Literal('request_credential'),
        envName: Type.String({ description: 'Environment variable name the skill requires (e.g. LINEAR_API_KEY)' }),
      }),
    ]),
    category: 'skill',
    actionMap: {
      search: 'skill_search',
      request_credential: 'credential_request',
    },
  },
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/tool-catalog-credential.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/tool-catalog.ts tests/agent/tool-catalog-credential.test.ts
git commit -m "feat: add request_credential action to skill tool catalog"
```

---

### Task 9: Update skills prompt module

**Files:**
- Modify: `src/agent/prompt/modules/skills.ts`

**Step 1: Add credential request guidance**

In `src/agent/prompt/modules/skills.ts`, within the `render()` method, before the closing `return lines;` (line 78), add:

```typescript
    lines.push(
      '',
      '### Credential Requirements',
      '',
      'Skills may declare required credentials (API keys, tokens) in their frontmatter.',
      'After installing a skill, check its `requires.env` list. For each required env var,',
      'use the skill tool with `type: "request_credential"` and the env var name.',
      'This ends your current turn and prompts the user to provide the credential.',
      'You will be re-invoked with the credentials available as environment variables.',
    );
```

**Step 2: Verify build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/agent/prompt/modules/skills.ts
git commit -m "feat: add credential request guidance to skills prompt module"
```

---

### Task 10: Integration tests and full test suite

**Files:**
- Create: `tests/host/credential-request-integration.test.ts`

**Step 1: Write the integration test**

```typescript
// tests/host/credential-request-integration.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createSkillsHandlers } from '../../src/host/ipc-handlers/skills.js';
import { requestCredential } from '../../src/host/credential-prompts.js';
import { createEventBus } from '../../src/host/event-bus.js';
import type { IPCContext } from '../../src/host/ipc-server.js';

function stubProviders() {
  const stored = new Map<string, string>();
  return {
    credentials: {
      get: vi.fn(async (key: string) => stored.get(key) ?? null),
      set: vi.fn(async (key: string, val: string) => { stored.set(key, val); }),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    },
    audit: { log: vi.fn(async () => {}), query: vi.fn(async () => []) },
  } as any;
}

describe('credential_request end-to-end via event bus', () => {
  it('IPC handler records request, event bus resolves credential', async () => {
    const eventBus = createEventBus();
    const requestedCredentials = new Map<string, Set<string>>();
    const providers = stubProviders();

    const handlers = createSkillsHandlers(providers, { requestedCredentials });
    const ctx: IPCContext = { sessionId: 'sess-1', agentId: 'agent-1', requestId: 'req-1' };

    // Agent calls credential_request
    const result = await handlers.credential_request({ envName: 'LINEAR_API_KEY' }, ctx);
    expect(result.ok).toBe(true);

    // Verify it was recorded
    expect(requestedCredentials.get('sess-1')?.has('LINEAR_API_KEY')).toBe(true);

    // Simulate the host-side credential collection via event bus
    const credPromise = requestCredential('sess-1', 'LINEAR_API_KEY', eventBus, 'req-1', 5000);

    // Simulate frontend providing credential (POST /v1/credentials/provide)
    setTimeout(() => {
      eventBus.emit({
        type: 'credential.resolved',
        requestId: 'req-1',
        timestamp: Date.now(),
        data: { envName: 'LINEAR_API_KEY', sessionId: 'sess-1', value: 'lin_test_abc' },
      });
    }, 50);

    const credValue = await credPromise;
    expect(credValue).toBe('lin_test_abc');
  });
});
```

**Step 2: Run integration test**

Run: `npx vitest run tests/host/credential-request-integration.test.ts`
Expected: PASS

**Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git add tests/host/credential-request-integration.test.ts
git commit -m "test: add integration test for mid-request credential collection via event bus"
```

---

### Task 11: Update journal and lessons

**Files:**
- Modify: `.claude/journal/host/` (add entry)
- Modify: `.claude/lessons/architecture/` (add lesson about session affinity and event bus coordination)

Append journal entry documenting the feature. Add lesson about:
- In-memory promise maps creating hidden session affinity requirements
- Event bus as the coordination mechanism for cross-replica communication
- The post-agent credential loop pattern

**Step 1: Update journal and lessons per protocol**

**Step 2: Commit**

```bash
git add .claude/journal/ .claude/lessons/
git commit -m "docs: journal and lessons for mid-request credential collection"
```
