/**
 * In-process fast path — runs the LLM orchestration loop directly in the
 * host process. No pods, no IPC, no proxy, no GCS sync.
 *
 * SECURITY: No module-level mutable state. All per-turn state is in
 * function-scoped variables or AsyncLocalStorage (Phase 2 hardening).
 * The LLM loop is a pure function of (request, session, deps).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Config, ProviderRegistry, Message, ContentBlock, TaintTag } from '../types.js';
import type { McpToolSchema } from '../providers/mcp/types.js';
import type { ChatChunk, ToolDef } from '../providers/llm/types.js';
import type { ConversationStoreProvider } from '../providers/storage/types.js';
import type { Router } from './router.js';
import type { TaintBudget } from './taint-budget.js';
import type { EventBus } from './event-bus.js';
import { routeToolCall, FAST_PATH_LIMITS, type ToolRouterContext, type ToolResult } from './tool-router.js';
import type { Logger } from '../logger.js';
import { deserializeContent } from '../utils/content-serialization.js';
import type { McpConnectionManager } from '../plugins/mcp-manager.js';
import { callToolOnServer } from '../plugins/mcp-client.js';
import { resolveMcpAuthHeaders } from './server-completions.js';

// ---------------------------------------------------------------------------
// Per-turn context (AsyncLocalStorage for cross-session isolation)
// ---------------------------------------------------------------------------

interface TurnContext {
  sessionId: string;
  agentId: string;
  userId: string;
  requestId: string;
  startTime: number;
}

const turnStore = new AsyncLocalStorage<TurnContext>();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FastPathDeps {
  config: Config;
  providers: ProviderRegistry;
  conversationStore: ConversationStoreProvider;
  router: Router;
  taintBudget: TaintBudget;
  sessionCanaries: Map<string, string>;
  logger: Logger;
  eventBus?: EventBus;
  workspaceBasePath: string;
  /** Per-agent plugin MCP server registry. */
  mcpManager?: McpConnectionManager;
  /** Tuple-keyed skill credential store. Used by the call-time
   *  `authForServer` resolver to look up Bearer tokens for skill-declared
   *  MCP servers. Absent in test/legacy wiring — falls back to no auth. */
  skillCredStore?: import('./skills/skill-cred-store.js').SkillCredStore;
}

export interface FastPathRequest {
  message: string;
  sessionId: string;
  requestId: string;
  agentId: string;
  userId: string;
  /** Client-provided history (ephemeral sessions). */
  clientHistory?: { role: string; content: string | ContentBlock[] }[];
  /** Persistent session ID for DB history. */
  persistentSessionId?: string;
}

export interface FastPathResult {
  responseContent: string;
  contentBlocks?: ContentBlock[];
  finishReason: 'stop' | 'content_filter';
}

// ---------------------------------------------------------------------------
// Tool definitions exposed on the fast path
// ---------------------------------------------------------------------------

const FILE_READ_TOOL: ToolDef = {
  name: 'file_read',
  description: 'Read a file from storage.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to scope root.' },
      scope: { type: 'string', enum: ['agent', 'user', 'session'], description: 'Storage scope.' },
    },
    required: ['path', 'scope'],
  },
};

const FILE_WRITE_TOOL: ToolDef = {
  name: 'file_write',
  description: 'Write a file to storage.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to scope root.' },
      scope: { type: 'string', enum: ['agent', 'user', 'session'], description: 'Storage scope.' },
      content: { type: 'string', description: 'File content to write.' },
    },
    required: ['path', 'scope', 'content'],
  },
};

const REQUEST_SANDBOX_TOOL: ToolDef = {
  name: 'request_sandbox',
  description: 'Request a dedicated sandbox environment for shell commands, filesystem, git, or package installation. The user will be asked to approve.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Why sandbox access is needed.' },
      ttl: { type: 'number', description: 'Desired sandbox lifetime in seconds (60-3600, default 1800).' },
    },
    required: ['reason'],
  },
};

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildFastPathSystemPrompt(
  canRequestSandbox: boolean,
): string {
  const parts: string[] = [];

  // MCP context
  parts.push(
    'You have access to external service tools via MCP (Linear, Gmail, Google Slides, etc.).',
  );

  if (canRequestSandbox) {
    parts.push(
      `\nIf you need capabilities beyond these — such as running shell commands, ` +
      `accessing the filesystem, cloning repositories, or installing packages — ` +
      `use the request_sandbox tool. The user will be asked to approve. ` +
      `A dedicated environment will be provisioned for your next turn.\n\n` +
      `Do not request sandbox access unless you genuinely need it.`,
    );
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

function mcpToolToToolDef(schema: McpToolSchema): ToolDef {
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.inputSchema,
  };
}

// ---------------------------------------------------------------------------
// Main fast path loop
// ---------------------------------------------------------------------------

export async function runFastPath(
  request: FastPathRequest,
  deps: FastPathDeps,
): Promise<FastPathResult> {
  const turnCtx: TurnContext = {
    sessionId: request.sessionId,
    agentId: request.agentId,
    userId: request.userId,
    requestId: request.requestId,
    startTime: Date.now(),
  };

  return turnStore.run(turnCtx, async () => {
    const { config, providers, conversationStore, logger } = deps;
    const reqLogger = logger.child({ reqId: request.requestId.slice(-8) });

    // 1. Discover MCP tools via the connection manager (if wired).
    let mcpTools: McpToolSchema[] = [];
    if (deps.mcpManager) {
      const resolveHeaders = providers.credentials
        ? async (h: Record<string, string>) => {
            const { resolveHeaders: rh } = await import('../providers/mcp/database.js');
            return rh(JSON.stringify(h), providers.credentials);
          }
        : undefined;
      // Discovery-time auth: resolve from skill_credentials when available,
      // else fall back to the legacy providers.credentials lookup. Same
      // rationale as the call-time path in this file — skill credentials
      // live in the tuple-keyed store after the SSoT migration.
      const authForServer = deps.skillCredStore
        ? async (server: { name: string; url: string }) => {
            const headers = await resolveMcpAuthHeaders({
              serverName: server.name,
              agentId: request.agentId,
              userId: request.userId,
              skillCredStore: deps.skillCredStore!,
            });
            if (headers) return headers;
            // Fallback for admin-added servers whose credentials still live
            // in providers.credentials (legacy path — untouched by the
            // skills SSoT migration).
            if (providers.credentials) {
              const prefix = server.name.toUpperCase().replace(/-/g, '_');
              for (const suffix of ['_API_KEY', '_ACCESS_TOKEN', '_OAUTH_TOKEN', '_TOKEN']) {
                const value = await providers.credentials.get(`${prefix}${suffix}`);
                if (value) return { Authorization: `Bearer ${value}` };
              }
            }
            return undefined;
          }
        : undefined;
      // Only discover tools from servers assigned to this agent
      let serverFilter: Set<string> | undefined;
      if (providers.database) {
        try {
          const { listAgentServerNames } = await import('../providers/mcp/database.js');
          const assigned = await listAgentServerNames(providers.database.db, request.agentId);
          serverFilter = new Set(assigned);
        } catch { /* table may not exist — leave filter undefined (all servers) */ }
      }
      mcpTools = await deps.mcpManager.discoverAllTools(request.agentId, { resolveHeaders, authForServer, serverFilter });
    }

    // 2. Build tool list
    const tools: ToolDef[] = [
      ...mcpTools.map(mcpToolToToolDef),
      FILE_READ_TOOL,
      FILE_WRITE_TOOL,
      REQUEST_SANDBOX_TOOL,
    ];

    // 3. Build system prompt
    const systemPrompt = buildFastPathSystemPrompt(true);

    // 4. Load conversation history
    let history: Message[] = [];
    if (request.persistentSessionId) {
      const stored = await conversationStore.load(request.persistentSessionId, config.history.max_turns);
      history = stored.map(t => ({
        role: t.role as 'user' | 'assistant',
        content: deserializeContent(t.content),
      }));
    } else if (request.clientHistory) {
      history = request.clientHistory.slice(0, -1).map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));
    }

    // 5. Build messages
    const messages: Message[] = [
      ...history,
      { role: 'user', content: request.message },
    ];

    // 6. Tool router context
    const routerCtx: ToolRouterContext = {
      requestId: request.requestId,
      agentId: request.agentId,
      userId: request.userId,
      sessionId: request.sessionId,
      eventBus: deps.eventBus,
      workspaceBasePath: deps.workspaceBasePath,
      totalBytes: 0,
      callCount: 0,
      // Unified MCP routing: resolve tool name → server URL, then call via HTTP
      resolveServer: deps.mcpManager
        ? (agentId: string, toolName: string) => deps.mcpManager!.getToolServerUrl(agentId, toolName)
        : undefined,
      mcpCallTool: deps.mcpManager ? callToolOnServer : undefined,
      getServerMetaByUrl: deps.mcpManager
        ? (agentId: string, url: string) => deps.mcpManager!.getServerMetaByUrl(agentId, url)
        : undefined,
      resolveHeaders: providers.credentials
        ? async (h: Record<string, string>) => {
            const { resolveHeaders: rh } = await import('../providers/mcp/database.js');
            return rh(JSON.stringify(h), providers.credentials);
          }
        : undefined,
      // Resolve Bearer auth for skill-declared MCP servers from the
      // tuple-keyed `skill_credentials` store (not the legacy
      // `providers.credentials`). Mirrors the `server-init.ts`
      // toolBatchProvider wiring — same rationale: skill credentials
      // live in `skill_credentials` after the SSoT migration.
      authForServer: deps.skillCredStore
        ? async (server: { name: string; url: string; agentId: string; userId: string }) =>
            resolveMcpAuthHeaders({
              serverName: server.name,
              agentId: server.agentId,
              userId: server.userId,
              skillCredStore: deps.skillCredStore!,
            })
        : undefined,
      mcp: providers.mcp, // @deprecated — legacy fallback; remove when McpConnectionManager replaces all callers
    };

    // 7. LLM orchestration loop
    const model = config.models?.default?.[0] ?? 'claude-sonnet-4-5-20250929';
    let responseText = '';
    let finishReason: 'stop' | 'content_filter' = 'stop';

    for (let iteration = 0; iteration < FAST_PATH_LIMITS.maxToolCallsPerTurn; iteration++) {
      // Check turn duration limit
      if (Date.now() - turnCtx.startTime > FAST_PATH_LIMITS.maxTurnDurationMs) {
        responseText = 'Turn timed out after 5 minutes.';
        break;
      }

      // Call LLM
      const chunks: ChatChunk[] = [];
      for await (const chunk of providers.llm.chat({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools,
        maxTokens: config.max_tokens ?? 8192,
        taskType: 'default',
        sessionId: request.sessionId,
      })) {
        chunks.push(chunk);
        // Enforce timeout during streaming
        if (Date.now() - turnCtx.startTime > FAST_PATH_LIMITS.maxTurnDurationMs) {
          break;
        }
      }

      // Check timeout after stream completes
      if (Date.now() - turnCtx.startTime > FAST_PATH_LIMITS.maxTurnDurationMs) {
        responseText = 'Turn timed out after 5 minutes.';
        break;
      }

      // Collect response
      const textChunks = chunks.filter(c => c.type === 'text' && c.content);
      const toolCalls = chunks.filter(c => c.type === 'tool_use' && c.toolCall);
      const doneChunk = chunks.find(c => c.type === 'done');
      if (doneChunk && (doneChunk as any).reason === 'content_filter') {
        finishReason = 'content_filter';
      }

      // Accumulate assistant text
      const assistantText = textChunks.map(c => c.content!).join('');
      if (assistantText) {
        responseText += assistantText;
      }

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        break;
      }

      // Add assistant message with tool use blocks
      const assistantBlocks: ContentBlock[] = [];
      if (assistantText) {
        assistantBlocks.push({ type: 'text', text: assistantText });
      }
      for (const tc of toolCalls) {
        assistantBlocks.push({
          type: 'tool_use',
          id: tc.toolCall!.id,
          name: tc.toolCall!.name,
          input: tc.toolCall!.args,
        });
      }
      messages.push({ role: 'assistant', content: assistantBlocks });

      // Process tool calls (with per-call timeout enforcement)
      const toolResults: ToolResult[] = [];
      let toolTimedOut = false;
      for (const tc of toolCalls) {
        const toolRemainingMs = FAST_PATH_LIMITS.maxTurnDurationMs - (Date.now() - turnCtx.startTime);
        if (toolRemainingMs <= 0) {
          toolTimedOut = true;
          break;
        }
        const result = await Promise.race([
          routeToolCall(
            { id: tc.toolCall!.id, name: tc.toolCall!.name, args: tc.toolCall!.args },
            routerCtx,
          ),
          new Promise<ToolResult>((resolve) =>
            setTimeout(() => resolve({
              toolUseId: tc.toolCall!.id,
              content: 'Tool call timed out.',
              isError: true,
            }), toolRemainingMs),
          ),
        ]);
        toolResults.push(result);
      }
      if (toolTimedOut) {
        responseText = 'Turn timed out after 5 minutes.';
        break;
      }

      // Add tool results as user message with tool_result blocks
      const resultBlocks: ContentBlock[] = toolResults.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.toolUseId,
        content: r.content,
      }));
      messages.push({ role: 'user', content: resultBlocks });

      // Intentional: reset response text so only the final iteration's text
      // is returned. Intermediate assistant text (alongside tool calls) is
      // captured in the messages array for the LLM context, not for the user.
      responseText = '';
    }

    // 8. Persist conversation (final text only — tool-use blocks are omitted
    //    to keep history compact; full message exchange lives in the LLM context)
    if (request.persistentSessionId) {
      await conversationStore.append(request.persistentSessionId, 'user', request.message);
      if (responseText) {
        await conversationStore.append(request.persistentSessionId, 'assistant', responseText);
      }
    }

    reqLogger.debug('fast_path_complete', {
      toolCalls: routerCtx.callCount,
      responseLength: responseText.length,
      durationMs: Date.now() - turnCtx.startTime,
    });

    return {
      responseContent: responseText || 'No response generated.',
      finishReason,
    };
  });
}

// ---------------------------------------------------------------------------
// Turn layer resolution
// ---------------------------------------------------------------------------

export interface SessionState {
  sandboxPod?: { alive: boolean };
}

export function resolveTurnLayer(
  config: Config,
  session: SessionState,
): 'in-process' | 'sandbox' {
  // 1. Claude-code runner always needs sandbox
  if (config.agent === 'claude-code') return 'sandbox';

  // 2. Active sandbox pod exists for this session
  if (session.sandboxPod?.alive) return 'sandbox';

  // 3. MCP provider not configured — need sandbox for everything
  if (!config.providers.mcp) return 'sandbox';

  // 4. Default: in-process fast path
  return 'in-process';
}

