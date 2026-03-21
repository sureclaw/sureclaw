# Chat UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a chat interface at `/` using assistant-ui, backed by AX sessions and conversation history.

**Architecture:** Separate Vite+React app (`ui/chat/`) serving at `/`. Uses `useChatRuntime` + `unstable_useRemoteThreadListRuntime` with custom HTTP adapters hitting new `/v1/chat/sessions` endpoints. AX server owns all persistence — the chat UI is a thin client. Auto-generates session titles via fast LLM on first message.

**Tech Stack:** React 19, Vite 6, Tailwind CSS 4, assistant-ui, @assistant-ui/react-ai-sdk, @assistant-ui/react-markdown, Lucide icons

**Design doc:** `docs/plans/2026-03-20-chat-ui-design.md`

---

### Task 1: Move `dashboard/` to `ui/dashboard/`

**Files:**
- Move: `dashboard/` → `ui/dashboard/`
- Modify: `ui/dashboard/vite.config.ts` (update outDir path)
- Modify: `package.json` (update build:dashboard script)

**Step 1: Create ui/ directory and move dashboard**

```bash
mkdir -p ui
git mv dashboard ui/dashboard
```

**Step 2: Update vite.config.ts outDir**

In `ui/dashboard/vite.config.ts`, change:
```typescript
// OLD
outDir: '../dist/admin-ui',
// NEW
outDir: '../../dist/admin-ui',
```

Also update the proxy target path (no change needed — it's absolute).

**Step 3: Update root package.json build:dashboard script**

```json
"build:dashboard": "cd ui/dashboard && npm install && npm run build"
```

**Step 4: Verify build still works**

```bash
cd ui/dashboard && npm install && npm run build
```

Expected: Build succeeds, output in `dist/admin-ui/`.

**Step 5: Verify server still serves admin UI**

No change needed in `server-admin.ts` — `resolveAdminUIDir()` resolves relative to the compiled output (`dist/admin-ui/`), not the source location.

**Step 6: Run tests**

```bash
npm test
```

Expected: All tests pass (no runtime behavior changed).

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move dashboard/ to ui/dashboard/"
```

---

### Task 2: Add `chat_sessions` table migration + storage methods

The existing `last_sessions` table stores one row per agent (last channel session). We need a separate `chat_sessions` table that can hold many sessions with titles.

**Files:**
- Modify: `src/providers/storage/migrations.ts`
- Modify: `src/providers/storage/types.ts`
- Modify: `src/providers/storage/database.ts`
- Create: `tests/providers/storage/chat-sessions.test.ts`

**Step 1: Write the failing test**

Create `tests/providers/storage/chat-sessions.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseStorage } from '../../../src/providers/storage/database.js';
import { createDatabaseProvider } from '../../../src/providers/database/sqlite.js';
import type { StorageProvider } from '../../../src/providers/storage/types.js';

describe('ChatSessionStore', () => {
  let storage: StorageProvider;

  beforeEach(async () => {
    const dbProvider = createDatabaseProvider({ type: 'sqlite', url: ':memory:' });
    storage = await createDatabaseStorage(dbProvider);
  });

  afterEach(() => {
    storage.close();
  });

  it('lists sessions ordered by updated_at desc', async () => {
    await storage.chatSessions.create({ id: 'sess-1' });
    await storage.chatSessions.create({ id: 'sess-2', title: 'Hello World' });

    const sessions = await storage.chatSessions.list();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe('sess-2'); // most recent
    expect(sessions[0].title).toBe('Hello World');
    expect(sessions[1].id).toBe('sess-1');
    expect(sessions[1].title).toBeNull();
  });

  it('creates a session with optional client-supplied id', async () => {
    const session = await storage.chatSessions.create({ id: 'my-custom-id', title: 'Test' });
    expect(session.id).toBe('my-custom-id');
    expect(session.title).toBe('Test');
  });

  it('creates a session with auto-generated id', async () => {
    const session = await storage.chatSessions.create({});
    expect(session.id).toBeTruthy();
  });

  it('updates session title', async () => {
    await storage.chatSessions.create({ id: 'sess-1' });
    await storage.chatSessions.updateTitle('sess-1', 'New Title');
    const sessions = await storage.chatSessions.list();
    expect(sessions[0].title).toBe('New Title');
  });

  it('ensures session exists (upsert)', async () => {
    // First call creates
    await storage.chatSessions.ensureExists('sess-1');
    let sessions = await storage.chatSessions.list();
    expect(sessions).toHaveLength(1);

    // Second call is idempotent
    await storage.chatSessions.ensureExists('sess-1');
    sessions = await storage.chatSessions.list();
    expect(sessions).toHaveLength(1);
  });

  it('touches updated_at on ensureExists', async () => {
    await storage.chatSessions.create({ id: 'sess-1' });
    const before = (await storage.chatSessions.list())[0].updated_at;

    // Small delay to ensure timestamp differs
    await new Promise(r => setTimeout(r, 10));
    await storage.chatSessions.ensureExists('sess-1');
    const after = (await storage.chatSessions.list())[0].updated_at;

    expect(after).toBeGreaterThanOrEqual(before);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/providers/storage/chat-sessions.test.ts
```

Expected: FAIL — `storage.chatSessions` does not exist.

**Step 3: Add migration for `chat_sessions` table**

In `src/providers/storage/migrations.ts`, add after `storage_004_documents`:

```typescript
storage_005_chat_sessions: {
  async up(db: Kysely<any>) {
    await db.schema
      .createTable('chat_sessions')
      .ifNotExists()
      .addColumn('id', 'text', col => col.primaryKey())
      .addColumn('title', 'text')
      .addColumn('status', 'text', col => col.notNull().defaultTo('active'))
      .addColumn('created_at', isSqlite ? 'integer' : 'bigint', col =>
        col.notNull().defaultTo(isSqlite ? sql`(unixepoch())` : sql`EXTRACT(EPOCH FROM NOW())::BIGINT`))
      .addColumn('updated_at', isSqlite ? 'integer' : 'bigint', col =>
        col.notNull().defaultTo(isSqlite ? sql`(unixepoch())` : sql`EXTRACT(EPOCH FROM NOW())::BIGINT`))
      .execute();

    await db.schema
      .createIndex('idx_chat_sessions_updated')
      .ifNotExists()
      .on('chat_sessions')
      .column('updated_at')
      .execute();
  },
  async down(db: Kysely<any>) {
    await db.schema.dropTable('chat_sessions').ifExists().execute();
  },
},
```

**Step 4: Add ChatSessionStore interface to types.ts**

In `src/providers/storage/types.ts`, add:

```typescript
// ═══════════════════════════════════════════════════════
// Chat Session Store
// ═══════════════════════════════════════════════════════

export interface ChatSession {
  id: string;
  title: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface ChatSessionStore {
  list(): Promise<ChatSession[]>;
  create(opts: { id?: string; title?: string }): Promise<ChatSession>;
  updateTitle(id: string, title: string): Promise<void>;
  ensureExists(id: string): Promise<void>;
}
```

Add `chatSessions` to the `StorageProvider` interface:

```typescript
/** Chat session metadata store (list/create/updateTitle). */
readonly chatSessions: ChatSessionStore;
```

**Step 5: Implement createChatSessionStore in database.ts**

In `src/providers/storage/database.ts`, add:

```typescript
function createChatSessionStore(db: Kysely<any>): ChatSessionStore {
  return {
    async list() {
      const rows = await db.selectFrom('chat_sessions')
        .selectAll()
        .where('status', '=', 'active')
        .orderBy('updated_at', 'desc')
        .execute();
      return rows as ChatSession[];
    },

    async create(opts) {
      const id = opts.id ?? randomUUID();
      const now = Math.floor(Date.now() / 1000);
      await db.insertInto('chat_sessions')
        .values({
          id,
          title: opts.title ?? null,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
      return { id, title: opts.title ?? null, status: 'active', created_at: now, updated_at: now };
    },

    async updateTitle(id, title) {
      const now = Math.floor(Date.now() / 1000);
      await db.updateTable('chat_sessions')
        .set({ title, updated_at: now })
        .where('id', '=', id)
        .execute();
    },

    async ensureExists(id) {
      const now = Math.floor(Date.now() / 1000);
      const existing = await db.selectFrom('chat_sessions')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing) {
        await db.updateTable('chat_sessions')
          .set({ updated_at: now })
          .where('id', '=', id)
          .execute();
      } else {
        await db.insertInto('chat_sessions')
          .values({ id, status: 'active', created_at: now, updated_at: now })
          .execute();
      }
    },
  };
}
```

Wire it into `createDatabaseStorage`:

```typescript
chatSessions: createChatSessionStore(db),
```

**Step 6: Run tests**

```bash
npx vitest run tests/providers/storage/chat-sessions.test.ts
```

Expected: All tests pass.

**Step 7: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

**Step 8: Commit**

```bash
git add src/providers/storage/migrations.ts src/providers/storage/types.ts src/providers/storage/database.ts tests/providers/storage/chat-sessions.test.ts
git commit -m "feat: add chat_sessions table for chat UI thread management"
```

---

### Task 3: Add `/v1/chat/sessions` API endpoints

**Files:**
- Create: `src/host/server-chat-api.ts`
- Modify: `src/host/server-request-handlers.ts` (add routes)
- Create: `tests/host/server-chat-api.test.ts`

**Step 1: Write the failing test**

Create `tests/host/server-chat-api.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createDatabaseProvider } from '../../src/providers/database/sqlite.js';
import { createDatabaseStorage } from '../../src/providers/storage/database.js';
import type { StorageProvider } from '../../src/providers/storage/types.js';
import { createChatApiHandler } from '../../src/host/server-chat-api.js';

function request(server: http.Server, method: string, path: string, body?: any): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, `http://localhost:${(server.address() as any).port}`);
    const req = http.request(url, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, data: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('Chat API', () => {
  let storage: StorageProvider;
  let server: http.Server;

  beforeEach(async () => {
    const dbProvider = createDatabaseProvider({ type: 'sqlite', url: ':memory:' });
    storage = await createDatabaseStorage(dbProvider);
    const handler = createChatApiHandler(storage);
    server = http.createServer(handler);
    await new Promise<void>(resolve => server.listen(0, resolve));
  });

  afterEach(async () => {
    storage.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('GET /v1/chat/sessions returns empty list initially', async () => {
    const { status, data } = await request(server, 'GET', '/v1/chat/sessions');
    expect(status).toBe(200);
    expect(data.sessions).toEqual([]);
  });

  it('POST /v1/chat/sessions creates a session', async () => {
    const { status, data } = await request(server, 'POST', '/v1/chat/sessions', { title: 'Test' });
    expect(status).toBe(201);
    expect(data.id).toBeTruthy();
    expect(data.title).toBe('Test');
  });

  it('GET /v1/chat/sessions/:id/history returns turns', async () => {
    const sessionId = 'test-session';
    await storage.chatSessions.create({ id: sessionId });
    await storage.conversations.append(sessionId, 'user', 'Hello');
    await storage.conversations.append(sessionId, 'assistant', 'Hi there!');

    const { status, data } = await request(server, 'GET', `/v1/chat/sessions/${sessionId}/history`);
    expect(status).toBe(200);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0].role).toBe('user');
    expect(data.messages[0].content).toBe('Hello');
    expect(data.messages[1].role).toBe('assistant');
  });

  it('GET /v1/chat/sessions/:id/history returns empty for unknown session', async () => {
    const { status, data } = await request(server, 'GET', '/v1/chat/sessions/nonexistent/history');
    expect(status).toBe(200);
    expect(data.messages).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/host/server-chat-api.test.ts
```

Expected: FAIL — `createChatApiHandler` does not exist.

**Step 3: Implement server-chat-api.ts**

Create `src/host/server-chat-api.ts`:

```typescript
/**
 * Chat API handler — serves /v1/chat/sessions endpoints
 * for the chat UI thread list and history.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, readBody } from './server-http.js';
import type { StorageProvider } from '../providers/storage/types.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'chat-api' });

function sendJSON(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

export function createChatApiHandler(storage: StorageProvider) {
  return async (req: IncomingMessage, res: ServerResponse, url?: string): Promise<boolean> => {
    const pathname = url ?? req.url?.split('?')[0] ?? '';

    // GET /v1/chat/sessions — list sessions
    if (pathname === '/v1/chat/sessions' && req.method === 'GET') {
      try {
        const sessions = await storage.chatSessions.list();
        sendJSON(res, { sessions });
      } catch (err) {
        logger.error('list_sessions_failed', { error: (err as Error).message });
        sendError(res, 500, 'Failed to list sessions');
      }
      return true;
    }

    // POST /v1/chat/sessions — create session
    if (pathname === '/v1/chat/sessions' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { id, title } = body ? JSON.parse(body) : {};
        const session = await storage.chatSessions.create({ id, title });
        sendJSON(res, session, 201);
      } catch (err) {
        logger.error('create_session_failed', { error: (err as Error).message });
        sendError(res, 400, `Failed to create session: ${(err as Error).message}`);
      }
      return true;
    }

    // GET /v1/chat/sessions/:id/history — get conversation history
    const historyMatch = pathname.match(/^\/v1\/chat\/sessions\/([^/]+)\/history$/);
    if (historyMatch && req.method === 'GET') {
      try {
        const sessionId = decodeURIComponent(historyMatch[1]);
        const turns = await storage.conversations.load(sessionId);
        const messages = turns.map(t => ({
          role: t.role,
          content: t.content,
          created_at: t.created_at,
        }));
        sendJSON(res, { messages });
      } catch (err) {
        logger.error('get_history_failed', { error: (err as Error).message });
        sendError(res, 500, 'Failed to get history');
      }
      return true;
    }

    return false; // Not handled
  };
}
```

**Step 4: Wire into request handlers**

In `src/host/server-request-handlers.ts`, add the chat API handler. In the `createRequestHandler` function, add a new route block **before** the root redirect (around line 607):

Import at top:
```typescript
import { createChatApiHandler } from './server-chat-api.js';
```

In the `createRequestHandler` options interface, the handler needs access to `providers` (which it already has). Add the route:

```typescript
// Chat API
if (url.startsWith('/v1/chat/sessions')) {
  const chatHandler = createChatApiHandler(/* storage from providers */);
  const handled = await chatHandler(req, res, url);
  if (handled) return;
}
```

Note: The exact wiring depends on how `providers` is passed through the request handler factory. The chat handler should be created once (not per-request) in the factory.

**Step 5: Run tests**

```bash
npx vitest run tests/host/server-chat-api.test.ts
```

Expected: All tests pass.

**Step 6: Run full test suite**

```bash
npm test
```

Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/host/server-chat-api.ts src/host/server-request-handlers.ts tests/host/server-chat-api.test.ts
git commit -m "feat: add /v1/chat/sessions API endpoints for chat UI"
```

---

### Task 4: Auto-generate session titles on first message

**Files:**
- Modify: `src/host/server-completions.ts`
- Create: `tests/host/session-title-generation.test.ts`

**Step 1: Write the failing test**

Create `tests/host/session-title-generation.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { generateSessionTitle } from '../../src/host/session-title.js';

describe('generateSessionTitle', () => {
  it('generates a short title from user message', async () => {
    const mockLLM = {
      complete: vi.fn().mockResolvedValue('Debug K8s pod crash'),
    };
    const title = await generateSessionTitle('My kubernetes pod keeps crashing with OOMKilled error, how do I fix it?', mockLLM as any);
    expect(title).toBe('Debug K8s pod crash');
    expect(mockLLM.complete).toHaveBeenCalledOnce();
  });

  it('truncates fallback when LLM fails', async () => {
    const mockLLM = {
      complete: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    };
    const longMessage = 'This is a very long message that should be truncated to create a reasonable title for display';
    const title = await generateSessionTitle(longMessage, mockLLM as any);
    expect(title.length).toBeLessThanOrEqual(50);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/host/session-title-generation.test.ts
```

Expected: FAIL — module not found.

**Step 3: Create session-title.ts**

Create `src/host/session-title.ts`:

```typescript
/**
 * Auto-generate session titles from the first user message
 * using the fast LLM model.
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'session-title' });

export interface TitleLLM {
  complete(prompt: string): Promise<string>;
}

/**
 * Generate a short (3-5 word) title for a chat session from the first user message.
 * Falls back to truncating the message if the LLM call fails.
 */
export async function generateSessionTitle(userMessage: string, llm: TitleLLM): Promise<string> {
  try {
    const prompt = `Summarize this user message as a 3-5 word conversation title. Reply with only the title, no quotes or punctuation at the end.\n\nUser message: ${userMessage}`;
    const title = await llm.complete(prompt);
    // Clean up: remove quotes, trim, limit length
    const cleaned = title.replace(/^["']|["']$/g, '').trim();
    return cleaned.length > 50 ? cleaned.substring(0, 47) + '...' : cleaned;
  } catch (err) {
    logger.warn('title_generation_failed', { error: (err as Error).message });
    // Fallback: truncate the user message
    const text = userMessage.trim();
    return text.length <= 50 ? text : text.substring(0, 47) + '...';
  }
}
```

**Step 4: Run test**

```bash
npx vitest run tests/host/session-title-generation.test.ts
```

Expected: All pass.

**Step 5: Wire into processCompletion**

In `src/host/server-completions.ts`, after the conversation turns are persisted (around line 1391, after the `history_save_failed` catch block), add:

```typescript
// Auto-generate session title for new sessions (first turn)
if (persistentSessionId && maxTurns > 0) {
  try {
    const chatSessions = deps.providers.storage?.chatSessions;
    if (chatSessions) {
      // Ensure session exists in chat_sessions table
      await chatSessions.ensureExists(persistentSessionId);

      // Check if this is the first turn (only 1 user + 1 assistant turn)
      const turnCount = await conversationStore.count(persistentSessionId);
      if (turnCount <= 2) {
        // Generate title asynchronously (don't block response)
        generateSessionTitle(textContent, /* fast LLM adapter */).then(async (title) => {
          await chatSessions.updateTitle(persistentSessionId!, title);
          reqLogger.debug('session_title_generated', { sessionId: persistentSessionId, title });
        }).catch(err => {
          reqLogger.warn('session_title_error', { error: (err as Error).message });
        });
      }
    }
  } catch (err) {
    reqLogger.warn('session_title_setup_error', { error: (err as Error).message });
  }
}
```

The fast LLM adapter creation depends on how AX creates LLM provider instances. This should use the existing `providers.llm` with a fast model (e.g. `claude-haiku-4-5-20251001`). The exact wiring will need to match how `deps.providers.llm` exposes a completion method.

**Step 6: Run full tests**

```bash
npm test
```

Expected: All pass.

**Step 7: Commit**

```bash
git add src/host/session-title.ts src/host/server-completions.ts tests/host/session-title-generation.test.ts
git commit -m "feat: auto-generate session titles on first message via fast LLM"
```

---

### Task 5: Scaffold `ui/chat/` Vite project

**Files:**
- Create: `ui/chat/package.json`
- Create: `ui/chat/vite.config.ts`
- Create: `ui/chat/tsconfig.json`
- Create: `ui/chat/index.html`
- Create: `ui/chat/src/main.tsx`
- Create: `ui/chat/src/App.tsx` (placeholder)
- Create: `ui/chat/src/index.css`
- Create: `ui/chat/tailwind.config.js`
- Create: `ui/chat/postcss.config.js`
- Modify: `package.json` (add build:chat script)

**Step 1: Create package.json**

```json
{
  "name": "ax-chat",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@assistant-ui/react": "^0.12.5",
    "@assistant-ui/react-ai-sdk": "^0.12.5",
    "@assistant-ui/react-markdown": "^0.12.5",
    "assistant-stream": "^0.2.0",
    "lucide-react": "^0.474.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.2.1",
    "@types/react": "^19.0.8",
    "@types/react-dom": "^19.0.3",
    "@vitejs/plugin-react": "^4.3.4",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.5.1",
    "tailwindcss": "^4.0.6",
    "typescript": "^5.7.3",
    "vite": "^6.1.0"
  }
}
```

**Step 2: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: '../../dist/chat-ui',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
});
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "noEmit": true
  },
  "include": ["src"]
}
```

**Step 4: Create index.html**

```html
<!DOCTYPE html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ax chat</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**Step 5: Create src/main.tsx**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

**Step 6: Create src/App.tsx (placeholder)**

```tsx
export function App() {
  return <div className="h-screen bg-background text-foreground flex items-center justify-center">
    <p className="text-muted-foreground">ax chat — loading...</p>
  </div>;
}
```

**Step 7: Create src/index.css**

Copy the design tokens from `ui/dashboard/src/index.css` — the `@import`, `@theme inline`, `:root`, `:root.dark`, and `@layer base` sections. Add assistant-ui base styles:

```css
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

@import "tailwindcss";

@custom-variant dark (&:is(.dark *));

@theme inline {
    --font-sans: "Outfit", system-ui, sans-serif;
    --font-mono: "IBM Plex Mono", ui-monospace, monospace;

    --radius-sm: calc(var(--radius) - 4px);
    --radius-md: calc(var(--radius) - 2px);
    --radius-lg: var(--radius);
    --radius-xl: calc(var(--radius) + 4px);
    --radius-2xl: calc(var(--radius) + 8px);

    --color-background: var(--background);
    --color-foreground: var(--foreground);
    --color-card: var(--card);
    --color-card-foreground: var(--card-foreground);
    --color-popover: var(--popover);
    --color-popover-foreground: var(--popover-foreground);
    --color-primary: var(--primary);
    --color-primary-foreground: var(--primary-foreground);
    --color-secondary: var(--secondary);
    --color-secondary-foreground: var(--secondary-foreground);
    --color-muted: var(--muted);
    --color-muted-foreground: var(--muted-foreground);
    --color-accent: var(--accent);
    --color-accent-foreground: var(--accent-foreground);
    --color-destructive: var(--destructive);
    --color-border: var(--border);
    --color-input: var(--input);
    --color-ring: var(--ring);
    --color-sidebar: var(--sidebar);
    --color-sidebar-foreground: var(--sidebar-foreground);
    --color-sidebar-primary: var(--sidebar-primary);
    --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
    --color-sidebar-accent: var(--sidebar-accent);
    --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
    --color-sidebar-border: var(--sidebar-border);
    --color-sidebar-ring: var(--sidebar-ring);

    --color-amber: #f59e0b;
    --color-emerald: #34d399;
    --color-rose: #fb7185;
    --color-sky: #38bdf8;
    --color-violet: #a78bfa;
}

:root {
    --radius: 0.5rem;
}

:root.dark {
    --background: #09090b;
    --foreground: #fafaf9;
    --card: #111113;
    --card-foreground: #fafaf9;
    --popover: #111113;
    --popover-foreground: #fafaf9;
    --primary: #fafaf9;
    --primary-foreground: #09090b;
    --secondary: #1c1c1f;
    --secondary-foreground: #fafaf9;
    --muted: #1c1c1f;
    --muted-foreground: #71717a;
    --accent: #1c1c1f;
    --accent-foreground: #fafaf9;
    --destructive: #ef4444;
    --border: rgba(255, 255, 255, 0.06);
    --input: rgba(255, 255, 255, 0.08);
    --ring: rgba(255, 255, 255, 0.12);
    --sidebar: #09090b;
    --sidebar-foreground: #fafaf9;
    --sidebar-primary: #fafaf9;
    --sidebar-primary-foreground: #09090b;
    --sidebar-accent: #1c1c1f;
    --sidebar-accent-foreground: #fafaf9;
    --sidebar-border: rgba(255, 255, 255, 0.06);
    --sidebar-ring: rgba(255, 255, 255, 0.12);
}

@layer base {
    * {
        border-color: var(--border);
    }
    body {
        background-color: var(--background);
        color: var(--foreground);
        font-family: var(--font-sans);
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
    }
}
```

**Step 8: Create tailwind.config.js**

```javascript
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        amber: {
          DEFAULT: '#f59e0b',
        },
      },
    },
  },
  plugins: [],
};
```

**Step 9: Create postcss.config.js**

```javascript
export default {
  plugins: {
    '@tailwindcss/postcss': {},
    autoprefixer: {},
  },
};
```

**Step 10: Add build:chat to root package.json**

```json
"build:chat": "cd ui/chat && npm install && npm run build"
```

**Step 11: Install deps and verify build**

```bash
cd ui/chat && npm install && npm run build
```

Expected: Build succeeds, output in `dist/chat-ui/`.

**Step 12: Commit**

```bash
git add ui/chat/ package.json
git commit -m "feat: scaffold ui/chat/ Vite project with shared design tokens"
```

---

### Task 6: Create chat UI adapters

**Files:**
- Create: `ui/chat/src/lib/thread-list-adapter.ts`
- Create: `ui/chat/src/lib/history-adapter.ts`

**Step 1: Create thread-list-adapter.ts**

Based on canopy-ai's `postgresThreadListAdapter`, simplified for AX:

```typescript
import { createAssistantStream } from 'assistant-stream';
import type { ThreadMessage } from '@assistant-ui/react';

/**
 * AX-backed RemoteThreadListAdapter.
 * Fetches and manages threads through /v1/chat/sessions endpoints.
 */
export const axThreadListAdapter = {
  async list() {
    const response = await fetch('/v1/chat/sessions');
    if (!response.ok) {
      console.error('[AxAdapter] Failed to fetch sessions:', response.status);
      return { threads: [] };
    }

    const { sessions } = await response.json();
    return {
      threads: sessions.map((s: any) => ({
        status: 'regular' as const,
        remoteId: s.id,
        title: s.title ?? undefined,
        externalId: undefined,
      })),
    };
  },

  async fetch(threadId: string) {
    // AX doesn't have a single-session fetch endpoint yet.
    // Return default metadata; the list() already provides what we need.
    return {
      status: 'regular' as const,
      remoteId: threadId,
      title: undefined,
      externalId: undefined,
    };
  },

  async initialize(threadId: string) {
    const response = await fetch('/v1/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: threadId }),
    });

    if (!response.ok) {
      throw new Error('Failed to create session');
    }

    const session = await response.json();
    return { remoteId: session.id, externalId: undefined };
  },

  async generateTitle(remoteId: string, messages: readonly ThreadMessage[]) {
    // Title is auto-generated server-side during processCompletion.
    // Return a placeholder stream — the real title will appear on next list() refresh.
    const firstUserMessage = messages.find(m => m.role === 'user');
    const textContent = firstUserMessage?.content.find(c => c.type === 'text');
    const text = textContent && 'text' in textContent ? textContent.text : 'New Chat';
    const title = text.length <= 50 ? text : text.substring(0, 47) + '...';

    return createAssistantStream((controller) => {
      controller.appendText(title);
      controller.close();
    });
  },

  // Stubs for future rename/archive/delete
  async rename() {},
  async archive() {},
  async unarchive() {},
  async delete() {},
};
```

**Step 2: Create history-adapter.ts**

```typescript
import type { ThreadHistoryAdapter } from '@assistant-ui/react';

/**
 * AX-backed ThreadHistoryAdapter.
 * Loads conversation history from /v1/chat/sessions/:id/history.
 * Append is a no-op since AX server persists turns during chat completions.
 */
export function createAxHistoryAdapter(
  getRemoteId: () => string | undefined,
  initializeThread: () => Promise<{ remoteId: string }>,
): ThreadHistoryAdapter {
  return {
    async load() {
      const remoteId = getRemoteId();
      if (!remoteId) return { messages: [] };

      const response = await fetch(`/v1/chat/sessions/${encodeURIComponent(remoteId)}/history`);
      if (!response.ok) {
        if (response.status === 404) return { messages: [] };
        throw new Error('Failed to fetch history');
      }

      const { messages } = await response.json();
      return {
        messages: messages.map((m: any, index: number) => ({
          message: {
            id: `${remoteId}-${index}`,
            role: m.role,
            content: [{ type: 'text' as const, text: m.content }],
            createdAt: m.created_at ? new Date(m.created_at * 1000) : new Date(),
          },
          parentId: index > 0 ? `${remoteId}-${index - 1}` : null,
        })),
      };
    },

    async append() {
      // No-op: AX server persists turns during processCompletion.
      // The history adapter only needs to load, not write.
    },
  };
}
```

**Step 3: Commit**

```bash
git add ui/chat/src/lib/
git commit -m "feat: add thread-list and history adapters for AX chat API"
```

---

### Task 7: Create runtime hook

**Files:**
- Create: `ui/chat/src/lib/useAxChatRuntime.tsx`

**Step 1: Create useAxChatRuntime.tsx**

Based on canopy-ai's `usePostgresChatRuntime`, adapted for AX:

```tsx
import { useEffect, useMemo, useRef } from 'react';
import {
  AssistantRuntime,
  unstable_useRemoteThreadListRuntime as useRemoteThreadListRuntime,
  useAui,
  RuntimeAdapterProvider,
  useAuiState,
  type ThreadHistoryAdapter,
} from '@assistant-ui/react';
import {
  useAISDKRuntime,
  AssistantChatTransport,
} from '@assistant-ui/react-ai-sdk';
import { useChat, type UIMessage } from '@ai-sdk/react';
import type { ChatTransport } from 'ai';
import { axThreadListAdapter } from './thread-list-adapter';
import { createAxHistoryAdapter } from './history-adapter';

/**
 * Create a dynamic transport proxy that can be updated without recreating the hook.
 */
const useDynamicChatTransport = <UI_MESSAGE extends UIMessage = UIMessage>(
  transport: ChatTransport<UI_MESSAGE>,
): ChatTransport<UI_MESSAGE> => {
  const transportRef = useRef<ChatTransport<UI_MESSAGE>>(transport);
  useEffect(() => {
    transportRef.current = transport;
  });
  return useMemo(
    () =>
      new Proxy(transportRef.current, {
        get(_, prop) {
          const res = transportRef.current[prop as keyof ChatTransport<UI_MESSAGE>];
          return typeof res === 'function' ? res.bind(transportRef.current) : res;
        },
      }),
    [],
  );
};

/**
 * Thread-specific runtime using AI SDK.
 */
const useChatThreadRuntime = (): AssistantRuntime => {
  const transport = useDynamicChatTransport(
    new AssistantChatTransport({ api: '/v1/chat/completions' }),
  );

  const id = useAuiState(({ threadListItem }) => threadListItem.id);
  const chat = useChat({ id, transport });
  const runtime = useAISDKRuntime(chat);

  if (transport instanceof AssistantChatTransport) {
    transport.setRuntime(runtime);
  }

  return runtime;
};

/**
 * Provider that injects AX history adapter into the runtime context.
 */
function AxHistoryProvider({ children }: { children?: React.ReactNode }) {
  const aui = useAui();

  const history = useMemo<ThreadHistoryAdapter>(
    () =>
      createAxHistoryAdapter(
        () => aui.threadListItem().getState().remoteId,
        () => aui.threadListItem().initialize(),
      ),
    [aui],
  );

  const adapters = useMemo(() => ({ history }), [history]);

  return (
    <RuntimeAdapterProvider adapters={adapters}>
      {children}
    </RuntimeAdapterProvider>
  );
}

/**
 * Custom hook that creates a chat runtime with AX-backed thread persistence.
 */
export const useAxChatRuntime = (): AssistantRuntime => {
  return useRemoteThreadListRuntime({
    runtimeHook: function RuntimeHook() {
      return useChatThreadRuntime();
    },
    adapter: {
      ...axThreadListAdapter,
      unstable_Provider: AxHistoryProvider,
    },
  });
};
```

**Step 2: Commit**

```bash
git add ui/chat/src/lib/useAxChatRuntime.tsx
git commit -m "feat: add useAxChatRuntime hook with thread list + history adapters"
```

---

### Task 8: Create chat UI components

**Files:**
- Create: `ui/chat/src/components/thread.tsx`
- Create: `ui/chat/src/components/thread-list.tsx`
- Create: `ui/chat/src/components/markdown-text.tsx`
- Modify: `ui/chat/src/App.tsx`

**Step 1: Create thread.tsx**

Adapted from canopy-ai's thread.tsx, simplified (no attachments, no artifacts, no next-themes):

```tsx
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  PencilIcon,
  RefreshCwIcon,
  Square,
} from 'lucide-react';
import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from '@assistant-ui/react';
import type { FC } from 'react';
import { MarkdownText } from './markdown-text';

export const Thread: FC = () => {
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root flex h-full flex-col bg-background"
      style={{ ['--thread-max-width' as string]: '44rem' }}
    >
      <ThreadPrimitive.Viewport className="aui-thread-viewport relative flex flex-1 flex-col overflow-y-auto px-4">
        <ThreadPrimitive.If empty>
          <ThreadWelcome />
        </ThreadPrimitive.If>

        <ThreadPrimitive.Messages
          components={{ UserMessage, AssistantMessage, EditComposer }}
        />

        <ThreadPrimitive.If empty={false}>
          <div className="min-h-8 grow" />
        </ThreadPrimitive.If>

        <Composer />
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
};

const ThreadWelcome: FC = () => (
  <div className="mx-auto my-auto flex w-full max-w-[var(--thread-max-width)] flex-grow flex-col items-center justify-center">
    <p className="text-2xl font-semibold">Hello there!</p>
    <p className="text-2xl text-muted-foreground/65">How can I help you today?</p>
  </div>
);

const Composer: FC = () => (
  <div className="sticky bottom-0 mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-4 rounded-t-3xl bg-background pb-4 md:pb-6">
    <ThreadPrimitive.ScrollToBottom asChild>
      <button className="absolute -top-12 z-10 self-center rounded-full border bg-background p-2 shadow-sm hover:bg-accent disabled:invisible">
        <ArrowDownIcon className="size-4" />
      </button>
    </ThreadPrimitive.ScrollToBottom>
    <ComposerPrimitive.Root className="relative flex w-full flex-col">
      <div className="flex w-full flex-col rounded-3xl border border-input bg-background px-1 pt-2 shadow-xs transition-[color,box-shadow] has-[textarea:focus-visible]:border-ring has-[textarea:focus-visible]:ring-[3px] has-[textarea:focus-visible]:ring-ring/50">
        <ComposerPrimitive.Input
          placeholder="Send a message..."
          className="mb-1 max-h-32 min-h-16 w-full resize-none bg-transparent px-3.5 pt-1.5 pb-3 text-base outline-none placeholder:text-muted-foreground"
          rows={1}
          autoFocus
        />
        <div className="relative mx-1 mt-2 mb-2 flex items-center justify-end">
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send asChild>
              <button className="rounded-full bg-foreground p-1.5 text-background hover:bg-foreground/90">
                <ArrowUpIcon className="size-4" />
              </button>
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel asChild>
              <button className="rounded-full bg-muted p-1.5 hover:bg-muted/80">
                <Square className="size-3.5" fill="currentColor" />
              </button>
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </div>
      </div>
    </ComposerPrimitive.Root>
  </div>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root asChild>
    <div className="relative mx-auto w-full max-w-[var(--thread-max-width)] py-4" data-role="assistant">
      <div className="mx-2 leading-7 break-words text-foreground">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
      <div className="mt-2 ml-2 flex">
        <ActionBarPrimitive.Root
          hideWhenRunning
          autohide="not-last"
          className="flex gap-1 text-muted-foreground"
        >
          <ActionBarPrimitive.Copy asChild>
            <button className="p-1 hover:text-foreground">
              <MessagePrimitive.If copied><CheckIcon className="size-4" /></MessagePrimitive.If>
              <MessagePrimitive.If copied={false}><CopyIcon className="size-4" /></MessagePrimitive.If>
            </button>
          </ActionBarPrimitive.Copy>
          <ActionBarPrimitive.Reload asChild>
            <button className="p-1 hover:text-foreground">
              <RefreshCwIcon className="size-4" />
            </button>
          </ActionBarPrimitive.Reload>
        </ActionBarPrimitive.Root>
      </div>
    </div>
  </MessagePrimitive.Root>
);

const UserMessage: FC = () => (
  <MessagePrimitive.Root asChild>
    <div className="mx-auto grid w-full max-w-[var(--thread-max-width)] auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 px-2 py-4 [&>*]:col-start-2" data-role="user">
      <div className="relative col-start-2 min-w-0">
        <div className="rounded-3xl bg-muted px-5 py-2.5 break-words text-foreground">
          <MessagePrimitive.Parts />
        </div>
        <div className="absolute top-1/2 left-0 -translate-x-full -translate-y-1/2 pr-2">
          <ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="flex flex-col items-end">
            <ActionBarPrimitive.Edit asChild>
              <button className="p-1 text-muted-foreground hover:text-foreground">
                <PencilIcon className="size-4" />
              </button>
            </ActionBarPrimitive.Edit>
          </ActionBarPrimitive.Root>
        </div>
      </div>
    </div>
  </MessagePrimitive.Root>
);

const EditComposer: FC = () => (
  <div className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-4 px-2 first:mt-4">
    <ComposerPrimitive.Root className="ml-auto flex w-full max-w-7/8 flex-col rounded-xl bg-muted">
      <ComposerPrimitive.Input
        className="flex min-h-[60px] w-full resize-none bg-transparent p-4 text-foreground outline-none"
        autoFocus
      />
      <div className="mx-3 mb-3 flex items-center justify-center gap-2 self-end">
        <ComposerPrimitive.Cancel asChild>
          <button className="rounded-md px-3 py-1.5 text-sm hover:bg-accent">Cancel</button>
        </ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send asChild>
          <button className="rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:bg-foreground/90">Update</button>
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  </div>
);
```

**Step 2: Create thread-list.tsx**

```tsx
import type { FC } from 'react';
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from '@assistant-ui/react';
import { PlusIcon } from 'lucide-react';

export const ThreadList: FC = () => (
  <ThreadListPrimitive.Root className="flex flex-col items-stretch gap-1.5">
    <ThreadListNew />
    <ThreadListItems />
  </ThreadListPrimitive.Root>
);

const ThreadListNew: FC = () => (
  <div className="flex justify-center px-2 py-4">
    <ThreadListPrimitive.New asChild>
      <button className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors">
        <PlusIcon className="size-4" />
        New Chat
      </button>
    </ThreadListPrimitive.New>
  </div>
);

const ThreadListItems: FC = () => {
  const isLoading = useAuiState(({ threads }) => threads.isLoading);

  if (isLoading) {
    return (
      <>
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-2 rounded-md px-3 py-2">
            <div className="h-5 flex-grow animate-pulse rounded bg-muted" />
          </div>
        ))}
      </>
    );
  }

  return <ThreadListPrimitive.Items components={{ ThreadListItem }} />;
};

const ThreadListItem: FC = () => (
  <ThreadListItemPrimitive.Root className="flex items-center gap-2 rounded-lg transition-all hover:bg-muted focus-visible:bg-muted data-active:bg-muted">
    <ThreadListItemPrimitive.Trigger className="truncate grow px-3 py-2 text-start">
      <span className="text-sm">
        <ThreadListItemPrimitive.Title fallback="New Chat" />
      </span>
    </ThreadListItemPrimitive.Trigger>
  </ThreadListItemPrimitive.Root>
);
```

**Step 3: Create markdown-text.tsx**

```tsx
import type { FC } from 'react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';

export const MarkdownText: FC = () => (
  <MarkdownTextPrimitive
    className="prose prose-invert max-w-none prose-pre:bg-muted prose-pre:rounded-lg prose-code:font-mono prose-code:text-sm"
  />
);
```

**Step 4: Update App.tsx**

```tsx
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { useAxChatRuntime } from './lib/useAxChatRuntime';
import { Thread } from './components/thread';
import { ThreadList } from './components/thread-list';

export function App() {
  const runtime = useAxChatRuntime();

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-screen bg-background">
        {/* Sidebar */}
        <div className="flex w-64 flex-col border-r border-border bg-background">
          <div className="flex items-center gap-2 px-4 py-4 border-b border-border">
            <span className="text-lg font-semibold text-foreground">ax</span>
            <span className="text-sm text-muted-foreground">chat</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            <ThreadList />
          </div>
        </div>
        {/* Main content */}
        <div className="flex-1">
          <Thread />
        </div>
      </div>
    </AssistantRuntimeProvider>
  );
}
```

**Step 5: Install deps and verify build**

```bash
cd ui/chat && npm install && npm run build
```

Expected: Build succeeds.

**Step 6: Commit**

```bash
git add ui/chat/src/
git commit -m "feat: add chat UI components — Thread, ThreadList, App layout"
```

---

### Task 9: Wire chat UI into AX server routing

**Files:**
- Create: `src/host/server-chat-ui.ts`
- Modify: `src/host/server-request-handlers.ts`

**Step 1: Create server-chat-ui.ts**

Create static file serving for the chat UI, mirroring `server-admin.ts` pattern:

```typescript
/**
 * Chat UI static file serving.
 * Serves the built chat UI from dist/chat-ui/ at the root path.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from './server-http.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function resolveChatUIDir(): string {
  // Sibling of host/ when running from dist/: dist/chat-ui/
  const siblingDir = resolve(import.meta.dirname, '../chat-ui');
  if (existsSync(siblingDir)) return siblingDir;
  // Fallback: dist/chat-ui/ when running from src/host/ (dev mode with tsx)
  const distDir = resolve(import.meta.dirname, '../../dist/chat-ui');
  if (existsSync(distDir)) return distDir;
  return siblingDir;
}

export function createChatUIHandler() {
  const chatUIDir = resolveChatUIDir();

  return (req: IncomingMessage, res: ServerResponse, pathname: string): void => {
    if (!existsSync(chatUIDir)) {
      sendError(res, 404, 'Chat UI not built. Run: npm run build:chat');
      return;
    }

    // Strip leading slash, default to index.html
    let filePath = pathname === '/' ? 'index.html' : pathname.slice(1);

    // Path traversal check
    if (filePath.includes('..')) {
      sendError(res, 400, 'Invalid path');
      return;
    }

    const fullPath = join(chatUIDir, filePath);
    const ext = extname(fullPath);

    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath);
      const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
      const isHtml = ext === '.html';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': content.length,
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      res.end(content);
    } else {
      // SPA fallback: serve index.html for non-asset routes
      const indexPath = join(chatUIDir, 'index.html');
      if (existsSync(indexPath)) {
        const content = readFileSync(indexPath);
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Length': content.length,
          'Cache-Control': 'no-cache',
        });
        res.end(content);
      } else {
        sendError(res, 404, 'Not found');
      }
    }
  };
}
```

**Step 2: Update server-request-handlers.ts routing**

In `createRequestHandler`, the root `/` currently redirects to `/admin`. We need to:

1. Remove the root redirect to `/admin`
2. Add chat API routes (`/v1/chat/sessions*`)
3. Add chat UI serving for non-API, non-admin routes

The routing order becomes:
1. Health, models, completions, events, files, webhooks, credentials, oauth (unchanged)
2. **NEW:** `/v1/chat/sessions*` → chat API handler
3. `/admin*` → admin handler (unchanged)
4. **NEW:** `/*` → chat UI handler (instead of 404)

Replace the root redirect block (lines 607-612):
```typescript
// OLD:
// Root → admin redirect
if (adminHandler && (url === '/' || url === '')) {
  res.writeHead(302, { Location: '/admin' });
  res.end();
  return;
}
```

With chat UI serving:
```typescript
// Chat API
if (url.startsWith('/v1/chat/sessions')) {
  if (chatApiHandler) {
    const handled = await chatApiHandler(req, res, url);
    if (handled) return;
  }
}

// Admin dashboard (unchanged)
if (adminHandler && url.startsWith('/admin')) { ... }

// Chat UI (replaces root redirect)
if (chatUIHandler) {
  chatUIHandler(req, res, url);
  return;
}
```

Add `chatApiHandler` and `chatUIHandler` to the `RequestHandlerOpts` interface and factory.

**Step 3: Run full tests**

```bash
npm test
```

Expected: All pass (existing redirect tests may need updating).

**Step 4: Commit**

```bash
git add src/host/server-chat-ui.ts src/host/server-request-handlers.ts
git commit -m "feat: serve chat UI at / and wire /v1/chat/sessions routes"
```

---

### Task 10: Integration testing

**Step 1: Build everything**

```bash
npm run build && npm run build:dashboard && npm run build:chat
```

**Step 2: Start the server**

```bash
npm run serve
```

**Step 3: Manual verification**

- Open `http://localhost:8080/` → should show chat UI
- Open `http://localhost:8080/admin` → should show admin dashboard
- Create a new thread → should call `POST /v1/chat/sessions`
- Send a message → should stream response via `/v1/chat/completions`
- Refresh page → thread list should show existing sessions
- Click a session → should load conversation history
- After first message → session should get an auto-generated title

**Step 4: Run full test suite**

```bash
npm test
```

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete chat UI integration"
```

---

## Task Dependency Graph

```
Task 1 (move dashboard) ─────┐
                              ├─→ Task 5 (scaffold chat/) ─→ Task 6 (adapters) ─→ Task 7 (runtime) ─→ Task 8 (components)
Task 2 (chat_sessions DB) ───┤                                                                              │
                              ├─→ Task 3 (API endpoints) ──────────────────────────────────────────────────┤
Task 4 (auto-title) ─────────┘                                                                              │
                                                                                                             ↓
                                                                                                    Task 9 (routing)
                                                                                                             ↓
                                                                                                    Task 10 (integration)
```

Tasks 1, 2, 3, and 4 can run in parallel.
Tasks 5-8 are sequential (each builds on the previous).
Task 9 depends on all prior tasks.
Task 10 is the final integration check.
