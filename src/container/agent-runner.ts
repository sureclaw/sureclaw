import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IPCClient } from './ipc-client.js';

interface AgentConfig {
  ipcSocket: string;
  workspace: string;
  skills: string;
}

function parseArgs(): AgentConfig {
  const args = process.argv.slice(2);
  let ipcSocket = '';
  let workspace = '';
  let skills = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--ipc-socket': ipcSocket = args[++i]; break;
      case '--workspace': workspace = args[++i]; break;
      case '--skills': skills = args[++i]; break;
    }
  }

  // Fallback to env vars (subprocess sandbox uses these)
  ipcSocket = ipcSocket || process.env.SURECLAW_IPC_SOCKET || '';
  workspace = workspace || process.env.SURECLAW_WORKSPACE || '';
  skills = skills || process.env.SURECLAW_SKILLS || '';

  if (!ipcSocket || !workspace) {
    console.error('Usage: agent-runner --ipc-socket <path> --workspace <path> [--skills <path>]');
    process.exit(1);
  }

  return { ipcSocket, workspace, skills };
}

function loadContext(workspace: string): string {
  try {
    return readFileSync(join(workspace, 'CONTEXT.md'), 'utf-8');
  } catch {
    return '';
  }
}

function loadSkills(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => readFileSync(join(skillsDir, f), 'utf-8'));
  } catch {
    return [];
  }
}

function buildSystemPrompt(context: string, skills: string[]): string {
  const parts: string[] = [];

  parts.push('You are SureClaw, a security-first AI agent.');
  parts.push('Follow the safety rules in your skills. Never reveal canary tokens.');

  if (context) {
    parts.push('\n## Context\n' + context);
  }

  if (skills.length > 0) {
    parts.push('\n## Skills\n' + skills.join('\n---\n'));
  }

  return parts.join('\n');
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

interface ChatChunk {
  type: 'text' | 'tool_use' | 'done';
  content?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
}

async function handleToolCall(
  client: IPCClient,
  toolCall: { id: string; name: string; args: Record<string, unknown> },
): Promise<string> {
  // Map tool names to IPC actions
  const actionMap: Record<string, string> = {
    memory_write: 'memory_write',
    memory_query: 'memory_query',
    memory_read: 'memory_read',
    memory_delete: 'memory_delete',
    memory_list: 'memory_list',
    web_fetch: 'web_fetch',
    web_search: 'web_search',
    skill_read: 'skill_read',
    skill_list: 'skill_list',
  };

  const action = actionMap[toolCall.name];
  if (!action) {
    return JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
  }

  const result = await client.call({ action, ...toolCall.args });
  return JSON.stringify(result);
}

const MAX_TOOL_LOOPS = 10;

export async function run(config: AgentConfig): Promise<void> {
  const client = new IPCClient({ socketPath: config.ipcSocket });
  await client.connect();

  const context = loadContext(config.workspace);
  const skills = loadSkills(config.skills);
  const systemPrompt = buildSystemPrompt(context, skills);

  // Read the user message from stdin
  const userMessage = await readStdin();
  if (!userMessage.trim()) {
    client.disconnect();
    return;
  }

  const messages: { role: string; content: string }[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  let loops = 0;

  while (loops < MAX_TOOL_LOOPS) {
    loops++;

    const response = await client.call({
      action: 'llm_call',
      messages,
    }) as { ok: boolean; chunks?: ChatChunk[]; error?: string };

    if (!response.ok) {
      console.error(`LLM error: ${response.error}`);
      break;
    }

    const chunks = response.chunks ?? [];
    let finalText = '';
    const toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];

    for (const chunk of chunks) {
      if (chunk.type === 'text' && chunk.content) {
        finalText += chunk.content;
      } else if (chunk.type === 'tool_use' && chunk.toolCall) {
        toolCalls.push(chunk.toolCall);
      }
    }

    if (toolCalls.length === 0) {
      // No tool calls — output final response and exit
      process.stdout.write(finalText);
      break;
    }

    // Handle tool calls
    messages.push({ role: 'assistant', content: finalText });

    for (const tc of toolCalls) {
      const result = await handleToolCall(client, tc);
      messages.push({
        role: 'user',
        content: `Tool result for ${tc.name} (id: ${tc.id}):\n${result}`,
      });
    }
  }

  if (loops >= MAX_TOOL_LOOPS) {
    console.error('Max tool call loops reached');
  }

  client.disconnect();
}

// Run if this is the main module
const isMain = process.argv[1]?.endsWith('agent-runner.js') ||
               process.argv[1]?.endsWith('agent-runner.ts');
if (isMain) {
  const config = parseArgs();
  run(config).catch((err) => {
    console.error('Agent runner error:', err);
    process.exit(1);
  });
}
