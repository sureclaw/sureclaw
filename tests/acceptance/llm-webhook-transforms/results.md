# Acceptance Test Results: LLM Webhook Transforms

**Date run:** 2026-03-05 14:45
**Server version:** 74b01ed
**LLM provider:** OpenRouter / google/gemini-3-flash-preview
**Environment:** Local (seatbelt sandbox, inprocess eventbus, sqlite storage)
**Test home:** /tmp/ax-acceptance-1772739837

## Summary

| Test | Category | Result | Notes |
|------|----------|--------|-------|
| ST-1 | Structural | PASS | ConfigSchema has `webhooks` with all 6 fields |
| ST-2 | Structural | PASS | Config interface matches Zod schema |
| ST-3 | Structural | PASS | Path helpers exported, use safePath |
| ST-4 | Structural | PASS | timingSafeEqual used for token comparison |
| ST-5 | Structural | PASS | Rate limiter: 20 failures / 60s window |
| ST-6 | Structural | PASS | Both Authorization and X-AX-Token supported |
| ST-7 | Structural | PASS | Transform output validated with z.strictObject |
| ST-8 | Structural | PASS | webhookHandler conditionally created |
| ST-9 | Structural | PASS | Configurable path prefix with trailing slash normalization |
| ST-10 | Structural | PASS | Drain check covers webhook prefix, returns 503 |
| ST-11 | Structural | PASS | processCompletion fire-and-forget with userId 'webhook' |
| ST-12 | Structural | PASS | docs/webhooks.md with config, examples, security section |
| BT-1 | Behavioral | PASS | GitHub push webhook returns 202 with valid runId |
| BT-2 | Behavioral | PASS | LLM returns null → 204 no content |
| BT-3 | Behavioral | PASS | Wrong/missing token → 401 |
| BT-4 | Behavioral | PASS | Missing transform file → 404 |
| BT-5 | Behavioral | PASS | X-AX-Token header accepted (202) |
| IT-1 | Integration | PASS | Full CI webhook pipeline: 202, audit log correct |
| IT-2 | Integration | PASS | Restricted agentId → 400, allowed agentId → 202 |
| IT-3 | Integration | PASS | 20 failures → 429 lockout, Retry-After: 60 |
| IT-4 | Integration | PASS | recordTaint wired, isTainted hardcoded true |

**Overall: 21/21 passed**

## Detailed Results

### ST-1: Config schema includes webhooks section
**Result:** PASS
**Evidence:** `src/config.ts:114-121` — `webhooks: z.strictObject({ enabled: z.boolean(), token: z.string().min(1), path: z.string().optional(), max_body_bytes: z.number().int().positive().optional(), model: z.string().optional(), allowed_agent_ids: z.array(z.string().min(1)).optional() }).optional()`

### ST-2: Config type interface includes webhooks
**Result:** PASS
**Evidence:** `src/types.ts:121-128` — `webhooks?: { enabled: boolean; token: string; path?: string; max_body_bytes?: number; model?: string; allowed_agent_ids?: string[]; }`

### ST-3: Path helpers exported and use safePath
**Result:** PASS
**Evidence:** `src/paths.ts:235-242` — `webhooksDir()` returns `join(axHome(), 'webhooks')`. `webhookTransformPath(name)` calls `safePath(webhooksDir(), ...)` for SC-SEC-004 compliance.

### ST-4: Webhook handler uses timing-safe token comparison
**Result:** PASS
**Evidence:** `src/host/server-webhooks.ts:12` imports `timingSafeEqual` from `node:crypto`. Lines 62-65: `safeEqual` wraps `timingSafeEqual(Buffer.from(a), Buffer.from(b))`. Auth check at line 147 uses `safeEqual()`.

### ST-5: Rate limiter implements fixed-window with correct constants
**Result:** PASS
**Evidence:** `src/host/server-webhooks.ts:24-47` — `RATE_LIMIT_WINDOW_MS = 60_000`, `RATE_LIMIT_MAX_FAILURES = 20`. Window expiry, increment, and reset logic all present.

### ST-6: Webhook handler supports both Authorization and X-AX-Token headers
**Result:** PASS
**Evidence:** `src/host/server-webhooks.ts:51-60` — `extractToken()` checks `Authorization: Bearer` first, falls back to `x-ax-token` header, returns `undefined` if neither present.

### ST-7: Transform validates output against strict Zod schema
**Result:** PASS
**Evidence:** `src/host/webhook-transform.ts:13-19` — `TransformResultSchema = z.strictObject({ message: z.string().min(1), agentId: z.string().optional(), sessionKey: z.string().optional(), model: z.string().optional(), timeoutSec: z.number().int().positive().optional() })`. Invalid JSON and missing message both throw descriptive errors.

### ST-8: Server wiring — webhookHandler created only when enabled
**Result:** PASS
**Evidence:** `src/host/server.ts:395-396` — `config.webhooks?.enabled ? createWebhookHandler(...) : null`. Line 571 checks `webhookHandler` truthy before processing. Both `createWebhookHandler` and `createWebhookTransform` imported.

### ST-9: Server wiring — configurable path prefix
**Result:** PASS
**Evidence:** `src/host/server.ts:390-392` — reads `config.webhooks?.path`, normalizes trailing slash, defaults to `/webhooks/`. Route matching uses `url.startsWith(webhookPrefix)`.

### ST-10: Server wiring — drain handling rejects webhooks
**Result:** PASS
**Evidence:** `src/host/server.ts:511-514` — `if (draining && (url === '/v1/chat/completions' || url.startsWith(webhookPrefix)))` returns 503. Check is before request tracking and webhook handler invocation.

### ST-11: Server wiring — dispatch calls processCompletion correctly
**Result:** PASS
**Evidence:** `src/host/server.ts:407-425` — `void processCompletion(...).catch(err => logger.error('webhook_dispatch_failed', ...))`. userId is `'webhook'` (line 422). Agent config overrides (`agentId` → `agent_name`, `model`, `timeoutSec`) plumbed through `childConfig`. `runId` passed as `requestId`.

### ST-12: Documentation exists with required sections
**Result:** PASS
**Evidence:** `docs/webhooks.md` contains: config section with YAML examples (min and full), 3 transform file examples (GitHub, Stripe, Generic alerts), curl testing examples, comprehensive security considerations section covering bearer tokens, rate limiting, timing-safe comparison, taint-tagging, audit logging, path traversal, and HMAC roadmap note. Tone matches CLAUDE.md voice guidelines.

### BT-1: GitHub push webhook — LLM transforms payload and dispatches agent run
**Result:** PASS
**Evidence:** HTTP response 202 with `{"ok":true,"runId":"webhook-37159106"}`. RunId matches `webhook-[a-f0-9]{8}` pattern. Audit log contains `webhook.received` and `webhook.dispatched` entries.

### BT-2: LLM returns null for ignored event — 204 no content
**Result:** PASS
**Evidence:** Sent `X-GitHub-Event: watch` (starred event, should be ignored per transform). HTTP response was 204 with empty body.

### BT-3: Auth rejection — 401 with wrong token
**Result:** PASS
**Evidence:** Wrong token returned 401. Missing token returned 401. Audit log recorded `webhook.auth_failed` entries.

### BT-4: Missing transform file returns 404
**Result:** PASS
**Evidence:** POST to `/webhooks/nonexistent` with valid auth returned 404 with body `{"error":{"message":"No webhook transform found for \"nonexistent\"","type":"invalid_request_error","code":null}}`.

### BT-5: X-AX-Token header accepted as alternative auth
**Result:** PASS
**Evidence:** POST with `X-AX-Token` header (no Authorization header) returned 202, confirming auth was accepted and transform/dispatch succeeded.

### IT-1: Full webhook pipeline — CI webhook
**Result:** PASS
**Evidence:** POST to `/webhooks/ci` returned 202 with `{"ok":true,"runId":"webhook-881e47ca"}`. Audit log contains `webhook.received` and `webhook.dispatched` for the CI webhook. Zero `webhook_dispatch_failed` errors in server log.

### IT-2: Allowlist enforcement end-to-end
**Result:** PASS
**Evidence:** With `allowed_agent_ids: ["main"]` configured:
- `restricted` webhook (LLM returned agentId "unauthorized-agent"): 400 with `"agentId \"unauthorized-agent\" is not in allowed list"`
- `allowed` webhook (LLM returned agentId "main"): 202 with valid runId

### IT-3: Rate limiting locks out after repeated auth failures
**Result:** PASS
**Evidence:** First 20 requests with wrong token all returned 401. 21st request returned 429. Valid-token request from rate-limited IP also returned 429. `Retry-After: 60` header present in 429 response.

### IT-4: Taint tagging verified via structural + behavioral analysis
**Result:** PASS
**Evidence:** Behavioral: Webhook dispatched successfully (202 with runId `webhook-ac86668f`). Structural: `src/host/server.ts:430-432` wires `recordTaint` callback to `taintBudget.recordContent(sessionId, content, isTainted)`. `src/host/server-webhooks.ts:227` calls `deps.recordTaint(sessionId, JSON.stringify(payload), true)` — `isTainted` is hardcoded to `true`. Session ID follows `webhook:<runId>` pattern (line 225) or uses custom `sessionKey`.

## Failures

None. All 21 tests passed.
