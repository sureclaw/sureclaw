# Server Shared Routes — Phase 2 Deduplication

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract the remaining duplicated and missing-from-one-side route handling into a shared `createRequestHandler()` function so both `server-local.ts` and `server-k8s.ts` use the same HTTP route dispatch, with mode-specific routes injected via a hook.

**Architecture:** Add a `createRequestHandler()` factory to `server-request-handlers.ts` that handles ALL shared routes (CORS, health, models, completions, files, events SSE, webhooks, credentials, OAuth, admin, root redirect, 404). Both servers call it with a `RequestHandlerOpts` bag containing their mode-specific dependencies and an optional `extraRoutes` callback for mode-specific routes (k8s `/internal/*` routes). Also add shared bootstrap gate, graceful drain tracking, and move file/OAuth/credential routes into the shared handler.

**Tech Stack:** TypeScript, Node.js HTTP, vitest

---

## What This Plan Does

1. **Creates `createRequestHandler()`** in `server-request-handlers.ts` — a single factory that returns an `(req, res) => Promise<void>` handler with all shared routes
2. **Moves into shared handler:** file upload/download, OAuth callback, credential provide, admin routes, root→admin redirect, bootstrap gate pre-flight, graceful drain support
3. **Rewrites `server-local.ts`** to call `createRequestHandler()` instead of having its own `handleRequest`
4. **Rewrites `server-k8s.ts`** to call `createRequestHandler()` with `extraRoutes` for `/internal/*` routes, adding file routes, OAuth, bootstrap gate, and graceful drain that it was missing

---

### Task 1: Extend `server-request-handlers.ts` with `createRequestHandler()`

**Files:**
- Modify: `src/host/server-request-handlers.ts`

**Step 1: Add the new types and factory function**

Add to the end of `server-request-handlers.ts`:

```typescript
// ── Shared request handler factory ──

export interface RequestHandlerOpts {
  // Core dependencies
  modelId: string;
  agentName: string;
  agentDirVal: string;
  eventBus: EventBus;
  providers: ProviderRegistry;
  fileStore: FileStore;
  taintBudget: TaintBudget;

  // Completion
  completionOpts: CompletionHandlerOpts;

  // Webhook
  webhookPrefix: string;
  webhookHandler: WebhookHandler | null;

  // Admin
  adminHandler: AdminHandler | null;

  // Drain state — caller manages the boolean; handler reads it
  isDraining: () => boolean;

  // Inflight tracking — caller provides start/end hooks for graceful drain
  trackRequestStart?: () => void;
  trackRequestEnd?: () => void;

  // Mode-specific routes — called BEFORE the 404 fallback.
  // Return true if the route was handled, false to fall through.
  extraRoutes?: (req: IncomingMessage, res: ServerResponse, url: string) => Promise<boolean>;
}

export function createRequestHandler(opts: RequestHandlerOpts): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const {
    modelId, eventBus, providers, fileStore,
    completionOpts, webhookPrefix, webhookHandler, adminHandler,
    isDraining, trackRequestStart, trackRequestEnd, extraRoutes,
  } = opts;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    // Reject new requests during shutdown
    if (isDraining() && (url === '/v1/chat/completions' || url.startsWith(webhookPrefix))) {
      sendError(res, 503, 'Server is shutting down — not accepting new requests');
      return;
    }

    // Health
    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: isDraining() ? 'draining' : 'ok' }));
      return;
    }

    // Models
    if (url === '/v1/models' && req.method === 'GET') {
      handleModels(res, modelId);
      return;
    }

    // Completions
    if (url === '/v1/chat/completions' && req.method === 'POST') {
      trackRequestStart?.();
      try {
        await handleCompletions(req, res, completionOpts);
      } catch (err) {
        logger.error('request_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      } finally {
        trackRequestEnd?.();
      }
      return;
    }

    // File upload
    if (url.startsWith('/v1/files') && req.method === 'POST') {
      try {
        await handleFileUpload(req, res, { fileStore });
      } catch (err) {
        logger.error('file_upload_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'File upload failed');
      }
      return;
    }

    // File download
    if (url.startsWith('/v1/files/') && req.method === 'GET') {
      try {
        await handleFileDownload(req, res, { fileStore });
      } catch (err) {
        logger.error('file_download_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'File download failed');
      }
      return;
    }

    // SSE events
    if (url.startsWith('/v1/events') && req.method === 'GET') {
      handleEventsSSE(req, res, eventBus);
      return;
    }

    // Webhooks
    if (webhookHandler && url.startsWith(webhookPrefix)) {
      const webhookName = url.slice(webhookPrefix.length).split('?')[0];
      if (!webhookName) {
        sendError(res, 404, 'Not found');
        return;
      }
      trackRequestStart?.();
      try {
        await webhookHandler(req, res, webhookName);
      } catch (err) {
        logger.error('webhook_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Webhook processing failed');
      } finally {
        trackRequestEnd?.();
      }
      return;
    }

    // Credential provide
    if (url === '/v1/credentials/provide' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const { envName, value } = body;
        if (typeof envName !== 'string' || !envName || typeof value !== 'string') {
          sendError(res, 400, 'Missing required fields: envName, value');
          return;
        }
        await providers.credentials.set(envName, value);
        const responseBody = JSON.stringify({ ok: true });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(responseBody)) });
        res.end(responseBody);
      } catch (err) {
        sendError(res, 400, `Invalid request: ${(err as Error).message}`);
      }
      return;
    }

    // OAuth callback
    if (url.startsWith('/v1/oauth/callback/') && req.method === 'GET') {
      const provider = url.split('/v1/oauth/callback/')[1]?.split('?')[0];
      const params = new URL(req.url!, `http://${req.headers.host}`).searchParams;
      const code = params.get('code');
      const state = params.get('state');

      if (!provider || !code || !state) {
        const html = '<html><body><h2>Bad request</h2><p>Missing required parameters (code, state).</p></body></html>';
        res.writeHead(400, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html) });
        res.end(html);
        return;
      }

      try {
        const { resolveOAuthCallback } = await import('./oauth-skills.js');
        const found = await resolveOAuthCallback(provider, code, state, providers.credentials, eventBus);

        const html = found
          ? '<html><body><h2>Authentication successful</h2><p>You can close this tab and return to your conversation.</p></body></html>'
          : '<html><body><h2>Authentication failed</h2><p>Invalid or expired OAuth flow. Please try again.</p></body></html>';
        const status = found ? 200 : 400;
        res.writeHead(status, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html) });
        res.end(html);
      } catch (err) {
        logger.error('oauth_callback_failed', { provider, error: (err as Error).message });
        const html = '<html><body><h2>Server error</h2><p>OAuth callback processing failed. Please try again.</p></body></html>';
        res.writeHead(500, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html) });
        res.end(html);
      }
      return;
    }

    // Root → admin redirect
    if (adminHandler && (url === '/' || url === '')) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return;
    }

    // Admin dashboard
    if (adminHandler && url.startsWith('/admin')) {
      try {
        await adminHandler(req, res, url.split('?')[0]);
      } catch (err) {
        logger.error('admin_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Admin request failed');
      }
      return;
    }

    // Mode-specific routes (k8s /internal/*, etc.)
    if (extraRoutes) {
      const handled = await extraRoutes(req, res, url);
      if (handled) return;
    }

    sendError(res, 404, 'Not found');
  };
}
```

Add the required imports at the top of the file:

```typescript
import { handleFileUpload, handleFileDownload } from './server-files.js';
import type { FileStore } from '../file-store.js';
import type { TaintBudget } from './taint-budget.js';
```

Also import the webhook/admin handler types. Check what `createWebhookHandler` and `createAdminHandler` return and use those types (likely function signatures — use `type WebhookHandler = ...` or import if exported). If they're not exported as named types, define them inline:

```typescript
type WebhookHandler = (req: IncomingMessage, res: ServerResponse, webhookName: string) => Promise<void>;
type AdminHandler = (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void>;
```

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/server-request-handlers.ts
git commit -m "refactor: add createRequestHandler() factory with all shared routes"
```

---

### Task 2: Rewrite `server-local.ts` to use `createRequestHandler()`

**Files:**
- Modify: `src/host/server-local.ts`

**Step 1: Replace the inline `handleRequest` function**

Remove the entire `handleRequest` function (currently ~160 lines) and replace with:

```typescript
const handleRequest = createRequestHandler({
  modelId,
  agentName,
  agentDirVal,
  eventBus,
  providers,
  fileStore,
  taintBudget,
  completionOpts: {
    modelId,
    agentName,
    agentDirVal,
    eventBus,
    runCompletion: async (content, requestId, messages, sessionId, userId) => {
      return processCompletion(completionDeps, content, requestId, messages, sessionId, undefined, userId);
    },
    preFlightCheck: (sessionId: string, userId: string | undefined) => {
      if (userId && isAgentBootstrapMode(agentName) && !isAdmin(agentDirVal, userId)) {
        if (claimBootstrapAdmin(agentDirVal, userId)) {
          logger.info('bootstrap_admin_claimed', { provider: 'http', sender: userId });
          return undefined;
        }
        return 'This agent is still being set up. Only admins can interact during bootstrap.';
      }
      return undefined;
    },
  },
  webhookPrefix,
  webhookHandler,
  adminHandler,
  isDraining: () => draining,
  trackRequestStart,
  trackRequestEnd,
});
```

Remove unused imports that were only needed for the inline handleRequest (e.g. `sendSSEChunk`, `sendSSENamedEvent` if no longer used directly).

Update imports to add `createRequestHandler` from `./server-request-handlers.js` and remove the now-unused individual handler imports if they're only used via the factory.

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 3: Run server tests**

Run: `npm test -- --bail tests/host/server.test.ts tests/host/admin-gate.test.ts tests/host/server-history.test.ts tests/host/server-multimodal.test.ts tests/host/server-webhooks.test.ts tests/host/server-credentials-sse.test.ts tests/host/server-files.test.ts`
Expected: All PASS

**Step 4: Commit**

```bash
git add src/host/server-local.ts
git commit -m "refactor: server-local.ts uses createRequestHandler() for all routes"
```

---

### Task 3: Rewrite `server-k8s.ts` to use `createRequestHandler()` with `extraRoutes`

**Files:**
- Modify: `src/host/server-k8s.ts`

**Step 1: Replace the inline `handleRequest` function**

Move the k8s-specific `/internal/*` routes into an `extraRoutes` callback:

```typescript
async function handleInternalRoutes(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
  // Direct workspace release from sandbox pods (k8s HTTP mode)
  if (url === '/internal/workspace/release' && req.method === 'POST') {
    // ... existing code ...
    return true;
  }

  // Workspace provision
  if (url.startsWith('/internal/workspace/provision') && req.method === 'GET') {
    // ... existing code ...
    return true;
  }

  // Workspace staging upload (legacy)
  if (url === '/internal/workspace-staging' && req.method === 'POST') {
    // ... existing code ...
    return true;
  }

  // LLM proxy over HTTP
  if (url.startsWith('/internal/llm-proxy/') && req.method === 'POST') {
    // ... existing code ...
    return true;
  }

  // IPC over HTTP
  if (url === '/internal/ipc' && req.method === 'POST') {
    // ... existing code ...
    return true;
  }

  return false;
}
```

Then replace the inline `handleRequest` with:

```typescript
const handleRequest = createRequestHandler({
  modelId,
  agentName,
  agentDirVal,
  eventBus,
  providers,
  fileStore: core.fileStore,
  taintBudget: core.taintBudget,
  completionOpts: {
    modelId,
    agentName,
    agentDirVal,
    eventBus,
    runCompletion: async (content, requestId, messages, sessionId, userId) => {
      return processCompletionWithNATS(content, requestId, messages, sessionId, userId, agentType);
    },
    preFlightCheck: (sessionId: string, userId: string | undefined) => {
      if (userId && isAgentBootstrapMode(agentName) && !isAdmin(agentDirVal, userId)) {
        if (claimBootstrapAdmin(agentDirVal, userId)) {
          logger.info('bootstrap_admin_claimed', { provider: 'http', sender: userId });
          return undefined;
        }
        return 'This agent is still being set up. Only admins can interact during bootstrap.';
      }
      return undefined;
    },
  },
  webhookPrefix,
  webhookHandler,
  adminHandler,
  isDraining: () => draining,
  extraRoutes: handleInternalRoutes,
});
```

This gives server-k8s.ts all the routes it was missing:
- File upload/download (`/v1/files`)
- OAuth callback (`/v1/oauth/callback/:provider`)
- Bootstrap gate pre-flight check
- Root → admin redirect

Add the import for `isAgentBootstrapMode`, `isAdmin`, `claimBootstrapAdmin` from `./server-admin-helpers.js`.

**Step 2: Add graceful drain to k8s shutdown**

Replace the simple `draining = true` in the shutdown handler with proper inflight tracking. Add before `handleRequest`:

```typescript
let inflightCount = 0;
let drainResolve: (() => void) | null = null;
const DRAIN_TIMEOUT_MS = 30_000;

function trackRequestStart(): void { inflightCount++; }
function trackRequestEnd(): void {
  inflightCount--;
  if (draining && inflightCount <= 0 && drainResolve) drainResolve();
}

function waitForDrain(): Promise<void> {
  if (inflightCount <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    drainResolve = resolve;
    setTimeout(() => {
      if (inflightCount > 0) logger.warn('drain_timeout', { inflight: inflightCount, timeoutMs: DRAIN_TIMEOUT_MS });
      resolve();
    }, DRAIN_TIMEOUT_MS);
  });
}
```

Pass `trackRequestStart` and `trackRequestEnd` to `createRequestHandler()`.

Update the shutdown handler to wait for drain before exiting:

```typescript
const shutdown = async () => {
  draining = true;
  logger.info('host_shutting_down');

  if (inflightCount > 0) {
    logger.info('graceful_drain_start', { inflight: inflightCount });
    await waitForDrain();
    logger.info('graceful_drain_complete');
  }

  await providers.scheduler.stop();
  server.close();
  // ... rest of shutdown ...
};
```

**Step 3: Remove the k8s-specific inline `handleEvents` (NATS-based SSE)**

The NATS-based SSE handler (`handleEvents`) in server-k8s.ts subscribes to NATS subjects directly. The shared `handleEventsSSE` uses EventBus instead. For k8s mode where EventBus is backed by NATS, the EventBus-based handler should work the same way — verify by checking if the k8s eventbus provider bridges NATS↔EventBus. If it does, remove the inline NATS handler and use the shared one. If not, keep it as an `extraRoutes` handler.

Check: `grep -r 'nats' src/providers/eventbus/` to see if the NATS eventbus bridges events.

If the NATS eventbus already publishes/subscribes correctly, remove the inline `handleEvents` and let `createRequestHandler` use the shared `handleEventsSSE`. If not, add it to `extraRoutes`:

```typescript
// In handleInternalRoutes or as a separate check before extraRoutes
if (url.startsWith('/v1/events') && req.method === 'GET') {
  handleNATSEvents(req, res);  // keep existing NATS-based handler
  return true;
}
```

**Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-k8s.ts
git commit -m "refactor: server-k8s.ts uses createRequestHandler() with extraRoutes for /internal/*"
```

---

### Task 4: Run full test suite and fix issues

**Step 1: Run all tests**

Run: `npm test -- --bail`
Expected: All PASS

**Step 2: Run build**

Run: `npm run build`
Expected: PASS

**Step 3: Fix any issues**

Common issues to watch for:
- `resolveOAuthCallback` function signature may differ between the two files — verify the shared version matches
- The `handleEventsSSE` in shared handler uses EventBus; k8s may need NATS-specific handling — check if NATS eventbus provider handles this transparently
- Import of `FileStore` type in `server-request-handlers.ts` — ensure the import path is correct
- `WebhookHandler` / `AdminHandler` types may not be exported from their respective modules — define them locally if needed

**Step 4: Commit fixes**

```bash
git add -A
git commit -m "fix: resolve issues from shared route handler extraction"
```

---

### Task 5: Clean up unused code and imports

**Files:**
- Modify: `src/host/server-local.ts`
- Modify: `src/host/server-k8s.ts`
- Modify: `src/host/server-request-handlers.ts`

**Step 1: Remove dead imports and unused functions**

In `server-local.ts`:
- Remove imports for `handleFileUpload`, `handleFileDownload` (now in shared handler)
- Remove imports for `sendError`, `readBody` if no longer used directly
- Remove the `completionOpts` local variable if it was only used for the old inline handler

In `server-k8s.ts`:
- Remove the old inline `handleModels` reference
- Remove the inline `handleEvents` if replaced by shared handler
- Remove duplicate credential provide route handling
- Remove `sendSSEChunk` import if no longer used directly

**Step 2: Run type check and tests**

Run: `npx tsc --noEmit && npm test -- --bail`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/server-local.ts src/host/server-k8s.ts src/host/server-request-handlers.ts
git commit -m "refactor: clean up unused imports after shared route extraction"
```

---

## Expected Results

After this plan:
- `server-local.ts`: ~300 lines (from ~600) — only lifecycle, channels, legacy migration
- `server-k8s.ts`: ~500 lines (from ~800) — only NATS/token/staging logic + `/internal/*` routes
- `server-request-handlers.ts`: ~550 lines (from ~400) — all shared routes in one place
- Both servers get file routes, OAuth, credential provide, bootstrap gate, graceful drain, root→admin redirect
- Adding a new shared route means touching ONE file
