# Automated Regression Test Suite — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create an automated, vitest-based regression test suite that exercises core AX workflows (bootstrap, chat, tool calls, file persistence, proxy commands, skill install + credentials) against a live k8s server deployed in an auto-managed kind cluster, with all external services mocked.

**Architecture:** A single vitest config (`tests/acceptance/automated/vitest.config.ts`) runs a `globalSetup` that creates a kind cluster, builds/loads the Docker image, deploys AX via Helm, and starts a mock server on the host. Tests use an `AcceptanceClient` to send streaming chat completions, parse SSE events, and provide credentials. A `globalTeardown` destroys the cluster and stops the mock server. All external services (OpenRouter, GCS, ClawHub, Linear API) are mocked by a single Node.js HTTP server.

**Tech Stack:** Vitest, Node.js `http.createServer`, kind, Helm, kubectl, Docker

**Security note:** All shell commands in setup/teardown use `execFileSync`/`spawn` (not `exec`/`execSync`) to prevent command injection. See `src/utils/execFileNoThrow.ts` for the project pattern.

---

## Overview of Changes

### Production Code Changes (small, targeted)

1. **`src/clawhub/registry-client.ts`** — Make `CLAWHUB_API` overridable via `CLAWHUB_API_URL` env var
2. **`src/host/web-proxy.ts`** — Add `urlRewrites` option to `WebProxyOptions` for domain-to-URL rewriting in both HTTP and CONNECT handlers
3. **`src/types.ts`** — Add `url_rewrites` config field
4. **`src/host/server-completions.ts`** + **`src/host/host-process.ts`** — Wire `url_rewrites` to proxy

### Test Infrastructure (new files)

5. **Mock server** — Single HTTP server with route-based dispatch for OpenRouter, GCS, ClawHub, Linear API
6. **AcceptanceClient** — HTTP client for AX's `/v1/chat/completions` SSE endpoint + credential submission
7. **Scripted turns** — Pre-built mock LLM responses that drive the bootstrap and test scenarios
8. **Test sequence** — Single ordered vitest file walking through the full lifecycle
9. **Global setup/teardown** — Kind cluster lifecycle + mock server + port-forward
10. **Vitest config** — Separate config for acceptance tests with long timeouts
11. **npm script** — `npm run test:acceptance`

---

## Task 1: Make ClawHub API URL Configurable

**Files:**
- Modify: `src/clawhub/registry-client.ts:17`
- Test: `tests/clawhub/registry-client.test.ts`

### Step 1: Write the failing test

Add a test to `tests/clawhub/registry-client.test.ts`:

```typescript
test('uses CLAWHUB_API_URL env override for search', async () => {
  const mockUrl = 'http://localhost:19999/clawhub/api/v1';
  process.env.CLAWHUB_API_URL = mockUrl;
  try {
    await searchSkills('test-query').catch((err) => {
      expect(err.message).toContain(mockUrl);
      throw err;
    });
  } catch {
    // Expected — no server listening. The point is the URL was overridden.
  } finally {
    delete process.env.CLAWHUB_API_URL;
  }
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run tests/clawhub/registry-client.test.ts -t "CLAWHUB_API_URL"
```
Expected: FAIL — the URL still points to `https://clawhub.ai/api/v1`

### Step 3: Implement the change

In `src/clawhub/registry-client.ts`, change line 17:

```typescript
// Before:
const CLAWHUB_API = 'https://clawhub.ai/api/v1';

// After:
const CLAWHUB_API = process.env.CLAWHUB_API_URL || 'https://clawhub.ai/api/v1';
```

### Step 4: Run test to verify it passes

```bash
npx vitest run tests/clawhub/registry-client.test.ts
```
Expected: All tests PASS

### Step 5: Commit

```bash
git add src/clawhub/registry-client.ts tests/clawhub/registry-client.test.ts
git commit -m "feat: allow CLAWHUB_API_URL env var override for testing"
```

---

## Task 2: Add URL Rewriting to Web Proxy

**Files:**
- Modify: `src/host/web-proxy.ts:56-92` (WebProxyOptions), `~200` (handleHTTPRequest), `~380` (handleCONNECT)
- Test: `tests/host/web-proxy.test.ts`

The proxy needs a `urlRewrites` option: a `Map<string, string>` mapping domain names to replacement base URLs. When a request targets a domain in the map, the proxy rewrites the URL to point at the replacement instead.

### Step 1: Write the failing test

Add to `tests/host/web-proxy.test.ts`:

```typescript
import { createServer as createHttpServer } from 'node:http';

test('URL rewrite redirects requests to mock target', async () => {
  // Start a mock target that records what it receives
  let receivedUrl = '';
  const mock = createHttpServer((req, res) => {
    receivedUrl = req.url ?? '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ mock: true }));
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = (mock.address() as any).port;

  const proxy = await startWebProxy({
    listen: 0,
    sessionId: 'test:rewrite:1',
    urlRewrites: new Map([
      ['api.linear.app', `http://127.0.0.1:${mockPort}`],
    ]),
  });

  // Send HTTP request through proxy targeting api.linear.app
  const res = await fetch('http://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ viewer { id } }' }),
    // @ts-expect-error — undici proxy agent
    dispatcher: new (await import('undici')).ProxyAgent(
      `http://127.0.0.1:${proxy.address}`
    ),
  });

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ mock: true });
  expect(receivedUrl).toBe('/graphql');

  proxy.stop();
  mock.close();
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run tests/host/web-proxy.test.ts -t "URL rewrite"
```
Expected: FAIL — `urlRewrites` is not a known option

### Step 3: Implement URL rewriting

**3a.** Add `urlRewrites` to `WebProxyOptions` interface (`src/host/web-proxy.ts:56`):

```typescript
export interface WebProxyOptions {
  // ... existing fields ...
  /**
   * URL rewrite map: domain -> replacement base URL.
   * When a request targets a domain in this map, the proxy rewrites the URL
   * to use the replacement base URL instead.
   * Works for both HTTP forwarding and HTTPS CONNECT tunneling.
   */
  urlRewrites?: Map<string, string>;
}
```

**3b.** Destructure in `startWebProxy()` (~line 149):

```typescript
const { listen, bindHost = '127.0.0.1', sessionId, canaryToken, onAudit,
        allowedIPs, onApprove, allowedDomains, urlRewrites } = options;
```

**3c.** Add a rewrite helper function inside `startWebProxy()`:

```typescript
/** Rewrite URL if domain matches a urlRewrites entry. Returns original if no match. */
function rewriteUrl(originalUrl: string): string {
  if (!urlRewrites?.size) return originalUrl;
  const parsed = new URL(originalUrl);
  const replacement = urlRewrites.get(parsed.hostname);
  if (!replacement) return originalUrl;
  const target = new URL(replacement);
  const basePath = target.pathname === '/' ? '' : target.pathname;
  return `${target.origin}${basePath}${parsed.pathname}${parsed.search}`;
}
```

**3d.** In `handleHTTPRequest()` (~line 202), apply rewrite before parsing:

```typescript
// Before:  const targetUrl = new URL(url);
// After:
const rewrittenUrl = rewriteUrl(url);
const targetUrl = new URL(rewrittenUrl);
```

Update the `fetch()` call and audit logging to use `rewrittenUrl` for the actual request but log the original `url` for audit.

**3e.** In `handleCONNECT()`, apply rewrite to redirect the tunnel. When a CONNECT request comes for `api.linear.app:443`, if a rewrite exists for that hostname, connect to the mock server's host:port instead:

```typescript
const rewriteTarget = urlRewrites?.get(hostname);
if (rewriteTarget) {
  const target = new URL(rewriteTarget);
  const connectHost = target.hostname;
  const connectPort = parseInt(target.port || (target.protocol === 'https:' ? '443' : '80'));
  const socket = net.connect(connectPort, connectHost, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.pipe(clientSocket);
    clientSocket.pipe(socket);
  });
  socket.on('error', (err) => {
    clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n`);
  });
  return;
}
```

### Step 4: Run test to verify it passes

```bash
npx vitest run tests/host/web-proxy.test.ts
```
Expected: All tests PASS

### Step 5: Commit

```bash
git add src/host/web-proxy.ts tests/host/web-proxy.test.ts
git commit -m "feat: add urlRewrites option to web proxy for domain-level redirect"
```

---

## Task 3: Wire URL Rewrites into Server Config

**Files:**
- Modify: `src/types.ts` (add `url_rewrites` config field)
- Modify: `src/host/server-completions.ts` (pass to `startWebProxy`)
- Modify: `src/host/host-process.ts` (pass to `startWebProxy` for k8s)

### Step 1: Add config field

In `src/types.ts`, add to the Config interface:

```typescript
/** Domain-to-URL rewrite map for web proxy (testing/mocking). */
url_rewrites?: Record<string, string>;
```

### Step 2: Pass urlRewrites to startWebProxy()

In `src/host/server-completions.ts`, find where `startWebProxy()` is called and add:

```typescript
urlRewrites: config.url_rewrites
  ? new Map(Object.entries(config.url_rewrites))
  : undefined,
```

### Step 3: Also wire into host-process.ts

In `src/host/host-process.ts`, find where `startWebProxy()` is called for k8s and pass the same option.

### Step 4: Run full test suite

```bash
npm test -- --run
```
Expected: All existing tests PASS (no behavior change when `url_rewrites` is absent)

### Step 5: Commit

```bash
git add src/types.ts src/host/server-completions.ts src/host/host-process.ts
git commit -m "feat: wire url_rewrites config to web proxy for acceptance testing"
```

---

## Task 4: Create Mock Server — GCS Backend

**Files:**
- Create: `tests/acceptance/automated/mock-server/gcs.ts`
- Create: `tests/acceptance/automated/mock-server/gcs.test.ts`

Implement a minimal GCS-compatible HTTP handler backed by `/tmp/fake-gcs/`. The `@google-cloud/storage` SDK uses these endpoints when `STORAGE_EMULATOR_HOST` is set:

- `POST /upload/storage/v1/b/{bucket}/o?uploadType=resumable&name={name}` — initiate resumable upload, return upload URI
- `PUT /upload/storage/v1/b/{bucket}/o?uploadType=resumable&upload_id={id}` — receive body, save file
- `POST /upload/storage/v1/b/{bucket}/o?uploadType=multipart&name={name}` — single-shot upload
- `GET /storage/v1/b/{bucket}/o?prefix={prefix}` — list objects
- `GET /storage/v1/b/{bucket}/o/{name}?alt=media` — download
- `GET /storage/v1/b/{bucket}/o/{name}` — metadata
- `DELETE /storage/v1/b/{bucket}/o/{name}` — delete

### Step 1: Implement the handler

Store files at `/tmp/fake-gcs/{bucket}/{objectName}`. URL-decode object names (they contain `/`). Create parent directories on save. Return proper GCS JSON response shapes.

### Step 2: Write a self-contained test

```typescript
test('mock GCS: upload, list, download, delete cycle', async () => {
  // Start mock server with just GCS handler
  // Use @google-cloud/storage SDK with STORAGE_EMULATOR_HOST pointing at mock
  // Upload a file, list it, download it, delete it, verify each step
});
```

### Step 3: Run test

```bash
npx vitest run tests/acceptance/automated/mock-server/gcs.test.ts
```

### Step 4: Commit

```bash
git add tests/acceptance/automated/mock-server/gcs.ts tests/acceptance/automated/mock-server/gcs.test.ts
git commit -m "feat: add mock GCS server for acceptance tests"
```

---

## Task 5: Create Mock Server — OpenRouter Backend

**Files:**
- Create: `tests/acceptance/automated/mock-server/openrouter.ts`
- Create: `tests/acceptance/automated/scripted-turns.ts`

The mock OpenRouter returns scripted responses in OpenAI streaming format. A turn queue matches incoming user messages to pre-defined responses.

### Step 1: Define scripted turns (`scripted-turns.ts`)

```typescript
export interface ScriptedTurn {
  /** Pattern to match in the latest user message */
  match: RegExp | string;
  /** Response to return */
  response: {
    content?: string;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  finishReason?: string;
}

export const BOOTSTRAP_TURNS: ScriptedTurn[] = [
  // Turn 1: User introduces self → agent calls user_write + asks about identity
  {
    match: /my name is/i,
    response: {
      content: 'Nice to meet you! Let me save your info.',
      tool_calls: [{
        id: 'tc_user_1',
        type: 'function',
        function: {
          name: 'identity',
          arguments: JSON.stringify({
            type: 'user_write',
            userId: 'testuser',
            content: '# TestUser\n\n**Name:** TestUser\n**Notes:** Participant in acceptance testing.',
            reason: 'Recording user name from introduction',
            origin: 'user_request',
          }),
        },
      }],
    },
  },
  // Turn 2: User sets agent identity → agent writes IDENTITY.md + SOUL.md
  {
    match: /your name is|witty and funny|acceptance testing/i,
    response: {
      content: 'Done! I am Reginald, your witty acceptance testing companion.',
      tool_calls: [
        {
          id: 'tc_identity_1',
          type: 'function',
          function: {
            name: 'identity',
            arguments: JSON.stringify({
              type: 'write',
              file: 'IDENTITY.md',
              content: '# Reginald\n\n**Name:** Reginald\n**Creature:** AI\n**Vibe:** Witty and funny\n**Emoji:** 🧪\n\n## Purpose\nAcceptance testing companion.',
              reason: 'Setting identity per user request',
              origin: 'user_request',
            }),
          },
        },
        {
          id: 'tc_soul_1',
          type: 'function',
          function: {
            name: 'identity',
            arguments: JSON.stringify({
              type: 'write',
              file: 'SOUL.md',
              content: '# Soul of Reginald\n\n## Core Philosophy\nI exist to make acceptance testing bearable through wit and reliability.\n\n## Voice\nWitty, funny, occasionally sarcastic but always helpful.',
              reason: 'Establishing personality',
              origin: 'user_request',
            }),
          },
        },
      ],
    },
  },
];

// ... additional turns for chat, tool calls, file ops, skill install, etc.
```

### Step 2: Implement OpenRouter mock handler (`openrouter.ts`)

Streaming format must match OpenAI SSE exactly:

```
data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

For `tool_calls`, stream `delta.tool_calls` with index-based accumulation per OpenAI spec.

### Step 3: Commit

```bash
git add tests/acceptance/automated/mock-server/openrouter.ts tests/acceptance/automated/scripted-turns.ts
git commit -m "feat: add mock OpenRouter with scripted turns for acceptance tests"
```

---

## Task 6: Create Mock Server — ClawHub and Linear

**Files:**
- Create: `tests/acceptance/automated/mock-server/clawhub.ts`
- Create: `tests/acceptance/automated/mock-server/linear.ts`
- Create: `tests/acceptance/automated/fixtures/linear-skill.zip` (or build in-memory)

### Step 1: Mock ClawHub registry

Handle two endpoints:

```typescript
// GET /api/v1/search?q=linear → return search results
// GET /api/v1/download?slug=ManuelHettich/linear → return ZIP with SKILL.md
```

The ZIP must contain a valid `SKILL.md` with `requires.env: [LINEAR_API_KEY]` in frontmatter. Build the ZIP in memory using raw ZIP format (local file header + central directory + end-of-central-directory), or use the `archiver` package if available.

### Step 2: Mock Linear API

```typescript
// POST /graphql → validate Authorization header has "Bearer lin_api_..."
//                → return canned GraphQL response
// { data: { issues: { nodes: [{ id: "ISS-1", title: "Test Issue" }] } } }
```

### Step 3: Commit

```bash
git add tests/acceptance/automated/mock-server/clawhub.ts tests/acceptance/automated/mock-server/linear.ts
git commit -m "feat: add mock ClawHub and Linear API for acceptance tests"
```

---

## Task 7: Create Mock Server — Router and Entry Point

**Files:**
- Create: `tests/acceptance/automated/mock-server/index.ts`

Single HTTP server that dispatches to all mock handlers based on URL path:

- `/v1/chat/completions`, `/v1/models` → OpenRouter
- `/storage/...`, `/upload/...` → GCS
- `/api/v1/...` → ClawHub
- `/graphql` → Linear
- `/health` → health check
- `/web-fetch-target` → canned HTML response for web_fetch tests

Also exports `reset()` to clear all mock state (GCS files, turn queue position).

### Step 1: Implement the router and start/stop functions

### Step 2: Write a smoke test

### Step 3: Commit

```bash
git add tests/acceptance/automated/mock-server/index.ts
git commit -m "feat: add mock server router for acceptance tests"
```

---

## Task 8: Create Acceptance Client

**Files:**
- Create: `tests/acceptance/automated/client.ts`

HTTP client that sends chat completions to AX server and parses SSE responses.

### Key interface:

```typescript
export interface ChatResponse {
  content: string;                    // Accumulated text from all chunks
  events: Map<string, any[]>;        // Named SSE events (credential_required, etc.)
  chunks: any[];                     // Raw parsed chunks
  status: number;
  finishReason: string;
}

export class AcceptanceClient {
  constructor(private baseUrl: string) {}

  async sendMessage(content: string, opts: {
    sessionId: string;
    user?: string;
    model?: string;
    timeoutMs?: number;
  }): Promise<ChatResponse>;

  async provideCredential(envName: string, value: string): Promise<void>;

  async waitForReady(timeoutMs?: number): Promise<void>;
}
```

SSE parsing must handle:
- Standard `data:` lines (OpenAI chunks) — accumulate `delta.content`, `delta.tool_calls`
- Named events (`event: credential_required\ndata: {...}`) — collect in `events` map
- Keepalive comments (`: keepalive`) — ignore
- `data: [DONE]` — end of stream
- Timeout via `AbortController` (default 60s)

### Step 1: Implement the client

### Step 2: Commit

```bash
git add tests/acceptance/automated/client.ts
git commit -m "feat: add AcceptanceClient for SSE-based acceptance tests"
```

---

## Task 9: Create Global Setup/Teardown — Kind Cluster Lifecycle

**Files:**
- Create: `tests/acceptance/automated/global-setup.ts`
- Create: `tests/acceptance/automated/global-teardown.ts`
- Create: `tests/acceptance/automated/kind-values.yaml`

### Global Setup Flow

Uses `execFileSync` and `spawn` (never `exec`) per project security policy.

```
1. Generate random cluster name: ax-test-<8-hex-chars>
2. Start mock server on host (port 0 = auto-assign, bind 0.0.0.0)
3. Detect host IP accessible from kind containers (docker bridge gateway)
4. Create kind cluster: kind create cluster --name <name> --wait 120s
5. Build AX: npm run build
6. Docker build: docker build -t ax-test:local -f container/agent/Dockerfile .
7. Load image: kind load docker-image ax-test:local --name <name>
8. Create namespace: kubectl create namespace ax-acceptance
9. Create k8s secret with env vars pointing at mock server on host:
   - OPENROUTER_API_KEY, OPENROUTER_BASE_URL, STORAGE_EMULATOR_HOST
   - GCS_WORKSPACE_BUCKET, CLAWHUB_API_URL, DEEPINFRA_API_KEY
10. Helm install with kind-values.yaml
11. Wait for rollout: kubectl rollout status deployment/ax-host --timeout=180s
12. Port-forward svc/ax-host to localhost:<random>
13. Write state to /tmp/ax-acceptance-state/state.json
14. Set AX_SERVER_URL env var for vitest
15. Wait for /health to respond 200
```

**Skip cluster if `AX_SERVER_URL` already set** — enables local server testing.

### Global Teardown Flow

```
1. Read state from /tmp/ax-acceptance-state/state.json
2. Kill port-forward process
3. kind delete cluster --name <name>
4. Stop mock server
5. Clean up /tmp/fake-gcs/ and state files
```

### kind-values.yaml

Based on existing `tests/acceptance/fixtures/kind-values.yaml` with these additions:
- `workspace: gcs` provider
- `web_proxy: true`
- `url_rewrites` config for `api.linear.app` and `mock-target.test` pointing at mock server
- `credentials: database` (for credential storage testing)

### Step 1: Implement global-setup.ts and global-teardown.ts

### Step 2: Create kind-values.yaml

### Step 3: Commit

```bash
git add tests/acceptance/automated/global-setup.ts tests/acceptance/automated/global-teardown.ts tests/acceptance/automated/kind-values.yaml
git commit -m "feat: add kind cluster lifecycle for automated acceptance tests"
```

---

## Task 10: Create Vitest Config and npm Script

**Files:**
- Create: `tests/acceptance/automated/vitest.config.ts`
- Modify: `package.json` (add `test:acceptance` script)
- Modify: `vitest.config.ts` (exclude `tests/acceptance/automated/**` from default run)

### Acceptance vitest config:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 120_000,       // 2 min per test
    hookTimeout: 300_000,       // 5 min for globalSetup
    sequence: { concurrent: false },
    include: ['tests/acceptance/automated/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/mock-server/*.test.ts'],
    globalSetup: ['tests/acceptance/automated/global-setup.ts'],
  },
});
```

### npm script:

```json
"test:acceptance": "vitest run --config tests/acceptance/automated/vitest.config.ts"
```

### Step 1: Create config, add script, update exclude

### Step 2: Verify default test suite unaffected

```bash
npm test -- --run
```

### Step 3: Commit

```bash
git add tests/acceptance/automated/vitest.config.ts package.json vitest.config.ts
git commit -m "feat: add vitest config and npm script for acceptance tests"
```

---

## Task 11: Create the Test Sequence

**Files:**
- Create: `tests/acceptance/automated/regression.test.ts`

Single `describe` block with ordered `test` calls. Each test has a 60s timeout.

### Test Sequence:

```
1. RESET         — verify server healthy, no prior state (fresh kind cluster)
2a. BOOTSTRAP    — first message triggers bootstrap mode, agent processes intro
2b. BOOTSTRAP    — user sets agent name/voice/purpose, agent writes IDENTITY.md + SOUL.md
3. PERSISTENCE   — new session, agent responds with established identity
4. TOOL CALL     — web_fetch through proxy (rewritten to mock server)
5. FILE OPS      — agent creates files in workspace via bash tool
6. FILE PERSIST  — new session, agent reads back files from previous session
7. BASH + PROXY  — curl command executed through web proxy
8a. SKILL INSTALL — triggers credential.required SSE event for LINEAR_API_KEY
8b. CREDENTIALS  — provide credential via POST, verify stored
9. SKILL EXEC    — Linear tool call goes through proxy to mock Linear API
```

### Key assertions per test:

| Test | Assert |
|------|--------|
| 1 | `GET /health` returns 200 |
| 2a | Status 200, response content non-empty, finishReason='stop' |
| 2b | Status 200, tool_calls for identity_write seen in response |
| 3 | Status 200, response references agent identity (scripted by mock) |
| 4 | Status 200, tool_call event for web_fetch present |
| 5 | Status 200, file created (verifiable via mock GCS contents) |
| 6 | Status 200, file content matches what was written |
| 7 | Status 200, curl output contains mock response |
| 8a | credential_required SSE event with envName=LINEAR_API_KEY |
| 8b | provideCredential returns 200 |
| 9 | Status 200, Linear tool executed, mock Linear received correct auth header |

### Step 1: Implement the test file

### Step 2: Dry-run syntax check

### Step 3: Commit

```bash
git add tests/acceptance/automated/regression.test.ts
git commit -m "feat: add regression test sequence for acceptance tests"
```

---

## Task 12: End-to-End Verification

### Step 1: Run the full acceptance test suite

```bash
npm run test:acceptance
```

This will: start mock server, create kind cluster, build/deploy AX, run all tests, tear down cluster.

### Step 2: Verify local mode works

```bash
# Start local server separately with mock env vars, then:
AX_SERVER_URL=http://localhost:8080 npm run test:acceptance
```

Should skip kind cluster creation, run tests against local server.

### Step 3: Fix any issues found

### Step 4: Final commit

---

## File Summary

| File | Type | Purpose |
|------|------|---------|
| `src/clawhub/registry-client.ts` | Modify | `CLAWHUB_API_URL` env override |
| `src/host/web-proxy.ts` | Modify | `urlRewrites` option |
| `src/host/server-completions.ts` | Modify | Wire `url_rewrites` config |
| `src/host/host-process.ts` | Modify | Wire `url_rewrites` config (k8s) |
| `src/types.ts` | Modify | `url_rewrites` config field |
| `vitest.config.ts` | Modify | Exclude acceptance from default |
| `package.json` | Modify | `test:acceptance` script |
| `tests/acceptance/automated/vitest.config.ts` | Create | Acceptance test config |
| `tests/acceptance/automated/global-setup.ts` | Create | Kind cluster + mock lifecycle |
| `tests/acceptance/automated/global-teardown.ts` | Create | Cleanup |
| `tests/acceptance/automated/kind-values.yaml` | Create | Helm overrides |
| `tests/acceptance/automated/client.ts` | Create | SSE-aware HTTP client |
| `tests/acceptance/automated/scripted-turns.ts` | Create | Mock LLM turn definitions |
| `tests/acceptance/automated/regression.test.ts` | Create | The test sequence |
| `tests/acceptance/automated/mock-server/index.ts` | Create | Mock server router |
| `tests/acceptance/automated/mock-server/gcs.ts` | Create | Mock GCS |
| `tests/acceptance/automated/mock-server/gcs.test.ts` | Create | Mock GCS self-test |
| `tests/acceptance/automated/mock-server/openrouter.ts` | Create | Mock OpenRouter |
| `tests/acceptance/automated/mock-server/clawhub.ts` | Create | Mock ClawHub |
| `tests/acceptance/automated/mock-server/linear.ts` | Create | Mock Linear API |
