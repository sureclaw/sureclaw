/**
 * claude-code agent runner — uses the Claude Agent SDK to run the full
 * Claude Code CLI experience inside the sandbox.
 *
 * Architecture:
 *   agent-runner.ts → runClaudeCode()
 *     → Start TCP bridge on localhost:PORT (HTTP → Unix socket forwarder)
 *     → Agent SDK query() with ANTHROPIC_BASE_URL=http://127.0.0.1:PORT
 *       → Claude Code CLI subprocess
 *         → API calls → TCP bridge → Unix socket proxy → Anthropic API
 *         → AX IPC tools via in-process MCP server (memory, web_search, audit)
 */

import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { IPCClient } from '../ipc-client.js';
import { startTCPBridge } from '../tcp-bridge.js';
import { createIPCMcpServer } from '../mcp-server.js';
import type { AgentConfig } from '../runner.js';
import { PromptBuilder } from '../prompt/builder.js';
import { loadContext, loadSkills } from '../stream-utils.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'claude-code' });

// ── Main runner ─────────────────────────────────────────────────────

export async function runClaudeCode(config: AgentConfig): Promise<void> {
  const userMessage = config.userMessage ?? '';
  if (!userMessage.trim()) return;

  if (!config.proxySocket) {
    logger.error('missing_proxy_socket', { message: 'claude-code agent requires --proxy-socket' });
    process.exit(1);
  }

  // 1. Start TCP bridge (localhost:PORT → Unix socket proxy)
  const bridge = await startTCPBridge(config.proxySocket);

  // 2. Connect IPC client for MCP tools
  const client = new IPCClient({ socketPath: config.ipcSocket });
  await client.connect();

  // 3. Create IPC MCP server
  const ipcMcpServer = createIPCMcpServer(client);

  // 4. Build system prompt via modular PromptBuilder
  const contextContent = loadContext(config.workspace);
  const skills = loadSkills(config.skills);

  const promptBuilder = new PromptBuilder();
  const promptResult = promptBuilder.build({
    agentType: config.agent ?? 'claude-code',
    workspace: config.workspace,
    skills,
    profile: config.profile ?? 'balanced',
    sandboxType: config.sandboxType ?? 'subprocess',
    taintRatio: config.taintRatio ?? 0,
    taintThreshold: config.taintThreshold ?? 1,
    // claude-code doesn't have agentDir, so identity files are empty
    identityFiles: { agent: '', soul: '', identity: '', user: '', bootstrap: '' },
    contextContent,
    contextWindow: 200000,
    historyTokens: config.history?.length ? JSON.stringify(config.history).length / 4 : 0,
  });
  const systemPrompt = promptResult.content;

  // Include conversation history in the prompt if available
  let fullPrompt = '';
  if (config.history && config.history.length > 0) {
    const historyText = config.history
      .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
      .join('\n\n');
    fullPrompt = `[Previous conversation]\n${historyText}\n\n[Current message]\n${userMessage}`;
  } else {
    fullPrompt = userMessage;
  }

  try {
    // 5. Call Agent SDK query()
    const result = query({
      prompt: fullPrompt,
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

    // 6. Stream output
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
      } else if (msg.type === 'error') {
        const errText = 'error' in msg ? String((msg as Record<string, unknown>).error) : 'unknown error';
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
    // 7. Cleanup
    bridge.stop();
    client.disconnect();
  }
}
