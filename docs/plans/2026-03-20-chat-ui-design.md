# Chat UI Design

**Date:** 2026-03-20
**Status:** Approved

## Overview

Add a chat interface at the root `/` path of the AX web interface using assistant-ui. The admin dashboard remains at `/admin`. Sessions from the AX database populate the thread list, and conversation history populates each thread. Styling matches the existing admin dashboard.

## Project Structure

```
ui/
├── chat/                    # New chat UI (Vite + React)
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx          # Runtime provider + layout
│   │   ├── index.css        # Shared design tokens from dashboard
│   │   ├── lib/
│   │   │   ├── thread-list-adapter.ts   # Calls /v1/chat/sessions
│   │   │   └── history-adapter.ts       # Calls /v1/chat/sessions/:id/history
│   │   └── components/
│   │       ├── thread.tsx               # assistant-ui Thread customized
│   │       ├── thread-list.tsx          # Sidebar with session list
│   │       └── markdown-text.tsx        # Message rendering
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts       # Outputs to ../../dist/chat-ui/
│   └── tailwind.config.js
├── dashboard/               # Existing admin UI (moved from dashboard/)
│   └── ...                  # Unchanged, outputs to ../../dist/admin-ui/
```

- `npm run build:chat` added to root package.json
- Server serves `dist/chat-ui/` at `/` and `dist/admin-ui/` at `/admin`
- Existing `dashboard/` directory moves to `ui/dashboard/`

## Backend — New API Endpoints

All under `/v1/chat/`, no authentication (reverse proxy handles it).

### `GET /v1/chat/sessions`

List sessions ordered by `updated_at` descending.

**Response:**
```json
{
  "sessions": [
    { "id": "main:http:user:conv1", "title": "Debug k8s pod", "updated_at": 1710900000 }
  ]
}
```

- Queries `last_sessions` table
- Optional `?status=active|archived` filter

### `GET /v1/chat/sessions/:id/history`

Get conversation history for a session.

**Response:**
```json
{
  "messages": [
    { "role": "user", "content": "Hello", "created_at": 1710900000 },
    { "role": "assistant", "content": "Hi there!", "created_at": 1710900001 }
  ]
}
```

- Calls `conversationStore.load(sessionId)`
- Maps stored turns to assistant-ui message format

### `POST /v1/chat/sessions`

Create a new session.

**Request:**
```json
{ "id": "optional-client-id", "title": "optional title" }
```

- Client can supply ID for optimistic updates
- Inserts into `last_sessions` table

### Auto-generated Session Titles

During `processCompletion`, when the server detects a session's first turn (no existing title), it automatically generates a 3-5 word title using the fast LLM (e.g. Haiku). The title is saved to the session record.

- Works for all channels (web, Slack, CLI), not just the chat UI
- Prompt: "Summarize this user message as a 3-5 word conversation title. Reply with only the title."
- Non-blocking: title generation happens asynchronously, doesn't delay the response

## Frontend — Runtime & Adapters

### Runtime

```tsx
const runtime = useChatRuntime({
  transport: new AssistantChatTransport({
    api: "/v1/chat/completions"
  }),
});
```

Combined with `unstable_useRemoteThreadListRuntime` for thread list management.

### Thread List Adapter

- `list()` → `GET /v1/chat/sessions` → maps to `{ threadId, title, updatedAt }`
- `create()` → `POST /v1/chat/sessions` → returns new thread ID

### History Adapter

- `load(threadId)` → `GET /v1/chat/sessions/:id/history` → maps turns to `ThreadMessage[]`
- `append()` — no-op, AX server persists turns during chat completions

## UI Layout

```
┌──────────────┬─────────────────────────────────┐
│  Thread List  │                                 │
│  Sidebar      │         Chat Thread             │
│  (220px)      │                                 │
│               │   Messages with markdown        │
│  [+ New Chat] │                                 │
│               │                                 │
│  Session 1    │                                 │
│  Session 2    │   ┌───────────────────────┐     │
│  Session 3    │   │ Composer input        │     │
│  ...          │   └───────────────────────┘     │
└──────────────┴─────────────────────────────────┘
```

## Styling

Shared design tokens from the admin dashboard:

- **Background:** `#09090b` / `#111113` (dark theme)
- **Accent:** amber `#f59e0b` for active states and buttons
- **Fonts:** Outfit (display) + IBM Plex Mono (code blocks)
- **Cards/sidebar:** glassmorphic with `backdrop-blur`, subtle borders
- **Messages:** user right-aligned with subtle bg, assistant left-aligned
- **Markdown:** `@assistant-ui/react-markdown` with code highlighting

## Scope

### Included
- List sessions in thread list sidebar
- Create new threads
- Chat with streaming responses
- Session titles auto-generated from first message
- Markdown rendering in messages

### Not included (future)
- Rename/archive/delete sessions
- Authentication (reverse proxy handles it)
- Tool call UI
- File attachments
- Voice input

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | Vite (not Next.js) | AX serves static files; no SSR needed |
| Runtime | `useChatRuntime` + `AssistantChatTransport` | AX has OpenAI-compatible API |
| Thread list | `unstable_useRemoteThreadListRuntime` | HTTP adapters to AX endpoints |
| Project structure | Separate `ui/chat/` app | Different deps/audience from admin |
| UI directory | `ui/` parent for chat + dashboard | Organized together |
| API namespace | `/v1/chat/` | Consistent with existing completions endpoint |
| Thread management | Minimal (list + create) | Iterate later |
| Title generation | Server-side automatic | Works for all channels |
| Auth | Skipped | Reverse proxy handles it |
