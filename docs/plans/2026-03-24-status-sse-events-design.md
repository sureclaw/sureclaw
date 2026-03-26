# Status SSE Events Design

**Date:** 2026-03-24
**Status:** Approved

## Problem

Long-running operations during session startup (pod provisioning, workspace restoration from GCS) produce no visible feedback to the frontend. Users see dead air for 5-30 seconds with no indication of what's happening.

## Design

### Event Shape

A single generic `status` SSE named event:

```typescript
interface StatusEvent {
  operation: string   // e.g. 'pod', 'workspace'
  phase: string       // e.g. 'creating', 'waiting', 'ready'
  message: string     // human-readable display text
}
```

- **Backend owns the message text** — frontend displays it as-is with no domain knowledge.
- **Implicit clearing** — each status replaces the previous; status disappears when the first LLM content chunk arrives. No explicit "done" phase needed.

### Backend Changes

**File: `src/host/server-completions.ts`**

Emit `status` events via `eventBus.emit()` at existing orchestration points. No new IPC actions, no provider changes.

**Pod provisioning** (around `sandbox.create()` call):

```
{ operation: 'pod', phase: 'creating', message: 'Starting sandbox…' }
{ operation: 'pod', phase: 'waiting', message: 'Waiting for available pod…' }
{ operation: 'pod', phase: 'ready', message: 'Sandbox ready' }
```

**Workspace provisioning** (around workspace pre-mount / provision calls):

```
{ operation: 'workspace', phase: 'downloading', message: 'Restoring workspace…' }
{ operation: 'workspace', phase: 'mounted', message: 'Workspace ready' }
```

Delivered via existing `sendSSENamedEvent()` helper (same mechanism as `credential_required`).

### Frontend Changes

**File: `ui/chat/src/lib/ax-chat-transport.ts`**

Add `status` case to existing named-event handler:

```typescript
case 'status':
  this.onStatus?.(JSON.parse(data))
  break
```

**File: `ui/chat/src/lib/useAxChatRuntime.tsx`**

Expose as reactive state:

```typescript
const [statusMessage, setStatusMessage] = useState<string | null>(null)

// Transport callback:
transport.onStatus = ({ message }) => setStatusMessage(message)

// Clear on first content chunk:
setStatusMessage(null)
```

**UI:** Render `statusMessage` as simple text when non-null. No spinners, no progress bars.

### Scope

Only two operations to start:

| Operation | Where it's slow | Typical duration |
|-----------|----------------|-----------------|
| Pod provisioning | `k8s.ts` polls up to 60s | 5-30s |
| GCS workspace provisioning | `workspace.ts` downloads 3 scopes | 5-10s each |

Other operations (skill refresh, memory recall, history summarization) are typically fast and excluded for now. New operations can be added later by emitting more `status` events from the host — no frontend changes needed.

### Files to Modify

- `src/host/server-completions.ts` — emit status events (~6 lines)
- `src/host/server-request-handlers.ts` — forward status named events to SSE (if not already covered)
- `ui/chat/src/lib/ax-chat-transport.ts` — handle status named event (~3 lines)
- `ui/chat/src/lib/useAxChatRuntime.tsx` — expose statusMessage state (~10 lines)
- UI component — render status text (~5 lines)
