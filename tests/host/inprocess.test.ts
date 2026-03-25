import { describe, it, expect, vi } from 'vitest';
import { resolveTurnLayer, extractAppHints, runFastPath } from '../../src/host/inprocess.js';
import type { Config, ProviderRegistry } from '../../src/types.js';
import type { LLMProvider, ChatChunk, ChatRequest } from '../../src/providers/llm/types.js';
import type { ConversationStoreProvider, DocumentStore } from '../../src/providers/storage/types.js';
import type { Router } from '../../src/host/router.js';
import type { TaintBudget } from '../../src/host/taint-budget.js';
import type { Logger } from '../../src/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubConfig(overrides: Partial<Config> = {}): Config {
  return {
    agent: 'pi-coding-agent',
    profile: 'balanced',
    providers: { mcp: 'none', ...overrides.providers } as Config['providers'],
    models: { default: ['mock-model'] },
    max_tokens: 1024,
    history: { max_turns: 50 } as Config['history'],
    ...overrides,
  } as unknown as Config;
}

function mockLLM(responses: ChatChunk[][]): LLMProvider {
  let callIdx = 0;
  return {
    name: 'mock',
    async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
      const chunks = responses[callIdx++];
      if (!chunks) {
        throw new Error(`Unexpected llm.chat() call #${callIdx}`);
      }
      for (const c of chunks) yield c;
    },
    async models() { return ['mock-model']; },
  };
}

function mockDocuments(data: Record<string, Record<string, string>> = {}): DocumentStore {
  return {
    async get(collection: string, key: string) { return data[collection]?.[key]; },
    async put() {},
    async delete() { return true; },
    async list(collection: string) { return Object.keys(data[collection] ?? {}); },
  };
}

function mockConversationStore(): ConversationStoreProvider {
  const history: Array<{ role: string; content: string; sender?: string }> = [];
  return {
    async load() { return history; },
    async append(_sid: string, role: 'user' | 'assistant', content: string) {
      history.push({ role, content });
    },
    async prune() {},
  };
}

function mockLogger(): Logger {
  return {
    child: () => mockLogger(),
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as Logger;
}

// ---------------------------------------------------------------------------
// resolveTurnLayer
// ---------------------------------------------------------------------------

describe('resolveTurnLayer', () => {
  it('returns sandbox for claude-code', () => {
    expect(resolveTurnLayer(stubConfig({ agent: 'claude-code' }), {})).toBe('sandbox');
  });

  it('returns sandbox when active pod exists', () => {
    expect(resolveTurnLayer(stubConfig(), { sandboxPod: { alive: true } })).toBe('sandbox');
  });

  it('returns sandbox when no MCP provider configured', () => {
    const config = stubConfig();
    (config.providers as Record<string, unknown>).mcp = undefined;
    expect(resolveTurnLayer(config, {})).toBe('sandbox');
  });

  it('returns in-process when MCP configured and no active pod', () => {
    expect(resolveTurnLayer(stubConfig(), {})).toBe('in-process');
  });

  it('returns sandbox when sandboxPod alive even with MCP', () => {
    expect(resolveTurnLayer(stubConfig(), { sandboxPod: { alive: true } })).toBe('sandbox');
  });
});

// ---------------------------------------------------------------------------
// extractAppHints
// ---------------------------------------------------------------------------

describe('extractAppHints', () => {
  it('returns matching apps from message', () => {
    expect(extractAppHints('Create a linear issue', ['linear', 'gmail'])).toEqual(['linear']);
  });

  it('returns multiple matches', () => {
    expect(extractAppHints('Send gmail and check linear', ['linear', 'gmail', 'slack'])).toEqual(['linear', 'gmail']);
  });

  it('returns empty for no matches', () => {
    expect(extractAppHints('hello world', ['linear', 'gmail'])).toEqual([]);
  });

  it('is case insensitive', () => {
    expect(extractAppHints('Check LINEAR', ['linear'])).toEqual(['linear']);
  });

  it('returns empty for empty message', () => {
    expect(extractAppHints('', ['linear'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// runFastPath
// ---------------------------------------------------------------------------

describe('runFastPath', () => {
  it('runs simple LLM turn with no tool calls', async () => {
    const llm = mockLLM([
      [
        { type: 'text', content: 'Hello from the fast path!' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ]);

    const result = await runFastPath(
      {
        message: 'Hello',
        sessionId: 'sess-1',
        requestId: 'req-1',
        agentId: 'test-agent',
        userId: 'user-1',
      },
      {
        config: stubConfig(),
        providers: { llm, mcp: undefined } as unknown as ProviderRegistry,
        conversationStore: mockConversationStore(),
        documents: mockDocuments(),
        router: {} as Router,
        taintBudget: {} as TaintBudget,
        sessionCanaries: new Map(),
        logger: mockLogger(),
        workspaceBasePath: '/tmp/ax-test-ws',
      },
    );

    expect(result.responseContent).toBe('Hello from the fast path!');
    expect(result.finishReason).toBe('stop');
  });

  it('routes MCP tool calls correctly', async () => {
    const llm = mockLLM([
      // First response: tool call
      [
        { type: 'tool_use', toolCall: { id: 'tc-1', name: 'linear_get_issues', args: { query: 'bugs' } } },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      // Second response: final text after tool result
      [
        { type: 'text', content: 'Found 3 issues.' },
        { type: 'done', usage: { inputTokens: 20, outputTokens: 5 } },
      ],
    ]);

    const mockMcp = {
      async listTools() { return []; },
      callTool: vi.fn().mockResolvedValue({
        content: '[{"id":1},{"id":2},{"id":3}]',
        isError: false,
        taint: { source: 'mcp:linear_get_issues', trust: 'external' as const, timestamp: new Date() },
      }),
      async credentialStatus() { return { available: true, app: 'linear', authType: 'api_key' as const }; },
      async storeCredential() {},
      async listApps() { return []; },
    };

    const result = await runFastPath(
      {
        message: 'List linear issues',
        sessionId: 'sess-2',
        requestId: 'req-2',
        agentId: 'test-agent',
        userId: 'user-1',
      },
      {
        config: stubConfig(),
        providers: { llm, mcp: mockMcp } as unknown as ProviderRegistry,
        conversationStore: mockConversationStore(),
        documents: mockDocuments(),
        router: {} as Router,
        taintBudget: {} as TaintBudget,
        sessionCanaries: new Map(),
        logger: mockLogger(),
        workspaceBasePath: '/tmp/ax-test-ws',
      },
    );

    expect(result.responseContent).toBe('Found 3 issues.');
    expect(mockMcp.callTool).toHaveBeenCalledOnce();
    expect(mockMcp.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'linear_get_issues' }),
    );
  });

  it('persists conversation to store for persistent sessions', async () => {
    const convStore = mockConversationStore();
    const appendSpy = vi.spyOn(convStore, 'append');

    const llm = mockLLM([
      [
        { type: 'text', content: 'Stored response.' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ]);

    await runFastPath(
      {
        message: 'Store this',
        sessionId: 'sess-p',
        requestId: 'req-p',
        agentId: 'test-agent',
        userId: 'user-1',
        persistentSessionId: 'persistent-sess-1',
      },
      {
        config: stubConfig(),
        providers: { llm, mcp: undefined } as unknown as ProviderRegistry,
        conversationStore: convStore,
        documents: mockDocuments(),
        router: {} as Router,
        taintBudget: {} as TaintBudget,
        sessionCanaries: new Map(),
        logger: mockLogger(),
        workspaceBasePath: '/tmp/ax-test-ws',
      },
    );

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(appendSpy).toHaveBeenCalledWith('persistent-sess-1', 'user', 'Store this');
    expect(appendSpy).toHaveBeenCalledWith('persistent-sess-1', 'assistant', 'Stored response.');
  });

  it('loads skill instructions from DB and includes in prompt', async () => {
    let capturedSystemPrompt = '';
    const llm: LLMProvider = {
      name: 'mock',
      async *chat(req: ChatRequest) {
        const sysMsg = req.messages.find(m => m.role === 'system');
        capturedSystemPrompt = typeof sysMsg?.content === 'string' ? sysMsg.content : '';
        yield { type: 'text', content: 'ok' } as ChatChunk;
        yield { type: 'done', usage: { inputTokens: 5, outputTokens: 1 } } as ChatChunk;
      },
      async models() { return ['mock']; },
    };

    const docs = mockDocuments({
      skills: {
        'test-agent/linear-skill': JSON.stringify({
          instructions: 'Use linear_get_issues to find issues.',
          mcpApps: ['linear'],
        }),
      },
    });

    await runFastPath(
      {
        message: 'test',
        sessionId: 'sess-3',
        requestId: 'req-3',
        agentId: 'test-agent',
        userId: 'user-1',
      },
      {
        config: stubConfig(),
        providers: { llm, mcp: undefined } as unknown as ProviderRegistry,
        conversationStore: mockConversationStore(),
        documents: docs,
        router: {} as Router,
        taintBudget: {} as TaintBudget,
        sessionCanaries: new Map(),
        logger: mockLogger(),
        workspaceBasePath: '/tmp/ax-test-ws',
      },
    );

    expect(capturedSystemPrompt).toContain('Use linear_get_issues to find issues.');
  });
});
