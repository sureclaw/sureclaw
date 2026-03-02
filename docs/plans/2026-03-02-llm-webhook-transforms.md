# LLM-Powered Webhook Transforms — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add inbound webhook support to AX where incoming HTTP payloads are transformed into agent-compatible messages by an LLM using markdown transform files — no template engine, no JS sandboxing.

**Architecture:** The host HTTP server gets a new `POST /webhooks/<name>` route. Auth is bearer-token. The `<name>` maps to a markdown file at `~/.ax/webhooks/<name>.md` that instructs a fast LLM how to reshape the raw payload into a structured `{ message, agentId?, ... }` object. The structured output is validated, taint-tagged, and dispatched through the existing `processCompletion` pipeline as a delegated agent run. Returns `202` immediately; the agent run is async.

**Tech Stack:** Zod (config validation), Node HTTP (existing server), LLM provider router (existing), safePath (existing)

---

## Background

OpenClaw uses a template engine + JS transform modules for webhook payload mapping. We're replacing both with a single LLM call guided by a markdown "transform file" — the same pattern AX already uses for skills and identity docs. This eliminates the template engine, the transform module loader, module sandboxing, and the mapping config schema entirely.

### Data Flow

```
External service (GitHub, Stripe, etc.)
  │
  ▼
POST /webhooks/<name>
  │
  ├─ Auth: Bearer token check
  ├─ Rate limit: per-IP fixed-window
  ├─ Body: JSON parse, size limit
  │
  ▼
Load ~/.ax/webhooks/<name>.md
  │
  ▼
LLM call (fast model):
  system = transform file contents
  user   = { headers, payload }
  output = structured JSON
  │
  ├─ null → 204 (skip)
  ├─ invalid → 500 + log
  │
  ▼
Validate + taint-tag
  │
  ▼
processCompletion() (async, fire-and-forget)
  │
  ▼
202 { runId }
```

---

## Task 1: Config Schema — Add `webhooks` Section

**Files:**
- Modify: `src/config.ts:33-104` (ConfigSchema)
- Modify: `src/types.ts:63-80` (Config interface)
- Test: `tests/config.test.ts`

**Step 1: Write the failing test**

In `tests/config.test.ts`, add a test that loads a config with the `webhooks` section and verifies it parses correctly.

```typescript
test('accepts valid webhooks config', () => {
  const yaml = baseYaml + `
webhooks:
  enabled: true
  token: "test-secret-token"
`;
  const cfg = loadConfigFromString(yaml);
  expect(cfg.webhooks).toEqual({
    enabled: true,
    token: 'test-secret-token',
  });
});

test('accepts webhooks config with all optional fields', () => {
  const yaml = baseYaml + `
webhooks:
  enabled: true
  token: "test-secret-token"
  path: "/hooks"
  max_body_bytes: 131072
  model: "claude-haiku-4-5-20251001"
  allowed_agent_ids:
    - "main"
    - "devops"
`;
  const cfg = loadConfigFromString(yaml);
  expect(cfg.webhooks?.path).toBe('/hooks');
  expect(cfg.webhooks?.max_body_bytes).toBe(131072);
  expect(cfg.webhooks?.model).toBe('claude-haiku-4-5-20251001');
  expect(cfg.webhooks?.allowed_agent_ids).toEqual(['main', 'devops']);
});

test('rejects webhooks config without token when enabled', () => {
  const yaml = baseYaml + `
webhooks:
  enabled: true
`;
  expect(() => loadConfigFromString(yaml)).toThrow();
});

test('config without webhooks section parses fine', () => {
  const cfg = loadConfigFromString(baseYaml);
  expect(cfg.webhooks).toBeUndefined();
});
```

Note: `baseYaml` and `loadConfigFromString` are test helpers — check existing tests for the pattern used. If `loadConfigFromString` doesn't exist, use a temp file with `loadConfig(path)`.

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/config.test.ts`
Expected: FAIL — `webhooks` key rejected by `z.strictObject`

**Step 3: Add webhooks to ConfigSchema and Config type**

In `src/config.ts`, add to ConfigSchema (after the `delegation` field around line 103):

```typescript
  webhooks: z.strictObject({
    enabled: z.boolean(),
    token: z.string().min(1),
    path: z.string().optional(),
    max_body_bytes: z.number().int().positive().optional(),
    model: z.string().optional(),
    allowed_agent_ids: z.array(z.string().min(1)).optional(),
  }).optional(),
```

In `src/types.ts`, add to the `Config` interface (after `delegation?`):

```typescript
  webhooks?: {
    enabled: boolean;
    token: string;
    path?: string;
    max_body_bytes?: number;
    model?: string;
    allowed_agent_ids?: string[];
  };
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/config.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts src/types.ts tests/config.test.ts
git commit -m "feat(webhooks): add webhooks config schema"
```

---

## Task 2: Path Helpers — Webhook Transform Files

**Files:**
- Modify: `src/paths.ts`
- Test: `tests/paths.test.ts`

**Step 1: Write the failing test**

```typescript
import { webhooksDir, webhookTransformPath } from '../src/paths.js';

test('webhooksDir returns ~/.ax/webhooks/', () => {
  const dir = webhooksDir();
  expect(dir).toMatch(/\.ax\/webhooks$/);
});

test('webhookTransformPath returns safe .md path', () => {
  const p = webhookTransformPath('github');
  expect(p).toMatch(/\.ax\/webhooks\/github\.md$/);
});

test('webhookTransformPath sanitizes unsafe names', () => {
  const p = webhookTransformPath('../../../etc/passwd');
  expect(p).not.toContain('..');
  expect(p).toMatch(/\.ax\/webhooks\//);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/paths.test.ts`
Expected: FAIL — `webhooksDir` not exported

**Step 3: Add path helpers**

In `src/paths.ts`, add:

```typescript
/** Directory for webhook transform files: ~/.ax/webhooks/ */
export function webhooksDir(): string {
  return join(axHome(), 'webhooks');
}

/** Path to a specific webhook transform file: ~/.ax/webhooks/<name>.md */
export function webhookTransformPath(name: string): string {
  return safePath(webhooksDir(), `${name}.md`);
}
```

Import `safePath` at the top of `paths.ts`:

```typescript
import { safePath } from './utils/safe-path.js';
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/paths.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/paths.ts tests/paths.test.ts
git commit -m "feat(webhooks): add webhook transform path helpers"
```

---

## Task 3: Webhook Handler — Auth, Rate Limiting, Body Parsing

**Files:**
- Create: `src/host/server-webhooks.ts`
- Test: `tests/host/server-webhooks.test.ts`

This is the core HTTP handler. It does NOT include the LLM transform or agent dispatch — those come in later tasks. This task covers: bearer token auth, per-IP rate limiting on auth failures, body size enforcement, JSON parsing, transform file lookup, and returning the right status codes.

**Step 1: Write the failing tests**

```typescript
// tests/host/server-webhooks.test.ts
import { describe, test, expect, beforeEach } from 'vitest';
import { createWebhookHandler, type WebhookDeps } from '../../src/host/server-webhooks.js';

// Use a minimal mock for deps — the handler needs config, logger, and callbacks.
// Tests should cover:

describe('webhook auth', () => {
  test('returns 401 when no token provided', async () => {
    const { handler, mockReq, mockRes } = setup({ token: 'secret' });
    mockReq.headers = {};
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).toBe(401);
  });

  test('returns 401 when token is wrong', async () => {
    const { handler, mockReq, mockRes } = setup({ token: 'secret' });
    mockReq.headers = { authorization: 'Bearer wrong' };
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).toBe(401);
  });

  test('accepts valid Bearer token', async () => {
    const { handler, mockReq, mockRes } = setup({ token: 'secret' });
    mockReq.headers = { authorization: 'Bearer secret' };
    // Will fail later (no transform file), but should NOT be 401
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).not.toBe(401);
  });

  test('rejects token in query string with 400', async () => {
    const { handler, mockReq, mockRes } = setup({ token: 'secret' });
    mockReq.url = '/webhooks/github?token=secret';
    mockReq.headers = {};
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).toBe(400);
  });
});

describe('webhook rate limiting', () => {
  test('returns 429 after repeated auth failures from same IP', async () => {
    const { handler, mockReq, mockRes, freshRes } = setup({ token: 'secret' });
    mockReq.headers = { authorization: 'Bearer wrong' };
    // Exhaust rate limit (default: 20 failures per 60s window)
    for (let i = 0; i < 20; i++) {
      await handler(mockReq, freshRes(), 'github');
    }
    const res = freshRes();
    await handler(mockReq, res, 'github');
    expect(res.statusCode).toBe(429);
  });
});

describe('webhook body parsing', () => {
  test('returns 400 for invalid JSON', async () => {
    const { handler, mockReq, mockRes } = setup({
      token: 'secret',
      body: 'not json',
    });
    mockReq.headers = { authorization: 'Bearer secret' };
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).toBe(400);
  });

  test('returns 404 when transform file does not exist', async () => {
    const { handler, mockReq, mockRes } = setup({
      token: 'secret',
      body: '{"event":"push"}',
      transformExists: false,
    });
    mockReq.headers = { authorization: 'Bearer secret' };
    await handler(mockReq, mockRes, 'nonexistent');
    expect(mockRes.statusCode).toBe(404);
  });
});

describe('webhook method enforcement', () => {
  test('returns 405 for GET requests', async () => {
    const { handler, mockReq, mockRes } = setup({ token: 'secret' });
    mockReq.method = 'GET';
    mockReq.headers = { authorization: 'Bearer secret' };
    await handler(mockReq, mockRes, 'github');
    expect(mockRes.statusCode).toBe(405);
  });
});
```

Note: The `setup()` helper should create mock `IncomingMessage` / `ServerResponse` objects and the `WebhookDeps` struct. Model this after existing test patterns in `tests/host/`. The handler signature is: `(req, res, webhookName) => Promise<void>`.

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/host/server-webhooks.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the handler**

Create `src/host/server-webhooks.ts`:

```typescript
/**
 * Inbound webhook handler.
 *
 * Auth: Bearer token via Authorization header or X-AX-Token header.
 * Rate limiting: per-IP fixed-window on auth failures.
 * Body: JSON, size-limited.
 * Transform: LLM-powered via ~/.ax/webhooks/<name>.md files.
 * Dispatch: async agent run via processCompletion.
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { webhookTransformPath } from '../paths.js';
import { readBody, sendError } from './server-http.js';
import type { Logger } from '../logger.js';

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

// ── Rate limiter (per-IP fixed-window) ──

interface RateLimitEntry {
  count: number;
  windowStartMs: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_FAILURES = 20;
const rateLimitMap = new Map<string, RateLimitEntry>();

function isRateLimited(ip: string, nowMs = Date.now()): boolean {
  const entry = rateLimitMap.get(ip);
  if (!entry || nowMs - entry.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
    return false;
  }
  return entry.count >= RATE_LIMIT_MAX_FAILURES;
}

function recordAuthFailure(ip: string, nowMs = Date.now()): void {
  const entry = rateLimitMap.get(ip);
  if (!entry || nowMs - entry.windowStartMs >= RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStartMs: nowMs });
    return;
  }
  entry.count += 1;
}

function resetRateLimit(ip: string): void {
  rateLimitMap.delete(ip);
}

// ── Auth ──

function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization?.trim() ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token) return token;
  }
  const headerToken = (req.headers['x-ax-token'] as string)?.trim();
  if (headerToken) return headerToken;
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── Types ──

export interface WebhookConfig {
  token: string;
  maxBodyBytes?: number;
  model?: string;
  allowedAgentIds?: string[];
}

export interface WebhookTransformResult {
  message: string;
  agentId?: string;
  sessionKey?: string;
  model?: string;
  timeoutSec?: number;
}

/** Callback that runs the LLM transform. Injected by caller. */
export type TransformFn = (
  transformContent: string,
  headers: Record<string, string>,
  payload: unknown,
  model?: string,
) => Promise<WebhookTransformResult | null>;

/** Callback that dispatches the agent run. Injected by caller. */
export type DispatchFn = (
  result: WebhookTransformResult,
  runId: string,
) => void;

export interface WebhookDeps {
  config: WebhookConfig;
  transform: TransformFn;
  dispatch: DispatchFn;
  logger: Logger;
}

// ── Handler ──

export function createWebhookHandler(deps: WebhookDeps) {
  return async function handleWebhook(
    req: IncomingMessage,
    res: ServerResponse,
    webhookName: string,
  ): Promise<void> {
    const { config, transform, dispatch, logger } = deps;

    // Method check
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }

    // Reject query-string tokens
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.searchParams.has('token')) {
      sendError(res, 400, 'Token must be provided via header, not query string');
      return;
    }

    // Rate limit check
    const clientIp = req.socket?.remoteAddress ?? 'unknown';
    if (isRateLimited(clientIp)) {
      res.writeHead(429, { 'Retry-After': '60' });
      res.end('Too Many Requests');
      return;
    }

    // Auth
    const token = extractToken(req);
    if (!token || !safeEqual(token, config.token)) {
      recordAuthFailure(clientIp);
      sendError(res, 401, 'Unauthorized');
      return;
    }
    resetRateLimit(clientIp);

    // Body parsing
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 413, 'Payload too large');
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      sendError(res, 400, 'Invalid JSON');
      return;
    }

    // Load transform file
    const transformPath = webhookTransformPath(webhookName);
    if (!existsSync(transformPath)) {
      sendError(res, 404, `No webhook transform found for "${webhookName}"`);
      return;
    }
    const transformContent = readFileSync(transformPath, 'utf-8');

    // Normalize headers
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
    }

    // LLM transform (async but we wait for the result before responding)
    let result: WebhookTransformResult | null;
    try {
      result = await transform(transformContent, headers, payload, config.model);
    } catch (err) {
      logger.error('webhook_transform_failed', {
        webhook: webhookName,
        error: (err as Error).message,
      });
      sendError(res, 500, 'Transform failed');
      return;
    }

    // null means "skip this event"
    if (result === null) {
      res.writeHead(204);
      res.end();
      return;
    }

    // Agent ID allowlist check
    if (result.agentId && config.allowedAgentIds) {
      if (!config.allowedAgentIds.includes(result.agentId)) {
        sendError(res, 400, `agentId "${result.agentId}" is not in allowed list`);
        return;
      }
    }

    // Dispatch (fire-and-forget)
    const runId = `webhook-${randomUUID().slice(0, 8)}`;
    dispatch(result, runId);

    // Respond immediately
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runId }));
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/host/server-webhooks.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-webhooks.ts tests/host/server-webhooks.test.ts
git commit -m "feat(webhooks): add webhook handler with auth, rate limiting, body parsing"
```

---

## Task 4: LLM Transform Function

**Files:**
- Create: `src/host/webhook-transform.ts`
- Test: `tests/host/webhook-transform.test.ts`

This task implements the `TransformFn` that calls the LLM with the transform file as system prompt and the raw payload as user content, then parses the structured JSON response.

**Step 1: Write the failing test**

```typescript
// tests/host/webhook-transform.test.ts
import { describe, test, expect } from 'vitest';
import { createWebhookTransform } from '../../src/host/webhook-transform.js';

// Mock LLM provider that returns predictable JSON
function mockLlm(responseJson: string) {
  return {
    name: 'mock',
    async *chat() {
      yield { type: 'text' as const, content: responseJson };
      yield { type: 'done' as const, usage: { inputTokens: 10, outputTokens: 10 } };
    },
    async models() { return ['mock']; },
  };
}

describe('webhook transform', () => {
  test('returns structured result from LLM response', async () => {
    const llm = mockLlm('{"message":"New push to main by alice","agentId":"devops"}');
    const transform = createWebhookTransform(llm, 'mock-model');
    const result = await transform(
      '# GitHub\nExtract push info',
      { 'x-github-event': 'push' },
      { ref: 'refs/heads/main', pusher: { name: 'alice' } },
    );
    expect(result).toEqual({
      message: 'New push to main by alice',
      agentId: 'devops',
    });
  });

  test('returns null when LLM returns null', async () => {
    const llm = mockLlm('null');
    const transform = createWebhookTransform(llm, 'mock-model');
    const result = await transform('# Skip stars', {}, { action: 'starred' });
    expect(result).toBeNull();
  });

  test('throws on invalid LLM output', async () => {
    const llm = mockLlm('not json');
    const transform = createWebhookTransform(llm, 'mock-model');
    await expect(
      transform('# Test', {}, {}),
    ).rejects.toThrow();
  });

  test('throws when message field is missing', async () => {
    const llm = mockLlm('{"agentId":"main"}');
    const transform = createWebhookTransform(llm, 'mock-model');
    await expect(
      transform('# Test', {}, {}),
    ).rejects.toThrow(/message/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/host/webhook-transform.test.ts`
Expected: FAIL — module not found

**Step 3: Implement the transform**

Create `src/host/webhook-transform.ts`:

```typescript
/**
 * LLM-powered webhook payload transform.
 *
 * Takes a markdown transform file (system prompt) and raw webhook
 * payload (user content), calls a fast LLM, and returns structured
 * output describing what the agent should do — or null to skip.
 */

import { z } from 'zod';
import type { LLMProvider } from '../providers/llm/types.js';
import type { WebhookTransformResult, TransformFn } from './server-webhooks.js';

const TransformResultSchema = z.object({
  message: z.string().min(1),
  agentId: z.string().optional(),
  sessionKey: z.string().optional(),
  model: z.string().optional(),
  timeoutSec: z.number().int().positive().optional(),
}).strict();

const SYSTEM_PREAMBLE = `You are a webhook payload transformer. You receive a webhook payload and HTTP headers. Your job is to extract the relevant information and return a JSON object that will be used to trigger an AI agent.

Your response MUST be valid JSON — either:
1. An object with at least a "message" field (string): the prompt for the agent.
   Optional fields: "agentId" (string), "sessionKey" (string), "model" (string), "timeoutSec" (number).
2. The literal value null — meaning this event should be ignored.

No markdown fencing. No explanation. Just the JSON value.

The following document describes how to handle payloads for this webhook source:

`;

export function createWebhookTransform(
  llm: LLMProvider,
  defaultModel: string,
): TransformFn {
  return async function transform(
    transformContent: string,
    headers: Record<string, string>,
    payload: unknown,
    modelOverride?: string,
  ): Promise<WebhookTransformResult | null> {
    const model = modelOverride ?? defaultModel;
    const systemPrompt = SYSTEM_PREAMBLE + transformContent;
    const userContent = JSON.stringify({ headers, payload }, null, 2);

    let responseText = '';
    for await (const chunk of llm.chat({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      maxTokens: 1024,
      taskType: 'fast',
    })) {
      if (chunk.type === 'text' && chunk.content) {
        responseText += chunk.content;
      }
    }

    const trimmed = responseText.trim();

    // Handle null (skip event)
    if (trimmed === 'null') return null;

    // Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`Webhook transform returned invalid JSON: ${trimmed.slice(0, 200)}`);
    }

    if (parsed === null) return null;

    // Validate schema
    const validated = TransformResultSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      throw new Error(`Webhook transform returned invalid structure: ${issues}`);
    }

    return validated.data;
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/host/webhook-transform.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/webhook-transform.ts tests/host/webhook-transform.test.ts
git commit -m "feat(webhooks): add LLM-powered webhook payload transform"
```

---

## Task 5: Wire Webhooks into the Host Server

**Files:**
- Modify: `src/host/server.ts:418-493` (handleRequest)
- Modify: `src/host/server.ts:295-360` (composition root — create handler)
- Test: `tests/host/server-webhooks.test.ts` (add integration-level test)

**Step 1: Write the failing test**

Add an integration test that verifies the full flow: POST to `/webhooks/github` → auth → transform → dispatch → 202.

```typescript
// Add to tests/host/server-webhooks.test.ts
describe('server integration', () => {
  test('POST /webhooks/<name> dispatches through full pipeline', async () => {
    // This test uses a real HTTP server on a random port.
    // Setup: create a temp webhooks dir with a transform file,
    // mock the LLM to return a known result, and verify dispatch is called.
    // Pattern: follow existing integration test setup in tests/host/ or tests/integration/.
  });
});
```

Note: The exact setup will depend on the test patterns already used in `tests/host/`. Look at existing server tests for the pattern. The key assertion is that `dispatch` is called with the transform result and a `runId`.

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/host/server-webhooks.test.ts`
Expected: FAIL

**Step 3: Wire the handler into server.ts**

In `src/host/server.ts`, in the composition section (around line 300-320, near `completionDeps`):

```typescript
import { createWebhookHandler, type WebhookDeps } from './server-webhooks.js';
import { createWebhookTransform } from './webhook-transform.js';

// ... after completionDeps is created ...

// Webhook handler (optional — only if config has webhooks.enabled)
const webhookHandler = config.webhooks?.enabled
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
      dispatch: (result, runId) => {
        // Fire-and-forget: run through processCompletion
        const sessionKey = result.sessionKey ?? `webhook:${runId}`;
        const childConfig: Config = {
          ...config,
          ...(result.agentId ? { agent_name: result.agentId } : {}),
          ...(result.model ? { models: { default: [result.model] } } : {}),
          ...(result.timeoutSec ? { sandbox: { ...config.sandbox, timeout_sec: result.timeoutSec } } : {}),
        };
        const childDeps: CompletionDeps = { ...completionDeps, config: childConfig };
        void processCompletion(
          childDeps,
          result.message,
          runId,
          [],
          undefined,
          undefined,
          'webhook',
        ).catch(err => {
          logger.error('webhook_dispatch_failed', { runId, error: (err as Error).message });
        });
      },
      logger,
    })
  : null;
```

In the `handleRequest` function (around line 488, before the final 404):

```typescript
    // Webhooks: POST /webhooks/<name>
    if (webhookHandler && url.startsWith('/webhooks/') && req.method === 'POST') {
      const webhookName = url.slice('/webhooks/'.length).split('?')[0];
      if (!webhookName) {
        sendError(res, 404, 'Not found');
        return;
      }
      trackRequestStart();
      try {
        await webhookHandler(req, res, webhookName);
      } catch (err) {
        logger.error('webhook_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Webhook processing failed');
      } finally {
        trackRequestEnd();
      }
      return;
    }
```

Also: reject webhook requests during drain (add alongside the existing completions drain check):

```typescript
    if (draining && url.startsWith('/webhooks/')) {
      sendError(res, 503, 'Server is shutting down');
      return;
    }
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/host/server-webhooks.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass — no regressions

**Step 6: Commit**

```bash
git add src/host/server.ts tests/host/server-webhooks.test.ts
git commit -m "feat(webhooks): wire webhook handler into host server"
```

---

## Task 6: Taint-Tag Webhook Payloads

**Files:**
- Modify: `src/host/server-webhooks.ts` (add taint recording)
- Modify: `src/host/server.ts` (pass taintBudget to webhook deps)
- Test: `tests/host/server-webhooks.test.ts`

Webhook payloads are external content by definition. They must be taint-tagged before entering the agent pipeline.

**Step 1: Write the failing test**

```typescript
test('webhook payload is taint-tagged as external', async () => {
  const taintCalls: Array<{ sessionId: string; isTainted: boolean }> = [];
  const { handler } = setup({
    token: 'secret',
    body: '{"event":"push"}',
    onTaint: (sessionId, _content, isTainted) => {
      taintCalls.push({ sessionId, isTainted });
    },
  });
  // ... invoke handler with valid auth and transform ...
  expect(taintCalls.length).toBeGreaterThan(0);
  expect(taintCalls[0].isTainted).toBe(true);
  expect(taintCalls[0].sessionId).toMatch(/^webhook:/);
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/host/server-webhooks.test.ts`
Expected: FAIL

**Step 3: Add taint recording**

In `server-webhooks.ts`, add an optional `recordTaint` callback to `WebhookDeps`:

```typescript
export interface WebhookDeps {
  config: WebhookConfig;
  transform: TransformFn;
  dispatch: DispatchFn;
  logger: Logger;
  recordTaint?: (sessionId: string, content: string, isTainted: boolean) => void;
}
```

In the handler, after the transform succeeds and before dispatch:

```typescript
    // Taint-tag the webhook payload (external content)
    const sessionId = result.sessionKey ?? `webhook:${runId}`;
    if (deps.recordTaint) {
      deps.recordTaint(sessionId, JSON.stringify(payload), true);
    }
```

In `server.ts`, pass the taint budget:

```typescript
      recordTaint: (sessionId, content, isTainted) => {
        taintBudget.recordContent(sessionId, content, isTainted);
      },
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/host/server-webhooks.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-webhooks.ts src/host/server.ts tests/host/server-webhooks.test.ts
git commit -m "feat(webhooks): taint-tag webhook payloads as external content"
```

---

## Task 7: Audit Logging for Webhooks

**Files:**
- Modify: `src/host/server-webhooks.ts` (add audit calls)
- Modify: `src/host/server.ts` (pass audit provider)
- Test: `tests/host/server-webhooks.test.ts`

Every webhook receipt and dispatch should be audit-logged.

**Step 1: Write the failing test**

```typescript
test('webhook receipt and dispatch are audit-logged', async () => {
  const auditEntries: Array<{ action: string }> = [];
  const { handler } = setup({
    token: 'secret',
    body: '{"event":"push"}',
    onAudit: (entry) => auditEntries.push(entry),
  });
  // ... invoke handler ...
  expect(auditEntries).toContainEqual(expect.objectContaining({ action: 'webhook.received' }));
  expect(auditEntries).toContainEqual(expect.objectContaining({ action: 'webhook.dispatched' }));
});

test('webhook auth failure is audit-logged', async () => {
  const auditEntries: Array<{ action: string }> = [];
  const { handler, mockReq, mockRes } = setup({
    token: 'secret',
    onAudit: (entry) => auditEntries.push(entry),
  });
  mockReq.headers = { authorization: 'Bearer wrong' };
  await handler(mockReq, mockRes, 'github');
  expect(auditEntries).toContainEqual(expect.objectContaining({ action: 'webhook.auth_failed' }));
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/host/server-webhooks.test.ts`
Expected: FAIL

**Step 3: Add audit logging**

Add optional `audit` callback to `WebhookDeps`:

```typescript
  audit?: (entry: { action: string; webhook: string; runId?: string; ip?: string }) => void;
```

Call at key points: auth failure, receipt, dispatch, transform failure.

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/host/server-webhooks.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-webhooks.ts src/host/server.ts tests/host/server-webhooks.test.ts
git commit -m "feat(webhooks): add audit logging for webhook events"
```

---

## Task 8: Documentation — Example Transform Files

**Files:**
- Create: `docs/webhooks.md`

Write user-facing documentation covering:
1. How to enable webhooks in `ax.yaml`
2. How to write a transform file (with 2-3 examples: GitHub, Stripe, generic)
3. How to test a webhook with curl
4. Security considerations

Include example transform files:

**`~/.ax/webhooks/github.md` example:**

```markdown
# GitHub Webhook Transform

You receive GitHub webhook events. The `x-github-event` header tells you the event type.

## Push events
When `headers.x-github-event` is "push":
- message: Summarize the push: who pushed, how many commits, to which branch, and the head commit message.
- agentId: "main"

## Issue events
When `headers.x-github-event` is "issues" and `payload.action` is "opened":
- message: Describe the new issue: number, title, body, and who opened it.
- agentId: "main"

## Pull request events
When `headers.x-github-event` is "pull_request" and `payload.action` is "opened":
- message: Describe the new PR: number, title, body, base/head branches, and author.
- agentId: "main"

## Everything else
Return null to ignore.
```

**Step 1: Write the docs**

Follow the voice & tone guidelines from CLAUDE.md.

**Step 2: Commit**

```bash
git add docs/webhooks.md
git commit -m "docs: add webhook transform documentation and examples"
```

---

## Summary

| Task | What | Files | Estimated Complexity |
|------|------|-------|---------------------|
| 1 | Config schema | config.ts, types.ts | Small |
| 2 | Path helpers | paths.ts | Small |
| 3 | Webhook handler (auth, rate limit, body) | server-webhooks.ts | Medium |
| 4 | LLM transform function | webhook-transform.ts | Medium |
| 5 | Wire into server.ts | server.ts | Medium |
| 6 | Taint tagging | server-webhooks.ts | Small |
| 7 | Audit logging | server-webhooks.ts | Small |
| 8 | Documentation | docs/webhooks.md | Small |

**New files:** 3 (`server-webhooks.ts`, `webhook-transform.ts`, `docs/webhooks.md`)
**Modified files:** 4 (`config.ts`, `types.ts`, `paths.ts`, `server.ts`)
**Test files:** 3 (`config.test.ts`, `paths.test.ts`, `server-webhooks.test.ts`, `webhook-transform.test.ts`)

### What's Intentionally NOT Here

- **Template engine** — The LLM replaces it.
- **JS/TS transform modules** — The LLM replaces them.
- **Module sandboxing** — No code execution, nothing to sandbox.
- **Mapping config schema** — No mappings; one file per webhook source.
- **Wake/agent endpoint split** — Single endpoint; all events become agent runs.
- **HMAC signature verification** — Bearer token only for v1. Add later.
- **Outbound webhooks** — Separate concern, not in scope.
- **Provider contract for webhooks** — Direct host module; not a swappable provider.
- **Session policy config knobs** — Auto-generate `webhook:<uuid>` session keys.
