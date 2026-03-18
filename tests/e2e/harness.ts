/**
 * E2E Test Harness — wires together mock providers, router, and IPC handler
 * to simulate full AX operation flows without real processes or network calls.
 *
 * Every external dependency is replaced with a recording mock. The harness
 * provides helpers to drive events (inbound messages, cron triggers, timer
 * fires) and assert on outcomes (audit trail, channel output, memory state,
 * workspace files, identity files).
 *
 * Usage:
 *   const h = await TestHarness.create({ llmTurns: [...] });
 *   await h.sendMessage('Hello!');
 *   expect(h.lastChannelReply()).toBe('Hi there!');
 *   h.dispose();
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import type { Kysely } from 'kysely';
import { createKyselyDb } from '../../src/utils/database.js';
import { runMigrations } from '../../src/utils/migrator.js';
import { storageMigrations } from '../../src/providers/storage/migrations.js';
import { create as createStorage } from '../../src/providers/storage/database.js';
import type { MessageQueueStore } from '../../src/providers/storage/types.js';
import { createRouter, type Router } from '../../src/host/router.js';
import { createIPCHandler, type IPCContext, type DelegationConfig, type DelegateRequest } from '../../src/host/ipc-server.js';
import type { ProviderRegistry, Config } from '../../src/types.js';
import type { AuditEntry } from '../../src/providers/audit/types.js';
import type { InboundMessage, SessionAddress, ChannelProvider, OutboundMessage } from '../../src/providers/channel/types.js';
import type { MemoryEntry, MemoryQuery } from '../../src/providers/memory/types.js';
import type { FetchRequest, FetchResponse, SearchResult } from '../../src/providers/web/types.js';
import type { ChatChunk } from '../../src/providers/llm/types.js';
import type { CronJobDef } from '../../src/providers/scheduler/types.js';
import type { BrowserSession, PageSnapshot } from '../../src/providers/browser/types.js';
// Skills are now filesystem-based; the SkillStoreProvider is removed.
import { FileAgentRegistry, type AgentRegistry, type AgentRegistryEntry } from '../../src/host/agent-registry.js';

import { ScriptedLLM, textTurn, type LLMTurn } from './scripted-llm.js';

// ─── Types ───────────────────────────────────────────

export interface ChannelMessage {
  session: SessionAddress;
  content: string;
  replyTo?: string;
}

export interface WebFetchStub {
  url: string | RegExp;
  response: FetchResponse;
}

export interface WebSearchStub {
  query: string | RegExp;
  results: SearchResult[];
}

export interface HarnessOptions {
  /** LLM turn script. */
  llmTurns?: LLMTurn[];
  /** Fallback LLM turn when script is exhausted. */
  llmFallback?: LLMTurn;
  /** IPC handler profile (paranoid, balanced, yolo). Default: balanced. */
  profile?: string;
  /** Canned web fetch responses. */
  webFetches?: WebFetchStub[];
  /** Canned web search responses. */
  webSearches?: WebSearchStub[];
  /** Canned browser snapshot. */
  browserSnapshot?: PageSnapshot;
  /** Initial memory entries to seed. */
  seedMemory?: MemoryEntry[];
  /** Whether skill screener is enabled. */
  enableSkillScreener?: boolean;
  /** Scanner input verdict override. */
  scannerInputVerdict?: 'PASS' | 'FLAG' | 'BLOCK';
  /** Scanner output verdict override. */
  scannerOutputVerdict?: 'PASS' | 'FLAG' | 'BLOCK';
  /** Delegation config (maxConcurrent, maxDepth). */
  delegation?: DelegationConfig;
  /** Delegation handler callback. */
  onDelegate?: (req: DelegateRequest, ctx: IPCContext) => Promise<string>;
  /** Seed agent registry entries. */
  seedAgents?: Omit<AgentRegistryEntry, 'createdAt' | 'updatedAt'>[];
}

// ─── TestHarness ─────────────────────────────────────

export class TestHarness {
  readonly tmpDir: string;
  readonly agentDir: string;
  readonly db: MessageQueueStore;
  readonly router: Router;
  readonly handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  readonly llm: ScriptedLLM;
  readonly providers: ProviderRegistry;
  readonly agentRegistry: AgentRegistry;

  // Recording stores
  readonly auditLog: Partial<AuditEntry>[] = [];
  readonly channelMessages: ChannelMessage[] = [];
  readonly memoryStore = new Map<string, MemoryEntry>();
  readonly schedulerJobs: CronJobDef[] = [];
  readonly schedulerOnceJobs: { job: CronJobDef; fireAt: Date }[] = [];
  readonly skillStore = new Map<string, string>();

  // Browser state
  private browserSessions = new Map<string, { url?: string }>();
  private browserSnapshot: PageSnapshot;

  // Web stubs
  private webFetches: WebFetchStub[];
  private webSearches: WebSearchStub[];

  private readonly mockChannel: ChannelProvider;

  private originalAxHome: string | undefined;
  private kyselyDb: Kysely<any>;

  private constructor(
    db: MessageQueueStore,
    kyselyDb: Kysely<any>,
    opts: HarnessOptions,
    tmpDir: string,
    agentDir: string,
    originalAxHome: string | undefined,
  ) {
    this.tmpDir = tmpDir;
    this.agentDir = agentDir;
    this.originalAxHome = originalAxHome;
    this.kyselyDb = kyselyDb;

    this.webFetches = opts.webFetches ?? [];
    this.webSearches = opts.webSearches ?? [];
    this.browserSnapshot = opts.browserSnapshot ?? {
      title: 'Test Page', url: 'https://example.com',
      text: 'Mock page content', refs: [{ ref: 0, tag: 'a', text: 'Link' }],
    };

    // Seed memory
    if (opts.seedMemory) {
      for (const entry of opts.seedMemory) {
        const id = entry.id ?? randomUUID();
        this.memoryStore.set(id, { ...entry, id });
      }
    }

    // Agent registry — uses temp dir since AX_HOME is set
    this.agentRegistry = new FileAgentRegistry(join(this.tmpDir, 'registry.json'));
    if (opts.seedAgents) {
      for (const agent of opts.seedAgents) {
        void this.agentRegistry.register(agent);
      }
    }

    // Build providers
    this.llm = new ScriptedLLM(opts.llmTurns ?? [textTurn('Hello!')], opts.llmFallback);
    this.mockChannel = this.buildMockChannel();
    this.providers = this.buildProviders(opts);

    // Wire up
    this.db = db;
    this.router = createRouter(this.providers, this.db);
    this.handleIPC = createIPCHandler(this.providers, {
      agentDir: this.agentDir,
      agentName: 'main',
      profile: opts.profile ?? 'balanced',
      delegation: opts.delegation,
      onDelegate: opts.onDelegate,
      agentRegistry: this.agentRegistry,
    });
  }

  static async create(opts: HarnessOptions = {}): Promise<TestHarness> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-e2e-harness-'));
    const agentDir = join(tmpDir, 'agents', 'main');
    mkdirSync(agentDir, { recursive: true });

    // Point AX_HOME to our temp dir so workspace/identity paths resolve there
    const originalAxHome = process.env.AX_HOME;
    process.env.AX_HOME = tmpDir;

    const kyselyDb = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'messages.db') });
    await runMigrations(kyselyDb, storageMigrations('sqlite'));
    const storage = await createStorage({} as Config, undefined, {
      database: { db: kyselyDb, type: 'sqlite', vectorsAvailable: false, close: async () => { await kyselyDb.destroy(); } },
    });
    return new TestHarness(storage.messages, kyselyDb, opts, tmpDir, agentDir, originalAxHome);
  }

  // ─── Event Drivers ───────────────────────────────

  /** Send an inbound message through the full pipeline (router + IPC + router). */
  async sendMessage(
    content: string,
    opts?: { sender?: string; channel?: string; scope?: 'dm' | 'channel' | 'thread' },
  ): Promise<{
    inbound: Awaited<ReturnType<Router['processInbound']>>;
    llmResponse?: string;
    outbound?: Awaited<ReturnType<Router['processOutbound']>>;
  }> {
    const msg: InboundMessage = {
      id: `msg-${randomUUID()}`,
      session: {
        provider: opts?.channel ?? 'test-channel',
        scope: opts?.scope ?? 'dm',
        identifiers: { peer: opts?.sender ?? 'test-user' },
      },
      sender: opts?.sender ?? 'test-user',
      content,
      attachments: [],
      timestamp: new Date(),
    };

    // Inbound
    const inResult = await this.router.processInbound(msg);
    if (!inResult.queued) {
      return { inbound: inResult };
    }

    // Dequeue
    const queued = await this.db.dequeue();
    if (!queued) {
      return { inbound: inResult };
    }

    // LLM call via IPC
    const ctx: IPCContext = { sessionId: inResult.sessionId, agentId: 'agent-1' };
    const llmResult = JSON.parse(await this.handleIPC(JSON.stringify({
      action: 'llm_call',
      messages: [{ role: 'user', content: queued.content }],
    }), ctx));

    let agentResponse = '';
    if (llmResult.ok && llmResult.chunks) {
      agentResponse = llmResult.chunks
        .filter((c: ChatChunk) => c.type === 'text')
        .map((c: ChatChunk) => c.content ?? '')
        .join('');
    }

    // Outbound
    const outResult = await this.router.processOutbound(
      agentResponse, inResult.sessionId, inResult.canaryToken,
    );

    await this.db.complete(queued.id);

    return { inbound: inResult, llmResponse: agentResponse, outbound: outResult };
  }

  /** Call an IPC action directly (bypassing router). */
  async ipcCall(action: string, params: Record<string, unknown>, ctx?: Partial<IPCContext>): Promise<any> {
    const fullCtx: IPCContext = {
      sessionId: ctx?.sessionId ?? 'test-session',
      agentId: ctx?.agentId ?? 'agent-1',
      ...ctx,
    };
    const raw = JSON.stringify({ action, ...params });
    const result = JSON.parse(await this.handleIPC(raw, fullCtx));
    return result;
  }

  /** Simulate a cron job firing by injecting a scheduler-style inbound message. */
  async fireCronJob(job: CronJobDef): Promise<{
    llmResponse?: string;
  }> {
    const ctx: IPCContext = { sessionId: `cron-${job.id}`, agentId: job.agentId };
    const llmResult = JSON.parse(await this.handleIPC(JSON.stringify({
      action: 'llm_call',
      messages: [{ role: 'user', content: job.prompt }],
    }), ctx));

    let response: string | undefined;
    if (llmResult.ok && llmResult.chunks) {
      response = llmResult.chunks
        .filter((c: ChatChunk) => c.type === 'text')
        .map((c: ChatChunk) => c.content ?? '')
        .join('');
    }

    return { llmResponse: response };
  }

  /**
   * Run a multi-turn agent loop: send messages to LLM, handle tool_use by
   * dispatching tool calls through IPC, feed tool_results back, repeat until
   * the LLM returns text-only (no tool_use).
   *
   * This simulates the actual agent runner loop without needing a real agent process.
   */
  async runAgentLoop(
    userMessage: string,
    opts?: { maxTurns?: number; sessionId?: string },
  ): Promise<{
    finalText: string;
    turns: { role: string; chunks: ChatChunk[] }[];
    toolCalls: { name: string; args: Record<string, unknown>; result: any }[];
  }> {
    const maxTurns = opts?.maxTurns ?? 10;
    const ctx: IPCContext = {
      sessionId: opts?.sessionId ?? `loop-${randomUUID()}`,
      agentId: 'agent-1',
    };

    const messages: { role: string; content: string | any[] }[] = [
      { role: 'user', content: userMessage },
    ];

    const turns: { role: string; chunks: ChatChunk[] }[] = [];
    const toolCalls: { name: string; args: Record<string, unknown>; result: any }[] = [];
    let finalText = '';

    for (let turn = 0; turn < maxTurns; turn++) {
      // Call LLM
      const llmResult = JSON.parse(await this.handleIPC(JSON.stringify({
        action: 'llm_call',
        messages,
      }), ctx));

      if (!llmResult.ok) {
        throw new Error(`LLM call failed: ${llmResult.error}`);
      }

      const chunks: ChatChunk[] = llmResult.chunks ?? [];
      turns.push({ role: 'assistant', chunks });

      // Extract text and tool_use chunks
      const textContent = chunks
        .filter((c: ChatChunk) => c.type === 'text')
        .map((c: ChatChunk) => c.content ?? '')
        .join('');

      const toolUseChunks = chunks.filter((c: ChatChunk) => c.type === 'tool_use');

      if (toolUseChunks.length === 0) {
        // No tool calls — LLM is done
        finalText = textContent;
        break;
      }

      // Build assistant message with content blocks
      const assistantContent: any[] = [];
      if (textContent) {
        assistantContent.push({ type: 'text', text: textContent });
      }
      for (const tc of toolUseChunks) {
        assistantContent.push({
          type: 'tool_use',
          id: tc.toolCall!.id,
          name: tc.toolCall!.name,
          input: tc.toolCall!.args,
        });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      // Execute each tool call through IPC
      const toolResults: any[] = [];
      for (const tc of toolUseChunks) {
        const toolCall = tc.toolCall!;
        const result = await this.ipcCall(toolCall.name, toolCall.args, ctx);
        toolCalls.push({ name: toolCall.name, args: toolCall.args, result });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResults });

      // If we've hit final text alongside tool_use, capture it
      if (turn === maxTurns - 1) {
        finalText = textContent;
      }
    }

    return { finalText, turns, toolCalls };
  }

  // ─── Assertion Helpers ───────────────────────────

  /** Get the last message sent to the mock channel. */
  lastChannelReply(): string | undefined {
    return this.channelMessages[this.channelMessages.length - 1]?.content;
  }

  /** Get all channel replies. */
  allChannelReplies(): string[] {
    return this.channelMessages.map(m => m.content);
  }

  /** Get audit entries matching an action name. */
  auditEntriesFor(action: string): Partial<AuditEntry>[] {
    return this.auditLog.filter(e => e.action === action);
  }

  /** Check if an audit action was logged. */
  wasAudited(action: string): boolean {
    return this.auditLog.some(e => e.action === action);
  }

  /** Get all memory entries for a scope. */
  memoryForScope(scope: string): MemoryEntry[] {
    return [...this.memoryStore.values()].filter(e => e.scope === scope);
  }

  /** Read an identity file (SOUL.md or IDENTITY.md). Checks DocumentStore first, falls back to filesystem. */
  async readIdentityFile(file: 'SOUL.md' | 'IDENTITY.md'): Promise<string | null> {
    // Check DocumentStore first (identity_write handler writes here)
    const key = `main/${file}`;
    const content = await this.providers.storage.documents.get('identity', key);
    if (content !== undefined) return content;
    // Fall back to filesystem (governance handler still writes here)
    const path = join(this.agentDir, file);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  /** Read a workspace file. */
  readWorkspaceFile(tier: string, path: string): string | null {
    const fullPath = join(this.tmpDir, 'workspace', tier, path);
    if (!existsSync(fullPath)) return null;
    return readFileSync(fullPath, 'utf-8');
  }

  // ─── Cleanup ─────────────────────────────────────

  dispose(): void {
    // For SQLite, destroy() is effectively synchronous under the hood
    void this.kyselyDb.destroy();
    // Restore AX_HOME
    if (this.originalAxHome !== undefined) {
      process.env.AX_HOME = this.originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }
    rmSync(this.tmpDir, { recursive: true, force: true });
  }

  // ─── Private: Provider Construction ──────────────

  private buildMockChannel(): ChannelProvider {
    return {
      name: 'test-channel',
      async connect() {},
      onMessage() {},
      shouldRespond() { return true; },
      send: async (_session: SessionAddress, msg: OutboundMessage) => {
        this.channelMessages.push({
          session: _session,
          content: msg.content,
          replyTo: msg.replyTo,
        });
      },
      async disconnect() {},
    };
  }

  private buildProviders(opts: HarnessOptions): ProviderRegistry {
    const self = this;

    return {
      llm: this.llm,

      memory: {
        async write(entry: MemoryEntry) {
          const id = entry.id ?? randomUUID();
          self.memoryStore.set(id, { ...entry, id });
          return id;
        },
        async query(q: MemoryQuery) {
          const entries = [...self.memoryStore.values()]
            .filter(e => e.scope === q.scope);
          if (q.tags?.length) {
            return entries.filter(e => e.tags?.some(t => q.tags!.includes(t))).slice(0, q.limit ?? 100);
          }
          return entries.slice(0, q.limit ?? 100);
        },
        async read(id: string) {
          return self.memoryStore.get(id) ?? null;
        },
        async delete(id: string) {
          self.memoryStore.delete(id);
        },
        async list(scope: string, limit?: number) {
          return [...self.memoryStore.values()]
            .filter(e => e.scope === scope)
            .slice(0, limit ?? 100);
        },
      },

      scanner: {
        canaryToken() { return `CANARY-e2e-${Date.now()}`; },
        checkCanary(output: string, token: string) { return output.includes(token); },
        async scanInput(msg: { content: string }) {
          const verdict = opts.scannerInputVerdict ?? 'PASS';
          if (verdict === 'BLOCK') {
            return { verdict: 'BLOCK' as const, reason: 'Scanner blocked', patterns: ['test'] };
          }
          if (verdict === 'FLAG') {
            return { verdict: 'FLAG' as const, reason: 'Scanner flagged', patterns: ['test'] };
          }
          return { verdict: 'PASS' as const };
        },
        async scanOutput(msg: { content: string }) {
          const verdict = opts.scannerOutputVerdict ?? 'PASS';
          if (verdict === 'BLOCK') {
            return { verdict: 'BLOCK' as const, reason: 'Sensitive data', patterns: ['pii'] };
          }
          if (verdict === 'FLAG') {
            return { verdict: 'FLAG' as const, reason: 'PII detected', patterns: ['ssn'] };
          }
          return { verdict: 'PASS' as const };
        },
      },

      channels: [this.mockChannel],

      web: {
        async fetch(req: FetchRequest): Promise<FetchResponse> {
          const stub = self.webFetches.find(s =>
            typeof s.url === 'string' ? s.url === req.url : s.url.test(req.url)
          );
          if (stub) return stub.response;
          return {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: '<html><body>Mock page</body></html>',
            taint: { source: 'web_fetch', trust: 'external' as const, timestamp: new Date() },
          };
        },
        async search(query: string, maxResults?: number): Promise<SearchResult[]> {
          const stub = self.webSearches.find(s =>
            typeof s.query === 'string' ? s.query === query : s.query.test(query)
          );
          if (stub) return stub.results.slice(0, maxResults ?? 10);
          return [{
            title: `Result for: ${query}`,
            url: 'https://example.com/result',
            snippet: `Mock search result for "${query}"`,
            taint: { source: 'web_search', trust: 'external' as const, timestamp: new Date() },
          }];
        },
      },

      browser: {
        async launch() {
          const id = `browser-${randomUUID().slice(0, 8)}`;
          self.browserSessions.set(id, {});
          return { id } as BrowserSession;
        },
        async navigate(session: string, url: string) {
          const s = self.browserSessions.get(session);
          if (s) s.url = url;
        },
        async snapshot(_session: string): Promise<PageSnapshot> {
          return self.browserSnapshot;
        },
        async click() {},
        async type() {},
        async screenshot() { return Buffer.from('fake-png'); },
        async close(session: string) {
          self.browserSessions.delete(session);
        },
      },

      credentials: {
        async get() { return null; },
        async set() {},
        async delete() {},
        async list() { return []; },
      },

      audit: {
        async log(entry: Partial<AuditEntry>) { self.auditLog.push(entry); },
        async query() { return self.auditLog as AuditEntry[]; },
      },

      sandbox: {
        workspaceLocation: 'host' as const,
        async spawn() { throw new Error('Sandbox disabled in E2E harness'); },
        async kill() {},
        async isAvailable() { return false; },
      },

      scheduler: {
        async start() {},
        async stop() {},
        addCron(job: CronJobDef) { self.schedulerJobs.push(job); },
        removeCron(jobId: string) {
          const idx = self.schedulerJobs.findIndex(j => j.id === jobId);
          if (idx >= 0) self.schedulerJobs.splice(idx, 1);
        },
        listJobs() { return self.schedulerJobs; },
        scheduleOnce(job: CronJobDef, fireAt: Date) {
          self.schedulerOnceJobs.push({ job, fireAt });
          self.schedulerJobs.push(job);
        },
      },

      storage: (() => {
        const docStore = new Map<string, Map<string, string>>();
        function getCol(col: string) {
          let c = docStore.get(col);
          if (!c) { c = new Map(); docStore.set(col, c); }
          return c;
        }
        return {
          documents: {
            async get(col: string, key: string) { return getCol(col).get(key); },
            async put(col: string, key: string, content: string) { getCol(col).set(key, content); },
            async delete(col: string, key: string) { return getCol(col).delete(key); },
            async list(col: string) { return [...getCol(col).keys()]; },
          },
          messages: {} as any,
          conversations: {} as any,
          sessions: {} as any,
          close() {},
        };
      })(),
      workspace: {
        async mount() { return { paths: {} }; },
        async commit() { return { scopes: {} }; },
        async cleanup() {},
        activeMounts() { return []; },
      },
    } as ProviderRegistry;
  }
}
