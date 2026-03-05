# Fix List: LLM Webhook Transforms (K8s)

**Generated from:** acceptance test results (2026-03-05)
**Total issues:** 1 (Critical: 1, Major: 0, Minor: 0)

## Critical

### FIX-1: Port webhook handler to host-process.ts

**Test:** BT-1 through BT-5, IT-1 through IT-4 (all 9 behavioral/integration tests)
**Environment:** K8s only (local passes all tests)
**Root cause:** Missing — webhook routes not implemented in k8s host process
**Location:** `src/host/host-process.ts:60-114`
**What's wrong:** The k8s host entry point (`host-process.ts`) handles only `/health`, `/v1/models`, `/v1/chat/completions`, and `/v1/events`. All webhook routes (`/webhooks/*`) return generic 404. The webhook implementation exists only in `server.ts` (local all-in-one).
**What to fix:**
1. Import `createWebhookHandler` from `./server-webhooks.js` and `createWebhookTransform` from `./webhook-transform.js` into `host-process.ts`
2. Add webhook handler initialization (conditional on `config.webhooks?.enabled`) — same pattern as `server.ts:394-435`
3. Add webhook route matching in `handleRequest()` — check `url.startsWith(webhookPrefix)` before the 404 fallback
4. Wire the `dispatch` callback to publish a session request to NATS (instead of calling `processCompletion` directly, since `host-process.ts` uses NATS dispatch)
5. Wire `recordTaint` to the taint budget (or publish a taint event to NATS)
6. Wire `auditLog` to the audit provider
7. Add drain check for webhook prefix (currently only checks `/v1/chat/completions`)
8. Fix the misleading comment on line 3 (says "webhooks" but doesn't implement them)

**Key difference from server.ts:** In `host-process.ts`, the dispatch callback must publish to NATS instead of calling `processCompletion()` directly. The webhook handler itself is environment-agnostic (auth, rate limiting, transform, validation), but the final dispatch step differs.

**Estimated scope:** 1 file to modify (`src/host/host-process.ts`), possibly extract shared webhook wiring into a helper to avoid duplicating the setup logic between `server.ts` and `host-process.ts`.

## Suggested Fix Order

1. FIX-1 — Only issue. Blocks all webhook functionality in k8s deployments.
