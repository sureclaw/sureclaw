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
import { startWebProxyBridge, type WebProxyBridge } from '../web-proxy-bridge.js';
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

  // Detect transport mode
  const isHTTPTransport = process.env.AX_IPC_TRANSPORT === 'http';

  if (!isHTTPTransport && !config.proxySocket) {
    logger.error('missing_proxy_socket', { message: 'claude-code agent requires --proxy-socket or AX_IPC_TRANSPORT=http' });
    process.exit(1);
  }

  // 1. Start bridge — HTTP mode needs no bridge, socket mode starts TCP bridge
  let bridge: { port: number; stop: () => void | Promise<void> } | undefined;
  if (isHTTPTransport) {
    // K8s HTTP mode: agent hits host LLM proxy directly via /internal/llm-proxy.
    // No bridge needed — ANTHROPIC_BASE_URL points to host, per-turn token as API key.
    logger.info('http_llm_proxy', { hostUrl: process.env.AX_HOST_URL });
  } else {
    bridge = await startTCPBridge(config.proxySocket!);
  }

  // 1b. Start web proxy bridge for outbound HTTP/HTTPS access if available
  let webProxyBridge: WebProxyBridge | undefined;
  const webProxySocket = process.env.AX_WEB_PROXY_SOCKET;
  const webProxyUrl = process.env.AX_WEB_PROXY_URL;
  const webProxyPort = process.env.AX_WEB_PROXY_PORT;
  if (webProxySocket) {
    try {
      webProxyBridge = await startWebProxyBridge(webProxySocket);
      logger.info('web_proxy_bridge_started', { port: webProxyBridge.port });
    } catch (err) {
      logger.warn('web_proxy_bridge_failed', { error: (err as Error).message });
    }
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

  // In k8s mode (NATS or HTTP), buffer text instead of writing to stdout — response goes via IPC
  const isK8sTransport = process.env.AX_IPC_TRANSPORT === 'nats' || process.env.AX_IPC_TRANSPORT === 'http';
  const textBuffer: string[] = [];

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
          // HTTP transport: point directly at host LLM proxy, per-turn token as API key
          // Bridge modes: point at local bridge port with dummy key
          ANTHROPIC_BASE_URL: isHTTPTransport
            ? `${process.env.AX_HOST_URL}/internal/llm-proxy`
            : `http://127.0.0.1:${bridge!.port}`,
          ANTHROPIC_API_KEY: isHTTPTransport
            ? (process.env.AX_IPC_TOKEN ?? 'ax-proxy')
            : 'ax-proxy',
          CLAUDE_CODE_OAUTH_TOKEN: undefined,
          // Web proxy for outbound HTTP/HTTPS (npm install, curl, git clone)
          ...(webProxyBridge ? {
            HTTP_PROXY: `http://127.0.0.1:${webProxyBridge.port}`,
            HTTPS_PROXY: `http://127.0.0.1:${webProxyBridge.port}`,
            http_proxy: `http://127.0.0.1:${webProxyBridge.port}`,
            https_proxy: `http://127.0.0.1:${webProxyBridge.port}`,
          } : webProxyUrl ? {
            HTTP_PROXY: webProxyUrl,
            HTTPS_PROXY: webProxyUrl,
            http_proxy: webProxyUrl,
            https_proxy: webProxyUrl,
          } : webProxyPort ? {
            HTTP_PROXY: `http://127.0.0.1:${webProxyPort}`,
            HTTPS_PROXY: `http://127.0.0.1:${webProxyPort}`,
            http_proxy: `http://127.0.0.1:${webProxyPort}`,
            https_proxy: `http://127.0.0.1:${webProxyPort}`,
          } : {}),
        },
      },
    });

    // 7. Stream output (buffer in NATS mode, write to stdout otherwise)
    let hasOutput = false;
    for await (const msg of result) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            if (hasOutput) {
              if (isK8sTransport) textBuffer.push('\n\n');
              else process.stdout.write('\n\n');
            }
            if (isK8sTransport) textBuffer.push(block.text);
            else process.stdout.write(block.text);
            hasOutput = true;
          }
        }
      } else if (msg.type === 'result' && 'is_error' in msg && msg.is_error) {
        const errText = 'errors' in msg ? String((msg as Record<string, unknown>).errors) : 'unknown error';
        logger.error('claude_code_error', { error: errText });
        process.stderr.write(`Claude Code error: ${errText}\n`);
      }
    }
    if (hasOutput && !isK8sTransport) process.stdout.write('\n');

    // In NATS mode, release workspace files then send agent_response
    if (isK8sTransport) {
      // Upload workspace file changes to host via sidecar before agent_response
      const hostUrl = process.env.AX_HOST_URL;
      if (hostUrl) {
        try {
          const { releaseWorkspaceScopes } = await import('../workspace-release.js');
          await releaseWorkspaceScopes(hostUrl, client);
        } catch (err) {
          logger.warn('workspace_release_failed', { error: (err as Error).message });
          // Non-fatal — don't lose the response over workspace sync failure
        }
      }

      // Sandbox-side finalize: git push + GCS cache update.
      // In k8s, the pod owns the workspace — finalize must happen in-pod.
      // Host-side providers (Docker/Apple) handle this after container exit.
      try {
        const { releaseWorkspace } = await import('../workspace.js');
        const scratchPath = '/workspace/scratch';
        const { existsSync } = await import('node:fs');
        if (existsSync(scratchPath + '/.git')) {
          await releaseWorkspace(scratchPath, {
            pushChanges: true,
            updateCache: !!process.env.WORKSPACE_CACHE_BUCKET,
            cacheKey: process.env.AX_WORKSPACE_CACHE_KEY,
          });
          logger.info('workspace_cleanup_done');
        }
      } catch (err) {
        logger.warn('workspace_cleanup_failed', { error: (err as Error).message });
      }

      const buffered = textBuffer.join('');
      logger.debug('nats_agent_response', { contentLength: buffered.length });
      try {
        await client.call({ action: 'agent_response', content: buffered });
      } catch (err) {
        logger.error('agent_response_failed', { error: (err as Error).message });
        process.stderr.write(`Failed to send agent_response: ${(err as Error).message}\n`);
      }
    }
  } catch (err) {
    // Surface the error clearly — expired OAuth, network failures, etc.
    const message = (err as Error).message ?? String(err);
    logger.error('claude_code_agent_failed', { error: message });
    process.stderr.write(`Claude Code agent failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    // 8. Cleanup — bridge.stop() may be async (NATS bridge) or sync (TCP bridge)
    if (bridge) await Promise.resolve(bridge.stop());
    if (webProxyBridge) webProxyBridge.stop();
    client.disconnect();
  }
}
