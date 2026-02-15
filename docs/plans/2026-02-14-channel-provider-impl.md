# Channel Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the ChannelProvider interface with typed session addressing, threading, media, and access control, then rewrite the Slack adapter to implement it.

**Architecture:** Layered adapter pattern. Platform-agnostic types in `channel/types.ts`, platform-specific adapters implement the `ChannelProvider` interface. Session identity uses typed `SessionAddress` objects with deterministic serialization. Access control is config-driven via `shouldRespond()`.

**Tech Stack:** TypeScript, @slack/bolt (Socket Mode), Vitest

**Design doc:** `docs/plans/2026-02-14-channel-provider-design.md`

---

### Task 1: New channel types

**Files:**
- Modify: `src/providers/channel/types.ts` (full rewrite)

**Step 1: Replace types.ts with new type definitions**

Replace the entire contents of `src/providers/channel/types.ts` with:

```typescript
// src/providers/channel/types.ts — Channel provider types

// ─── Session Addressing ────────────────────────────

export type SessionScope = 'dm' | 'channel' | 'thread' | 'group';

export interface SessionAddress {
  provider: string;
  scope: SessionScope;
  identifiers: {
    workspace?: string;
    channel?: string;
    thread?: string;
    peer?: string;
  };
  parent?: SessionAddress;
}

/**
 * Deterministic serialization of a SessionAddress for use as map keys.
 * Format: "provider:scope:workspace:channel:thread:peer" (omits empty segments).
 */
export function canonicalize(addr: SessionAddress): string {
  const parts = [addr.provider, addr.scope];
  const ids = addr.identifiers;
  if (ids.workspace) parts.push(ids.workspace);
  if (ids.channel) parts.push(ids.channel);
  if (ids.thread) parts.push(ids.thread);
  if (ids.peer) parts.push(ids.peer);
  return parts.join(':');
}

// ─── Media ─────────────────────────────────────────

export interface Attachment {
  filename: string;
  mimeType: string;
  size: number;
  content?: Buffer;
  url?: string;
}

// ─── Messages ──────────────────────────────────────

export interface InboundMessage {
  id: string;
  session: SessionAddress;
  sender: string;
  content: string;
  attachments: Attachment[];
  timestamp: Date;
  replyTo?: string;
  raw?: unknown;
}

export interface OutboundMessage {
  content: string;
  attachments?: Attachment[];
  replyTo?: string;
}

// ─── Access Control ────────────────────────────────

export type DMPolicy = 'open' | 'allowlist' | 'disabled';

export interface ChannelAccessConfig {
  dmPolicy: DMPolicy;
  allowedUsers?: string[];
  requireMention: boolean;
  mentionPatterns?: string[];
  maxAttachmentBytes: number;
  allowedMimeTypes?: string[];
}

// ─── Provider Interface ────────────────────────────

export interface ChannelProvider {
  name: string;
  connect(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
  shouldRespond(msg: InboundMessage): boolean;
  send(session: SessionAddress, content: OutboundMessage): Promise<void>;
  disconnect(): Promise<void>;
}
```

**Step 2: Commit**

```bash
git add src/providers/channel/types.ts
git commit -m "feat(channel): replace types with typed SessionAddress, media, and access control"
```

---

### Task 2: canonicalize() tests

**Files:**
- Create: `tests/providers/channel/types.test.ts`

**Step 1: Write tests for canonicalize()**

```typescript
import { describe, test, expect } from 'vitest';
import { canonicalize, type SessionAddress } from '../../../src/providers/channel/types.js';

describe('canonicalize', () => {
  test('serializes DM session', () => {
    const addr: SessionAddress = {
      provider: 'slack',
      scope: 'dm',
      identifiers: { workspace: 'T01', peer: 'U789' },
    };
    expect(canonicalize(addr)).toBe('slack:dm:T01:U789');
  });

  test('serializes channel session', () => {
    const addr: SessionAddress = {
      provider: 'discord',
      scope: 'channel',
      identifiers: { workspace: 'G01', channel: 'C01', peer: 'U123' },
    };
    expect(canonicalize(addr)).toBe('discord:channel:G01:C01:U123');
  });

  test('serializes thread session with all identifiers', () => {
    const addr: SessionAddress = {
      provider: 'slack',
      scope: 'thread',
      identifiers: { workspace: 'T01', channel: 'C01', thread: '1234.5678', peer: 'U789' },
    };
    expect(canonicalize(addr)).toBe('slack:thread:T01:C01:1234.5678:U789');
  });

  test('omits empty identifier segments', () => {
    const addr: SessionAddress = {
      provider: 'telegram',
      scope: 'dm',
      identifiers: { peer: 'U999' },
    };
    expect(canonicalize(addr)).toBe('telegram:dm:U999');
  });

  test('serializes scheduler session', () => {
    const addr: SessionAddress = {
      provider: 'scheduler',
      scope: 'dm',
      identifiers: { peer: 'heartbeat' },
    };
    expect(canonicalize(addr)).toBe('scheduler:dm:heartbeat');
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run tests/providers/channel/types.test.ts`
Expected: PASS — canonicalize() is already implemented in Task 1

**Step 3: Commit**

```bash
git add tests/providers/channel/types.test.ts
git commit -m "test(channel): add canonicalize() unit tests"
```

---

### Task 3: Update router for new InboundMessage shape

The router uses `msg.id` as sessionId, `msg.channel` for taint source, and `msg.isGroup` is not referenced. After this change, the router uses `canonicalize(msg.session)` for sessionId and `msg.session.provider` for taint source.

**Files:**
- Modify: `src/host/router.ts:3,52-59,98`
- Modify: `tests/host/router.test.ts:5,84-94`

**Step 1: Update router imports and processInbound**

In `src/host/router.ts`:

Change the import (line 3):
```typescript
// old
import type { InboundMessage } from '../providers/channel/types.js';
// new
import { canonicalize, type InboundMessage } from '../providers/channel/types.js';
```

Change `processInbound` (lines 52-59) to use `canonicalize(msg.session)` instead of `msg.id`, and `msg.session.provider` instead of `msg.channel`:

```typescript
    async processInbound(msg: InboundMessage): Promise<RouterResult> {
      const sessionId = canonicalize(msg.session);
      const canaryToken = providers.scanner.canaryToken();

      // Taint-tag external content
      const isTainted = msg.session.provider !== 'system';
      const taint = taintTag(msg.session.provider);
      const taggedContent = wrapExternalContent(msg.content, msg.session.provider);
```

Change the audit log (line 77) from `channel: msg.channel` to `channel: msg.session.provider`:

```typescript
        args: {
          channel: msg.session.provider,
          sender: msg.sender,
          verdict: scanResult.verdict,
        },
```

Change the enqueue call (line 98) from `channel: msg.channel` to `channel: msg.session.provider`:

```typescript
      const messageId = db.enqueue({
        sessionId,
        channel: msg.session.provider,
        sender: msg.sender,
        content: contentWithCanary,
      });
```

**Step 2: Update router test helper**

In `tests/host/router.test.ts`, update the import and `makeMsg` helper:

Change import (line 5):
```typescript
// old
import type { InboundMessage } from '../../src/providers/channel/types.js';
// new
import type { InboundMessage, SessionAddress } from '../../src/providers/channel/types.js';
```

Replace the `makeMsg` function (lines 84-94):

```typescript
function makeSession(overrides?: Partial<SessionAddress>): SessionAddress {
  return {
    provider: 'cli',
    scope: 'dm',
    identifiers: { peer: 'user' },
    ...overrides,
  };
}

function makeMsg(content: string, overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id: 'msg-001',
    session: makeSession(),
    sender: 'user',
    content,
    attachments: [],
    timestamp: new Date(),
    ...overrides,
  };
}
```

Update the test "uses message id as session id" (lines 150-156) — sessionId is now derived from SessionAddress, not msg.id:

```typescript
    test('derives session id from session address', async () => {
      const result = await router.processInbound(
        makeMsg('hello', { session: makeSession({ provider: 'slack', identifiers: { workspace: 'T01', peer: 'U42' } }) })
      );

      expect(result.sessionId).toBe('slack:dm:T01:U42');
    });
```

Also update the first test "enqueues valid message with taint tags" (line 115) — sessionId is no longer `'msg-001'`:

```typescript
      expect(result.sessionId).toBe('cli:dm:user');
```

And update the "wraps content with external_content tags" test (line 126) — source is now `'cli'` not always `'cli'` (it already is, so just verify the test still matches the `provider` field):

```typescript
      expect(queued!.content).toContain('<external_content trust="external" source="cli">');
```

This line is unchanged — it already expects `source="cli"` which matches `msg.session.provider`.

**Step 3: Run router tests**

Run: `npx vitest run tests/host/router.test.ts`
Expected: PASS — all 8 router tests pass

**Step 4: Commit**

```bash
git add src/host/router.ts tests/host/router.test.ts
git commit -m "refactor(router): use SessionAddress for session identity and taint source"
```

---

### Task 4: Update scheduler types and implementations

The scheduler creates synthetic `InboundMessage` objects with `channel: 'scheduler'`. These need to use `SessionAddress` instead.

**Files:**
- Modify: `src/providers/scheduler/types.ts:2`
- Modify: `src/providers/scheduler/cron.ts:3,48-55,89-96`
- Modify: `src/providers/scheduler/full.ts:4,156-163,174-181,260-267`

**Step 1: Update scheduler/types.ts import**

The import is unchanged — it still imports `InboundMessage` from `../channel/types.js`. No modification needed. The `SchedulerProvider.start()` signature already accepts `(msg: InboundMessage) => void`.

**Step 2: Create helper function for scheduler session addresses**

In both `src/providers/scheduler/cron.ts` and `src/providers/scheduler/full.ts`, add a helper after the imports:

```typescript
import type { InboundMessage, SessionAddress } from '../channel/types.js';

function schedulerSession(sender: string): SessionAddress {
  return { provider: 'scheduler', scope: 'dm', identifiers: { peer: sender } };
}
```

**Step 3: Update all synthetic InboundMessage constructions**

In `src/providers/scheduler/cron.ts`, replace the heartbeat message (lines 48-55):

```typescript
    const msg: InboundMessage = {
      id: randomUUID(),
      session: schedulerSession('heartbeat'),
      sender: 'heartbeat',
      content: 'Heartbeat check — review pending tasks and proactive hints.',
      attachments: [],
      timestamp: new Date(),
    };
```

Replace the cron job message (lines 89-96):

```typescript
      const msg: InboundMessage = {
        id: randomUUID(),
        session: schedulerSession(`cron:${job.id}`),
        sender: `cron:${job.id}`,
        content: job.prompt,
        attachments: [],
        timestamp: now,
      };
```

In `src/providers/scheduler/full.ts`, apply the same pattern to all three `InboundMessage` constructions (heartbeat at ~156, cron at ~174, hint at ~260). Each replaces `channel: 'scheduler'` with `session: schedulerSession(sender)`, removes `isGroup: false`, and adds `attachments: []`.

**Step 4: Run scheduler tests**

Run: `npx vitest run tests/providers/scheduler/`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/scheduler/types.ts src/providers/scheduler/cron.ts src/providers/scheduler/full.ts
git commit -m "refactor(scheduler): use SessionAddress in synthetic InboundMessage objects"
```

---

### Task 5: Add channel_config to Config type

**Files:**
- Modify: `src/types.ts:33-66`

**Step 1: Add channel_config to Config interface**

In `src/types.ts`, add the import for `ChannelAccessConfig`:

```typescript
import type { ChannelProvider, ChannelAccessConfig } from './providers/channel/types.js';
```

Add `channel_config` to the `Config` interface after the `providers` block:

```typescript
export interface Config {
  agent?: AgentType;
  max_tokens?: number;
  profile: ProfileName;
  providers: {
    llm: string;
    memory: string;
    scanner: string;
    channels: string[];
    web: string;
    browser: string;
    credentials: string;
    skills: string;
    audit: string;
    sandbox: string;
    scheduler: string;
    skillScreener?: string;
  };
  channel_config?: Record<string, Partial<ChannelAccessConfig>>;
  sandbox: {
    timeout_sec: number;
    memory_mb: number;
  };
  scheduler: {
    active_hours: {
      start: string;
      end: string;
      timezone: string;
    };
    max_token_budget: number;
    heartbeat_interval_min: number;
    proactive_hint_confidence_threshold?: number;
    proactive_hint_cooldown_sec?: number;
  };
}
```

**Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat(config): add channel_config for per-provider access control settings"
```

---

### Task 6: Rewrite Slack adapter — tests first

**Files:**
- Create: `tests/providers/channel/slack.test.ts`

**Step 1: Write Slack adapter tests**

These tests mock `@slack/bolt` to avoid needing real Slack credentials. They verify:
- `create()` throws without tokens
- `shouldRespond()` respects DM policy and mention requirements
- `send()` routes to correct channel/thread from SessionAddress
- Session addresses are correctly constructed from Slack events

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { ChannelProvider, InboundMessage, SessionAddress } from '../../../src/providers/channel/types.js';
import type { Config } from '../../../src/types.js';

// Minimal config for testing
function testConfig(channelConfig?: Record<string, unknown>): Config {
  return {
    profile: 'default' as any,
    providers: {
      llm: 'mock', memory: 'file', scanner: 'basic', channels: ['slack'],
      web: 'none', browser: 'none', credentials: 'env', skills: 'readonly',
      audit: 'file', sandbox: 'subprocess', scheduler: 'none',
    },
    channel_config: channelConfig as any,
    sandbox: { timeout_sec: 30, memory_mb: 512 },
    scheduler: {
      active_hours: { start: '09:00', end: '17:00', timezone: 'UTC' },
      max_token_budget: 1000, heartbeat_interval_min: 60,
    },
  };
}

// Mock Slack Bolt App
const mockPostMessage = vi.fn().mockResolvedValue({ ok: true });
const mockFilesUploadV2 = vi.fn().mockResolvedValue({ ok: true });
const mockAuthTest = vi.fn().mockResolvedValue({ user_id: 'UBOT' });
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const eventHandlers = new Map<string, Function>();

vi.mock('@slack/bolt', () => ({
  App: vi.fn().mockImplementation(() => ({
    message: (handler: Function) => eventHandlers.set('message', handler),
    event: (name: string, handler: Function) => eventHandlers.set(name, handler),
    start: mockStart,
    stop: mockStop,
    client: {
      auth: { test: mockAuthTest },
      chat: { postMessage: mockPostMessage },
      files: { uploadV2: mockFilesUploadV2 },
    },
  })),
}));

describe('Slack channel provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
  });

  test('throws without credentials', async () => {
    const { create } = await import('../../../src/providers/channel/slack.js');
    await expect(create(testConfig())).rejects.toThrow('SLACK_BOT_TOKEN');
  });

  test('connects and resolves bot user id', async () => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_APP_TOKEN = 'xapp-test';
    const { create } = await import('../../../src/providers/channel/slack.js');
    const provider = await create(testConfig());
    await provider.connect();
    expect(mockStart).toHaveBeenCalled();
    expect(mockAuthTest).toHaveBeenCalled();
    await provider.disconnect();
  });

  describe('shouldRespond', () => {
    test('allows DMs when policy is open', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const msg: InboundMessage = {
        id: '1234.5678',
        session: { provider: 'slack', scope: 'dm', identifiers: { peer: 'U123' } },
        sender: 'U123',
        content: 'hello',
        attachments: [],
        timestamp: new Date(),
      };
      expect(provider.shouldRespond(msg)).toBe(true);
    });

    test('blocks DMs when policy is disabled', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig({ slack: { dm_policy: 'disabled' } }));

      const msg: InboundMessage = {
        id: '1234.5678',
        session: { provider: 'slack', scope: 'dm', identifiers: { peer: 'U123' } },
        sender: 'U123',
        content: 'hello',
        attachments: [],
        timestamp: new Date(),
      };
      expect(provider.shouldRespond(msg)).toBe(false);
    });

    test('allowlist blocks unlisted users', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig({
        slack: { dm_policy: 'allowlist', allowed_users: ['U999'] },
      }));

      const msg: InboundMessage = {
        id: '1234.5678',
        session: { provider: 'slack', scope: 'dm', identifiers: { peer: 'U123' } },
        sender: 'U123',
        content: 'hello',
        attachments: [],
        timestamp: new Date(),
      };
      expect(provider.shouldRespond(msg)).toBe(false);
    });

    test('allowlist permits listed users', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig({
        slack: { dm_policy: 'allowlist', allowed_users: ['U123'] },
      }));

      const msg: InboundMessage = {
        id: '1234.5678',
        session: { provider: 'slack', scope: 'dm', identifiers: { peer: 'U123' } },
        sender: 'U123',
        content: 'hello',
        attachments: [],
        timestamp: new Date(),
      };
      expect(provider.shouldRespond(msg)).toBe(true);
    });

    test('channel messages always allowed (mention gating is pre-filtered)', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const msg: InboundMessage = {
        id: '1234.5678',
        session: { provider: 'slack', scope: 'channel', identifiers: { channel: 'C01', peer: 'U123' } },
        sender: 'U123',
        content: 'hello',
        attachments: [],
        timestamp: new Date(),
      };
      expect(provider.shouldRespond(msg)).toBe(true);
    });
  });

  describe('send', () => {
    test('posts message to channel', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack',
        scope: 'channel',
        identifiers: { channel: 'C01', peer: 'U123' },
      };
      await provider.send(session, { content: 'Hello!' });

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C01', text: 'Hello!' }),
      );
    });

    test('posts threaded reply when thread identifier present', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack',
        scope: 'thread',
        identifiers: { channel: 'C01', thread: '1234.5678', peer: 'U123' },
      };
      await provider.send(session, { content: 'Thread reply' });

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C01',
          text: 'Thread reply',
          thread_ts: '1234.5678',
        }),
      );
    });

    test('chunks long messages at newline boundaries', async () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      const { create } = await import('../../../src/providers/channel/slack.js');
      const provider = await create(testConfig());

      const session: SessionAddress = {
        provider: 'slack',
        scope: 'channel',
        identifiers: { channel: 'C01' },
      };
      // Create a message that exceeds 4000 chars
      const longLine = 'A'.repeat(3000);
      const content = `${longLine}\n${'B'.repeat(3000)}`;
      await provider.send(session, { content });

      expect(mockPostMessage).toHaveBeenCalledTimes(2);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/providers/channel/slack.test.ts`
Expected: FAIL — slack.ts still has the old interface

**Step 3: Commit**

```bash
git add tests/providers/channel/slack.test.ts
git commit -m "test(slack): add tests for new ChannelProvider interface"
```

---

### Task 7: Rewrite Slack adapter

**Files:**
- Modify: `src/providers/channel/slack.ts` (full rewrite)

**Step 1: Rewrite slack.ts**

```typescript
import type {
  ChannelProvider,
  ChannelAccessConfig,
  InboundMessage,
  OutboundMessage,
  SessionAddress,
  Attachment,
} from './types.js';
import type { Config } from '../../types.js';

const SLACK_MAX_TEXT = 4000;

const DEFAULT_ACCESS: ChannelAccessConfig = {
  dmPolicy: 'open',
  requireMention: true,
  maxAttachmentBytes: 20 * 1024 * 1024,
};

interface SlackMessage {
  text: string;
  user: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  channel_type?: string;
  files?: SlackFile[];
}

interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  size: number;
  url_private: string;
}

/**
 * Split text into chunks that fit within Slack's message size limit.
 * Prefers splitting at newline boundaries.
 */
function chunkText(text: string, limit: number = SLACK_MAX_TEXT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find last newline within limit
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit; // No newline found — hard split

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}

export async function create(config: Config): Promise<ChannelProvider> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !appToken) {
    throw new Error(
      'Slack channel requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN environment variables.\n' +
      'Enable Socket Mode in your Slack app settings and generate an app-level token.',
    );
  }

  // Read access config from ax.yaml channel_config.slack
  const rawConfig = config.channel_config?.slack ?? {};
  const access: ChannelAccessConfig = {
    dmPolicy: rawConfig.dmPolicy ?? rawConfig.dm_policy ?? DEFAULT_ACCESS.dmPolicy,
    allowedUsers: rawConfig.allowedUsers ?? rawConfig.allowed_users,
    requireMention: rawConfig.requireMention ?? rawConfig.require_mention ?? DEFAULT_ACCESS.requireMention,
    mentionPatterns: rawConfig.mentionPatterns ?? rawConfig.mention_patterns,
    maxAttachmentBytes: rawConfig.maxAttachmentBytes ?? rawConfig.max_attachment_bytes ?? DEFAULT_ACCESS.maxAttachmentBytes,
    allowedMimeTypes: rawConfig.allowedMimeTypes ?? rawConfig.allowed_mime_types,
  };

  // Dynamic import — @slack/bolt is an optional dependency
  const { App } = await import('@slack/bolt');

  let messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;
  let botUserId: string | undefined;
  let teamId: string | undefined;

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  function buildSession(
    user: string,
    channel: string,
    threadTs?: string,
    isDM?: boolean,
  ): SessionAddress {
    if (isDM) {
      return {
        provider: 'slack',
        scope: 'dm',
        identifiers: { workspace: teamId, peer: user },
      };
    }

    if (threadTs) {
      const channelSession: SessionAddress = {
        provider: 'slack',
        scope: 'channel',
        identifiers: { workspace: teamId, channel, peer: user },
      };
      return {
        provider: 'slack',
        scope: 'thread',
        identifiers: { workspace: teamId, channel, thread: threadTs, peer: user },
        parent: channelSession,
      };
    }

    return {
      provider: 'slack',
      scope: 'channel',
      identifiers: { workspace: teamId, channel, peer: user },
    };
  }

  function buildAttachments(files?: SlackFile[]): Attachment[] {
    if (!files?.length) return [];
    return files
      .filter(f => f.size <= access.maxAttachmentBytes)
      .filter(f => {
        if (!access.allowedMimeTypes?.length) return true;
        return access.allowedMimeTypes.some(pattern => {
          if (pattern.endsWith('/*')) {
            return f.mimetype.startsWith(pattern.slice(0, -1));
          }
          return f.mimetype === pattern;
        });
      })
      .map(f => ({
        filename: f.name,
        mimeType: f.mimetype,
        size: f.size,
        url: f.url_private,
      }));
  }

  // Handle direct messages
  app.message(async ({ message }) => {
    const msg = message as SlackMessage;
    if (!msg.text || !msg.user) return;
    if (msg.user === botUserId) return;
    if (!messageHandler) return;

    const isDM = msg.channel_type === 'im';

    await messageHandler({
      id: msg.ts,
      session: buildSession(msg.user, msg.channel, msg.thread_ts, isDM),
      sender: msg.user,
      content: msg.text,
      attachments: buildAttachments(msg.files),
      timestamp: new Date(parseFloat(msg.ts) * 1000),
      replyTo: msg.thread_ts,
      raw: message,
    });
  });

  // Handle @mentions in channels
  app.event('app_mention', async ({ event }) => {
    if (!event.text || !event.user) return;
    if (event.user === botUserId) return;
    if (!messageHandler) return;

    // Strip bot mention from text
    let text = event.text.trim();
    if (botUserId) {
      text = text.replace(new RegExp(`<@${botUserId}>\\s*`, 'g'), '').trim();
    }
    if (!text) return;

    await messageHandler({
      id: event.ts,
      session: buildSession(event.user, event.channel, event.thread_ts ?? event.ts),
      sender: event.user,
      content: text,
      attachments: buildAttachments((event as any).files),
      timestamp: new Date(parseFloat(event.ts) * 1000),
      replyTo: event.thread_ts,
      raw: event,
    });
  });

  return {
    name: 'slack',

    async connect(): Promise<void> {
      await app.start();
      const authResult = await app.client.auth.test({ token: botToken });
      botUserId = authResult.user_id as string;
      teamId = authResult.team_id as string;
    },

    onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
      messageHandler = handler;
    },

    shouldRespond(msg: InboundMessage): boolean {
      // Only apply access control for slack messages
      if (msg.session.provider !== 'slack') return true;

      if (msg.session.scope === 'dm') {
        if (access.dmPolicy === 'disabled') return false;
        if (access.dmPolicy === 'allowlist') {
          return access.allowedUsers?.includes(msg.sender) ?? false;
        }
        return true; // 'open'
      }

      // Channel and thread messages — mention gating is handled by Slack event
      // subscription (app_mention only fires when bot is mentioned). Additional
      // mention patterns could be checked here in the future.
      return true;
    },

    async send(session: SessionAddress, content: OutboundMessage): Promise<void> {
      const channel = session.identifiers.channel ?? session.identifiers.peer;
      if (!channel) throw new Error('SessionAddress has no channel or peer identifier for send()');

      const threadTs = session.identifiers.thread ?? content.replyTo;

      // Upload attachments first
      if (content.attachments?.length) {
        for (const att of content.attachments) {
          if (att.content) {
            await app.client.files.uploadV2({
              token: botToken,
              channel_id: channel,
              file: att.content,
              filename: att.filename,
              ...(threadTs ? { thread_ts: threadTs } : {}),
            });
          }
        }
      }

      // Send text in chunks
      const chunks = chunkText(content.content);
      for (const chunk of chunks) {
        await app.client.chat.postMessage({
          token: botToken,
          channel,
          text: chunk,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        });
      }
    },

    async disconnect(): Promise<void> {
      await app.stop();
    },
  };
}
```

**Step 2: Run tests**

Run: `npx vitest run tests/providers/channel/slack.test.ts`
Expected: PASS — all Slack adapter tests pass

**Step 3: Commit**

```bash
git add src/providers/channel/slack.ts
git commit -m "feat(slack): rewrite adapter with SessionAddress, threading, media, access control"
```

---

### Task 8: Update host server channel loop

**Files:**
- Modify: `src/host/server.ts:604-618`

**Step 1: Update the channel loop**

Replace lines 603-618 in `src/host/server.ts`:

```typescript
    // Connect channel providers (Slack, Discord, etc.)
    for (const channel of providers.channels) {
      channel.onMessage(async (msg: InboundMessage) => {
        if (!channel.shouldRespond(msg)) {
          logger.debug('Channel message filtered', { provider: channel.name, sender: msg.sender });
          return;
        }
        const result = await router.processInbound(msg);
        if (!result.queued) {
          await channel.send(msg.session, {
            content: `Message blocked: ${result.scanResult.reason ?? 'security scan failed'}`,
          });
          return;
        }
        sessionCanaries.set(result.sessionId, result.canaryToken);
        const { responseContent } = await processCompletion(msg.content, `ch-${randomUUID().slice(0, 8)}`, [], msg.id);
        await channel.send(msg.session, { content: responseContent });
      });
      await channel.connect();
    }
```

Note: the `onMessage` handler is now `async` (matching the new interface), `channel.send()` takes `msg.session` (SessionAddress) instead of `msg.sender` (string), and `shouldRespond()` is called before processing.

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All existing tests pass (minus pre-existing failures)

**Step 3: Commit**

```bash
git add src/host/server.ts
git commit -m "feat(server): add shouldRespond() gating and SessionAddress routing in channel loop"
```

---

### Task 9: Update integration tests

**Files:**
- Modify: `tests/integration/e2e.test.ts`
- Modify: `tests/integration/phase1.test.ts`
- Modify: `tests/integration/phase2.test.ts`

**Step 1: Update InboundMessage constructions in integration tests**

Each of these files constructs `InboundMessage` objects. Update them to use the new shape:

Replace `channel: 'cli'` → `session: { provider: 'cli', scope: 'dm', identifiers: { peer: sender } }`
Remove `isGroup: false`
Add `attachments: []`

For example, change:
```typescript
{ id: 'test', channel: 'cli', sender: 'user', content: 'hi', timestamp: new Date(), isGroup: false }
```
to:
```typescript
{ id: 'test', session: { provider: 'cli', scope: 'dm', identifiers: { peer: 'user' } }, sender: 'user', content: 'hi', attachments: [], timestamp: new Date() }
```

**Step 2: Run integration tests**

Run: `npx vitest run tests/integration/`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/integration/
git commit -m "test: update integration tests for new InboundMessage shape"
```

---

### Task 10: Update scheduler tests

**Files:**
- Modify: `tests/providers/scheduler/cron.test.ts`
- Modify: `tests/providers/scheduler/full.test.ts`

**Step 1: Update scheduler test assertions**

These tests check the `InboundMessage` objects emitted by schedulers. Update assertions that check for `channel: 'scheduler'` and `isGroup: false` to check for `session.provider: 'scheduler'` and `attachments: []` instead.

For example, change:
```typescript
expect(msg.channel).toBe('scheduler');
expect(msg.isGroup).toBe(false);
```
to:
```typescript
expect(msg.session.provider).toBe('scheduler');
expect(msg.session.scope).toBe('dm');
expect(msg.attachments).toEqual([]);
```

**Step 2: Run scheduler tests**

Run: `npx vitest run tests/providers/scheduler/`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/providers/scheduler/
git commit -m "test: update scheduler tests for new InboundMessage shape"
```

---

### Task 11: Final verification

**Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass (minus the 1-2 pre-existing failures documented in lessons.md)

**Step 2: Run TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: Clean compile (minus pre-existing errors in unrelated files)

**Step 3: Commit any remaining fixes**

If any tests or types need adjustments, fix and commit.

---

### Summary of all files touched

**Modified:**
- `src/providers/channel/types.ts` — Full rewrite (new types)
- `src/providers/channel/slack.ts` — Full rewrite (new adapter)
- `src/host/router.ts` — Use SessionAddress for session ID and taint source
- `src/host/server.ts` — shouldRespond() gating + SessionAddress routing
- `src/types.ts` — Add channel_config to Config
- `src/providers/scheduler/types.ts` — Import change
- `src/providers/scheduler/cron.ts` — SessionAddress in synthetic messages
- `src/providers/scheduler/full.ts` — SessionAddress in synthetic messages
- `tests/host/router.test.ts` — New InboundMessage shape
- `tests/integration/e2e.test.ts` — New InboundMessage shape
- `tests/integration/phase1.test.ts` — New InboundMessage shape
- `tests/integration/phase2.test.ts` — New InboundMessage shape
- `tests/providers/scheduler/cron.test.ts` — New assertions
- `tests/providers/scheduler/full.test.ts` — New assertions

**Created:**
- `tests/providers/channel/types.test.ts` — canonicalize() tests
- `tests/providers/channel/slack.test.ts` — Slack adapter tests
