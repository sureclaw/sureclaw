# Chat UI

Journal entries for the chat UI implementation.

## [2026-03-21 16:30] — Add --k8s mode to chat-dev.sh

**Task:** Enable the chat UI dev loop to point at a kind k8s cluster instead of a local AX server
**What I did:**
- Added `--k8s` flag to `scripts/chat-dev.sh` that port-forwards the k8s host service (svc/ax-host) to localhost:18080 instead of starting a local AX server
- K8s mode verifies kind cluster exists and host pod is running before starting
- Tracks port-forward PID for proper cleanup on stop/Ctrl+C
- Updated help text with k8s workflow documentation
- Updated `ax-debug` skill (Tier 0 section) to document k8s mode, architecture diagram, iteration workflow, and when-to-use guidance
**Files touched:** `scripts/chat-dev.sh`, `.claude/skills/ax-debug/skill.md`
**Outcome:** Success — `npm run dev:chat start --k8s` now gives Vite HMR + k8s backend in one command
**Notes:** Port 18080 chosen to avoid conflict with the default local AX server port (8080). Use `npm run k8s:dev debug host` in a separate terminal to attach the Node.js debugger (port 9229).

## [2026-03-21 14:30] — Fix four chat UI bugs against kind k8s cluster

**Task:** Fix tool call visibility, thread switching, thread titles, and loading spinner
**What I did:**
1. **Transport (ax-chat-transport.ts):** Added `tool-input-available` UIMessageChunk emission for `delta.tool_calls` in OpenAI SSE stream; added `tool-calls` finish reason mapping
2. **Thread component (thread.tsx):** Added `ToolCallFallback` component rendered via `tools.Fallback` in `MessagePrimitive.Parts`; added `AuiIf`-based loading spinner on last assistant message while running
3. **History adapter (history-adapter.ts):** Implemented `withFormat()` method — `useExternalHistory` uses this instead of direct `load()`. Without it, history silently never loaded
4. **Runtime hook (useAxChatRuntime.tsx):** Simplified by passing history adapter directly to `useAISDKRuntime` instead of using `RuntimeAdapterProvider` context (which didn't propagate correctly). Removed `AxHistoryProvider` wrapper
5. **Thread list adapter (thread-list-adapter.ts):** Fixed `generateTitle()` to poll server for real title with suffix-matching (server prefixes session IDs with `main:http:chat-ui:`)
**Files touched:** `ui/chat/src/lib/ax-chat-transport.ts`, `ui/chat/src/components/thread.tsx`, `ui/chat/src/lib/history-adapter.ts`, `ui/chat/src/lib/useAxChatRuntime.tsx`, `ui/chat/src/lib/thread-list-adapter.ts`
**Outcome:** All four issues fixed and verified via Playwright MCP against kind cluster
**Notes:** Key insight: `useExternalHistory` calls `historyAdapter.withFormat?.(adapter).load()` not `historyAdapter.load()`. The optional chaining silently returns undefined when `withFormat` is missing, making history appear to work but never actually loading.

## [2026-03-21 12:40] — Credential modal for SSE credential_required events

**Task:** Implement a modal in the chat UI that appears when the server emits a `credential_required` SSE event, allowing users to enter missing credentials.
**What I did:**
- Modified `ax-chat-transport.ts` to detect named SSE events (`event: credential_required` + `data:` lines) and invoke a callback
- Created `credential-modal.tsx` — glassmorphism modal with password input, eye toggle, Cancel/Provide buttons
- Updated `useAxChatRuntime.tsx` to accept and forward `onCredentialRequired` callback via a ref
- Updated `App.tsx` to wire credential state from transport → modal → auto-send "continue" message via `aui.composer()`
- Modal POSTs to `/v1/credentials/provide` with envName, value, sessionId
- On submit, auto-sends "Credentials provided, please continue." via the thread composer
**Files touched:** `ui/chat/src/lib/ax-chat-transport.ts`, `ui/chat/src/lib/useAxChatRuntime.tsx`, `ui/chat/src/App.tsx`, `ui/chat/src/components/credential-modal.tsx` (new)
**Outcome:** Success — visually verified with Playwright MCP (Tier 0 dev loop)
**Notes:** Pre-existing TextDecoderStream TS error in chat UI unrelated to these changes. Backdrop click and Escape key both dismiss the modal.
