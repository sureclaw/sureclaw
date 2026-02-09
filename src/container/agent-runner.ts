import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from '@mariozechner/pi-agent-core';
import type { Model } from '@mariozechner/pi-ai';
import { IPCClient } from './ipc-client.js';
import { createIPCStreamFn } from './ipc-transport.js';
import { createLocalTools } from './local-tools.js';
import { createIPCTools } from './ipc-tools.js';

// Default model — the actual model ID is forwarded through IPC to the host,
// which routes it to the configured LLM provider. This just needs to be a
// valid Model object for pi-agent-core's Agent class.
const DEFAULT_MODEL: Model<any> = {
  id: 'claude-sonnet-4-5-20250929',
  name: 'Claude Sonnet 4.5',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

export interface AgentConfig {
  ipcSocket: string;
  workspace: string;
  skills: string;
  userMessage?: string;
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

export async function run(config: AgentConfig): Promise<void> {
  const userMessage = config.userMessage ?? '';
  if (!userMessage.trim()) return;

  const client = new IPCClient({ socketPath: config.ipcSocket });
  await client.connect();

  const context = loadContext(config.workspace);
  const skills = loadSkills(config.skills);
  const systemPrompt = buildSystemPrompt(context, skills);

  // Build tools: local (execute in sandbox) + IPC (route to host)
  const localTools = createLocalTools(config.workspace);
  const ipcTools = createIPCTools(client);
  const allTools = [...localTools, ...ipcTools];

  // Create agent with IPC-proxied LLM calls
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: DEFAULT_MODEL,
      tools: allTools,
    },
    streamFn: createIPCStreamFn(client),
  });

  // Subscribe to events — stream text to stdout
  agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  // Send the user message and wait for the agent to finish
  await agent.prompt(userMessage);
  await agent.waitForIdle();

  client.disconnect();
}

// Run if this is the main module
const isMain = process.argv[1]?.endsWith('agent-runner.js') ||
               process.argv[1]?.endsWith('agent-runner.ts');
if (isMain) {
  const config = parseArgs();
  readStdin().then((msg) => {
    config.userMessage = msg;
    return run(config);
  }).catch((err) => {
    console.error('Agent runner error:', err);
    process.exit(1);
  });
}
