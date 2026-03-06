# Acceptance Test Results: LLM Webhook Transforms

**Date run:** 2026-03-05 21:45
**Server version:** e158750
**LLM provider:** openrouter/google/gemini-3-flash-preview (default), fast model for transforms
**Environment:** Local (seatbelt sandbox, inprocess eventbus, file storage, file audit)

## Summary
| Test | Category | Result | Notes |
|------|----------|--------|-------|
| ST-1 | Structural | PASS | ConfigSchema has `webhooks` with all 6 fields in `z.strictObject()` |
| ST-2 | Structural | PASS | Config interface has `webhooks?` with matching typed fields |
| ST-3 | Structural | PASS | `webhooksDir()` and `webhookTransformPath()` exported, uses `safePath()` |
| ST-4 | Structural | PASS | `timingSafeEqual` imported and used via `safeEqual()` wrapper |
| ST-5 | Structural | PASS | Rate limiter: 60s window, 20 max failures, reset on success |
| ST-6 | Structural | PASS | `extractToken()` checks Authorization + X-AX-Token headers |
| ST-7 | Structural | PASS | `TransformResultSchema` is `z.strictObject()` with required `message` |
| ST-8 | Structural | PASS | `webhookHandler` conditionally created based on `config.webhooks?.enabled` |
| ST-9 | Structural | PASS | `webhookPrefix` defaults to `/webhooks/`, uses config path with trailing slash normalization |
| ST-10 | Structural | PASS | Drain check at line 511 covers both completions and webhook prefix |
| ST-11 | Structural | PASS | `void processCompletion(...)` with `.catch()`, userId `'webhook'` |
| ST-12 | Structural | PASS | `docs/webhooks.md` exists with config, 3 transform examples, curl, security |
| BT-1 | Behavioral | PASS | 202 returned with `runId` matching `webhook-[a-f0-9]{8}` pattern |
| BT-2 | Behavioral | PASS | 204 returned for watch event (LLM returned null) |
| BT-3 | Behavioral | PASS | 401 for wrong token, 401 for missing token, audit logged |
| BT-4 | Behavioral | PASS | 404 with "No webhook transform found" for missing transform file |
| BT-5 | Behavioral | PASS | X-AX-Token header accepted, returned 202 |
| IT-1 | Integration | PASS | Full pipeline: 202 with runId, audit has received + dispatched, no dispatch errors |
| IT-2 | Integration | PASS | Restricted (400 "not in allowed list"), allowed (202) |
| IT-3 | Integration | PASS | 20x 401, then 429, valid token also 429, Retry-After: 60 present |
| IT-4 | Integration | PASS | 202 returned, dispatch logged, taint wired structurally |

**Overall: 21/21 passed**

## Detailed Results

### ST-1: Config schema includes webhooks section
**Result: PASS**

Verified in `src/config.ts` lines 115-122:
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
- [x] ConfigSchema contains `webhooks` key with `z.strictObject` containing all 6 fields
- [x] `enabled` is `z.boolean()` (required)
- [x] `token` is `z.string().min(1)` (required)
- [x] `path`, `max_body_bytes`, `model`, `allowed_agent_ids` are all optional
- [x] `webhooks` itself is `.optional()` on the top-level schema

---

### ST-2: Config type interface includes webhooks
**Result: PASS**

Verified in `src/types.ts` lines 124-131:
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
- [x] `Config` interface has `webhooks?` with all 6 typed fields
- [x] Types match the Zod schema exactly

---

### ST-3: Path helpers exported and use safePath
**Result: PASS**

Verified in `src/paths.ts` lines 235-242:
```typescript
export function webhooksDir(): string {
  return join(axHome(), 'webhooks');
}

export function webhookTransformPath(name: string): string {
  return safePath(webhooksDir(), `${name}.md`);
}
```
- [x] Both functions are exported
- [x] `webhooksDir()` uses `join(axHome(), 'webhooks')`
- [x] `webhookTransformPath(name)` delegates to `safePath()` (SC-SEC-004 compliance)

---

### ST-4: Webhook handler uses timing-safe token comparison
**Result: PASS**

Verified in `src/host/server-webhooks.ts` lines 2, 62-65:
```typescript
import { timingSafeEqual } from 'node:crypto';
...
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
```
Auth check at line 147: `if (!token || !safeEqual(token, config.token))`
- [x] `timingSafeEqual` is imported from `node:crypto`
- [x] Token comparison goes through `safeEqual()` which wraps `timingSafeEqual`
- [x] No direct `===` comparison on raw token strings

---

### ST-5: Rate limiter implements fixed-window with correct constants
**Result: PASS**

Verified in `src/host/server-webhooks.ts` lines 24-47:
- `RATE_LIMIT_WINDOW_MS = 60_000`
- `RATE_LIMIT_MAX_FAILURES = 20`
- `isRateLimited(ip)` checks `entry.count >= RATE_LIMIT_MAX_FAILURES` with window expiry
- `recordAuthFailure(ip)` increments count within window or resets on new window
- `resetRateLimit(ip)` deletes the entry on successful auth (line 46-47)

- [x] Window is 60 seconds, max failures is 20
- [x] Rate limit resets on successful auth (via `resetRateLimit`)
- [x] Window expiry logic is correct

---

### ST-6: Webhook handler supports both Authorization and X-AX-Token headers
**Result: PASS**

Verified in `src/host/server-webhooks.ts` lines 51-60:
```typescript
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
```
- [x] `extractToken` checks `req.headers.authorization` for `Bearer ` prefix
- [x] Falls back to `req.headers['x-ax-token']`
- [x] Returns `undefined` when no token found

---

### ST-7: Transform validates output against strict Zod schema
**Result: PASS**

Verified in `src/host/webhook-transform.ts` lines 13-19:
```typescript
const TransformResultSchema = z.strictObject({
  message: z.string().min(1),
  agentId: z.string().optional(),
  sessionKey: z.string().optional(),
  model: z.string().optional(),
  timeoutSec: z.number().int().positive().optional(),
});
```
Error handling at lines 72-83: invalid JSON throws Error with "invalid JSON", missing fields throws Error with field names via Zod issues.
- [x] Schema is `z.strictObject()` (strict mode, no extra keys)
- [x] `message` is required, non-empty string
- [x] `agentId`, `sessionKey`, `model` are optional strings
- [x] `timeoutSec` is optional positive integer
- [x] Error messages are descriptive (include field names)

---

### ST-8: Server wiring -- webhookHandler created only when enabled
**Result: PASS**

Verified in `src/host/server.ts` lines 395-443:
```typescript
const webhookHandler = config.webhooks?.enabled
  ? createWebhookHandler({...})
  : null;
```
Route matching at line 571: `if (webhookHandler && url.startsWith(webhookPrefix))`
- [x] `webhookHandler` is conditionally created based on `config.webhooks?.enabled`
- [x] Null when disabled -- route simply doesn't match
- [x] Both `createWebhookHandler` and `createWebhookTransform` are imported (lines 41-42)

---

### ST-9: Server wiring -- configurable path prefix
**Result: PASS**

Verified in `src/host/server.ts` lines 390-392:
```typescript
const webhookPrefix = config.webhooks?.path
  ? (config.webhooks.path.endsWith('/') ? config.webhooks.path : config.webhooks.path + '/')
  : '/webhooks/';
```
Route matching at line 571: `url.startsWith(webhookPrefix)`
- [x] `webhookPrefix` defaults to `/webhooks/`
- [x] Custom path from config is used with trailing slash normalization
- [x] Route matching uses `startsWith(webhookPrefix)` for correct prefix matching

---

### ST-10: Server wiring -- drain handling rejects webhooks
**Result: PASS**

Verified in `src/host/server.ts` line 511:
```typescript
if (draining && (url === '/v1/chat/completions' || url.startsWith(webhookPrefix))) {
  sendError(res, 503, 'Server is shutting down -- not accepting new requests');
  return;
}
```
- [x] Drain check covers both `/v1/chat/completions` AND webhook prefix
- [x] Returns 503 with appropriate error message
- [x] Check happens before request tracking and handler invocation

---

### ST-11: Server wiring -- dispatch calls processCompletion correctly
**Result: PASS**

Verified in `src/host/server.ts` lines 407-425:
```typescript
dispatch: (result, runId) => {
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
```
- [x] `processCompletion` called with `void` + `.catch()` for fire-and-forget
- [x] userId is `'webhook'` (7th argument)
- [x] Agent config overrides (agentId, model, timeout) are plumbed through
- [x] Error handler logs `webhook_dispatch_failed`

---

### ST-12: Documentation exists with required sections
**Result: PASS**

Verified `docs/webhooks.md` exists (205 lines). Contains:
- Configuration section with YAML examples showing all options (lines 22-43)
- 3 transform file examples: GitHub (lines 62-90), Stripe (lines 102-130), Generic monitoring alert (lines 134-150)
- curl testing examples (lines 154-180)
- Security considerations section (lines 182-193) covering: bearer tokens, rate limiting, timing-safe comparison, taint-tagging, audit logging, path traversal, HMAC roadmap
- Tone matches project voice guidelines (warm, approachable, honest about HMAC gap)

- [x] `docs/webhooks.md` exists and is non-empty
- [x] Has config section with YAML examples showing all options
- [x] Has 3 transform file examples (exceeds minimum of 2)
- [x] Has curl examples for testing
- [x] Has security considerations section covering all required topics
- [x] Tone matches project voice guidelines

---

### BT-1: GitHub push webhook -- LLM transforms payload and dispatches agent run
**Result: PASS**

Response: `{"ok":true,"runId":"webhook-8722d0e4"}`
HTTP status: 202

Audit log evidence:
```
{"action":"webhook.received","sessionId":"webhook","args":{"webhook":"github",...}}
{"action":"webhook.dispatched","sessionId":"webhook-8722d0e4","args":{"webhook":"github",...}}
```

- [x] HTTP response is 202 with valid JSON `{ ok, runId }`
- [x] `runId` matches `webhook-[a-f0-9]{8}` pattern
- [x] Audit log contains `webhook.received` and `webhook.dispatched` entries
- [x] No 500 errors in server logs

---

### BT-2: LLM returns null for ignored event -- 204 no content
**Result: PASS**

Sent `X-GitHub-Event: watch` with `{"action":"starred"}` payload.
HTTP status: 204
Response body: (empty)

- [x] HTTP status code is 204
- [x] Response body is empty
- [x] No `webhook.dispatched` audit entry for this request (only `webhook.received` expected, though audit shows no additional dispatch for watch events)
- [x] No errors in server logs

Note: The LLM correctly interpreted the "Everything else: Return null to ignore" instruction in the GitHub transform file and returned null.

---

### BT-3: Auth rejection -- 401 with wrong token
**Result: PASS**

- Wrong token: HTTP 401
- Missing token: HTTP 401
- Audit log contains `webhook.auth_failed` entries

- [x] Wrong token returns 401
- [x] Missing token returns 401
- [x] Audit log records `webhook.auth_failed`

---

### BT-4: Missing transform file returns 404
**Result: PASS**

Response: `{"error":{"message":"No webhook transform found for \"nonexistent\"","type":"invalid_request_error","code":null}}`
HTTP status: 404

- [x] HTTP status code is 404
- [x] Response body mentions "No webhook transform found"

---

### BT-5: X-AX-Token header accepted as alternative auth
**Result: PASS**

Sent with `X-AX-Token: <token>` header (no Authorization header).
Response: `{"ok":true,"runId":"webhook-bf83ac41"}`
HTTP status: 202

- [x] HTTP status is NOT 401 (auth accepted)
- [x] Response is 202 (dispatched successfully)

---

### IT-1: Full webhook pipeline -- payload to agent run via processCompletion
**Result: PASS**

Sent CI payload: `{"pipeline":"build","status":"failed","branch":"main","commit":"abc123"}`
Response: `{"ok":true,"runId":"webhook-27062ca2"}`

Audit log evidence:
```
{"action":"webhook.received","sessionId":"webhook","args":{"webhook":"ci",...}}
{"action":"webhook.dispatched","sessionId":"webhook-27062ca2","args":{"webhook":"ci",...}}
```

No `webhook_dispatch_failed` errors in server logs (count: 0).

- [x] 202 returned with valid runId
- [x] Audit log has both `webhook.received` and `webhook.dispatched` for the CI webhook
- [x] No dispatch failure errors in server logs
- [x] The LLM was called (implied by successful 202)

---

### IT-2: Allowlist enforcement end-to-end
**Result: PASS**

Server restarted with `allowed_agent_ids: ["main"]`.

Restricted webhook (returns agentId: "unauthorized-agent"):
- HTTP 400: `{"error":{"message":"agentId \"unauthorized-agent\" is not in allowed list",...}}`

Allowed webhook (returns agentId: "main"):
- HTTP 202: `{"ok":true,"runId":"webhook-c26501c2"}`

- [x] `restricted` webhook returns 400 (blocked by allowlist)
- [x] `allowed` webhook returns 202 (allowed through)
- [x] Allowlist applies to the LLM's returned agentId, not a request-level field

---

### IT-3: Rate limiting locks out after repeated auth failures
**Result: PASS**

Sent 20 requests with wrong token: all returned 401.
21st request with wrong token: returned 429.
Valid-token request from same IP: returned 429.
`Retry-After: 60` header present in 429 response.

```
First 20 codes: 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401 401
21st code: 429
Valid token from rate-limited IP: 429
```

- [x] First 20 requests return 401
- [x] 21st request returns 429
- [x] Valid-token request from rate-limited IP also returns 429
- [x] `Retry-After: 60` header present in 429 response

Note: Rate limiter uses `req.socket.remoteAddress` which resolves to `'unknown'` over Unix sockets, so all requests are treated as the same "IP". This is correct behavior for the test scenario.

---

### IT-4: Taint tagging verified via taint budget state
**Result: PASS**

Successful webhook dispatched: `{"ok":true,"runId":"webhook-2b346177"}`
Audit log confirms dispatch.

Structural verification from `src/host/server.ts` lines 430-432:
```typescript
recordTaint: (sessionId, content, isTainted) => {
  taintBudget.recordContent(sessionId, content, isTainted);
},
```

And from `src/host/server-webhooks.ts` lines 224-228:
```typescript
const sessionId = result.sessionKey ?? `webhook:${runId}`;
if (deps.recordTaint) {
  deps.recordTaint(sessionId, JSON.stringify(payload), true);
}
```

- [x] Webhook dispatched successfully (202)
- [x] Server.ts wires `recordTaint` callback to `taintBudget.recordContent`
- [x] The `isTainted` parameter is hardcoded to `true` (all webhook content is external)
- [x] Session ID for taint follows `webhook:<runId>` pattern (or custom `sessionKey`)

## Failures

None. All 21 tests passed.

## Test Environment Notes

- Token with `!` character caused zsh shell escaping issues (`!` expanded to `\!` by zsh history expansion). Tests after BT-1 were affected until the token was changed to one without special shell characters. All affected tests were re-run with a clean token and passed. This is a test harness issue, not a product issue.
- Rate limiter state is per-process (module-level `Map`). Server restarts were required between IT-3 and IT-4 to clear the rate limit lockout.
- Unix socket connections resolve `remoteAddress` to `undefined`/`'unknown'`, so all requests share the same rate limit bucket. This is expected behavior documented in the test plan.
- LLM transform calls use the configured default model (openrouter/google/gemini-3-flash-preview) since no fast model chain was explicitly configured.
