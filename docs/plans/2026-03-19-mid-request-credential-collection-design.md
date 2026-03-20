# Mid-Request Credential Collection — Design

## Problem

When a user asks the agent to install a skill that requires credentials (e.g., LINEAR_API_KEY), the agent tells the user to provide the key manually. The host's credential scan runs at the start of `processCompletion()` — before the agent installs the skill — so it finds no credential requirements. There is no mechanism for the agent to trigger credential collection mid-request.

## Goal

Allow the agent to signal that newly-installed skills need credentials. The host collects them via SSE → frontend modal → user input, then re-spawns the agent with the credentials available. All within a single API request. Works across multiple stateless host replicas without session affinity.

## Architecture

### Credential Resolution via Event Bus

Replace the in-memory promise map in `credential-prompts.ts` with event bus coordination. The event bus provider abstracts transport: in-process for local/Docker (single host), NATS for k8s (multiple replicas).

**Flow:**

1. `processCompletion()` on replica A: emits `credential.required` SSE event, then subscribes to eventBus for `credential.resolved` events on this requestId, blocks via Promise.
2. `POST /v1/credentials/provide` on any replica: stores credential in DB, emits `credential.resolved` event via eventBus with the requestId.
3. NATS mode: event published to `events.{requestId}` → replica A's `subscribeRequest` listener receives it → promise resolves.
4. In-process mode: same flow, same process.

The `POST /v1/credentials/provide` endpoint gains a `requestId` parameter. The frontend already has it — it's a top-level field on every SSE event including `credential.required`.

### The `credential_request` IPC Action

Lightweight signal from agent to host. The agent calls it after installing a skill that needs credentials.

**IPC handler:** Records `{ envName }` in a session-scoped `Map<sessionId, Set<envName>>` (shared via `IPCHandlerOptions`, same pattern as `workspaceMap`). Returns `{ ok: true }`.

### Post-Agent Credential Loop in processCompletion

After the agent exits and `workspace.commit()` runs (skill files are now on host), new logic:

1. Check if `credential_request` was called during this turn.
2. If yes:
   a. Re-scan skills from the now-committed workspace via `collectSkillCredentialRequirements()`.
   b. For each missing credential: emit `credential.required` SSE, subscribe to eventBus for `credential.resolved`, block until resolved or timeout.
   c. Store credentials, register in MITM credentialMap.
   d. Re-spawn the agent with updated env vars + system message: "Credentials collected: LINEAR_API_KEY is now available."
   e. Agent responds confirming setup.
3. If no: proceed as normal.

### Changes to Existing Credential Endpoints

**`POST /v1/credentials/provide`** (server.ts, server-admin.ts):
- Accept `{ sessionId, envName, value, requestId }` — requestId is new (required).
- Store credential via `providers.credentials.set()`.
- Emit `credential.resolved` event via eventBus.
- No longer calls `resolveCredential()`.

**`GET /v1/oauth/callback/:provider`** (oauth-skills.ts):
- After token exchange, emit `credential.resolved` via eventBus instead of calling `resolveCredential()`.
- The `requestId` is available from the `pendingFlows` map.

### credential-prompts.ts Rewrite

**`requestCredential(sessionId, envName, eventBus, requestId, timeoutMs)`:**
- Subscribe to eventBus for this requestId.
- Return Promise that resolves when `credential.resolved` event with matching envName arrives, or null on timeout.
- Unsubscribe on resolve/timeout.

**`resolveCredential()`** — removed. Resolution happens via eventBus emit.

**`cleanupSession()`** — removed. No in-memory state to clean up; eventBus subscriptions self-cleanup.

### Agent-Side Changes

**Tool catalog:** Skill tool gains `request_credential` action type mapping to `credential_request` IPC action.

**Prompt module:** Guidance telling the agent to call `request_credential` after installing skills with credential requirements.

## File Changes

| File | Change |
|------|--------|
| `src/ipc-schemas.ts` | Add `CredentialRequestSchema` |
| `src/host/credential-prompts.ts` | Rewrite to use eventBus; remove `resolveCredential()`, `cleanupSession()` |
| `src/host/ipc-handlers/skills.ts` | Add `credential_request` handler |
| `src/host/ipc-server.ts` | Add `requestedCredentials` map + eventBus to opts; pass to skills handler |
| `src/host/server-completions.ts` | Post-agent credential loop; pass `requestedCredentials` + eventBus |
| `src/host/server.ts` | Create `requestedCredentials` map; update provide endpoint to use eventBus |
| `src/host/server-admin.ts` | Same provide endpoint change |
| `src/host/oauth-skills.ts` | Use eventBus instead of `resolveCredential()` |
| `src/host/host-process.ts` | Create `requestedCredentials` map, pass through |
| `src/agent/tool-catalog.ts` | Add `request_credential` to skill tool |
| `src/agent/prompt/modules/skills.ts` | Add credential request guidance |

## Follow-Up

`web-proxy-approvals.ts` has the same in-memory promise pattern. Should be migrated to eventBus coordination in a separate task.
