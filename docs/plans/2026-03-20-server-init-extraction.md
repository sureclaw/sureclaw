# Server Init Extraction — Deduplicating host-process.ts and server.ts

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract ~700 lines of duplicated initialization, request handling, and lifecycle code from `server.ts` and `host-process.ts` into a shared `server-init.ts` module.

**Architecture:** Create `src/host/server-init.ts` that exports an `initHostCore()` async function returning a bag of initialized objects (providers, deps, handlers, helpers). Both `server.ts` and `host-process.ts` call it once, then wire up only their mode-specific pieces. Also extract the duplicated `handleCompletions` streaming/non-streaming logic and `handleEvents` SSE logic into `server-request-handlers.ts`. The admin helper functions (`isAdmin`, `isAgentBootstrapMode`, etc.) move to a small `server-admin-helpers.ts` since they're pure functions imported by 4+ other modules.

**Tech Stack:** TypeScript, Node.js HTTP, vitest

---

## Inventory of Duplicated Code

| Section | server.ts lines | host-process.ts lines | Identical? |
|---------|----------------|-----------------------|------------|
| Imports | 1-46 | 1-45 | ~90% overlap |
| Provider/storage init | 169-177 | 105-111 | Yes |
| Agent dir setup + mkdirSync | 179-185 | 112-118 | Yes |
| Template seeding (bootstrap check, AGENTS.md, HEARTBEAT.md, capabilities.yaml, BOOTSTRAP.md, USER_BOOTSTRAP.md, DocumentStore) | 218-301 | 120-171 | Yes (server.ts has more comments + USER_BOOTSTRAP configDest copy) |
| Skills seeding | 303-326 | 173-193 | Yes |
| Admins file | 328-336 | 195-199 | Yes |
| IPC socket + sessionCanaries + workspaceMap | 339-347 | 201-206 | Yes |
| CompletionDeps | 358-373 | 211-227 | ~95% (server.ts has `sharedCredentialRegistry` absent, `verbose` source differs) |
| handleDelegate | 378-423 | 230-256 | Yes |
| Orchestrator + agentRegistry | 426-434 | 258-261 | Yes |
| createIPCHandler | 436-452 | 263-279 | Yes |
| Webhook handler | 455-508 | 339-385 | ~90% (dispatch differs) |
| Admin handler | 510-520 | 387-398 | Yes |
| handleRequest routing | 561-718 | 600-868 | ~70% (host-process has /internal/* routes) |
| handleModels | 721-728 | 625-633 | Yes |
| handleEvents SSE | 733-785 | 1079-1123 | Different (EventBus vs NATS subscribe) |
| handleCompletions body parse + session derivation | 787-865 | 903-950 | ~95% |
| handleCompletions streaming | 868-989 | 952-1051 | ~90% (processCompletion vs processCompletionWithNATS) |
| handleCompletions non-streaming | 990-1010 | 1052-1076 | ~90% |
| Scheduler callback | 1073-1142 | 1138-1210 | Yes (processCompletion vs processCompletionWithNATS) |

## What Stays Mode-Specific

**server.ts only:**
- Unix socket + TCP dual-listen lifecycle
- Channel providers (connect/disconnect/dedup)
- Legacy migration (renameSync identity files)
- Graceful drain (inflight tracking)
- File upload/download routes
- OAuth callback + credential provide routes
- `cleanStaleWorkspaces`

**host-process.ts only:**
- NATS connection + per-turn token registry (`activeTokens`)
- `processCompletionWithNATS` wrapper (staging, agent_response, workspace_release interception)
- `/internal/ipc`, `/internal/llm-proxy`, `/internal/workspace/*` routes
- `stagingStore` + cleanup
- Web proxy with MITM CA (shared k8s proxy)

---

### Task 1: Create `server-admin-helpers.ts` — extract pure admin functions

**Files:**
- Create: `src/host/server-admin-helpers.ts`
- Modify: `src/host/server.ts`
- Modify: `src/host/server-completions.ts`
- Modify: `src/host/ipc-handlers/identity.ts`
- Modify: `src/host/ipc-handlers/governance.ts`

**Step 1: Create the new file with the 4 admin helper functions**

Move these functions from `server.ts` to `server-admin-helpers.ts`:
- `isAgentBootstrapMode`
- `isAdmin`
- `addAdmin`
- `claimBootstrapAdmin`

```typescript
// src/host/server-admin-helpers.ts
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { agentIdentityDir, agentIdentityFilesDir } from '../paths.js';

/** Returns true when the agent is still in bootstrap mode. */
export function isAgentBootstrapMode(agentName: string): boolean {
  const configDir = agentIdentityDir(agentName);
  const idFilesDir = agentIdentityFilesDir(agentName);
  if (!existsSync(join(configDir, 'BOOTSTRAP.md'))) return false;
  return !existsSync(join(idFilesDir, 'SOUL.md')) || !existsSync(join(idFilesDir, 'IDENTITY.md'));
}

/** Returns true when the given userId appears in the agent's admins file. */
export function isAdmin(agentDirPath: string, userId: string): boolean {
  const adminsPath = join(agentDirPath, 'admins');
  if (!existsSync(adminsPath)) return false;
  const lines = readFileSync(adminsPath, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.includes(userId);
}

/** Appends a userId to the agent's admins file. */
export function addAdmin(agentDirPath: string, userId: string): void {
  const adminsPath = join(agentDirPath, 'admins');
  appendFileSync(adminsPath, `${userId}\n`, 'utf-8');
}

/**
 * Atomically claims the bootstrap admin slot for the given userId.
 * Returns true if this user is the first to claim (and is added to admins).
 */
export function claimBootstrapAdmin(agentDirPath: string, userId: string): boolean {
  const claimPath = join(agentDirPath, '.bootstrap-admin-claimed');
  if (existsSync(claimPath)) {
    const claimedUser = readFileSync(claimPath, 'utf-8').trim();
    if (!isAdmin(agentDirPath, claimedUser)) {
      unlinkSync(claimPath);
    }
  }
  try {
    writeFileSync(claimPath, userId, { flag: 'wx' });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  addAdmin(agentDirPath, userId);
  return true;
}
```

**Step 2: Update server.ts — re-export from the new module**

Replace the function bodies in `server.ts` with re-exports:

```typescript
// At the top of server.ts, replace the function definitions with:
export { isAgentBootstrapMode, isAdmin, addAdmin, claimBootstrapAdmin } from './server-admin-helpers.js';
```

Remove the original function definitions (lines 76-123 of server.ts).

**Step 3: Update other importers**

- `src/host/server-completions.ts` line 13: change `from './server.js'` to `from './server-admin-helpers.js'`
- `src/host/ipc-handlers/identity.ts` line 13: change `from '../server.js'` to `from '../server-admin-helpers.js'`
- `src/host/ipc-handlers/governance.ts` line 16: change `from '../server.js'` to `from '../server-admin-helpers.js'`

**Step 4: Run tests**

Run: `npm test -- --bail tests/host/admin-gate.test.ts`
Expected: All tests PASS (imports resolve to same functions via re-export)

**Step 5: Commit**

```bash
git add src/host/server-admin-helpers.ts src/host/server.ts src/host/server-completions.ts src/host/ipc-handlers/identity.ts src/host/ipc-handlers/governance.ts
git commit -m "refactor: extract admin helpers from server.ts into server-admin-helpers.ts"
```

---

### Task 2: Create `server-init.ts` — shared initialization

**Files:**
- Create: `src/host/server-init.ts`
- Modify: `src/host/server.ts`
- Modify: `src/host/host-process.ts`

**Step 1: Create `server-init.ts` with the `initHostCore()` function**

This function encapsulates all shared initialization: provider loading → storage → taint budget → router → agent dir setup → template seeding → skills seeding → admins → IPC socket → FileStore → CompletionDeps skeleton → delegation → orchestrator → agentRegistry → createIPCHandler.

```typescript
// src/host/server-init.ts — Shared host initialization for both local server and k8s host-process.

import { existsSync, readFileSync, mkdirSync, mkdtempSync, copyFileSync, cpSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../logger.js';
import type { Config, ProviderRegistry } from '../types.js';
import { dataDir, agentDir as agentDirPath, agentIdentityDir, agentIdentityFilesDir, agentSkillsDir } from '../paths.js';
import { createRouter, type Router } from './router.js';
import { createIPCHandler, createIPCServer, type DelegateRequest, type IPCContext } from './ipc-server.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { createOrchestrator, type Orchestrator } from './orchestration/orchestrator.js';
import { FileStore } from '../file-store.js';
import { templatesDir as resolveTemplatesDir, seedSkillsDir as resolveSeedSkillsDir } from '../utils/assets.js';
import type { EventBus } from './event-bus.js';
import type { MessageQueueStore } from '../providers/storage/types.js';
import { createAgentRegistry, type AgentRegistry } from './agent-registry.js';
import type { Server as NetServer } from 'node:net';

const logger = getLogger();

export interface HostCoreOptions {
  config: Config;
  providers: ProviderRegistry;
  eventBus: EventBus;
  verbose?: boolean;
}

export interface HostCore {
  config: Config;
  providers: ProviderRegistry;
  eventBus: EventBus;
  db: MessageQueueStore;
  conversationStore: ProviderRegistry['storage']['conversations'];
  sessionStore: ProviderRegistry['storage']['sessions'];
  router: Router;
  taintBudget: TaintBudget;
  fileStore: FileStore;
  completionDeps: CompletionDeps;
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  ipcServer: NetServer;
  ipcSocketPath: string;
  ipcSocketDir: string;
  orchestrator: Orchestrator;
  disableAutoState: () => void;
  agentRegistry: AgentRegistry;
  agentName: string;
  agentDirVal: string;
  identityFilesDir: string;
  sessionCanaries: Map<string, string>;
  workspaceMap: Map<string, string>;
  defaultUserId: string;
  modelId: string;
}

/**
 * Shared initialization for both server.ts (local) and host-process.ts (k8s).
 * Sets up storage, routing, IPC, template seeding, delegation, orchestrator.
 */
export async function initHostCore(opts: HostCoreOptions): Promise<HostCore> {
  const { config, providers, eventBus, verbose } = opts;

  // ── Storage, routing, taint budget ──
  mkdirSync(dataDir(), { recursive: true });
  const db = providers.storage.messages;
  const conversationStore = providers.storage.conversations;
  const sessionStore = providers.storage.sessions;
  const fileStore = await FileStore.create(providers.database);
  const taintBudget = new TaintBudget({ threshold: thresholdForProfile(config.profile) });
  const router = createRouter(providers, db, { taintBudget });

  // ── Agent directory setup ──
  const agentName = 'main';
  const agentDirVal = agentDirPath(agentName);
  const agentConfigDir = agentIdentityDir(agentName);
  const identityFilesDir = agentIdentityFilesDir(agentName);
  mkdirSync(agentDirVal, { recursive: true });
  mkdirSync(agentConfigDir, { recursive: true });
  mkdirSync(identityFilesDir, { recursive: true });

  // ── Template seeding — seed to both filesystem and DocumentStore ──
  const templatesDir = resolveTemplatesDir();
  const documents = providers.storage.documents;

  const fsBootstrapComplete =
    existsSync(join(identityFilesDir, 'SOUL.md')) && existsSync(join(identityFilesDir, 'IDENTITY.md'));
  let dbBootstrapComplete = false;
  try {
    const dbSoul = await documents.get('identity', `${agentName}/SOUL.md`);
    const dbIdentity = await documents.get('identity', `${agentName}/IDENTITY.md`);
    dbBootstrapComplete = !!(dbSoul && dbIdentity);
  } catch { /* non-fatal */ }
  const bootstrapAlreadyComplete = fsBootstrapComplete || dbBootstrapComplete;

  // Identity files → identityFilesDir + DocumentStore
  for (const file of ['AGENTS.md', 'HEARTBEAT.md']) {
    const dest = join(identityFilesDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) copyFileSync(src, dest);
    if (existsSync(src)) {
      const key = `${agentName}/${file}`;
      try {
        const existing = await documents.get('identity', key);
        if (!existing) await documents.put('identity', key, readFileSync(src, 'utf-8'));
      } catch { /* non-fatal */ }
    }
  }

  // Config files → agentConfigDir
  for (const file of ['capabilities.yaml']) {
    const dest = join(agentConfigDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) copyFileSync(src, dest);
  }

  // Bootstrap files
  if (!bootstrapAlreadyComplete) {
    const src = join(templatesDir, 'BOOTSTRAP.md');
    if (existsSync(src)) {
      if (!existsSync(join(agentConfigDir, 'BOOTSTRAP.md'))) copyFileSync(src, join(agentConfigDir, 'BOOTSTRAP.md'));
      if (!existsSync(join(identityFilesDir, 'BOOTSTRAP.md'))) copyFileSync(src, join(identityFilesDir, 'BOOTSTRAP.md'));
      const key = `${agentName}/BOOTSTRAP.md`;
      try {
        const existing = await documents.get('identity', key);
        if (!existing) await documents.put('identity', key, readFileSync(src, 'utf-8'));
      } catch { /* non-fatal */ }
    }
    const ubSrc = join(templatesDir, 'USER_BOOTSTRAP.md');
    if (existsSync(ubSrc)) {
      const key = `${agentName}/USER_BOOTSTRAP.md`;
      try {
        const existing = await documents.get('identity', key);
        if (!existing) await documents.put('identity', key, readFileSync(ubSrc, 'utf-8'));
      } catch { /* non-fatal */ }
    }
  }

  // Skills seeding
  const persistentSkillsDir = agentSkillsDir(agentName);
  mkdirSync(persistentSkillsDir, { recursive: true });
  try {
    const existingSkills = readdirSync(persistentSkillsDir).filter(f => f.endsWith('.md'));
    const existingDirs = readdirSync(persistentSkillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(persistentSkillsDir, d.name, 'SKILL.md')));
    if (existingSkills.length === 0 && existingDirs.length === 0) {
      const seedDir = resolveSeedSkillsDir();
      if (existsSync(seedDir)) {
        const seedEntries = readdirSync(seedDir, { withFileTypes: true });
        for (const entry of seedEntries) {
          if (entry.isFile() && entry.name.endsWith('.md')) {
            copyFileSync(join(seedDir, entry.name), join(persistentSkillsDir, entry.name));
          } else if (entry.isDirectory()) {
            cpSync(join(seedDir, entry.name), join(persistentSkillsDir, entry.name), { recursive: true });
          }
        }
      }
    }
  } catch { /* non-fatal */ }

  // Admins file
  const defaultUserId = process.env.USER ?? 'default';
  const adminsPath = join(agentDirVal, 'admins');
  if (!existsSync(adminsPath)) writeFileSync(adminsPath, '', 'utf-8');

  // ── IPC socket ──
  const ipcSocketDir = mkdtempSync(join(tmpdir(), 'ax-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');
  const sessionCanaries = new Map<string, string>();
  const workspaceMap = new Map<string, string>();

  // ── CompletionDeps ──
  const completionDeps: CompletionDeps = {
    config,
    providers,
    db,
    conversationStore,
    router,
    taintBudget,
    sessionCanaries,
    ipcSocketPath,
    ipcSocketDir,
    logger,
    verbose,
    fileStore,
    eventBus,
    workspaceMap,
  };

  // ── Delegation ──
  async function handleDelegate(req: DelegateRequest, ctx: IPCContext): Promise<string> {
    const tier = req.resourceTier ?? 'default';
    const tierConfig = config.sandbox.tiers?.[tier] ?? (tier === 'heavy'
      ? { memory_mb: 2048, cpus: 4 }
      : { memory_mb: config.sandbox.memory_mb, cpus: 1 });

    const childConfig = {
      ...config,
      ...(req.runner ? { agent: req.runner } : {}),
      ...(req.model ? { models: { default: [req.model] } } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      sandbox: {
        ...config.sandbox,
        memory_mb: tierConfig.memory_mb,
        tiers: {
          default: tierConfig,
          heavy: config.sandbox.tiers?.heavy ?? { memory_mb: 2048, cpus: 4 },
        },
        ...(req.timeoutSec ? { timeout_sec: req.timeoutSec } : {}),
      },
    };
    const childDeps: CompletionDeps = { ...completionDeps, config: childConfig };
    const taskPrompt = req.context ? `${req.context}\n\n---\n\nTask: ${req.task}` : req.task;
    const requestId = req.requestId ?? `delegate-${randomUUID().slice(0, 8)}`;
    const result = await processCompletion(childDeps, taskPrompt, requestId, [], undefined, undefined, ctx.userId);
    return result.responseContent;
  }

  // ── Orchestrator + agent registry ──
  const orchestrator = createOrchestrator(eventBus, providers.audit);
  const disableAutoState = orchestrator.enableAutoState();
  const agentRegistry = await createAgentRegistry(providers.database);
  await agentRegistry.ensureDefault();

  // ── IPC handler ──
  const handleIPC = createIPCHandler(providers, {
    taintBudget,
    agentDir: identityFilesDir,
    agentName,
    profile: config.profile,
    configModel: config.models?.default?.[0],
    onDelegate: handleDelegate,
    delegation: config.delegation ? {
      maxConcurrent: config.delegation.max_concurrent,
      maxDepth: config.delegation.max_depth,
    } : undefined,
    eventBus,
    orchestrator,
    agentRegistry,
    workspaceMap,
  });
  completionDeps.ipcHandler = handleIPC;

  const defaultCtx = { sessionId: 'server', agentId: 'system', userId: defaultUserId };
  const ipcServer = await createIPCServer(ipcSocketPath, handleIPC, defaultCtx);

  const modelId = providers.llm.name;

  return {
    config,
    providers,
    eventBus,
    db,
    conversationStore,
    sessionStore,
    router,
    taintBudget,
    fileStore,
    completionDeps,
    handleIPC,
    ipcServer,
    ipcSocketPath,
    ipcSocketDir,
    orchestrator,
    disableAutoState,
    agentRegistry,
    agentName,
    agentDirVal,
    identityFilesDir,
    sessionCanaries,
    workspaceMap,
    defaultUserId,
    modelId,
  };
}
```

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (new file compiles, nothing imports it yet)

**Step 3: Commit**

```bash
git add src/host/server-init.ts
git commit -m "refactor: add server-init.ts with shared initHostCore()"
```

---

### Task 3: Create `server-request-handlers.ts` — shared HTTP handler logic

**Files:**
- Create: `src/host/server-request-handlers.ts`

This extracts: `handleModels`, `handleCompletions` (body parsing + streaming + non-streaming), `handleEvents` (EventBus-based SSE), and the `createSchedulerCallback` factory. Both callers can use these directly or wrap them for mode-specific behavior.

**Step 1: Create the file**

```typescript
// src/host/server-request-handlers.ts — Shared HTTP request handlers for server.ts and host-process.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../logger.js';
import { isValidSessionId } from '../paths.js';
import { sendError, sendSSEChunk, sendSSENamedEvent, readBody } from './server-http.js';
import type { OpenAIChatRequest } from './server-http.js';
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { resolveDelivery } from './delivery.js';
import type { EventBus, StreamEvent } from './event-bus.js';
import type { Router } from './router.js';
import type { InboundMessage } from '../providers/shared-types.js';

const logger = getLogger();

/** SSE keepalive interval. */
const SSE_KEEPALIVE_MS = 15_000;

// ── Models ──

export function handleModels(res: ServerResponse, modelId: string): void {
  const body = JSON.stringify({
    object: 'list',
    data: [{ id: modelId, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'ax' }],
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) });
  res.end(body);
}

// ── Completions ──

export interface CompletionHandlerOpts {
  modelId: string;
  agentName: string;
  agentDirVal: string;
  eventBus: EventBus;
  /** Called to run the completion. Allows callers to wrap with NATS logic. */
  runCompletion: (
    content: string | import('../types.js').ContentBlock[],
    requestId: string,
    messages: { role: string; content: string | import('../types.js').ContentBlock[] }[],
    sessionId: string,
    userId?: string,
  ) => Promise<{ responseContent: string; finishReason: 'stop' | 'content_filter'; contentBlocks?: import('../types.js').ContentBlock[] }>;
  /** Optional pre-flight check (e.g. bootstrap gate). Return error string to reject, undefined to proceed. */
  preFlightCheck?: (sessionId: string, userId: string | undefined) => string | undefined;
}

/**
 * Parse the OpenAI chat request body and derive sessionId/userId.
 * Shared between server.ts and host-process.ts.
 */
export function parseChatRequest(
  chatReq: OpenAIChatRequest,
  modelId: string,
): { sessionId: string; userId: string | undefined; content: string | import('../types.js').ContentBlock[]; requestModel: string } | { error: string } {
  if (!chatReq.messages?.length) {
    return { error: 'messages array is required' };
  }
  if (chatReq.session_id !== undefined && !isValidSessionId(chatReq.session_id)) {
    return { error: 'Invalid session_id' };
  }

  const requestModel = chatReq.model ?? modelId;

  let sessionId = chatReq.session_id;
  if (!sessionId && chatReq.user) {
    const parts = chatReq.user.split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const agentPrefix = chatReq.model?.startsWith('agent:')
        ? chatReq.model.slice(6) : 'main';
      const candidate = `${agentPrefix}:http:${parts[0]}:${parts[1]}`;
      if (isValidSessionId(candidate)) sessionId = candidate;
    }
  }
  if (!sessionId) sessionId = randomUUID();

  const lastMsg = chatReq.messages[chatReq.messages.length - 1];
  const content = lastMsg?.content ?? '';
  const userId = chatReq.user?.split('/')[0] || undefined;

  return { sessionId, userId, content, requestModel };
}

export async function handleCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  opts: CompletionHandlerOpts,
): Promise<void> {
  const requestId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendError(res, 413, 'Request body too large');
    return;
  }

  let chatReq: OpenAIChatRequest;
  try {
    chatReq = JSON.parse(body);
  } catch {
    sendError(res, 400, 'Invalid JSON');
    return;
  }

  const parsed = parseChatRequest(chatReq, opts.modelId);
  if ('error' in parsed) {
    sendError(res, 400, parsed.error);
    return;
  }
  const { sessionId, userId, content, requestModel } = parsed;

  // Optional pre-flight (bootstrap gate, etc.)
  if (opts.preFlightCheck) {
    const rejection = opts.preFlightCheck(sessionId, userId);
    if (rejection) {
      sendError(res, 403, rejection);
      return;
    }
  }

  logger.info('chat_request', {
    requestId, sessionId, stream: !!chatReq.stream,
    model: requestModel, userId: userId ?? 'anonymous',
    messageCount: chatReq.messages.length,
  });

  if (chatReq.stream) {
    // ── Streaming mode ──
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Request-Id': requestId,
      'X-Accel-Buffering': 'no',
    });

    sendSSEChunk(res, {
      id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });

    let streamedContent = false;
    let toolCallIndex = 0;
    let hasToolCalls = false;

    const unsubscribe = opts.eventBus.subscribeRequest(requestId, (event: StreamEvent) => {
      try {
        if (event.type === 'llm.chunk' && typeof event.data.content === 'string') {
          streamedContent = true;
          sendSSEChunk(res, {
            id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
            choices: [{ index: 0, delta: { content: event.data.content as string }, finish_reason: null }],
          });
        } else if (event.type === 'tool.call' && event.data.toolName) {
          streamedContent = true;
          hasToolCalls = true;
          sendSSEChunk(res, {
            id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
            choices: [{ index: 0, delta: {
              tool_calls: [{
                index: toolCallIndex++,
                id: (event.data.toolId as string) ?? `call_${toolCallIndex}`,
                type: 'function',
                function: {
                  name: event.data.toolName as string,
                  arguments: JSON.stringify(event.data.args ?? {}),
                },
              }],
            }, finish_reason: null }],
          });
        } else if (event.type === 'oauth.required' && event.data.envName) {
          sendSSENamedEvent(res, 'oauth_required', {
            envName: event.data.envName as string,
            sessionId: event.data.sessionId as string,
            authorizeUrl: event.data.authorizeUrl as string,
            requestId,
          });
        } else if (event.type === 'credential.required' && event.data.envName) {
          sendSSENamedEvent(res, 'credential_required', {
            envName: event.data.envName as string,
            sessionId: event.data.sessionId as string,
            requestId,
          });
        }
      } catch { /* client gone, skip */ }
    });

    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { /* client gone */ }
    }, SSE_KEEPALIVE_MS);

    const onClientGone = () => {
      clearInterval(keepalive);
      unsubscribe();
    };
    req.on('close', onClientGone);
    req.on('error', onClientGone);

    try {
      const result = await opts.runCompletion(content, requestId, chatReq.messages, sessionId, userId);

      if (!streamedContent && result.responseContent) {
        sendSSEChunk(res, {
          id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
          choices: [{ index: 0, delta: { content: result.responseContent }, finish_reason: null }],
        });
      }

      const streamFinishReason = hasToolCalls && result.finishReason === 'stop'
        ? 'tool_calls' as const : result.finishReason;
      sendSSEChunk(res, {
        id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
        choices: [{ index: 0, delta: {}, finish_reason: streamFinishReason }],
      });
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      logger.error('completion_failed', { requestId, error: (err as Error).message });
      if (!res.writableEnded) {
        sendSSEChunk(res, {
          id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
          choices: [{ index: 0, delta: { content: '\n\nInternal processing error' }, finish_reason: 'stop' }],
        });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } finally {
      clearInterval(keepalive);
      unsubscribe();
    }
  } else {
    // ── Non-streaming mode ──
    try {
      const result = await opts.runCompletion(content, requestId, chatReq.messages, sessionId, userId);

      const response = {
        id: requestId, object: 'chat.completion', created, model: requestModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.responseContent },
          finish_reason: result.finishReason,
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };

      const responseBody = JSON.stringify(response);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(responseBody)) });
      res.end(responseBody);
    } catch (err) {
      logger.error('completion_failed', { requestId, error: (err as Error).message });
      sendError(res, 500, 'Internal server error');
    }
  }
}

// ── Events SSE (EventBus-based, used by server.ts) ──

export function handleEventsSSE(req: IncomingMessage, res: ServerResponse, eventBus: EventBus): void {
  const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
  const requestIdFilter = parsedUrl.searchParams.get('request_id') ?? undefined;
  const typesParam = parsedUrl.searchParams.get('types') ?? undefined;
  const typeFilter = typesParam ? new Set(typesParam.split(',').map(t => t.trim()).filter(Boolean)) : undefined;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':connected\n\n');

  const listener = (event: StreamEvent) => {
    if (typeFilter && !typeFilter.has(event.type)) return;
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch { /* client disconnected */ }
  };

  const unsubscribe = requestIdFilter
    ? eventBus.subscribeRequest(requestIdFilter, listener)
    : eventBus.subscribe(listener);

  const keepalive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch { /* client gone */ }
  }, SSE_KEEPALIVE_MS);

  const cleanup = () => {
    clearInterval(keepalive);
    unsubscribe();
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

// ── Scheduler callback factory ──

export interface SchedulerCallbackOpts {
  config: Config;
  router: Router;
  sessionCanaries: Map<string, string>;
  sessionStore: ProviderRegistry['storage']['sessions'];
  agentName: string;
  channels: ProviderRegistry['channels'];
  scheduler: ProviderRegistry['scheduler'];
  runCompletion: (
    content: string,
    requestId: string,
    messages: { role: string; content: string }[],
    sessionId: string,
    userId?: string,
    preProcessed?: { sessionId: string; messageId: string; canaryToken: string },
  ) => Promise<{ responseContent: string }>;
}

export function createSchedulerCallback(opts: SchedulerCallbackOpts): (msg: InboundMessage) => Promise<void> {
  const { config, router, sessionCanaries, sessionStore, agentName, channels, scheduler } = opts;

  return async (msg: InboundMessage) => {
    const result = await router.processInbound(msg);
    if (!result.queued) return;

    sessionCanaries.set(result.sessionId, result.canaryToken);
    const requestId = `sched-${randomUUID().slice(0, 8)}`;
    const { responseContent } = await opts.runCompletion(
      msg.content,
      requestId,
      [{ role: 'user', content: msg.content }],
      result.sessionId,
      undefined,
      { sessionId: result.sessionId, messageId: result.messageId!, canaryToken: result.canaryToken },
    );

    if (!responseContent.trim()) {
      logger.info('scheduler_message_processed', {
        sender: msg.sender, sessionId: result.sessionId,
        contentLength: responseContent.length, hasResponse: false,
      });
      return;
    }

    let delivery: import('../providers/scheduler/types.js').CronDelivery | undefined;
    let jobAgentId = agentName;

    if (msg.sender.startsWith('cron:')) {
      const jobId = msg.sender.slice(5);
      const jobs = await scheduler.listJobs?.() ?? [];
      const job = jobs.find(j => j.id === jobId);
      if (job) {
        jobAgentId = job.agentId;
        delivery = job.delivery ?? config.scheduler.defaultDelivery;
      } else {
        delivery = config.scheduler.defaultDelivery;
      }
    } else {
      delivery = config.scheduler.defaultDelivery;
    }

    const resolution = await resolveDelivery(delivery, {
      sessionStore,
      agentId: jobAgentId,
      defaultDelivery: config.scheduler.defaultDelivery,
      channels,
    });

    if (resolution.mode === 'channel' && resolution.session && resolution.channelProvider) {
      const outbound = await router.processOutbound(responseContent, result.sessionId, result.canaryToken);
      if (!outbound.canaryLeaked) {
        try {
          await resolution.channelProvider.send(resolution.session, { content: outbound.content });
          logger.info('cron_delivered', {
            sender: msg.sender, provider: resolution.session.provider,
            contentLength: outbound.content.length,
          });
        } catch (err) {
          logger.error('cron_delivery_failed', {
            sender: msg.sender, provider: resolution.session.provider,
            error: (err as Error).message,
          });
        }
      } else {
        logger.warn('cron_delivery_canary_leaked', { sender: msg.sender });
      }
    }

    logger.info('scheduler_message_processed', {
      sender: msg.sender, sessionId: result.sessionId,
      contentLength: responseContent.length, hasResponse: true,
    });
  };
}
```

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/server-request-handlers.ts
git commit -m "refactor: add server-request-handlers.ts with shared completion/events/scheduler handlers"
```

---

### Task 4: Create `server-webhook-admin.ts` — shared webhook + admin handler setup

**Files:**
- Create: `src/host/server-webhook-admin.ts`

This extracts the identical webhook handler and admin handler creation logic.

**Step 1: Create the file**

```typescript
// src/host/server-webhook-admin.ts — Shared webhook + admin handler factories.

import { existsSync, readFileSync } from 'node:fs';
import type { Config, ProviderRegistry } from '../types.js';
import type { Logger } from '../logger.js';
import { webhookTransformPath } from '../paths.js';
import { createWebhookHandler, type WebhookHandler } from './server-webhooks.js';
import { createWebhookTransform } from './webhook-transform.js';
import { createAdminHandler, type AdminHandler } from './server-admin.js';
import type { EventBus } from './event-bus.js';
import type { AgentRegistry } from './agent-registry.js';
import { TaintBudget } from './taint-budget.js';

export interface WebhookSetupOpts {
  config: Config;
  providers: ProviderRegistry;
  logger: Logger;
  taintBudget: TaintBudget;
  dispatch: (result: { message: string; agentId?: string; sessionKey?: string; model?: string; timeoutSec?: number }, runId: string) => void;
}

export function setupWebhookHandler(opts: WebhookSetupOpts): WebhookHandler | null {
  const { config, providers, logger, taintBudget, dispatch } = opts;

  const webhookPrefix = config.webhooks?.path
    ? (config.webhooks.path.endsWith('/') ? config.webhooks.path : config.webhooks.path + '/')
    : '/webhooks/';

  const handler = config.webhooks?.enabled
    ? createWebhookHandler({
        config: {
          token: config.webhooks.token,
          maxBodyBytes: config.webhooks.max_body_bytes,
          model: config.webhooks.model,
          allowedAgentIds: config.webhooks.allowed_agent_ids,
        },
        transform: createWebhookTransform(
          providers.llm,
          config.webhooks.model ?? config.models?.fast?.[0] ?? config.models?.default?.[0] ?? 'claude-haiku-4-5-20251001',
        ),
        dispatch,
        logger,
        transformExists: (name) => existsSync(webhookTransformPath(name)),
        readTransform: (name) => readFileSync(webhookTransformPath(name), 'utf-8'),
        recordTaint: (sessionId, content, isTainted) => {
          taintBudget.recordContent(sessionId, content, isTainted);
        },
        audit: (entry) => {
          providers.audit.log({
            action: entry.action,
            sessionId: entry.runId ?? 'webhook',
            args: { webhook: entry.webhook, ip: entry.ip },
            result: 'success',
            durationMs: 0,
          }).catch(() => {});
        },
      })
    : null;

  return handler;
}

export interface AdminSetupOpts {
  config: Config;
  providers: ProviderRegistry;
  eventBus: EventBus;
  agentRegistry: AgentRegistry;
  startTime: number;
}

export function setupAdminHandler(opts: AdminSetupOpts): AdminHandler | null {
  const { config, providers, eventBus, agentRegistry, startTime } = opts;
  return config.admin?.enabled
    ? createAdminHandler({ config, providers, eventBus, agentRegistry, startTime })
    : null;
}
```

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS (may need to verify the types for `WebhookHandler` and `AdminHandler` exports — adjust as needed by checking what `createWebhookHandler` and `createAdminHandler` return)

**Step 3: Commit**

```bash
git add src/host/server-webhook-admin.ts
git commit -m "refactor: add server-webhook-admin.ts with shared webhook + admin handler setup"
```

---

### Task 5: Rewrite `server.ts` to use extracted modules

**Files:**
- Modify: `src/host/server.ts`

**Step 1: Rewrite server.ts**

Replace the duplicated initialization, handleCompletions, handleEvents, and scheduler callback with calls to the shared modules. Keep server.ts-specific logic:
- Unix socket + TCP lifecycle
- Channel connect/disconnect
- Legacy migration
- Graceful drain
- File upload/download routes
- OAuth/credential routes

Key changes:
1. Replace lines 129-452 (from `createServer` through `createIPCHandler`) with `const core = await initHostCore({ config, providers, eventBus, verbose: opts.verbose })`
2. Destructure from `core`: `completionDeps`, `handleIPC`, `ipcServer`, etc.
3. Replace `handleCompletions` (lines 787-1010) with a call to the shared handler, passing `runCompletion: (content, requestId, messages, sessionId, userId) => processCompletion(completionDeps, content, requestId, messages, sessionId, undefined, userId)`
4. Replace `handleEvents` (lines 733-785) with `handleEventsSSE(req, res, eventBus)`
5. Replace `handleModels` (lines 721-728) with the shared `handleModels(res, modelId)`
6. Replace scheduler callback (lines 1073-1142) with `createSchedulerCallback(...)`
7. Replace webhook/admin handler setup with `setupWebhookHandler(...)` and `setupAdminHandler(...)`
8. Keep re-exports: `export { isAgentBootstrapMode, isAdmin, addAdmin, claimBootstrapAdmin } from './server-admin-helpers.js'`

The file should shrink from ~1250 lines to ~500 lines.

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Run full server tests**

Run: `npm test -- --bail tests/host/server.test.ts tests/host/admin-gate.test.ts tests/host/server-history.test.ts tests/host/server-multimodal.test.ts tests/host/server-webhooks.test.ts tests/host/server-credentials-sse.test.ts tests/host/server-files.test.ts`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/host/server.ts
git commit -m "refactor: rewrite server.ts to use shared initHostCore + request handlers"
```

---

### Task 6: Rewrite `host-process.ts` to use extracted modules

**Files:**
- Modify: `src/host/host-process.ts`

**Step 1: Rewrite host-process.ts**

Replace the duplicated initialization with `const core = await initHostCore(...)`. Keep host-process-specific logic:
- NATS connection + `activeTokens` token registry
- `processCompletionWithNATS` wrapper (staging, agent_response, workspace interception)
- `/internal/*` routes (ipc, llm-proxy, workspace staging/release/provision)
- Web proxy with MITM CA
- `stagingStore` + cleanup

Key changes:
1. Replace lines 92-279 (from `main()` through `createIPCHandler`) with `const core = await initHostCore(...)` + destructure
2. Keep `processCompletionWithNATS` but have it use `core.completionDeps` as its base
3. Replace `handleCompletions` with shared handler, passing `runCompletion` that wraps `processCompletionWithNATS`
4. Replace inline `handleModels` with the shared version
5. Replace scheduler callback with `createSchedulerCallback(...)` passing `processCompletionWithNATS` as `runCompletion`
6. Replace webhook/admin handler setup with shared factories
7. Keep all `/internal/*` routes in the request handler

The file should shrink from ~1223 lines to ~600 lines.

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/host-process.ts
git commit -m "refactor: rewrite host-process.ts to use shared initHostCore + request handlers"
```

---

### Task 7: Run full test suite and fix any issues

**Step 1: Run all tests**

Run: `npm test -- --bail`
Expected: All PASS

**Step 2: Run build**

Run: `npm run build`
Expected: PASS

**Step 3: Fix any issues found**

If tests fail, diagnose the root cause. Common issues:
- Missing re-exports from `server.ts` (tests import `isAdmin` etc. from `server.js`)
- Type mismatches in `runCompletion` callback signature
- `InboundMessage` import path differences (`providers/channel/types.js` vs `providers/shared-types.js`)

**Step 4: Final commit (if fixes were needed)**

```bash
git add -A
git commit -m "fix: resolve test issues from server-init extraction"
```

---

## Summary of new files

| File | Purpose | Lines (approx) |
|------|---------|----------------|
| `src/host/server-admin-helpers.ts` | Pure admin functions (isAdmin, claimBootstrapAdmin, etc.) | ~50 |
| `src/host/server-init.ts` | `initHostCore()` — shared initialization | ~200 |
| `src/host/server-request-handlers.ts` | Shared HTTP handlers (completions, events, scheduler, models) | ~300 |
| `src/host/server-webhook-admin.ts` | Shared webhook + admin handler factories | ~80 |

## Expected line count changes

| File | Before | After | Delta |
|------|--------|-------|-------|
| `server.ts` | ~1250 | ~500 | -750 |
| `host-process.ts` | ~1223 | ~600 | -623 |
| New shared files | 0 | ~630 | +630 |
| **Net** | **2473** | **1730** | **-743** |
