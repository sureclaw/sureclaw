/**
 * claude-code agent runner — uses the Claude Agent SDK to run the full
 * Claude Code CLI experience inside the sandbox.
 *
 * Architecture (local mode):
 *   agent-runner.ts → runClaudeCode()
 *     → Start TCP bridge on localhost:PORT (HTTP → Unix socket forwarder)
 *     → Agent SDK query() with ANTHROPIC_BASE_URL=http://127.0.0.1:PORT
 *       → Claude Code CLI subprocess
 *         → API calls → TCP bridge → Unix socket proxy → Anthropic API
 *         → AX IPC tools via in-process MCP server (memory, web_search, audit)
 *
 * Architecture (k8s mode — NATS_URL set, no proxySocket):
 *   agent-runner.ts → runClaudeCode()
 *     → Start NATS bridge on localhost:PORT (HTTP → NATS request/reply)
 *     → Agent SDK query() with ANTHROPIC_BASE_URL=http://127.0.0.1:PORT
 *       → Claude Code CLI subprocess
 *         → API calls → NATS bridge → ipc.llm.{sessionId} → agent runtime LLM proxy → Anthropic API
 *         → AX IPC tools via in-process MCP server (memory, web_search, audit)
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { IPCClient } from '../ipc-client.js';
import { startTCPBridge } from '../tcp-bridge.js';
import { createIPCMcpServer } from '../mcp-server.js';
import type { AgentConfig, IIPCClient } from '../runner.js';
import type { ContentBlock } from '../../types.js';
import { buildSystemPrompt } from '../agent-setup.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'claude-code' });

// ── Prompt builder helpers ──────────────────────────────────────────

type AnthropicMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/**
 * Build a prompt suitable for the Agent SDK query().
 * When image blocks are present, returns an AsyncIterable<SDKUserMessage> with
 * structured content (text + image blocks). Otherwise returns a plain string.
 */
export function buildSDKPrompt(
  textPrompt: string,
  imageBlocks: ContentBlock[],
): string | AsyncIterable<SDKUserMessage> {
  if (imageBlocks.length === 0) return textPrompt;

  const contentParts: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: AnthropicMediaType; data: string } }
  > = [];
  if (textPrompt.trim()) {
    contentParts.push({ type: 'text', text: textPrompt });
  }
  for (const img of imageBlocks) {
    if (img.type === 'image_data') {
      contentParts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mimeType as AnthropicMediaType,
          data: img.data,
        },
      });
    }
  }
  const userMsg: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: contentParts },
    parent_tool_use_id: null,
    session_id: '',
  };
  return (async function* () { yield userMsg; })();
}

// ── Main runner ─────────────────────────────────────────────────────

export async function runClaudeCode(config: AgentConfig): Promise<void> {
  const rawMsg = config.userMessage ?? '';
  const userMessage = typeof rawMsg === 'string'
    ? rawMsg
    : rawMsg.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
  if (!userMessage.trim()) return;

  // Extract inline image blocks so they can be forwarded to the Agent SDK
  const imageBlocks: ContentBlock[] = Array.isArray(rawMsg)
    ? rawMsg.filter(b => b.type === 'image_data')
    : [];

  // Detect k8s mode: NATS_URL is set and no proxySocket provided.
  // In k8s sandbox pods, LLM calls go through NATS instead of a Unix socket proxy.
  const useNATSBridge = !config.proxySocket && !!process.env.NATS_URL;

  if (!config.proxySocket && !useNATSBridge) {
    logger.error('missing_proxy_socket', { message: 'claude-code agent requires --proxy-socket or NATS_URL env var' });
    process.exit(1);
  }

  // 1. Start bridge — TCP bridge for local mode, NATS bridge for k8s mode
  let bridge: { port: number; stop: () => void | Promise<void> };
  if (useNATSBridge) {
    if (!config.sessionId) {
      logger.error('missing_session_id', { message: 'claude-code NATS bridge requires sessionId' });
      process.exit(1);
    }
    const { startNATSBridge } = await import('../nats-bridge.js');
    bridge = await startNATSBridge({ sessionId: config.sessionId });
    logger.info('nats_bridge_started', { port: bridge.port, sessionId: config.sessionId });
  } else {
    bridge = await startTCPBridge(config.proxySocket!);
  }

  // 2. Connect IPC client for MCP tools
  // Use pre-connected client if available (listen mode starts before stdin read).
  const client = config.ipcClient ?? new IPCClient({ socketPath: config.ipcSocket, listen: config.ipcListen, sessionId: config.sessionId, requestId: config.requestId, userId: config.userId, sessionScope: config.sessionScope });
  if (!config.ipcClient) await client.connect();

  // 3. Build system prompt (also returns toolFilter for MCP tool filtering)
  const { systemPrompt, toolFilter } = buildSystemPrompt(config);

  // 4. Create IPC MCP server with context-aware tool filtering
  // When running in a container, sandbox tools execute locally with host audit gate.
  const CONTAINER_SANDBOXES = new Set(['docker', 'apple', 'k8s']);
  const useLocalSandbox = CONTAINER_SANDBOXES.has(config.sandboxType ?? '');
  const ipcMcpServer = createIPCMcpServer(client, {
    userId: config.userId,
    filter: toolFilter,
    ...(useLocalSandbox ? { localSandbox: { client, workspace: config.workspace } } : {}),
  });

  // Include conversation history in the prompt if available
  let fullPrompt = '';
  if (config.history && config.history.length > 0) {
    const historyText = config.history
      .map(t => {
        const text = typeof t.content === 'string'
          ? t.content
          : t.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
        return `${t.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
      })
      .join('\n\n');
    fullPrompt = `[Previous conversation]\n${historyText}\n\n[Current message]\n${userMessage}`;
  } else {
    fullPrompt = userMessage;
  }

  try {
    // 5. Build prompt — structured with images, or plain string
    const prompt = buildSDKPrompt(fullPrompt, imageBlocks);

    // 6. Call Agent SDK query()
    const result = query({
      prompt,
      options: {
        model: 'claude-sonnet-4-5-20250929',
        cwd: config.workspace,
        systemPrompt,
        maxTurns: 20,
        persistSession: false,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: [],
        mcpServers: { 'ax-tools': ipcMcpServer },
        disallowedTools: ['WebFetch', 'WebSearch', 'Skill'],
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${bridge.port}`,
          ANTHROPIC_API_KEY: 'ax-proxy',
          CLAUDE_CODE_OAUTH_TOKEN: undefined,
        },
      },
    });

    // 7. Stream output
    let hasOutput = false;
    for await (const msg of result) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            if (hasOutput) process.stdout.write('\n\n');
            process.stdout.write(block.text);
            hasOutput = true;
          }
        }
      } else if (msg.type === 'result' && 'is_error' in msg && msg.is_error) {
        const errText = 'errors' in msg ? String((msg as Record<string, unknown>).errors) : 'unknown error';
        logger.error('claude_code_error', { error: errText });
        process.stderr.write(`Claude Code error: ${errText}\n`);
      }
    }
    if (hasOutput) process.stdout.write('\n');
  } catch (err) {
    // Surface the error clearly — expired OAuth, network failures, etc.
    const message = (err as Error).message ?? String(err);
    logger.error('claude_code_agent_failed', { error: message });
    process.stderr.write(`Claude Code agent failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    // 8. Cleanup — bridge.stop() may be async (NATS bridge) or sync (TCP bridge)
    await Promise.resolve(bridge.stop());
    client.disconnect();
  }
}
