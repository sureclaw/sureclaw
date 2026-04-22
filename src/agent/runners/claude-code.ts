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
 * Architecture (k8s mode — AX_HOST_URL set, no proxySocket):
 *   agent-runner.ts → runClaudeCode()
 *     → Start HTTP bridge on localhost:PORT (HTTP → host HTTP IPC)
 *     → Agent SDK query() with ANTHROPIC_BASE_URL=http://127.0.0.1:PORT
 *       → Claude Code CLI subprocess
 *         → API calls → HTTP bridge → host LLM proxy → Anthropic API
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
import { GitWorkspace } from '../git-workspace.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getLogger } from '../../logger.js';

// Bind chat-turn correlation ID into every log emit from this hot-path runner.
// The sandbox provider sets AX_REQUEST_ID in the pod env before node imports
// this module, so reading it at module load is safe (same trade-off as
// `runner.ts:15-22`). Last 8 chars match the convention used elsewhere in the
// chain so a single `grep <reqId>` reconstructs host → sandbox → agent logs.
const reqIdBinding = process.env.AX_REQUEST_ID?.slice(-8);
const logger = reqIdBinding
  ? getLogger().child({ component: 'claude-code', reqId: reqIdBinding })
  : getLogger().child({ component: 'claude-code' });

// ── Prompt builder helpers ──────────────────────────────────────────

type AnthropicMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf', 'text/plain',
]);

/**
 * Build a prompt suitable for the Agent SDK query().
 * When media blocks (images, PDFs) are present, returns an AsyncIterable<SDKUserMessage>
 * with structured content. Otherwise returns a plain string.
 */
export function buildSDKPrompt(
  textPrompt: string,
  mediaBlocks: ContentBlock[],
): string | AsyncIterable<SDKUserMessage> {
  if (mediaBlocks.length === 0) return textPrompt;

  const contentParts: any[] = [];
  if (textPrompt.trim()) {
    contentParts.push({ type: 'text', text: textPrompt });
  }
  for (const block of mediaBlocks) {
    if (block.type === 'image_data') {
      contentParts.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: block.mimeType as AnthropicMediaType,
          data: block.data,
        },
      });
    } else if (block.type === 'file_data') {
      if (DOCUMENT_MIME_TYPES.has(block.mimeType)) {
        contentParts.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: block.mimeType,
            data: block.data,
          },
        });
      } else {
        // Non-document files: inline as text only if text-like MIME
        const TEXT_MIMES = ['text/', 'application/json', 'application/xml', 'application/javascript'];
        const isTextLike = TEXT_MIMES.some(prefix => block.mimeType.startsWith(prefix));
        if (isTextLike) {
          const text = Buffer.from(block.data, 'base64').toString('utf-8');
          contentParts.push({ type: 'text', text: `--- ${block.filename} ---\n${text}\n--- end ---` });
        } else {
          contentParts.push({ type: 'text', text: `[File: ${block.filename} (${block.mimeType}, binary — not inlined)]` });
        }
      }
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

  // Extract inline media blocks (images, PDFs) so they can be forwarded to the Agent SDK
  const mediaBlocks: ContentBlock[] = Array.isArray(rawMsg)
    ? rawMsg.filter(b => b.type === 'image_data' || b.type === 'file_data')
    : [];

  // Detect transport mode — AX_HOST_URL means k8s HTTP mode
  const isHTTPTransport = !!process.env.AX_HOST_URL;

  if (!isHTTPTransport && !config.proxySocket) {
    logger.error('missing_proxy_socket', { message: 'claude-code agent requires --proxy-socket or AX_HOST_URL' });
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
  const webProxyPort = process.env.AX_PROXY_LISTEN_PORT;
  if (webProxySocket) {
    try {
      webProxyBridge = await startWebProxyBridge(webProxySocket);
      logger.info('web_proxy_bridge_started', { port: webProxyBridge.port });
    } catch (err) {
      logger.warn('web_proxy_bridge_failed', { error: (err as Error).message });
    }
  }

  // Set proxy env vars so child processes (including skill installs) can reach the network.
  // pi-session does this before the installer; claude-code must do the same.
  const webProxyEnvUrl = webProxyBridge
    ? `http://127.0.0.1:${webProxyBridge.port}`
    : webProxyUrl
      ? webProxyUrl
      : webProxyPort
        ? `http://127.0.0.1:${webProxyPort}`
        : undefined;
  if (webProxyEnvUrl) {
    process.env.HTTP_PROXY = webProxyEnvUrl;
    process.env.HTTPS_PROXY = webProxyEnvUrl;
    process.env.http_proxy = webProxyEnvUrl;
    process.env.https_proxy = webProxyEnvUrl;
    logger.info('web_proxy_env_set', {
      url: webProxyEnvUrl,
      source: webProxyBridge ? 'bridge' : webProxyUrl ? 'AX_WEB_PROXY_URL' : 'AX_PROXY_LISTEN_PORT',
    });
  } else {
    logger.info('web_proxy_env_none', {
      socket: webProxySocket ?? 'unset',
      url: webProxyUrl ?? 'unset',
      port: webProxyPort ?? 'unset',
    });
  }

  // 1c. Initialize git workspace if WORKSPACE_REPO_URL is set.
  // In k8s, git-init container already cloned and .git is locked to UID 1001.
  const hasGitWorkspace = !!process.env.WORKSPACE_REPO_URL;
  const hasSidecar = hasGitWorkspace && !!process.env.AX_HOST_URL; // k8s mode
  let gitWorkspace: GitWorkspace | null = null;
  if (hasGitWorkspace && !hasSidecar) {
    gitWorkspace = new GitWorkspace(config.workspace, process.env.WORKSPACE_REPO_URL!);
    try {
      await gitWorkspace.clone();
      await gitWorkspace.init();
      await gitWorkspace.pull();
      logger.info('git_workspace_ready', { url: process.env.WORKSPACE_REPO_URL });
    } catch (err) {
      logger.error('git_workspace_init_failed', { error: (err as Error).message });
      throw err;
    }
  } else if (hasSidecar) {
    // K8s mode: pull latest via sidecar. Retry handles sidecar startup race
    // (both containers start simultaneously, sidecar may not be listening yet).
    const sidecarPort = process.env.AX_GIT_SIDECAR_PORT || '9099';
    const sidecarUrl = `http://localhost:${sidecarPort}`;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const resp = await fetch(`${sidecarUrl}/pull`, { method: 'POST' });
        const result = await resp.json() as { ok: boolean; error?: string };
        if (result.ok) {
          logger.info('sidecar_pull_complete', { attempt });
          break;
        }
        logger.warn('sidecar_pull_failed', { error: result.error, attempt });
        if (attempt < 9) await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        if (attempt < 9) {
          logger.debug('sidecar_not_ready', { attempt, error: (err as Error).message });
          await new Promise(r => setTimeout(r, 500));
        } else {
          logger.warn('sidecar_pull_failed_all_retries', { error: (err as Error).message });
        }
      }
    }
  }

  // Skill dependencies are installed lazily when the agent reads a SKILL.md
  // and runs its install commands via bash — not eagerly at startup.

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
  logger.info('sandbox_type_check', { sandboxType: config.sandboxType, useLocalSandbox });

  const ipcMcpServer = createIPCMcpServer(client, {
    userId: config.userId,
    filter: toolFilter,
    ...(useLocalSandbox ? { localSandbox: { client, workspace: config.workspace, sessionId: config.sessionId } } : {}),
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

  // Buffer text when response goes via IPC (k8s HTTP or Apple Container bridge).
  // For Docker/subprocess, stream to stdout — the host reads from stdout.
  const useIPCResponse = !!process.env.AX_HOST_URL || process.env.AX_IPC_LISTEN === '1';
  const textBuffer: string[] = [];

  try {
    // 5. Build prompt — structured with images, or plain string
    const prompt = buildSDKPrompt(fullPrompt, mediaBlocks);

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

    // 7. Stream output — buffer for IPC or write to stdout
    let hasOutput = false;
    for await (const msg of result) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') {
            if (useIPCResponse) {
              if (hasOutput) textBuffer.push('\n\n');
              textBuffer.push(block.text);
            } else {
              if (hasOutput) process.stdout.write('\n\n');
              process.stdout.write(block.text);
            }
            hasOutput = true;
          }
        }
      } else if (msg.type === 'result' && 'is_error' in msg && msg.is_error) {
        const errText = 'errors' in msg ? String((msg as Record<string, unknown>).errors) : 'unknown error';
        logger.error('claude_code_error', { error: errText });
        process.stderr.write(`Claude Code error: ${errText}\n`);
      }
    }

    // Persist workspace changes
    if (gitWorkspace) {
      try {
        const timestamp = new Date().toISOString();
        await gitWorkspace.commitAndPush(`agent-turn: ${timestamp}`);
      } catch (err) {
        logger.error('git_turn_commit_failed', { error: (err as Error).message });
      }
    } else if (hasSidecar) {
      // Signal git-sidecar via HTTP — containers share localhost in the same pod
      const sidecarPort = process.env.AX_GIT_SIDECAR_PORT || '9099';
      try {
        const resp = await fetch(`http://localhost:${sidecarPort}/turn-complete`, { method: 'POST' });
        const result = await resp.json() as { ok: boolean; hash?: string; files?: number; error?: string };
        if (result.ok) {
          logger.info('sidecar_commit_complete', { hash: result.hash, files: result.files });
        } else {
          logger.error('sidecar_commit_failed', { error: result.error });
        }
      } catch (err) {
        logger.error('sidecar_signal_failed', { error: (err as Error).message });
      }
    }

    // Send response back to host via agent_response IPC action (k8s/bridge only).
    // Docker/subprocess response goes via stdout — no IPC needed.
    if (useIPCResponse) {
      const buffered = textBuffer.join('');
      logger.debug('agent_response', { contentLength: buffered.length });
      try {
        await client.call({ action: 'agent_response', content: buffered }, 5000);
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
    // 8. Cleanup — bridge.stop() may be async (HTTP bridge) or sync (TCP bridge)
    if (bridge) await Promise.resolve(bridge.stop());
    if (webProxyBridge) webProxyBridge.stop();
    client.disconnect();
  }
}
